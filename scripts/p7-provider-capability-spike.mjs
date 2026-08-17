import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const repositoryRoot = resolve(scriptDirectory, "..");
const capabilityMarker = "P7_NATIVE_USER_PROMPT_CONTEXT_20260817";
const expectedAnswer = "P7_USER_PROMPT_CONTEXT_PASS";
const supportedProviders = ["codex", "claude"];

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
  const timeoutMs = options.timeoutMs ?? 300_000;
  const code = await Promise.race([
    new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", resolvePromise);
    }),
    new Promise((_, rejectPromise) => {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));

  return { code, stdout, stderr };
}

function hookCommand(provider) {
  return [process.execPath, scriptPath, "--hook", provider]
    .map(shellQuote)
    .join(" ");
}

function codexHookConfig() {
  return {
    description: "Isolated Memory Space P7 native capability spike",
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: hookCommand("codex"), timeout: 8 }]
      }]
    }
  };
}

function claudeHookSettings() {
  return {
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: "command", command: hookCommand("claude"), timeout: 8 }]
      }]
    }
  };
}

function hookOutput() {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: [
        `Capability marker: ${capabilityMarker}.`,
        `Reply with exactly ${expectedAnswer}.`
      ].join(" ")
    }
  };
}

function safeHookRecord(provider, input, output) {
  const fields = input && typeof input === "object" && !Array.isArray(input)
    ? input
    : {};
  return {
    provider,
    hookEventName: fields.hook_event_name,
    promptObserved: typeof fields.prompt === "string",
    expectedPromptObserved: fields.prompt === capabilityPrompt(),
    output
  };
}

function capabilityPrompt() {
  return [
    "This is an isolated provider hook capability check.",
    "Return P7_USER_PROMPT_CONTEXT_MISSING unless extra developer context instructs you",
    "to return a different exact token.",
    "Do not use tools and do not infer or guess any token not present in this user message."
  ].join(" ");
}

function hookRecords(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertHookEvidence(records, provider) {
  assert.equal(records.length, 1, `${provider} did not invoke UserPromptSubmit exactly once`);
  const [record] = records;
  assert.equal(record.provider, provider);
  assert.equal(record.hookEventName, "UserPromptSubmit");
  assert.equal(record.promptObserved, true);
  assert.equal(record.expectedPromptObserved, true);
  assert.deepEqual(record.output, hookOutput());
}

function claudeResult(stdout) {
  const records = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const result = records.findLast((record) => record.type === "result");
  assert.ok(result, "Claude output did not contain a result event");
  assert.equal(typeof result.result, "string", "Claude result was not text");
  return result.result.trim();
}

async function runCodexSpike(root) {
  const workspace = repositoryRoot;
  const hookLogPath = join(root, "codex-hook.jsonl");
  const lastMessagePath = join(root, "codex-last-message.txt");
  const projectCodexDirectory = join(workspace, ".codex");
  const projectHookPath = join(projectCodexDirectory, "hooks.json");
  const createdDirectory = !existsSync(projectCodexDirectory);
  if (!createdDirectory) {
    const stat = lstatSync(projectCodexDirectory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(),
      "Refusing to use a project .codex path that is not a real directory");
  }
  assert.equal(existsSync(projectHookPath), false,
    "Refusing to replace an existing project .codex/hooks.json");
  mkdirSync(projectCodexDirectory, { recursive: true });
  const expectedHookText = `${JSON.stringify(codexHookConfig(), null, 2)}\n`;
  writeFileSync(projectHookPath, expectedHookText);
  writeFileSync(hookLogPath, "");

  try {
    const version = runSync("codex", ["--version"]).replace(/^codex-cli\s+/u, "");
    runSync("codex", ["login", "status"]);
    const result = await run("codex", [
      "exec",
      "--ignore-rules",
      "--strict-config",
      "--enable", "hooks",
      "--dangerously-bypass-hook-trust",
      "--sandbox", "read-only",
      "--ephemeral",
      "--json",
      "--output-last-message", lastMessagePath,
      "--cd", workspace,
      "-"
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MEMORY_SPACE_P7_CAPABILITY_LOG: hookLogPath
      },
      input: capabilityPrompt()
    });
    writeFileSync(join(root, "codex-events.jsonl"), result.stdout);
    writeFileSync(join(root, "codex-stderr.log"), result.stderr);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const answer = readFileSync(lastMessagePath, "utf8").trim();
    assert.equal(answer, expectedAnswer,
      "Codex did not observe UserPromptSubmit additionalContext");
    const records = hookRecords(hookLogPath);
    assertHookEvidence(records, "codex");
    return { provider: "codex", cliVersion: version, markerObserved: true, answer };
  } finally {
    if (existsSync(projectHookPath)
      && readFileSync(projectHookPath, "utf8") === expectedHookText) {
      rmSync(projectHookPath);
    } else if (existsSync(projectHookPath)) {
      process.stderr.write(`Preserved changed project hook file: ${projectHookPath}\n`);
    }
    if (createdDirectory
      && existsSync(projectCodexDirectory)
      && readdirSync(projectCodexDirectory).length === 0) {
      rmdirSync(projectCodexDirectory);
    }
  }
}

