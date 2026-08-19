import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const memoryKey = "CROSS_AGENT_TEST_20260817";
const memoryValue = "lavender-731";
const memoryContent = `${memoryKey} = ${memoryValue}`;

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000,
    ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  let timer;
  const code = await Promise.race([
    new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", resolvePromise);
    }),
    new Promise((_, rejectPromise) => {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`${command} timed out`));
      }, options.timeoutMs ?? 360_000);
    }),
  ]).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

async function freePort() {
  const server = createServer();
  return await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? rejectPromise(error) : resolvePromise(address.port)));
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForHealth(baseUrl, daemon) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited with ${daemon.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("daemon health check timed out");
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
  });
  const body = await response.text();
  assert.ok(response.ok, `${response.status} ${body}`);
  return body === "" ? undefined : JSON.parse(body);
}

function hookCommand(provider) {
  return [process.execPath, scriptPath, "--hook", provider].map(shellQuote).join(" ");
}

function codexHooks() {
  const hook = { type: "command", command: hookCommand("codex"), timeout: 8 };
  return {
    description: "Memory Space P8 real implicit remember smoke",
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
    },
  };
}

function claudeSettings() {
  const hook = { type: "command", command: hookCommand("claude"), timeout: 8 };
  return {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };
}

async function relayHook(provider) {
  assert.ok(provider === "codex" || provider === "claude");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const inputText = Buffer.concat(chunks).toString("utf8");
  const input = JSON.parse(inputText);
  const command = provider === "codex" ? "codex:hook" : "claude-code:hook";
  const child = spawnSync("pnpm", ["--dir", repositoryRoot, "--silent", command], {
    input: inputText,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  let output;
  try {
    output = child.stdout ? JSON.parse(child.stdout) : undefined;
  } catch {
    output = undefined;
  }
  const logPath = process.env.MEMORY_SPACE_P8_BRIDGE_HOOK_LOG;
  assert.ok(logPath);
  appendFileSync(
    logPath,
    `${JSON.stringify({
      provider,
      hookEventName: input.hook_event_name,
      sessionId: input.session_id,
      promptObserved: typeof input.prompt === "string",
      assistantObserved: typeof input.last_assistant_message === "string",
      output,
      exitCode: child.status,
    })}\n`
  );
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
}

function hookRecords(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runCodex(workspace, environment, artifactRoot, label, prompt) {
  const outputPath = join(artifactRoot, `codex-${label}-last-message.txt`);
  const result = await run(
    "codex",
    [
      "exec",
      "--ignore-rules",
      "--strict-config",
      "--enable",
      "hooks",
      "--dangerously-bypass-hook-trust",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--json",
      "--output-last-message",
      outputPath,
      "--cd",
      workspace,
      "-",
    ],
    { cwd: workspace, env: environment, input: prompt }
  );
  writeFileSync(join(artifactRoot, `codex-${label}-events.jsonl`), result.stdout);
  writeFileSync(join(artifactRoot, `codex-${label}-stderr.log`), result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /memory_(?:remember|search|context)/iu);
  return readFileSync(outputPath, "utf8").trim();
}

async function runClaude(workspace, settingsPath, environment, artifactRoot, label, prompt) {
  const result = await run(
    "claude",
    [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--no-chrome",
      "--disable-slash-commands",
      "--tools",
      "",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "1",
      "--max-budget-usd",
      process.env.MEMORY_SPACE_CLAUDE_MAX_BUDGET_USD ?? "1",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--session-id",
      randomUUID(),
      prompt,
    ],
    { cwd: workspace, env: environment }
  );
  writeFileSync(join(artifactRoot, `claude-${label}-events.jsonl`), result.stdout);
  writeFileSync(join(artifactRoot, `claude-${label}-stderr.log`), result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /mcp__memory_space__memory_(?:remember|search|context)/u);
  const events = result.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const final = events.findLast((event) => event.type === "result")?.result;
  assert.equal(typeof final, "string");
  return final.trim();
}

async function runProvider(provider) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `memory-space-p8-${provider}-smoke-`));
  const workspace = mkdtempSync(join(repositoryRoot, `.p8-${provider}-smoke-workspace-`));
  const databasePath = join(temporaryRoot, "memory-space.db");
  const hookLogPath = join(temporaryRoot, "hook-events.jsonl");
  const settingsPath = join(temporaryRoot, "claude-settings.json");
  const spaceId = `p8-real-smoke-${provider}`;
  let daemon;
  let completed = false;
  try {
    mkdirSync(join(workspace, ".memory-space"));
    writeJson(join(workspace, ".memory-space", "config.json"), {
      version: 1,
      spaceId,
      implicitRecall: { mode: "exact" },
      implicitRemember: { mode: "conservative" },
    });
    if (provider === "codex") {
      mkdirSync(join(workspace, ".codex"));
      writeJson(join(workspace, ".codex", "hooks.json"), codexHooks());
    } else {
      writeJson(settingsPath, claudeSettings());
    }
    writeFileSync(hookLogPath, "");
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const environment = {
      ...process.env,
      MEMORY_SPACE_CODEX_HOOK_URL: `${baseUrl}/providers/codex/lifecycle`,
      MEMORY_SPACE_CLAUDE_CODE_HOOK_URL: `${baseUrl}/providers/claude-code/lifecycle`,
      MEMORY_SPACE_P8_BRIDGE_HOOK_LOG: hookLogPath,
      MEMORY_SPACE_HOOK_TIMEOUT_MS: "8000",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      MAX_THINKING_TOKENS: "0",
    };
    daemon = spawn("pnpm", ["start"], {
      cwd: repositoryRoot,
      env: {
        ...environment,
        MEMORY_SPACE_DB: databasePath,
        MEMORY_SPACE_HOST: "127.0.0.1",
        MEMORY_SPACE_PORT: String(port),
        MEMORY_SPACE_CWD: workspace,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForHealth(baseUrl, daemon);
    await jsonRequest(`${baseUrl}/spaces`, {
      method: "POST",
      body: JSON.stringify({ id: spaceId, name: `P8 ${provider} Real Smoke` }),
    });

    const sourcePrompt = [
      memoryContent,
      "Acknowledge briefly. Do not call tools or any Memory Space command.",
    ].join("\n");
    const sourceAnswer =
      provider === "codex"
        ? await runCodex(workspace, environment, temporaryRoot, "source", sourcePrompt)
        : await runClaude(
            workspace,
            settingsPath,
            environment,
            temporaryRoot,
            "source",
            sourcePrompt
          );
    assert.ok(sourceAnswer.length > 0);
    const afterSource = await jsonRequest(`${baseUrl}/spaces/${spaceId}/memories?limit=20`);
    const stored = afterSource.items.filter((memory) => memory.key === memoryKey);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].content, memoryContent);
    assert.equal(stored[0].tier, "indexed");
    const sourceStops = hookRecords(hookLogPath).filter(
      (record) =>
        record.provider === provider &&
        record.hookEventName === "Stop" &&
        record.assistantObserved &&
        record.exitCode === 0
    );
    assert.equal(sourceStops.length, 1, `${provider} did not emit one reliable Stop`);

    writeFileSync(hookLogPath, "");
    const targetAnswer =
      provider === "codex"
        ? await runCodex(workspace, environment, temporaryRoot, "target", memoryKey)
        : await runClaude(workspace, settingsPath, environment, temporaryRoot, "target", memoryKey);
    assert.match(targetAnswer, new RegExp(memoryValue, "u"));
    const targetPrompt = hookRecords(hookLogPath).find(
      (record) =>
        record.provider === provider &&
        record.hookEventName === "UserPromptSubmit" &&
        record.exitCode === 0
    );
    assert.ok(targetPrompt, `${provider} target UserPromptSubmit was not observed`);
    assert.match(
      targetPrompt.output?.hookSpecificOutput?.additionalContext ?? "",
      new RegExp(memoryValue, "u")
    );
    const afterTarget = await jsonRequest(`${baseUrl}/spaces/${spaceId}/memories?limit=20`);
    assert.equal(afterTarget.items.filter((memory) => memory.key === memoryKey).length, 1);
    completed = true;
    return {
      provider,
      sourceStop: "PASS",
      indexedMemory: "PASS",
      targetRecallContext: "PASS",
      targetAnswer,
      explicitMemoryToolCall: false,
    };
  } finally {
    if (daemon) await stopProcess(daemon);
    if (completed) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } else {
      process.stderr.write(`P8 smoke artifacts preserved at ${temporaryRoot}\n`);
      process.stderr.write(`P8 smoke workspace preserved at ${workspace}\n`);
    }
  }
}

