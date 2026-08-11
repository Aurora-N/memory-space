import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const scriptPath = fileURLToPath(import.meta.url);
const smokeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());
const spaceId = "claude-p3-real-smoke";
const bootstrapSeed = "Claude Code P3 real smoke bootstrap seed 2026-08-11";
const indexedDetail = "Claude P3 indexed-only detail: recall-token-20260811-real-cli";
const handoffMarker = "真实 Claude Code CLI P3 smoke handoff";
const nextStepMarker = "真实 Claude compact checkpoint";
const smokeStepCount = 8;

function smokeMode(args) {
  return args.includes("--hooks-only") ? "hooks-only" : "full";
}

function createProgressReporter(mode) {
  const startedAt = Date.now();
  const label = mode === "hooks-only" ? "Claude P3 Hook Smoke" : "Claude P3 Smoke";
  const emit = (step, status, message) => {
    const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    process.stderr.write(
      `[${label} ${step}/${smokeStepCount} +${elapsedSeconds}s] ${status} ${message}\n`
    );
  };
  const runStage = async (step, message, action, options = {}) => {
    emit(step, "START", message);
    const heartbeat = options.heartbeat === false ? undefined : setInterval(() => {
      emit(step, "WAIT", `${message}（仍在运行）`);
    }, 20_000);
    try {
      const result = await action();
      emit(step, "PASS", message);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
      emit(step, "FAIL", `${message}: ${detail}`);
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  };
  return { emit, runStage };
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    ...options
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function claudeInvocation(args) {
  const packageVersion = process.env.MEMORY_SPACE_CLAUDE_PACKAGE_VERSION;
  if (!packageVersion) return { command: "claude", args };
  assert.match(
    packageVersion,
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
    "MEMORY_SPACE_CLAUDE_PACKAGE_VERSION must be an exact semver"
  );
  return {
    command: "corepack",
    args: [
      "pnpm",
      "--silent",
      "dlx",
      `@anthropic-ai/claude-code@${packageVersion}`,
      ...args
    ]
  };
}

function runClaudeSync(args, options = {}) {
  const invocation = claudeInvocation(args);
  return runSync(invocation.command, invocation.args, options);
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
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();

  let timer;
  const timeoutMs = options.timeoutMs ?? 360_000;
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

async function freeLoopbackPort() {
  const server = createServer();
  return await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? rejectPromise(error) : resolvePromise(port));
    });
  });
}