async function runClaudeSpike(root) {
  const workspace = join(root, "claude-workspace");
  const hookLogPath = join(root, "claude-hook.jsonl");
  const settingsPath = join(root, "claude-settings.json");
  mkdirSync(workspace, { recursive: true });
  writeJson(settingsPath, claudeHookSettings());
  writeFileSync(hookLogPath, "");

  const version = runSync("claude", ["--version"]);
  runSync("claude", ["auth", "status"]);
  const result = await run("claude", [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-hook-events",
    "--settings", settingsPath,
    "--setting-sources", "",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools", "",
    "--permission-mode", "bypassPermissions",
    "--max-turns", "1",
    "--max-budget-usd", process.env.MEMORY_SPACE_CLAUDE_MAX_BUDGET_USD ?? "1",
    "--strict-mcp-config",
    "--no-session-persistence",
    capabilityPrompt()
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      MEMORY_SPACE_P7_CAPABILITY_LOG: hookLogPath,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      MAX_THINKING_TOKENS: "0"
    }
  });
  writeFileSync(join(root, "claude-events.jsonl"), result.stdout);
  writeFileSync(join(root, "claude-stderr.log"), result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const answer = claudeResult(result.stdout);
  assert.equal(answer, expectedAnswer, "Claude did not observe UserPromptSubmit additionalContext");
  const records = hookRecords(hookLogPath);
  assertHookEvidence(records, "claude");
  return { provider: "claude-code", cliVersion: version, markerObserved: true, answer };
}

async function relayHook(provider) {
  assert.ok(supportedProviders.includes(provider), `Unsupported hook provider: ${provider}`);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = hookOutput();
  const logPath = process.env.MEMORY_SPACE_P7_CAPABILITY_LOG;
  assert.ok(logPath, "MEMORY_SPACE_P7_CAPABILITY_LOG is required");
  appendFileSync(logPath, `${JSON.stringify(safeHookRecord(provider, input, output))}\n`);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function selectedProviders(args) {
  const index = args.indexOf("--provider");
  if (index === -1) return supportedProviders;
  const provider = args[index + 1];
  assert.ok(supportedProviders.includes(provider), "--provider must be codex or claude");
  return [provider];
}

function selfTest() {
  assert.deepEqual(selectedProviders([]), supportedProviders);
  assert.deepEqual(selectedProviders(["--provider", "codex"]), ["codex"]);
  assert.equal(codexHookConfig().hooks.UserPromptSubmit.length, 1);
  assert.equal(claudeHookSettings().hooks.UserPromptSubmit.length, 1);
  assert.equal(hookOutput().hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const safe = safeHookRecord("codex", {
    hook_event_name: "UserPromptSubmit",
    prompt: capabilityPrompt(),
    secret: "must-not-be-recorded"
  }, hookOutput());
  assert.equal(safe.expectedPromptObserved, true);
  assert.equal("secret" in safe, false);
  process.stdout.write("P7 provider capability spike self-test: PASS\n");
}

async function main(args) {
  const providers = selectedProviders(args);
  const root = mkdtempSync(join(tmpdir(), "memory-space-p7-capability-"));
  let completed = false;
  try {
    const results = [];
    for (const provider of providers) {
      process.stderr.write(`[P7.0A] START ${provider} native UserPromptSubmit context spike\n`);
      const result = provider === "codex"
        ? await runCodexSpike(root)
        : await runClaudeSpike(root);
      results.push(result);
      process.stderr.write(`[P7.0A] PASS ${provider} native UserPromptSubmit context spike\n`);
    }
    process.stdout.write(`P7_PROVIDER_CAPABILITY_RESULT=${JSON.stringify({
      capabilityMarker,
      expectedAnswer,
      results,
      overall: "PASS"
    })}\n`);
    completed = true;
  } finally {
    if (completed) rmSync(root, { recursive: true, force: true });
    else process.stderr.write(`P7.0A artifacts preserved at ${root}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args[0] === "--hook") await relayHook(args[1]);
  else if (args.includes("--self-test")) selfTest();
  else await main(args);
}
