import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync
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
const lexicalContent = "上传模块使用 variant 区分新版样式，variant 的类型包括 a、b、c。";
const staleContent = "This project uses React 18.";
const hookDescription = "Memory Space P7 real bridge smoke";

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
    ...options
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
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
    })
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
      server.close((error) => error ? rejectPromise(error) : resolvePromise(address.port));
    });
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("close", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000))
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
      // Daemon may still be starting.
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
      ...options.headers
    }
  });
  const body = await response.text();
  assert.ok(response.ok, `${response.status} ${body}`);
  return body === "" ? undefined : JSON.parse(body);
}

function hookCommand(provider) {
  return [process.execPath, scriptPath, "--hook", provider].map(shellQuote).join(" ");
}

function codexHooks() {
  const hook = (provider) => ({
    type: "command",
    command: hookCommand(provider),
    timeout: 8
  });
  return {
    description: hookDescription,
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [hook("codex")] }],
      UserPromptSubmit: [{ hooks: [hook("codex")] }]
    }
  };
}

function claudeSettings() {
  const hook = { type: "command", command: hookCommand("claude"), timeout: 8 };
  return {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }]
    }
  };
}

function projectBinding() {
  const path = join(repositoryRoot, ".memory-space", "config.json");
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(value.version, 1);
  assert.equal(typeof value.spaceId, "string");
  assert.notEqual(value.spaceId.trim(), "");
  return { path, spaceId: value.spaceId.trim() };
}

