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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const scriptPath = fileURLToPath(import.meta.url);
const smokeHookDescription =
  "Isolated Memory Space Codex P2 real smoke (managed by scripts/codex-p2-real-smoke.mjs)";
const legacySmokeHookDescription = "Isolated Memory Space Codex P2 real smoke";
const smokeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());
const spaceId = "codex-p2-real-smoke";
const bootstrapSeed = "Codex P2 real smoke bootstrap seed 2026-08-11";
const indexedDetail = "Codex P2 indexed-only detail: recall-token-20260811-real-cli";
const handoffMarker = "真实 Codex CLI P2 smoke handoff";
const nextStepMarker = "真实 Codex compact checkpoint";
const smokeStepCount = 8;

function createProgressReporter() {
  const startedAt = Date.now();
  const emit = (step, status, message) => {
    const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    process.stderr.write(
      `[Codex P2 Smoke ${step}/${smokeStepCount} +${elapsedSeconds}s] ${status} ${message}\n`
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
    ...options
  });
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
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();

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
    if (daemon.exitCode !== null) throw new Error(`daemon exited early with ${daemon.exitCode}`);
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
  const text = await response.text();
  assert.ok(response.ok, `${response.status} ${text}`);
  return text === "" ? undefined : JSON.parse(text);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function smokeHookConfig() {
  const hookCommand = [process.execPath, scriptPath, "--hook"].map(shellQuote).join(" ");
  const hook = { type: "command", command: hookCommand, timeout: 8 };
  return {
    description: smokeHookDescription,
    hooks: {
      SessionStart: [{ matcher: "startup|resume|compact", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      PreCompact: [{ matcher: "manual|auto", hooks: [hook] }]
    }
  };
}

function commandHooks(config) {
  if (config === null || typeof config !== "object"
    || config.hooks === null || typeof config.hooks !== "object") return [];
  const commands = [];
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups)) return [];
    for (const group of groups) {
      if (group === null || typeof group !== "object" || !Array.isArray(group.hooks)) return [];
      for (const hook of group.hooks) {
        if (hook?.type !== "command" || typeof hook.command !== "string") return [];
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

function isManagedSmokeHookConfig(config) {
  if (config?.description !== smokeHookDescription
    && config?.description !== legacySmokeHookDescription) return false;
  const eventNames = Object.keys(config.hooks ?? {}).sort();
  if (eventNames.join("\n") !== [
    "PreCompact",
    "SessionStart",
    "Stop",
    "UserPromptSubmit"
  ].join("\n")) return false;

  const commands = commandHooks(config);
  if (commands.length !== 4) return false;
  if (config.description === smokeHookDescription) {
    return commands.every((command) => command.includes(shellQuote(scriptPath))
      && command.endsWith("'--hook'"));
  }
  return commands.every((command) => command.includes(repositoryRoot)
    && command.includes("memory-space-codex-p2-smoke-")
    && command.includes("hook-wrapper.mjs"));
}

function readManagedSmokeHook(path) {
  if (!existsSync(path)) return undefined;
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return isManagedSmokeHookConfig(config) ? config : undefined;
}

function assertProjectHookReplaceable(projectCodexDirectory, projectHookPath) {
  if (existsSync(projectCodexDirectory)) {
    const directoryStat = lstatSync(projectCodexDirectory);
    assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      "Refusing to use a project .codex path that is not a real directory");
  }
  if (!existsSync(projectHookPath)) return;
  const hookStat = lstatSync(projectHookPath);
  assert.ok(hookStat.isFile() && !hookStat.isSymbolicLink(),
    "Refusing to replace a project .codex/hooks.json that is not a regular file");
  assert.ok(readManagedSmokeHook(projectHookPath), [
    "Refusing to replace an existing project .codex/hooks.json that is not owned by this smoke runner.",
    "Move that file aside for the smoke run, then restore it afterwards."
  ].join(" "));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validatePrerequisites(projectCodexDirectory, projectHookPath) {
  assert.equal(process.platform, "darwin", "This recorded P2 smoke is scoped to macOS");
  runSync("git", ["diff", "--quiet", "HEAD", "--", "src"]);
  const commit = runSync("git", ["rev-parse", "HEAD"]);
  const codexVersion = runSync("codex", ["--version"]).replace(/^codex-cli\s+/u, "");
  runSync("codex", ["login", "status"]);
  const macosVersion = runSync("sw_vers", ["-productVersion"]);
  const architecture = runSync("uname", ["-m"]);
  assertProjectHookReplaceable(projectCodexDirectory, projectHookPath);
  return { commit, codexVersion, macosVersion, architecture };
}

function jsonLines(value) {
  return value.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function threadIdFrom(stdout) {
  for (const event of jsonLines(stdout)) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return event.thread_id;
    }
  }
  throw new Error("Codex JSONL did not contain thread.started");
}

function hookRecords(path) {
  const raw = readFileSync(path, "utf8");
  return raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
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

function readLastMessage(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function commonCodexConfig(mcpUrl) {
  return [
    "-c", `mcp_servers.memory_space.url=${JSON.stringify(mcpUrl)}`,
    "-c", "mcp_servers.memory_space.enabled=true",
    "-c", "mcp_servers.memory_space.required=true",
    "-c", "mcp_servers.memory_space.default_tools_approval_mode=\"approve\""
  ];
}

async function runCodexExec(options) {
  const args = ["exec"];
  if (options.resumeId) args.push("resume");
  args.push(
    "--ignore-rules",
    "--strict-config",
    "--enable", "hooks",
    "--dangerously-bypass-hook-trust",
    "--json",
    "--output-schema", options.schemaPath,
    "--output-last-message", options.outputPath
  );
  if (!options.resumeId) {
    args.push("--approve-for-me", "--cd", options.workspace);
  }
  if (options.mcpUrl) args.push(...commonCodexConfig(options.mcpUrl));
  if (options.compactLimit) {
    args.push(
      "-c", "model_context_window=32000",
      "-c", `model_auto_compact_token_limit=${options.compactLimit}`
    );
  }
  if (options.ephemeral) args.push("--ephemeral");
  if (options.resumeId) args.push(options.resumeId);
  args.push("-");

  const result = await run("codex", args, {
    cwd: options.workspace,
    env: options.env,
    input: options.prompt,
    timeoutMs: 360_000
  });
  writeFileSync(`${options.outputPath}.events.jsonl`, result.stdout);
  writeFileSync(`${options.outputPath}.stderr.log`, result.stderr);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result;
}

function assertCodexMcpCall(stdout, toolName) {
  assert.match(stdout, new RegExp(`memory[_\\w]*${toolName.replace("memory_", "")}`, "u"),
    `Codex JSONL did not record ${toolName}`);
}

const resultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memorySession: { type: "string" },
    remembered: { type: "boolean" },
    searchFound: { type: "boolean" },
    marker: { type: "string" }
  },
  required: ["memorySession", "remembered", "searchFound", "marker"]
};

const resumeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memorySession: { type: "string" },
    continued: { type: "boolean" },
    marker: { type: "string" }
  },
  required: ["memorySession", "continued", "marker"]
};

const secondSessionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memorySession: { type: "string" },
    handoffSeen: { type: "boolean" },
    indexedAbsentFromBootstrap: { type: "boolean" },
    recallFound: { type: "boolean" },
    marker: { type: "string" }
  },
  required: [
    "memorySession",
    "handoffSeen",
    "indexedAbsentFromBootstrap",
    "recallFound",
    "marker"
  ]
};

const unavailableSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    continued: { type: "boolean" },
    marker: { type: "string" }
  },
  required: ["continued", "marker"]
};

async function main() {
  const progress = createProgressReporter();
  const workspace = repositoryRoot;
  const projectCodexDirectory = join(workspace, ".codex");
  const projectHookPath = join(projectCodexDirectory, "hooks.json");
  const { commit, codexVersion, macosVersion, architecture } =
    await progress.runStage(
      1,
      "检查平台、源码状态、Codex CLI 登录状态和 project hooks",
      async () => validatePrerequisites(projectCodexDirectory, projectHookPath),
      { heartbeat: false }
    );
  const temporaryRoot = mkdtempSync(join(tmpdir(), "memory-space-codex-p2-smoke-"));
  const databasePath = join(temporaryRoot, "memory-space.db");
  const hookLogPath = join(temporaryRoot, "hook-events.jsonl");
  const daemonLog = [];
  let daemon;
  let completed = false;
  let removeProjectCodexDirectory = false;
  let createdProjectHook = false;

  try {
    const firstSchemaPath = join(temporaryRoot, "first-schema.json");
    const resumeSchemaPath = join(temporaryRoot, "resume-schema.json");
    const secondSchemaPath = join(temporaryRoot, "second-schema.json");
    const unavailableSchemaPath = join(temporaryRoot, "unavailable-schema.json");
    const { baseUrl, mcpUrl, smokeEnvironment } = await progress.runStage(
      2,
      "准备临时 hooks/SQLite，启动 loopback daemon 并写入 bootstrap seed",
      async () => {
        assertProjectHookReplaceable(projectCodexDirectory, projectHookPath);
        const existingManagedHook = readManagedSmokeHook(projectHookPath);
        removeProjectCodexDirectory = !existsSync(projectCodexDirectory)
          || readdirSync(projectCodexDirectory).length === 0
          || (existingManagedHook !== undefined
            && readdirSync(projectCodexDirectory).length === 1);
        mkdirSync(projectCodexDirectory, { recursive: true });
        writeFileSync(hookLogPath, "");
        createdProjectHook = true;
        writeJson(projectHookPath, smokeHookConfig());
        writeJson(firstSchemaPath, resultSchema);
        writeJson(resumeSchemaPath, resumeSchema);
        writeJson(secondSchemaPath, secondSessionSchema);
        writeJson(unavailableSchemaPath, unavailableSchema);

        const port = await freeLoopbackPort();
        const nextBaseUrl = `http://127.0.0.1:${port}`;
        const nextMcpUrl = `${nextBaseUrl}/mcp`;
        const hookUrl = `${nextBaseUrl}/providers/codex/lifecycle`;
        const nextSmokeEnvironment = {
          ...process.env,
          MEMORY_SPACE_CODEX_HOOK_URL: hookUrl,
          MEMORY_SPACE_SMOKE_HOOK_LOG: hookLogPath,
          NODE_NO_WARNINGS: "1"
        };

        daemon = spawn("pnpm", ["start"], {
          cwd: repositoryRoot,
          env: {
            ...nextSmokeEnvironment,
            MEMORY_SPACE_DB: databasePath,
            MEMORY_SPACE_HOST: "127.0.0.1",
            MEMORY_SPACE_PORT: String(port),
            MEMORY_SPACE_SPACE_ID: spaceId,
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
          body: JSON.stringify({ id: spaceId, name: "Codex P2 Real Smoke" })
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
            key: "validation.codex_p2.bootstrap_seed",
            content: bootstrapSeed
          })
        });
        await jsonRequest(`${nextBaseUrl}/memories/${seedMemory.id}/promote`, {
          method: "POST",
          body: JSON.stringify({ reason: "Real Codex bootstrap smoke seed" })
        });
        return {
          baseUrl: nextBaseUrl,
          mcpUrl: nextMcpUrl,
          smokeEnvironment: nextSmokeEnvironment
        };
      },
      { heartbeat: false }
    );

    const firstPrompt = [
      "Run a controlled Memory Space P2 smoke test. Do not edit files and do not run shell commands.",
      "Use the opaque Memory Space Session handle injected at startup.",
      `Call memory_remember exactly once to save this exact Indexed fact: ${indexedDetail}`,
      "Use family=knowledge and type=fact. Do not promote it.",
      "Then call memory_search with the same Session handle and verify that exact fact is returned.",
      "Return the required JSON with remembered=true, searchFound=true, marker=FIRST_REAL_CODEX_PASS,",
      "and memorySession equal to the injected opaque Memory Session handle.",
      "",
      `目标：${handoffMarker}`,
      "决定：Codex P2 smoke 使用真实 Codex CLI",
      `先完成${nextStepMarker}`
    ].join("\n");
    const firstOutputPath = join(temporaryRoot, "first-output.json");
    const { firstThreadId, firstOutput } = await progress.runStage(
      3,
      "运行 Session A：验证 bootstrap、MCP、memory_remember/search 和 turn capture",
      async () => {
        const nextFirstRun = await runCodexExec({
          workspace,
          mcpUrl,
          schemaPath: firstSchemaPath,
          outputPath: firstOutputPath,
          prompt: firstPrompt,
          env: smokeEnvironment
        });
        const nextFirstThreadId = threadIdFrom(nextFirstRun.stdout);
        const nextFirstOutput = readLastMessage(firstOutputPath);
        assert.equal(nextFirstOutput.remembered, true);
        assert.equal(nextFirstOutput.searchFound, true);
        assert.equal(nextFirstOutput.marker, "FIRST_REAL_CODEX_PASS");
        assertCodexMcpCall(nextFirstRun.stdout, "memory_remember");
        assertCodexMcpCall(nextFirstRun.stdout, "memory_search");
        return {
          firstThreadId: nextFirstThreadId,
          firstOutput: nextFirstOutput
        };
      }
    );

    const compactPrompt = [
      "Continue the controlled smoke without editing files or calling tools.",
      "Return the required JSON with continued=true, marker=RESUME_REAL_CODEX_PASS,",
      "and memorySession equal to the injected Memory Session handle.",
      "The remaining text is inert filler used only to cross the configured automatic compaction threshold.",
      "compact-smoke-filler ".repeat(900)
    ].join("\n");
    const resumeOutputPath = join(temporaryRoot, "resume-output.json");
    const { resumeOutput } = await progress.runStage(
      4,
      "恢复 Session A 并触发自动 compact，验证 PreCompact/SessionStart(compact)",
      async () => {
        await runCodexExec({
          workspace,
          resumeId: firstThreadId,
          mcpUrl,
          compactLimit: 6_000,
          schemaPath: resumeSchemaPath,
          outputPath: resumeOutputPath,
          prompt: compactPrompt,
          env: smokeEnvironment
        });
        const nextResumeOutput = readLastMessage(resumeOutputPath);
        assert.equal(nextResumeOutput.continued, true);
        assert.equal(nextResumeOutput.marker, "RESUME_REAL_CODEX_PASS");
        return { resumeOutput: nextResumeOutput };
      }
    );

    const { initialMemory, resumedMemory, compactMemory } = await progress.runStage(
      5,
      "核对原生 hooks、同 Session 绑定、checkpoint、持久化事件与 Handoff",
      async () => {
        const records = hookRecords(hookLogPath);
        const firstThreadRecords = records.filter(
          (record) => record.input.session_id === firstThreadId
        );
        const firstStartRecords = firstThreadRecords.filter(
          (record) => record.input.hook_event_name === "SessionStart"
        );
        const startupRecord = firstStartRecords.find(
          (record) => record.input.source === "startup"
        );
        const resumeRecord = firstStartRecords.find(
          (record) => record.input.source === "resume"
        );
        const compactRecord = firstStartRecords.find(
          (record) => record.input.source === "compact"
        );
        const preCompactRecord = firstThreadRecords.find(
          (record) => record.input.hook_event_name === "PreCompact"
        );
        assert.ok(startupRecord, "real Codex startup SessionStart hook was not observed");
        assert.ok(resumeRecord, "real Codex resume SessionStart hook was not observed");
        assert.ok(preCompactRecord, "real Codex PreCompact hook was not observed");
        assert.ok(compactRecord, "real Codex compact SessionStart hook was not observed");
        const nextInitialMemory = memorySessionFrom(startupRecord);
        const nextResumedMemory = memorySessionFrom(resumeRecord);
        const nextCompactMemory = memorySessionFrom(compactRecord);
        assert.equal(nextInitialMemory.id, nextResumedMemory.id);
        assert.equal(nextInitialMemory.id, nextCompactMemory.id);
        assert.equal(firstOutput.memorySession, nextInitialMemory.id);
        assert.equal(resumeOutput.memorySession, nextInitialMemory.id);
        assert.match(nextInitialMemory.context, new RegExp(bootstrapSeed, "u"));

        const firstSession = await jsonRequest(
          `${baseUrl}/sessions/${nextInitialMemory.id}`
        );
        const firstEvents = await jsonRequest(
          `${baseUrl}/sessions/${nextInitialMemory.id}/events`
        );
        assert.ok(firstSession.lastCheckpointEventId,
          "PreCompact did not advance the checkpoint boundary");
        assert.ok(firstEvents.some((event) => event.payload?.role === "user"
          && event.payload?.content === firstPrompt),
        "UserPromptSubmit content was not captured exactly");
        assert.ok(firstEvents.some((event) => event.payload?.role === "assistant"
          && String(event.payload?.content).includes("FIRST_REAL_CODEX_PASS")),
        "Stop assistant content was not captured");

        const rememberedSearch = await jsonRequest(
          `${baseUrl}/spaces/${spaceId}/memories/search?query=${encodeURIComponent(indexedDetail)}`
        );
        assert.ok(rememberedSearch.some((entry) => entry.memory?.content === indexedDetail
          && entry.memory?.tier === "indexed"));
        const latestHandoff = await jsonRequest(`${baseUrl}/spaces/${spaceId}/handoff/latest`);
        assert.equal(latestHandoff.sessionId, nextInitialMemory.id);
        assert.ok(JSON.stringify(latestHandoff).includes(handoffMarker)
          || JSON.stringify(latestHandoff).includes(nextStepMarker));
        return {
          initialMemory: nextInitialMemory,
          resumedMemory: nextResumedMemory,
          compactMemory: nextCompactMemory
        };
      },
      { heartbeat: false }
    );

    const secondPrompt = [
      "Run the second-session half of the controlled Memory Space smoke. Do not edit files or run shell commands.",
      `Confirm the startup Handoff contains '${handoffMarker}' or '${nextStepMarker}'.`,
      `Confirm the startup bootstrap itself does not contain the Indexed-only detail '${indexedDetail}'.`,
      "Then call memory_search with the newly injected Memory Session handle and explicitly recall that detail.",
      "Return the required JSON with handoffSeen=true, indexedAbsentFromBootstrap=true, recallFound=true,",
      "marker=SECOND_REAL_CODEX_PASS, and memorySession equal to the new injected handle."
    ].join("\n");
    const secondOutputPath = join(temporaryRoot, "second-output.json");
    const { secondThreadId, secondMemory } = await progress.runStage(
      6,
      "运行 Session B：验证最新 Handoff 可见、Indexed 不泄漏且可显式 recall",
      async () => {
        const secondRun = await runCodexExec({
          workspace,
          mcpUrl,
          schemaPath: secondSchemaPath,
          outputPath: secondOutputPath,
          prompt: secondPrompt,
          env: smokeEnvironment
        });
        const nextSecondThreadId = threadIdFrom(secondRun.stdout);
        const secondOutput = readLastMessage(secondOutputPath);
        assert.equal(secondOutput.handoffSeen, true);
        assert.equal(secondOutput.indexedAbsentFromBootstrap, true);
        assert.equal(secondOutput.recallFound, true);
        assert.equal(secondOutput.marker, "SECOND_REAL_CODEX_PASS");
        assertCodexMcpCall(secondRun.stdout, "memory_search");

        const records = hookRecords(hookLogPath);
        const secondStartRecord = records.find(
          (record) => record.input.session_id === nextSecondThreadId
            && record.input.hook_event_name === "SessionStart"
            && record.input.source === "startup"
        );
        assert.ok(secondStartRecord, "second real Codex startup hook was not observed");
        const nextSecondMemory = memorySessionFrom(secondStartRecord);
        assert.notEqual(nextSecondMemory.id, initialMemory.id);
        assert.equal(secondOutput.memorySession, nextSecondMemory.id);
        assert.ok(nextSecondMemory.context.includes(handoffMarker)
          || nextSecondMemory.context.includes(nextStepMarker));
        assert.ok(!nextSecondMemory.context.includes(indexedDetail));
        return {
          secondThreadId: nextSecondThreadId,
          secondMemory: nextSecondMemory
        };
      }
    );

    const unavailableOutputPath = join(temporaryRoot, "unavailable-output.json");
    await progress.runStage(
      7,
      "停止 daemon 后运行新 Session，验证 lifecycle fail-open",
      async () => {
        await stopProcess(daemon);
        daemon = undefined;
        const unavailableRun = await runCodexExec({
          workspace,
          schemaPath: unavailableSchemaPath,
          outputPath: unavailableOutputPath,
          prompt: [
            "The Memory Space daemon is intentionally unavailable for a fail-open smoke test.",
            "Do not edit files or call tools. Continue normally and return the required JSON with",
            "continued=true and marker=DAEMON_FAIL_OPEN_PASS."
          ].join("\n"),
          env: smokeEnvironment,
          ephemeral: true
        });
        const unavailableOutput = readLastMessage(unavailableOutputPath);
        assert.equal(unavailableOutput.continued, true);
        assert.equal(unavailableOutput.marker, "DAEMON_FAIL_OPEN_PASS");
        const unavailableThreadId = threadIdFrom(unavailableRun.stdout);
        const records = hookRecords(hookLogPath);
        const unavailableStart = records.find(
          (record) => record.input.session_id === unavailableThreadId
            && record.input.hook_event_name === "SessionStart"
        );
        assert.ok(unavailableStart, "daemon-unavailable SessionStart hook was not observed");
        assert.match(
          hookOutput(unavailableStart)?.systemMessage ?? "",
          /MEMORY_SERVICE_UNAVAILABLE/u
        );
      }
    );

    progress.emit(8, "START", "汇总全部断言并输出机器可读结果");
    const result = {
      date: smokeDate,
      memorySpaceCommit: commit,
      codexVersion,
      platform: `macOS ${macosVersion} (${architecture})`,
      initialMemorySession: initialMemory.id,
      resumedMemorySession: resumedMemory.id,
      compactMemorySession: compactMemory.id,
      secondMemorySession: secondMemory.id,
      initialCodexSession: firstThreadId,
      secondCodexSession: secondThreadId,
      results: {
        sessionStartBootstrap: "PASS",
        mcpConnection: "PASS",
        memoryRememberSearch: "PASS",
        userPromptSubmitCapture: "PASS",
        stopCapture: "PASS",
        preCompactCheckpoint: "PASS",
        sessionStartCompactSameSession: "PASS",
        resumeSameSession: "PASS",
        newSessionLatestHandoff: "PASS",
        indexedDetailExplicitRecall: "PASS",
        daemonUnavailableLifecycleFailOpen: "PASS"
      },
      overall: "PASS"
    };
    process.stdout.write(`CODEX_P2_SMOKE_RESULT=${JSON.stringify(result)}\n`);
    completed = true;
    progress.emit(8, "PASS", "全部检查通过；临时数据将在退出前清理");
  } finally {
    if (daemon) await stopProcess(daemon);
    if (createdProjectHook && readManagedSmokeHook(projectHookPath)) {
      rmSync(projectHookPath, { force: true });
    } else if (createdProjectHook && existsSync(projectHookPath)) {
      process.stderr.write(
        `Preserved changed project hook file instead of deleting it: ${projectHookPath}\n`
      );
    }
    if (removeProjectCodexDirectory
      && existsSync(projectCodexDirectory)
      && readdirSync(projectCodexDirectory).length === 0) {
      rmdirSync(projectCodexDirectory);
    }
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
  const child = spawnSync("pnpm", ["--dir", repositoryRoot, "--silent", "codex:hook"], {
    input,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
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
  assert.equal(isManagedSmokeHookConfig(smokeHookConfig()), true);
  const legacyWrapperPath = join(
    tmpdir(),
    "memory-space-codex-p2-smoke-old",
    "hook-wrapper.mjs"
  );
  const legacyCommand = [process.execPath, legacyWrapperPath, repositoryRoot]
    .map(shellQuote)
    .join(" ");
  assert.equal(isManagedSmokeHookConfig({
    description: legacySmokeHookDescription,
    hooks: {
      SessionStart: [{ hooks: [{
        type: "command",
        command: legacyCommand
      }] }],
      UserPromptSubmit: [{ hooks: [{
        type: "command",
        command: legacyCommand
      }] }],
      Stop: [{ hooks: [{
        type: "command",
        command: legacyCommand
      }] }],
      PreCompact: [{ hooks: [{
        type: "command",
        command: legacyCommand
      }] }]
    }
  }), true);
  assert.equal(isManagedSmokeHookConfig({
    description: smokeHookDescription,
    hooks: { SessionStart: [] }
  }), false);
  assert.equal(isManagedSmokeHookConfig({
    description: "User-owned hooks",
    hooks: smokeHookConfig().hooks
  }), false);
  process.stdout.write("Codex P2 smoke runner self-test: PASS\n");
}

async function preflight() {
  const projectCodexDirectory = join(repositoryRoot, ".codex");
  const projectHookPath = join(projectCodexDirectory, "hooks.json");
  const facts = validatePrerequisites(projectCodexDirectory, projectHookPath);
  const hookState = existsSync(projectHookPath) ? "recoverable runner artifact" : "absent";
  process.stdout.write([
    "Codex P2 smoke preflight: PASS",
    `Codex CLI: ${facts.codexVersion}`,
    `Project hooks: ${hookState}`
  ].join("\n") + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv.includes("--hook")) await relaySmokeHook();
  else if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--preflight")) await preflight();
  else await main();
}