async function waitForHealth(baseUrl, daemon) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with ${daemon.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("daemon health check timed out");
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

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookSettings() {
  const command = [process.execPath, scriptPath, "--hook"].map(shellQuote).join(" ");
  const hook = { type: "command", command, timeout: 8 };
  return {
    hooks: {
      SessionStart: [{
        matcher: "startup|resume|clear|compact|fork",
        hooks: [hook]
      }],
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      PreCompact: [{ matcher: "manual|auto", hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }]
    }
  };
}

function mcpConfig(mcpUrl) {
  return {
    mcpServers: {
      memory_space: {
        type: "http",
        url: mcpUrl
      }
    }
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(path) {
  const result = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function implementationDigest() {
  const paths = [
    ...walkFiles(join(repositoryRoot, "src")),
    join(repositoryRoot, "package.json"),
    scriptPath
  ].sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path.slice(repositoryRoot.length + 1));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validatePrerequisites() {
  const commit = runSync("git", ["rev-parse", "HEAD"]);
  const sourceStatus = runSync("git", ["status", "--short", "--", "src", "package.json", scriptPath]);
  const sourceDigest = implementationDigest();
  const claudeVersion = runClaudeSync(["--version"]);
  const versionMatch = claudeVersion.match(/^(\d+)\.(\d+)\.(\d+)/u);
  assert.ok(versionMatch, `Could not parse Claude Code version: ${claudeVersion}`);
  const numericVersion = versionMatch.slice(1).map(Number);
  const supportsReliableStop = numericVersion[0] > 2
    || (numericVersion[0] === 2 && numericVersion[1] > 1)
    || (numericVersion[0] === 2 && numericVersion[1] === 1
      && numericVersion[2] >= 47);
  assert.ok(
    supportsReliableStop,
    "Claude Code >= 2.1.47 is required because older Stop payloads lack last_assistant_message"
  );
  runClaudeSync(["auth", "status"], { timeout: 30_000 });
  const platform = `${process.platform} ${runSync("uname", ["-r"])} (${process.arch})`;
  return { commit, sourceStatus, sourceDigest, claudeVersion, platform };
}

function jsonLines(value) {
  return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function resultEvent(records) {
  const result = records.findLast((record) => record.type === "result");
  assert.ok(result, "Claude stream did not contain a result event");
  return result;
}

function plainJsonOutput(records) {
  const result = resultEvent(records).result;
  assert.equal(typeof result, "string", "Claude result lacked final assistant text");
  try {
    const output = JSON.parse(result);
    assert.ok(output && typeof output === "object" && !Array.isArray(output));
    return output;
  } catch (error) {
    throw new Error("Claude final response was not a plain JSON object", { cause: error });
  }
}

function assertClaudeMcpCall(records, toolName) {
  const serialized = JSON.stringify(records);
  if (/No such tool available: mcp_memory_space_memory_/u.test(serialized)) {
    throw new Error([
      "Claude backend normalized MCP double-underscore tool names incompatibly.",
      "Use first-party Anthropic authentication or a gateway that preserves Claude MCP tool names."
    ].join(" "));
  }
  assert.match(
    serialized,
    new RegExp(`mcp__memory_space__${toolName}`, "u"),
    `Claude stream did not record ${toolName}`
  );
}

function hookRecords(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function hookOutput(record) {
  return record.stdout === "" ? undefined : JSON.parse(record.stdout);
}

function memorySessionFrom(record) {
  const context = hookOutput(record)?.hookSpecificOutput?.additionalContext;
  assert.equal(typeof context, "string", "SessionStart did not inject additionalContext");
  const match = context.match(/Session: ([0-9a-f-]+)/u);
  assert.ok(match, "SessionStart context did not contain a Memory Session handle");
  return { id: match[1], context };
}

function claudeArgs(options) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-hook-events",
    "--settings", options.settingsPath,
    "--setting-sources", "",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools", "",
    "--permission-mode", "bypassPermissions",
    "--max-turns", "8",
    "--max-budget-usd", process.env.MEMORY_SPACE_CLAUDE_MAX_BUDGET_USD ?? "3"
  ];
  if (options.mcpPath) {
    args.push(
      "--strict-mcp-config",
      "--mcp-config", options.mcpPath,
      "--allowedTools", [
        "mcp__memory_space__memory_remember",
        "mcp__memory_space__memory_search"
      ].join(",")
    );
  } else {
    args.push("--strict-mcp-config");
  }
  if (options.resumeId) args.push("--resume", options.resumeId);
  else args.push("--session-id", options.sessionId);
  if (process.env.MEMORY_SPACE_CLAUDE_MODEL) {
    args.push("--model", process.env.MEMORY_SPACE_CLAUDE_MODEL);
  }
  if (options.noSessionPersistence) args.push("--no-session-persistence");
  args.push(options.prompt);
  return args;
}

async function runClaude(options) {
  const args = claudeArgs(options);
  const invocation = claudeInvocation(args);
  const result = await run(invocation.command, invocation.args, {
    cwd: options.workspace,
    env: options.env,
    timeoutMs: 420_000
  });
  writeFileSync(options.artifactPath, result.stdout);
  writeFileSync(`${options.artifactPath}.stderr.log`, result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return jsonLines(result.stdout);
}

function scopedResult(mode) {
  const hooksOnly = mode === "hooks-only";
  return {
    results: {
      sessionStartBootstrap: "PASS",
      mcpConnection: hooksOnly ? "SKIPPED" : "PASS",
      sharedMemoryRememberSearch: hooksOnly ? "SKIPPED" : "PASS",
      userPromptSubmitCapture: "PASS",
      stopCapture: "PASS",
      preCompactCheckpoint: "PASS",
      sessionStartCompactSameSession: "PASS",
      resumeSameSession: "PASS",
      sessionEndCheckpoint: "PASS",
      newSessionLatestHandoff: "PASS",
      indexedDetailExplicitRecall: hooksOnly ? "SKIPPED" : "PASS",
      daemonUnavailableLifecycleFailOpen: "PASS"
    },
    p3FreezeEligible: !hooksOnly,
    overall: "PASS"
  };
}

async function main(options = {}) {
  const mode = options.mode ?? "full";
  const hooksOnly = mode === "hooks-only";
  const progress = createProgressReporter(mode);
  const prerequisites = await progress.runStage(
    1,
    "检查源码指纹、Claude CLI 版本和认证状态",
    async () => validatePrerequisites(),
    { heartbeat: false }
  );
  const temporaryRoot = mkdtempSync(join(
    tmpdir(),
    hooksOnly
      ? "memory-space-claude-p3-hook-smoke-"
      : "memory-space-claude-p3-smoke-"
  ));
  const workspace = join(temporaryRoot, "workspace");
  const databasePath = join(temporaryRoot, "memory-space.db");
  const settingsPath = join(temporaryRoot, "claude-settings.json");
  const mcpPath = join(temporaryRoot, "mcp.json");
  const hookLogPath = join(temporaryRoot, "hook-events.jsonl");
  const daemonLog = [];
  let daemon;
  let completed = false;

  try {
    const { baseUrl, smokeEnvironment } = await progress.runStage(
      2,
      hooksOnly
        ? "准备隔离 settings/SQLite，启动 loopback daemon 并写入 bootstrap seed"
        : "准备隔离 settings/MCP/SQLite，启动 loopback daemon 并写入 bootstrap seed",
      async () => {
        mkdirSync(join(workspace, ".memory-space"), { recursive: true });
        writeJson(join(workspace, ".memory-space", "config.json"), {
          version: 1,
          spaceId
        });
        writeJson(settingsPath, hookSettings());
        writeFileSync(hookLogPath, "");

        const port = await freeLoopbackPort();
        const nextBaseUrl = `http://127.0.0.1:${port}`;
        if (!hooksOnly) writeJson(mcpPath, mcpConfig(`${nextBaseUrl}/mcp`));
        const nextSmokeEnvironment = {
          ...process.env,
          MEMORY_SPACE_CLAUDE_CODE_HOOK_URL:
            `${nextBaseUrl}/providers/claude-code/lifecycle`,
          MEMORY_SPACE_SMOKE_HOOK_LOG: hookLogPath,
          CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
          MAX_THINKING_TOKENS: "0",
          NODE_NO_WARNINGS: "1"
        };

        daemon = spawn("pnpm", ["start"], {
          cwd: repositoryRoot,
          env: {
            ...nextSmokeEnvironment,
            MEMORY_SPACE_DB: databasePath,
            MEMORY_SPACE_HOST: "127.0.0.1",
            MEMORY_SPACE_PORT: String(port),
            MEMORY_SPACE_CWD: workspace
          },
          stdio: ["ignore", "pipe", "pipe"]
        });
        daemon.stdout.setEncoding("utf8");
        daemon.stderr.setEncoding("utf8");
        daemon.stdout.on("data", (chunk) => daemonLog.push(chunk));
        daemon.stderr.on("data", (chunk) => daemonLog.push(chunk));
        await waitForHealth(nextBaseUrl, daemon);

        await jsonRequest(`${nextBaseUrl}/spaces`, {
          method: "POST",
          body: JSON.stringify({ id: spaceId, name: "Claude P3 Real Smoke" })
        });
        const seedSession = await jsonRequest(`${nextBaseUrl}/spaces/${spaceId}/sessions`, {
          method: "POST",
          body: JSON.stringify({ provider: "smoke-seed", agentId: "validation" })
        });
        const seedMemory = await jsonRequest(`${nextBaseUrl}/spaces/${spaceId}/memories`, {
          method: "POST",
          body: JSON.stringify({
            sourceSessionId: seedSession.id,
            family: "state",
            type: "goal",
            key: "validation.claude_p3.bootstrap_seed",
            content: bootstrapSeed
          })
        });
        await jsonRequest(`${nextBaseUrl}/memories/${seedMemory.id}/promote`, {
          method: "POST",
          body: JSON.stringify({ reason: "Real Claude bootstrap smoke seed" })
        });
        return { baseUrl: nextBaseUrl, smokeEnvironment: nextSmokeEnvironment };
      },
      { heartbeat: false }
    );

    const firstClaudeSession = randomUUID();
    const firstMarker = hooksOnly
      ? "FIRST_REAL_CLAUDE_HOOK_PASS"
      : "FIRST_REAL_CLAUDE_PASS";
    const firstPrompt = hooksOnly
      ? [
        "Run a controlled Memory Space P3 hook-only smoke test.",
        "Do not edit files, run shell commands, or call tools.",
        "Read the opaque Memory Space Session handle injected at startup.",
        "Your final response must be exactly one valid JSON object with no Markdown:",
        `captured=true, marker=${firstMarker}, and memorySession equal to the injected handle.`,
        "",
        `目标：${handoffMarker}`,
        "决定：Claude P3 hook-only smoke 使用真实 Claude Code CLI",
        `下一步：${nextStepMarker}`
      ].join("\n")
      : [
        "Run a controlled Memory Space P3 smoke test. Do not edit files and do not run shell commands.",
        "Use the opaque Memory Space Session handle injected at startup.",
        `Call memory_remember exactly once to save this exact Indexed fact: ${indexedDetail}`,
        "Use family=knowledge and type=fact. Do not promote it.",
        "Then call memory_search with the same Session handle and verify that exact fact is returned.",
        "Your final response must be exactly one valid JSON object with no Markdown:",
        `remembered=true, searchFound=true, marker=${firstMarker},`,
        "and memorySession equal to the injected handle.",
        "",
        `目标：${handoffMarker}`,
        "决定：Claude P3 smoke 使用真实 Claude Code CLI",
        `下一步：${nextStepMarker}`
      ].join("\n");
    const { firstOutput } = await progress.runStage(
      3,
      hooksOnly
        ? "运行 Session A：验证 bootstrap、UserPromptSubmit、Stop 和 SessionEnd"
        : "运行 Session A：验证 bootstrap、MCP、memory_remember/search 和 turn capture",
      async () => {
        const records = await runClaude({
          workspace,
          sessionId: firstClaudeSession,
          mcpPath: hooksOnly ? undefined : mcpPath,
          settingsPath,
          prompt: firstPrompt,
          env: smokeEnvironment,
          artifactPath: join(temporaryRoot, "first.events.jsonl")
        });
        if (!hooksOnly) {
          assertClaudeMcpCall(records, "memory_remember");
          assertClaudeMcpCall(records, "memory_search");
        }
        const output = plainJsonOutput(records);
        if (hooksOnly) assert.equal(output.captured, true);
        else {
          assert.equal(output.remembered, true);
          assert.equal(output.searchFound, true);
        }
        assert.equal(output.marker, firstMarker);
        return { firstOutput: output };
      }
    );

    const resumePrompt = [
      "Continue the controlled smoke without editing files or calling tools.",
      "Your final response must be exactly one valid JSON object with no Markdown:",
      "continued=true, marker=RESUME_REAL_CLAUDE_PASS, and memorySession equal to",
      "the injected Memory Session handle.",
      `目标：${handoffMarker}`,
      `下一步：${nextStepMarker}`,
      "The remaining inert filler is only to cross the automatic compaction threshold.",
      "claude-compact-smoke-filler ".repeat(1_200)
    ].join("\n");
    const { resumeOutput } = await progress.runStage(
      4,
      "恢复 Session A 并触发 auto compact，验证 PreCompact/SessionStart(compact)",
      async () => {
        if (hooksOnly) {
          for (const turn of [1, 2]) {
            const marker = `COMPACT_WARMUP_${turn}_PASS`;
            const records = await runClaude({
              workspace,
              resumeId: firstClaudeSession,
              settingsPath,
              prompt: [
                `Accumulate completed conversation group ${turn} for the hook-only compact smoke.`,
                "Do not edit files, run shell commands, or call tools.",
                "Return exactly one valid JSON object with no Markdown:",
                `continued=true, marker=${marker}, and memorySession equal to the injected handle.`
              ].join("\n"),
              env: smokeEnvironment,
              artifactPath: join(temporaryRoot, `compact-warmup-${turn}.events.jsonl`)
            });
            const output = plainJsonOutput(records);
            assert.equal(output.continued, true);
            assert.equal(output.marker, marker);
            assert.equal(output.memorySession, firstOutput.memorySession);
          }
        }
        const records = await runClaude({
          workspace,
          resumeId: firstClaudeSession,
          mcpPath: hooksOnly ? undefined : mcpPath,
          settingsPath,
          prompt: resumePrompt,
          env: {
            ...smokeEnvironment,
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "20000"
          },
          artifactPath: join(temporaryRoot, "resume.events.jsonl")
        });
        const output = plainJsonOutput(records);
        assert.equal(output.continued, true);
        assert.equal(output.marker, "RESUME_REAL_CLAUDE_PASS");
        return { resumeOutput: output };
      }
    );

    const { initialMemory, resumedMemory, compactMemory } = await progress.runStage(
      5,
      "核对原生 hooks、Session 复用、PreCompact、SessionEnd、事件与 Handoff",
      async () => {
        const records = hookRecords(hookLogPath);
        const sessionRecords = records.filter(
          (record) => record.input.session_id === firstClaudeSession
        );
        const starts = sessionRecords.filter(
          (record) => record.input.hook_event_name === "SessionStart"
        );
        const startup = starts.find((record) => record.input.source === "startup");
        const resume = starts.find((record) => record.input.source === "resume");
        const compact = starts.find((record) => record.input.source === "compact");
        const preCompact = sessionRecords.find(
          (record) => record.input.hook_event_name === "PreCompact"
        );
        const sessionEnd = sessionRecords.find(
          (record) => record.input.hook_event_name === "SessionEnd"
        );
        assert.ok(startup, "real Claude startup SessionStart hook was not observed");
        assert.ok(resume, "real Claude resume SessionStart hook was not observed");
        assert.ok(preCompact, "real Claude PreCompact hook was not observed");
        assert.ok(compact, "real Claude compact SessionStart hook was not observed");
        assert.ok(sessionEnd, "real Claude SessionEnd hook was not observed");
        const nextInitialMemory = memorySessionFrom(startup);
        const nextResumedMemory = memorySessionFrom(resume);
        const nextCompactMemory = memorySessionFrom(compact);
        assert.equal(nextInitialMemory.id, nextResumedMemory.id);
        assert.equal(nextInitialMemory.id, nextCompactMemory.id);
        assert.equal(firstOutput.memorySession, nextInitialMemory.id);
        assert.equal(resumeOutput.memorySession, nextInitialMemory.id);
        assert.match(nextInitialMemory.context, new RegExp(bootstrapSeed, "u"));

        const firstSession = await jsonRequest(
          `${baseUrl}/sessions/${nextInitialMemory.id}`
        );
        const events = await jsonRequest(
          `${baseUrl}/sessions/${nextInitialMemory.id}/events`
        );
        assert.ok(firstSession.lastCheckpointEventId,
          "real Claude lifecycle did not advance a checkpoint boundary");
        assert.ok(events.some((event) => event.payload?.role === "user"
          && event.payload?.content === firstPrompt),
        "UserPromptSubmit content was not captured exactly");
        assert.ok(events.some((event) => event.payload?.role === "assistant"
          && String(event.payload?.content).includes(firstMarker)),
        "Stop assistant content was not captured");
        assert.ok(events.every((event) => event.payload?.transcriptRef?.provider
          === "claude-code"), "Claude TranscriptRef provenance was not preserved");

        if (!hooksOnly) {
          const remembered = await jsonRequest(
            `${baseUrl}/spaces/${spaceId}/memories/search?query=${encodeURIComponent(indexedDetail)}`
          );
          assert.ok(remembered.some((entry) => entry.memory?.content === indexedDetail
            && entry.memory?.tier === "indexed"));
        }
        const handoff = await jsonRequest(`${baseUrl}/spaces/${spaceId}/handoff/latest`);
        assert.equal(handoff.sessionId, nextInitialMemory.id);
        assert.ok(JSON.stringify(handoff).includes(handoffMarker)
          || JSON.stringify(handoff).includes(nextStepMarker));
        return {
          initialMemory: nextInitialMemory,
          resumedMemory: nextResumedMemory,
          compactMemory: nextCompactMemory
        };
      },
      { heartbeat: false }
    );

    const secondClaudeSession = randomUUID();
    const secondMarker = hooksOnly
      ? "SECOND_REAL_CLAUDE_HOOK_PASS"
      : "SECOND_REAL_CLAUDE_PASS";
    const secondPrompt = hooksOnly
      ? [
        "Run the second-session half of the controlled Memory Space hook-only smoke.",
        "Do not edit files, run shell commands, or call tools.",
        `Confirm startup Handoff contains '${handoffMarker}' or '${nextStepMarker}'.`,
        "Your final response must be exactly one valid JSON object with no Markdown, with",
        `handoffSeen=true, marker=${secondMarker}, and memorySession equal to the new injected handle.`
      ].join("\n")
      : [
        "Run the second-session half of the controlled Memory Space smoke.",
        "Do not edit files and do not run shell commands.",
        `Confirm startup Handoff contains '${handoffMarker}' or '${nextStepMarker}'.`,
        `Confirm startup bootstrap does not contain Indexed-only detail '${indexedDetail}'.`,
        "Call memory_search with the newly injected Session handle and explicitly recall it.",
        "Your final response must be exactly one valid JSON object with no Markdown, with handoffSeen=true,",
        `indexedAbsentFromBootstrap=true, recallFound=true, marker=${secondMarker},`,
        "and memorySession equal to the new injected handle."
      ].join("\n");
    const { secondMemory } = await progress.runStage(
      6,
      hooksOnly
        ? "运行 Session B：验证新 Session 接收最新 Handoff"
        : "运行 Session B：验证最新 Handoff、Indexed 渐进披露与显式 recall",
      async () => {
        const records = await runClaude({
          workspace,
          sessionId: secondClaudeSession,
          mcpPath: hooksOnly ? undefined : mcpPath,
          settingsPath,
          prompt: secondPrompt,
          env: smokeEnvironment,
          artifactPath: join(temporaryRoot, "second.events.jsonl")
        });
        if (!hooksOnly) assertClaudeMcpCall(records, "memory_search");
        const output = plainJsonOutput(records);
        assert.equal(output.handoffSeen, true);
        if (!hooksOnly) {
          assert.equal(output.indexedAbsentFromBootstrap, true);
          assert.equal(output.recallFound, true);
        }
        assert.equal(output.marker, secondMarker);
        const start = hookRecords(hookLogPath).find(
          (record) => record.input.session_id === secondClaudeSession
            && record.input.hook_event_name === "SessionStart"
            && record.input.source === "startup"
        );
        assert.ok(start, "second real Claude startup hook was not observed");
        const memory = memorySessionFrom(start);
        assert.notEqual(memory.id, initialMemory.id);
        assert.equal(output.memorySession, memory.id);
        assert.ok(memory.context.includes(handoffMarker)
          || memory.context.includes(nextStepMarker));
        if (!hooksOnly) assert.ok(!memory.context.includes(indexedDetail));
        return { secondMemory: memory };
      }
    );

    await progress.runStage(
      7,
      "停止 daemon 后运行新 Session，验证 lifecycle fail-open",
      async () => {
        await stopProcess(daemon);
        daemon = undefined;
        const unavailableClaudeSession = randomUUID();
        const records = await runClaude({
          workspace,
          sessionId: unavailableClaudeSession,
          settingsPath,
          prompt: [
            "Memory Space is intentionally unavailable for a fail-open smoke test.",
            "Do not edit files or call tools. Continue normally and return the required",
            "final JSON object with continued=true and marker=DAEMON_FAIL_OPEN_PASS."
          ].join("\n"),
          env: smokeEnvironment,
          noSessionPersistence: true,
          artifactPath: join(temporaryRoot, "unavailable.events.jsonl")
        });
        const output = plainJsonOutput(records);
        assert.equal(output.continued, true);
        assert.equal(output.marker, "DAEMON_FAIL_OPEN_PASS");
        const start = hookRecords(hookLogPath).find(
          (record) => record.input.session_id === unavailableClaudeSession
            && record.input.hook_event_name === "SessionStart"
        );
        assert.ok(start, "daemon-unavailable Claude SessionStart was not observed");
        assert.match(
          hookOutput(start)?.systemMessage ?? "",
          /MEMORY_SERVICE_UNAVAILABLE/u
        );
        assert.doesNotMatch(
          JSON.stringify(hookOutput(start)),
          /ECONNREFUSED|127\.0\.0\.1|memory-space\.db/u
        );
      }
    );

    progress.emit(
      8,
      "START",
      hooksOnly
        ? "汇总 hook-only 断言并输出机器可读结果"
        : "汇总全部断言并输出机器可读结果"
    );
    const result = {
      mode,
      date: smokeDate,
      memorySpaceCommit: prerequisites.commit,
      implementationSha256: prerequisites.sourceDigest,
      sourceTreeStatus: prerequisites.sourceStatus === "" ? "clean" : "working-tree",
      claudeVersion: prerequisites.claudeVersion,
      platform: prerequisites.platform,
      initialMemorySession: initialMemory.id,
      resumedMemorySession: resumedMemory.id,
      compactMemorySession: compactMemory.id,
      secondMemorySession: secondMemory.id,
      initialClaudeSession: firstClaudeSession,
      secondClaudeSession,
      ...scopedResult(mode)
    };
    const resultName = hooksOnly
      ? "CLAUDE_P3_HOOK_SMOKE_RESULT"
      : "CLAUDE_P3_SMOKE_RESULT";
    process.stdout.write(`${resultName}=${JSON.stringify(result)}\n`);
    completed = true;
    progress.emit(
      8,
      "PASS",
      hooksOnly
        ? "hook-only 检查通过，MCP 已跳过；临时数据将在退出前清理"
        : "全部检查通过；临时数据将在退出前清理"
    );
  } finally {
    if (daemon) await stopProcess(daemon);
    if (completed) rmSync(temporaryRoot, { recursive: true, force: true });
    else {
      appendFileSync(join(temporaryRoot, "daemon.log"), daemonLog.join(""));
      process.stderr.write(`Smoke artifacts preserved at ${temporaryRoot}\n`);
    }
  }
}

async function relaySmokeHook() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks).toString("utf8");
  const child = spawnSync(
    "pnpm",
    ["--dir", repositoryRoot, "--silent", "claude-code:hook"],
    {
      input,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    }
  );
  if (process.env.MEMORY_SPACE_SMOKE_HOOK_LOG) {
    appendFileSync(process.env.MEMORY_SPACE_SMOKE_HOOK_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      input: JSON.parse(input),
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      exitCode: child.status
    })}\n`);
  }
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  process.exitCode = child.status ?? 1;
}

function selfTest() {
  assert.equal(smokeMode([]), "full");
  assert.equal(smokeMode(["--hooks-only"]), "hooks-only");
  const hookArgs = claudeArgs({
    sessionId: "00000000-0000-4000-8000-000000000001",
    settingsPath: "/tmp/settings.json",
    prompt: "hook-only"
  });
  assert.ok(hookArgs.includes("--strict-mcp-config"));
  assert.ok(!hookArgs.includes("--mcp-config"));
  assert.ok(!hookArgs.includes("--allowedTools"));
  const fullArgs = claudeArgs({
    sessionId: "00000000-0000-4000-8000-000000000002",
    settingsPath: "/tmp/settings.json",
    mcpPath: "/tmp/mcp.json",
    prompt: "full"
  });
  assert.ok(fullArgs.includes("--mcp-config"));
  assert.ok(fullArgs.includes("--allowedTools"));
  assert.equal(scopedResult("hooks-only").results.mcpConnection, "SKIPPED");
  assert.equal(scopedResult("hooks-only").p3FreezeEligible, false);
  assert.equal(scopedResult("full").results.mcpConnection, "PASS");
  assert.equal(scopedResult("full").p3FreezeEligible, true);
  const settings = hookSettings();
  assert.deepEqual(Object.keys(settings.hooks).sort(), [
    "PreCompact",
    "SessionEnd",
    "SessionStart",
    "Stop",
    "UserPromptSubmit"
  ]);
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      assert.equal(group.hooks.length, 1);
      assert.equal(group.hooks[0].type, "command");
      assert.match(group.hooks[0].command, /--hook/u);
      assert.equal(group.hooks[0].timeout, 8);
    }
  }
  assert.deepEqual(mcpConfig("http://127.0.0.1:4310/mcp"), {
    mcpServers: {
      memory_space: {
        type: "http",
        url: "http://127.0.0.1:4310/mcp"
      }
    }
  });
  assert.equal(implementationDigest().length, 64);
  process.stdout.write("Claude P3 smoke runner self-test: PASS\n");
}

function preflight() {
  const facts = validatePrerequisites();
  process.stdout.write([
    "Claude P3 smoke preflight: PASS",
    `Claude Code: ${facts.claudeVersion}`,
    `Source tree: ${facts.sourceStatus === "" ? "clean" : "working-tree"}`,
    `Implementation SHA-256: ${facts.sourceDigest}`
  ].join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--hook")) await relaySmokeHook();
  else if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--preflight")) preflight();
  else await main({ mode: smokeMode(process.argv.slice(2)) });
}