function selfTest() {
  assert.deepEqual(Object.keys(codexHooks().hooks).sort(), [
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  assert.deepEqual(Object.keys(claudeSettings().hooks).sort(), [
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ]);
  process.stdout.write("P8 real implicit remember smoke self-test: PASS\n");
}

async function main() {
  const providerIndex = process.argv.indexOf("--provider");
  const requestedProvider = providerIndex < 0 ? undefined : process.argv[providerIndex + 1];
  if (
    requestedProvider !== undefined &&
    requestedProvider !== "codex" &&
    requestedProvider !== "claude"
  ) {
    throw new Error("--provider must be codex or claude");
  }
  const providers = requestedProvider ? [requestedProvider] : ["codex", "claude"];
  if (providers.includes("codex")) runSync("codex", ["login", "status"]);
  if (providers.includes("claude")) runSync("claude", ["auth", "status"]);
  const codexVersion = providers.includes("codex")
    ? runSync("codex", ["--version"]).replace(/^codex-cli\s+/u, "")
    : undefined;
  const claudeVersion = providers.includes("claude") ? runSync("claude", ["--version"]) : undefined;
  const results = {};
  for (const provider of providers) {
    process.stderr.write(`[P8 real smoke] START ${provider}\n`);
    results[provider] = await runProvider(provider);
    process.stderr.write(`[P8 real smoke] PASS ${provider}\n`);
  }
  process.stdout.write(
    `P8_REAL_SMOKE_RESULT=${JSON.stringify({
      date: "2026-08-19",
      memorySpaceCommit: runSync("git", ["rev-parse", "HEAD"]),
      sourceTree: "working-tree",
      codexVersion,
      claudeVersion,
      configuration: {
        implicitRecall: "exact",
        implicitRemember: "conservative",
      },
      results,
      overall: "PASS",
    })}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === "--hook") await relayHook(process.argv[3]);
  else if (process.argv.includes("--self-test")) selfTest();
  else await main();
}