function parseHookRecords(path) {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

function userPromptContext(records, scenario) {
  const record = records.find((item) => item.hookEventName === "UserPromptSubmit");
  assert.ok(record, "UserPromptSubmit production hook was not observed");
  assert.equal(record.exitCode, 0);
  assert.equal(record.output?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  const context = record.output.hookSpecificOutput.additionalContext;
  assert.equal(typeof context, "string");
  for (const pattern of scenario.contextPatterns) assert.match(context, pattern);
  for (const pattern of scenario.contextForbiddenPatterns ?? []) {
    assert.doesNotMatch(context, pattern);
  }
  return context;
}

async function runCodex(workspace, environment, artifactRoot, scenario) {
  const outputPath = join(artifactRoot, `codex-${scenario.id}-last-message.txt`);
  const result = await run("codex", [
    "exec",
    "--ignore-rules",
    "--strict-config",
    "--enable", "hooks",
    "--dangerously-bypass-hook-trust",
    "--sandbox", "read-only",
    "--ephemeral",
    "--json",
    "--output-last-message", outputPath,
    "--cd", workspace,
    "-"
  ], { cwd: workspace, env: environment, input: scenario.prompt });
  writeFileSync(join(artifactRoot, `codex-${scenario.id}-events.jsonl`), result.stdout);
  writeFileSync(join(artifactRoot, `codex-${scenario.id}-stderr.log`), result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const answer = readFileSync(outputPath, "utf8").trim();
  for (const pattern of scenario.answerPatterns) assert.match(answer, pattern);
  for (const pattern of scenario.answerForbiddenPatterns ?? []) assert.doesNotMatch(answer, pattern);
  assert.doesNotMatch(result.stdout, /memory_space.*memory_(?:search|context)/iu);
  return answer;
}

async function runClaude(workspace, settingsPath, environment, artifactRoot, scenario) {
  const result = await run("claude", [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-hook-events",
    "--settings", settingsPath,
    "--setting-sources", "",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools", scenario.tools ?? "",
    "--permission-mode", "bypassPermissions",
    "--max-turns", scenario.maxTurns ?? "1",
    "--max-budget-usd", process.env.MEMORY_SPACE_CLAUDE_MAX_BUDGET_USD ?? "1",
    "--strict-mcp-config",
    "--no-session-persistence",
    scenario.prompt
  ], { cwd: workspace, env: environment });
  writeFileSync(join(artifactRoot, `claude-${scenario.id}-events.jsonl`), result.stdout);
  writeFileSync(join(artifactRoot, `claude-${scenario.id}-stderr.log`), result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const events = result.stdout.split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  const final = events.findLast((event) => event.type === "result")?.result;
  assert.equal(typeof final, "string");
  for (const pattern of scenario.answerPatterns) assert.match(final, pattern);
  for (const pattern of scenario.answerForbiddenPatterns ?? []) assert.doesNotMatch(final, pattern);
  assert.doesNotMatch(result.stdout, /mcp__memory_space__memory_(?:search|context)/u);
  return final.trim();
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
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  let output;
  try {
    output = child.stdout ? JSON.parse(child.stdout) : undefined;
  } catch {
    output = undefined;
  }
  const logPath = process.env.MEMORY_SPACE_P7_BRIDGE_HOOK_LOG;
  assert.ok(logPath);
  appendFileSync(logPath, `${JSON.stringify({
    provider,
    hookEventName: input.hook_event_name,
    promptObserved: typeof input.prompt === "string",
    output,
    exitCode: child.status
  })}\n`);
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
}

function selfTest() {
  assert.deepEqual(Object.keys(codexHooks().hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  assert.deepEqual(Object.keys(claudeSettings().hooks).sort(), ["SessionStart", "UserPromptSubmit"]);
  process.stdout.write("P7 real bridge smoke self-test: PASS\n");
}

async function main() {
  const { spaceId } = projectBinding();
  const temporaryRoot = mkdtempSync(join(tmpdir(), "memory-space-p7-real-smoke-"));
  const workspace = mkdtempSync(join(repositoryRoot, ".p7-real-smoke-workspace-"));
  const databasePath = join(temporaryRoot, "memory-space.db");
  const hookLogPath = join(temporaryRoot, "hook-events.jsonl");
  const claudeSettingsPath = join(temporaryRoot, "claude-settings.json");
  const projectCodexDirectory = join(repositoryRoot, ".codex");
  const projectHookPath = join(projectCodexDirectory, "hooks.json");
  const createdCodexDirectory = !existsSync(projectCodexDirectory);
  const expectedHookText = `${JSON.stringify(codexHooks(), null, 2)}\n`;
  let daemon;
  let completed = false;
  try {
    mkdirSync(join(workspace, ".memory-space"));
    writeJson(join(workspace, ".memory-space", "config.json"), {
      version: 1,
      spaceId,
      implicitRecall: { mode: "lexical" }
    });
    writeJson(join(workspace, "package.json"), {
      private: true,
      dependencies: { react: "19.0.0" }
    });
    if (!createdCodexDirectory) {
      const stat = lstatSync(projectCodexDirectory);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    }
    assert.equal(existsSync(projectHookPath), false,
      "Refusing to replace an existing project .codex/hooks.json");
    mkdirSync(projectCodexDirectory, { recursive: true });
    writeFileSync(projectHookPath, expectedHookText);
    writeJson(claudeSettingsPath, claudeSettings());
    writeFileSync(hookLogPath, "");
    runSync("codex", ["login", "status"]);
    runSync("claude", ["auth", "status"]);
    const codexVersion = runSync("codex", ["--version"]).replace(/^codex-cli\s+/u, "");
    const claudeVersion = runSync("claude", ["--version"]);

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const environment = {
      ...process.env,
      MEMORY_SPACE_CODEX_HOOK_URL: `${baseUrl}/providers/codex/lifecycle`,
      MEMORY_SPACE_CLAUDE_CODE_HOOK_URL: `${baseUrl}/providers/claude-code/lifecycle`,
      MEMORY_SPACE_P7_BRIDGE_HOOK_LOG: hookLogPath,
      MEMORY_SPACE_HOOK_TIMEOUT_MS: "8000",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      MAX_THINKING_TOKENS: "0"
    };
    daemon = spawn("pnpm", ["start"], {
      cwd: repositoryRoot,
      env: {
        ...environment,
        MEMORY_SPACE_DB: databasePath,
        MEMORY_SPACE_HOST: "127.0.0.1",
        MEMORY_SPACE_PORT: String(port),
        MEMORY_SPACE_CWD: workspace
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForHealth(baseUrl, daemon);
    await jsonRequest(`${baseUrl}/spaces`, {
      method: "POST",
      body: JSON.stringify({ id: spaceId, name: "P7 Real Bridge Smoke" })
    });
    const source = await jsonRequest(`${baseUrl}/spaces/${spaceId}/sessions`, {
      method: "POST",
      body: JSON.stringify({ provider: "p7-smoke-seed", agentId: "validation" })
    });
    const seeded = await jsonRequest(`${baseUrl}/spaces/${spaceId}/memories`, {
      method: "POST",
      body: JSON.stringify({
        sourceSessionId: source.id,
        family: "knowledge",
        type: "fact",
        key: memoryKey,
        content: memoryContent
      })
    });
    await jsonRequest(`${baseUrl}/spaces/${spaceId}/memories`, {
      method: "POST",
      body: JSON.stringify({
        sourceSessionId: source.id,
        family: "knowledge",
        type: "fact",
        key: "upload.variant.types",
        content: lexicalContent
      })
    });
    await jsonRequest(`${baseUrl}/spaces/${spaceId}/memories`, {
      method: "POST",
      body: JSON.stringify({
        sourceSessionId: source.id,
        family: "knowledge",
        type: "fact",
        key: "project.react.version",
        content: staleContent
      })
    });

    const scenarios = [
      {
        id: "bare-key",
        prompt: memoryKey,
        contextPatterns: [new RegExp(memoryValue, "u"), /complete user prompt matched a durable Memory key/iu],
        answerPatterns: [new RegExp(memoryValue, "u")]
      },
      {
        id: "natural-lexical",
        prompt: "上传模块的 variant 有什么类型？",
        contextPatterns: [/a、b、c/u],
        answerPatterns: [/a/u, /b/u, /c/u]
      },
      {
        id: "stale-conflict",
        prompt: `当前项目使用的 React 版本是什么？请读取 ${join(workspace, "package.json")}，并指出历史记忆与当前文件是否冲突。`,
        contextPatterns: [/React 18/u],
        answerPatterns: [/19/u, /18/u, /冲突|历史|stale|conflict|outdated|旧/iu],
        tools: "Read",
        maxTurns: "3"
      },
      {
        id: "opt-out",
        prompt: "不要使用之前的记忆回答。上传模块的 variant 有什么类型？",
        contextPatterns: [/disabled Memory Space reads/iu],
        contextForbiddenPatterns: [/a、b、c|lavender-731|React 18/u],
        answerPatterns: [/.+/u],
        answerForbiddenPatterns: [/lavender-731|a、b、c/u]
      }
    ];
    const results = { codex: {}, claudeCode: {} };
    let stage = 0;
    const totalStages = scenarios.length * 2;
    for (const provider of ["codex", "claude"]) {
      for (const scenario of scenarios) {
        stage += 1;
        const label = provider === "codex" ? "Codex" : "Claude Code";
        process.stderr.write(`[P7 real smoke ${stage}/${totalStages}] START ${label} ${scenario.id}\n`);
        writeFileSync(hookLogPath, "");
        const answer = provider === "codex"
          ? await runCodex(workspace, environment, temporaryRoot, scenario)
          : await runClaude(workspace, claudeSettingsPath, environment, temporaryRoot, scenario);
        const records = parseHookRecords(hookLogPath)
          .filter((item) => item.provider === provider);
        const context = userPromptContext(records, scenario);
        assert.doesNotMatch(context, new RegExp(seeded.id, "u"));
        const target = provider === "codex" ? results.codex : results.claudeCode;
        target[scenario.id] = {
          hookContext: "PASS",
          answer,
          explicitMemoryToolCall: false
        };
        process.stderr.write(`[P7 real smoke ${stage}/${totalStages}] PASS ${label} ${scenario.id}\n`);
      }
    }

    process.stdout.write(`P7_REAL_BRIDGE_RESULT=${JSON.stringify({
      memorySpaceCommit: runSync("git", ["rev-parse", "HEAD"]),
      sourceTree: "working-tree",
      codexVersion,
      claudeVersion,
      results,
      overall: "PASS"
    })}\n`);
    completed = true;
  } finally {
    if (daemon) await stopProcess(daemon);
    if (existsSync(projectHookPath)
      && readFileSync(projectHookPath, "utf8") === expectedHookText) {
      rmSync(projectHookPath);
    } else if (existsSync(projectHookPath)) {
      process.stderr.write(`Preserved changed project hook file: ${projectHookPath}\n`);
    }
    if (createdCodexDirectory
      && existsSync(projectCodexDirectory)
      && readdirSync(projectCodexDirectory).length === 0) {
      rmdirSync(projectCodexDirectory);
    }
    if (completed) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    } else {
      process.stderr.write(`P7 real smoke artifacts preserved at ${temporaryRoot}\n`);
      process.stderr.write(`P7 real smoke workspace preserved at ${workspace}\n`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === "--hook") await relayHook(process.argv[3]);
  else if (process.argv.includes("--self-test")) selfTest();
  else await main();
}
