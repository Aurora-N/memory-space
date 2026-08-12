import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CrossSessionEvalReport } from "../eval/support/cross-session-runner.ts";
import type { MemoryQualityReport } from "../eval/quality/types.ts";
import { runCli, type CliDependencies } from "../src/cli/main.ts";
import { CliError } from "../src/cli/errors.ts";
import { detectProviderConfigs } from "../src/cli/provider-config.ts";
import {
  LocalMemorySpaceClient,
  MEMORY_MCP_TOOLS,
  type LocalMemorySpaceClientPort
} from "../src/cli/local-client.ts";
import type { HandoffSnapshot, Space } from "../src/domain/types.ts";
import { SpaceResolver } from "../src/binding/space-resolver.ts";
import { createDefaultMemorySpace, createMemorySpaceDaemon } from "../src/index.ts";

class FakeClient implements LocalMemorySpaceClientPort {
  readonly endpoint = "http://127.0.0.1:4310";
  readonly spaces = new Map<string, Space>();
  createCalls = 0;
  healthCalls = 0;
  readCalls = 0;
  healthError?: Error;
  createError?: Error;
  mcpError?: Error;
  tools: string[] = [...MEMORY_MCP_TOOLS];
  handoff?: HandoffSnapshot;

  async health(): Promise<void> {
    this.healthCalls += 1;
    if (this.healthError) throw this.healthError;
  }

  async createSpace(input: { id?: string; name: string }): Promise<Space> {
    this.createCalls += 1;
    if (this.createError) throw this.createError;
    const now = new Date(0).toISOString();
    const space = {
      id: input.id ?? `space-${this.createCalls}`,
      name: input.name,
      createdAt: now,
      updatedAt: now
    };
    this.spaces.set(space.id, space);
    return space;
  }

  async getSpace(spaceId: string): Promise<Space> {
    this.readCalls += 1;
    const space = this.spaces.get(spaceId);
    if (!space) throw new CliError("SPACE_NOT_FOUND", `Space not found: ${spaceId}`);
    return space;
  }

  async getLatestHandoff(): Promise<HandoffSnapshot | undefined> {
    this.readCalls += 1;
    return this.handoff;
  }

  async listMcpTools(): Promise<string[]> {
    this.readCalls += 1;
    if (this.mcpError) throw this.mcpError;
    return this.tools;
  }
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(
  args: string[],
  options: {
    cwd: string;
    home?: string;
    client?: FakeClient;
    dependencies?: Partial<CliDependencies>;
  }
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = options.client ?? new FakeClient();
  const code = await runCli(args, {
    cwd: options.cwd,
    home: options.home ?? join(options.cwd, "home"),
    env: {},
    clientFactory: () => client,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...options.dependencies
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function temporaryProject(label: string): { directory: string; project: string } {
  const directory = mkdtempSync(join(tmpdir(), `memory-space-cli-${label}-`));
  const project = join(directory, "项目 with spaces");
  mkdirSync(project);
  return { directory, project };
}

function bind(project: string, value: unknown): string {
  const directory = join(project, ".memory-space");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "config.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function addSpace(client: FakeClient, id: string, name = "CLI Space"): void {
  const now = new Date(0).toISOString();
  client.spaces.set(id, { id, name, createdAt: now, updatedAt: now });
}

function claudeHook(command = "pnpm claude-code:hook"): object {
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command }] }]
    }
  };
}

function claudeMcp(secret?: string): object {
  return {
    mcpServers: {
      memory_space: {
        type: "http",
        url: "http://127.0.0.1:4310/mcp",
        headers: secret ? { authorization: secret } : undefined
      }
    }
  };
}

async function claudeConfigState(project: string, home: string): Promise<string> {
  return (await detectProviderConfigs(project, home))
    .find((provider) => provider.provider === "claude-code")?.state ?? "missing";
}

test("init creates an atomic v1 binding and is idempotent for the same Space", async () => {
  const { directory, project } = temporaryProject("init");
  const client = new FakeClient();
  try {
    const first = await cli([
      "init", "--cwd", project, "--name", "Unicode Project", "--space-id", "space-init"
    ], { cwd: project, client });
    assert.equal(first.code, 0);
    assert.equal(client.createCalls, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(project, ".memory-space", "config.json"), "utf8")),
      { version: 1, spaceId: "space-init" }
    );
    assert.match(first.stdout, /global configuration was not modified/u);

    const second = await cli([
      "init", "--cwd", project, "--space-id", "space-init"
    ], { cwd: project, client });
    assert.equal(second.code, 0);
    assert.equal(client.createCalls, 1);
    assert.match(second.stdout, /already initialized/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init rejects conflicting and malformed bindings without changing them", async () => {
  const { directory, project } = temporaryProject("conflict");
  const client = new FakeClient();
  try {
    const path = bind(project, { version: 1, spaceId: "space-existing" });
    addSpace(client, "space-existing");
    const conflict = await cli([
      "init", "--cwd", project, "--space-id", "space-other"
    ], { cwd: project, client });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /BINDING_CONFLICT/u);
    assert.equal(readFileSync(path, "utf8"), JSON.stringify({
      version: 1,
      spaceId: "space-existing"
    }));
    assert.equal(client.createCalls, 0);

    const malformed = "{not-json";
    writeFileSync(path, malformed);
    const invalid = await cli(["init", "--cwd", project], { cwd: project, client });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /BINDING_INVALID/u);
    assert.equal(readFileSync(path, "utf8"), malformed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nested init preserves inherited binding unless a different Space is explicit", async () => {
  const { directory, project } = temporaryProject("nested-init");
  const nested = join(project, "apps", "web");
  const client = new FakeClient();
  const resolver = new SpaceResolver();
  try {
    mkdirSync(nested, { recursive: true });
    const rootConfigPath = bind(project, { version: 1, spaceId: "space-a" });
    const rootConfigBefore = readFileSync(rootConfigPath, "utf8");
    addSpace(client, "space-a", "Root Space A");

    assert.equal((await resolver.resolve({ cwd: nested })).spaceId, "space-a");
    const inherited = await cli(["init", "--cwd", nested], { cwd: nested, client });
    assert.equal(inherited.code, 0, inherited.stderr);
    assert.match(inherited.stdout, /inherited binding/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(nested, ".memory-space", "config.json")), false);
    assert.equal(readFileSync(rootConfigPath, "utf8"), rootConfigBefore);

    const explicitSame = await cli([
      "init", "--cwd", nested, "--space-id", "space-a"
    ], { cwd: nested, client });
    assert.equal(explicitSame.code, 0, explicitSame.stderr);
    assert.match(explicitSame.stdout, /inherited binding/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(nested, ".memory-space", "config.json")), false);

    const override = await cli([
      "init", "--cwd", nested, "--space-id", "space-b", "--name", "Nested Space B"
    ], { cwd: nested, client });
    assert.equal(override.code, 0, override.stderr);
    assert.equal(client.createCalls, 1);
    assert.equal((await resolver.resolve({ cwd: project })).spaceId, "space-a");
    assert.equal((await resolver.resolve({ cwd: nested })).spaceId, "space-b");
    assert.equal(readFileSync(rootConfigPath, "utf8"), rootConfigBefore);

    const repeated = await cli([
      "init", "--cwd", nested, "--space-id", "space-b"
    ], { cwd: nested, client });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /already initialized/u);
    assert.equal(client.createCalls, 1);

    const nestedConfigPath = join(nested, ".memory-space", "config.json");
    const nestedConfigBefore = readFileSync(nestedConfigPath, "utf8");
    const conflict = await cli([
      "init", "--cwd", nested, "--space-id", "space-c"
    ], { cwd: nested, client });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /BINDING_CONFLICT/u);
    assert.equal(readFileSync(nestedConfigPath, "utf8"), nestedConfigBefore);
    assert.equal(readFileSync(rootConfigPath, "utf8"), rootConfigBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("init leaves no binding when daemon or Space creation fails", async () => {
  const unavailable = temporaryProject("unavailable");
  const failedCreate = temporaryProject("create-failure");
  try {
    const offlineClient = new FakeClient();
    offlineClient.healthError = new CliError("DAEMON_UNAVAILABLE", "Daemon unavailable.");
    const offline = await cli(["init", "--cwd", unavailable.project], {
      cwd: unavailable.project,
      client: offlineClient
    });
    assert.equal(offline.code, 1);
    assert.equal(offlineClient.createCalls, 0);
    assert.throws(() => readFileSync(join(
      unavailable.project, ".memory-space", "config.json"
    )));

    const createClient = new FakeClient();
    createClient.createError = new CliError("DAEMON_REQUEST_FAILED", "Space creation rejected.");
    const creation = await cli(["init", "--cwd", failedCreate.project], {
      cwd: failedCreate.project,
      client: createClient
    });
    assert.equal(creation.code, 1);
    assert.equal(createClient.createCalls, 1);
    assert.throws(() => readFileSync(join(
      failedCreate.project, ".memory-space", "config.json"
    )));
  } finally {
    rmSync(unavailable.directory, { recursive: true, force: true });
    rmSync(failedCreate.directory, { recursive: true, force: true });
  }
});

test("init reports an orphan Space when the final binding write fails", async () => {
  const { directory, project } = temporaryProject("partial-write");
  const client = new FakeClient();
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await runCli([
      "init", "--cwd", project, "--space-id", "orphan-space"
    ], {
      cwd: project,
      home: join(directory, "home"),
      env: {},
      clientFactory: () => client,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      writeBinding: async () => {
        throw new CliError(
          "BINDING_WRITE_FAILED",
          "simulated write failure",
          { remediation: "write the binding manually" }
        );
      }
    });
    assert.equal(code, 1);
    assert.ok(client.spaces.has("orphan-space"));
    assert.match(stderr.join("\n"), /Space orphan-space exists/u);
    assert.match(stderr.join("\n"), /write the binding manually/u);
    assert.throws(() => readFileSync(join(project, ".memory-space", "config.json")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports a healthy exact-six project without exposing credentials", async () => {
  const { directory, project } = temporaryProject("doctor-healthy");
  const home = join(directory, "home");
  const client = new FakeClient();
  try {
    bind(project, { version: 1, spaceId: "space-doctor" });
    addSpace(client, "space-doctor", "Doctor Space");
    mkdirSync(join(project, ".codex"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".codex", "hooks.json"), JSON.stringify({
      command: "pnpm codex:hook",
      token: "codex-super-secret"
    }));
    writeFileSync(join(project, ".codex", "config.toml"), [
      "[mcp_servers.memory_space]",
      "token = 'codex-mcp-secret'"
    ].join("\n"));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
      ...claudeHook(),
      apiKey: "claude-super-secret"
    }));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify(claudeMcp(
      "Bearer claude-mcp-secret"
    )));
    const result = await cli([
      "doctor", "--cwd", project, "--json"
    ], { cwd: project, home, client });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { checks: Array<{ id: string; status: string }> };
    assert.equal(parsed.checks.find((item) => item.id === "mcp")?.status, "ok");
    assert.equal(parsed.checks.find((item) => item.id === "codex")?.status, "ok");
    assert.equal(parsed.checks.find((item) => item.id === "claude-code")?.status, "ok");
    assert.equal(parsed.checks.find(
      (item) => item.id === "claude-real-mcp-waiver"
    )?.status, "warn");
    assert.doesNotMatch(result.stdout, /super-secret|mcp-secret/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude detection supports project MCP and settings.local.json hooks", async () => {
  const { directory, project } = temporaryProject("claude-project-scope");
  const home = join(directory, "home");
  try {
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify(
      claudeHook("pnpm claude-code:hook --local")
    ));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify(claudeMcp()));
    assert.equal(await claudeConfigState(project, home), "detected");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude local MCP detection reads only the resolved current project", async () => {
  const { directory, project } = temporaryProject("claude-local-scope");
  const home = join(directory, "home");
  const unrelated = join(directory, "另一个 project");
  try {
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(claudeHook()));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      projects: {
        [unrelated]: claudeMcp("Bearer unrelated-secret"),
        [join(project, ".")]: claudeMcp("Bearer current-project-secret")
      }
    }));
    assert.equal(await claudeConfigState(project, home), "detected");

    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      projects: { [unrelated]: claudeMcp("Bearer unrelated-secret") }
    }));
    assert.equal(await claudeConfigState(project, home), "partial");

    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    assert.equal(await claudeConfigState(project, home), "not-configured");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude user MCP scope is detected without disclosing parsed secrets", async () => {
  const { directory, project } = temporaryProject("claude-user-scope");
  const home = join(directory, "home");
  const client = new FakeClient();
  try {
    bind(project, { version: 1, spaceId: "space-user-scope" });
    addSpace(client, "space-user-scope");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(claudeHook()));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      ...claudeMcp("Bearer user-scope-api-key"),
      env: { ANTHROPIC_API_KEY: "user-scope-env-secret" }
    }));

    const result = await cli(["doctor", "--cwd", project, "--json"], {
      cwd: project,
      home,
      client
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(parsed.checks.find((item) => item.id === "claude-code")?.status, "ok");
    assert.doesNotMatch(result.stdout, /user-scope-api-key|user-scope-env-secret/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude detection reports multiple active Memory Space scopes as ambiguous", async () => {
  const { directory, project } = temporaryProject("claude-ambiguous");
  const home = join(directory, "home");
  try {
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify(
      claudeHook("pnpm claude-code:hook --project")
    ));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(
      claudeHook("pnpm claude-code:hook --user")
    ));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify(claudeMcp()));
    assert.equal(await claudeConfigState(project, home), "ambiguous");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor identifies daemon, binding, Space, MCP, and provider configuration failures", async () => {
  const noBinding = temporaryProject("doctor-unbound");
  const malformed = temporaryProject("doctor-malformed");
  const missingSpace = temporaryProject("doctor-space");
  try {
    const offline = new FakeClient();
    offline.healthError = new CliError("DAEMON_UNAVAILABLE", "offline");
    offline.mcpError = new CliError("MCP_UNAVAILABLE", "offline");
    const unbound = await cli(["doctor", "--cwd", noBinding.project, "--json"], {
      cwd: noBinding.project,
      client: offline
    });
    assert.equal(unbound.code, 1);
    assert.match(unbound.stdout, /"id": "daemon"[\s\S]*"status": "error"/u);
    assert.match(unbound.stdout, /"id": "binding"[\s\S]*"status": "error"/u);
    assert.match(unbound.stdout, /"id": "mcp"[\s\S]*"status": "error"/u);

    const malformedText = "not-json";
    const malformedPath = bind(malformed.project, malformedText);
    const invalid = await cli(["doctor", "--cwd", malformed.project, "--json"], {
      cwd: malformed.project
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stdout, /Project binding is malformed/u);
    assert.equal(readFileSync(malformedPath, "utf8"), malformedText);

    bind(missingSpace.project, { version: 1, spaceId: "missing-space" });
    const mismatchClient = new FakeClient();
    mismatchClient.tools = ["memory_bootstrap", "unexpected_tool"];
    const missing = await cli(["doctor", "--cwd", missingSpace.project, "--json"], {
      cwd: missingSpace.project,
      client: mismatchClient
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Bound Space does not exist/u);
    assert.match(missing.stdout, /MCP tool mismatch/u);
    assert.match(missing.stdout, /not detected/u);
  } finally {
    rmSync(noBinding.directory, { recursive: true, force: true });
    rmSync(malformed.directory, { recursive: true, force: true });
    rmSync(missingSpace.directory, { recursive: true, force: true });
  }
});

test("status is read-only and reports binding, Space, checkpoint, and Handoff", async () => {
  const { directory, project } = temporaryProject("status");
  const client = new FakeClient();
  try {
    bind(project, { version: 1, spaceId: "space-status" });
    addSpace(client, "space-status", "Status Space");
    client.handoff = {
      id: "handoff-1",
      spaceId: "space-status",
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      completed: [],
      activeTasks: [],
      decisions: [],
      blockers: [],
      openQuestions: [],
      nextSteps: ["continue P5"],
      createdAt: new Date(0).toISOString()
    };
    const result = await cli(["status", "--cwd", project, "--json"], {
      cwd: project,
      client
    });
    assert.equal(result.code, 0);
    const report = JSON.parse(result.stdout) as {
      space: { id: string };
      latestCheckpoint: { id: string };
      latestHandoff: { id: string };
    };
    assert.equal(report.space.id, "space-status");
    assert.equal(report.latestCheckpoint.id, "checkpoint-1");
    assert.equal(report.latestHandoff.id, "handoff-1");
    assert.equal(client.createCalls, 0);
    assert.ok(client.readCalls >= 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status fails safely when unbound or daemon is unavailable", async () => {
  const unbound = temporaryProject("status-unbound");
  const offline = temporaryProject("status-offline");
  try {
    const missing = await cli(["status", "--cwd", unbound.project], {
      cwd: unbound.project
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /BINDING_NOT_FOUND/u);

    bind(offline.project, { version: 1, spaceId: "space-offline" });
    const client = new FakeClient();
    addSpace(client, "space-offline");
    client.healthError = new CliError("DAEMON_UNAVAILABLE", "Daemon unavailable.");
    const unavailable = await cli(["status", "--cwd", offline.project], {
      cwd: offline.project,
      client
    });
    assert.equal(unavailable.code, 1);
    assert.match(unavailable.stderr, /DAEMON_UNAVAILABLE/u);
    assert.equal(client.readCalls, 0);
  } finally {
    rmSync(unbound.directory, { recursive: true, force: true });
    rmSync(offline.directory, { recursive: true, force: true });
  }
});

function evalReport(status: "pass" | "fail"): CrossSessionEvalReport {
  return {
    checks: [{ id: "matrix.codex.codex", label: "Codex → Codex", status }],
    overall: status,
    claudeRealMcp: "waived"
  };
}

function qualityEvalReport(status: "pass" | "fail"): MemoryQualityReport {
  return {
    version: 1,
    summary: {
      extraction: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 },
      retrieval: [{ k: 1, precision: 1, recall: 1, queryCount: 1 }],
      corePollution: {
        numerator: 0, denominator: 1, value: 0, pollutedKeys: []
      },
      bootstrap: {
        criticalCoverage: { numerator: 1, denominator: 1, value: 1 },
        missingCriticalKeys: [],
        unexpectedDefaultKeys: [],
        coreItemCount: 1,
        handoffFactCount: 1,
        chars: 100,
        bytes: 100
      },
      handoff: {
        numerator: 1, denominator: 1, value: 1, missingFacts: [], unexpectedFacts: []
      },
      staleMemory: { numerator: 0, denominator: 1, value: 0, staleKeys: [] },
      duplicateMemory: {
        numerator: 0, denominator: 1, value: 0, groups: []
      },
      contradiction: { numerator: 1, denominator: 1, value: 1, checks: [] },
      longHorizonSessions: 20
    },
    correctness: { overall: status, checks: [] },
    scenarios: [],
    failures: []
  };
}

test("eval CLI uses the injected canonical runner and maps overall status to exit code", async () => {
  const { directory, project } = temporaryProject("eval");
  try {
    let calls = 0;
    const success = await cli(["eval", "cross-session"], {
      cwd: project,
      dependencies: {
        evalRunner: async () => {
          calls += 1;
          return evalReport("pass");
        }
      }
    });
    assert.equal(success.code, 0);
    assert.equal(calls, 1);
    assert.match(success.stdout, /Overall\s+PASS/u);
    assert.match(success.stdout, /WAIVED/u);

    const failure = await cli(["eval", "cross-session", "--json"], {
      cwd: project,
      dependencies: { evalRunner: async () => evalReport("fail") }
    });
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /"overall": "fail"/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quality eval CLI is daemon-independent and separates metrics from correctness exit", async () => {
  const { directory, project } = temporaryProject("quality-eval");
  try {
    let calls = 0;
    const success = await cli(["eval", "quality"], {
      cwd: project,
      dependencies: {
        qualityEvalRunner: async () => {
          calls += 1;
          return qualityEvalReport("pass");
        },
        clientFactory: () => {
          throw new Error("quality eval must not construct a daemon client");
        }
      }
    });
    assert.equal(success.code, 0, success.stderr);
    assert.equal(calls, 1);
    assert.match(success.stdout, /Memory Quality v1 — Baseline/u);
    assert.match(success.stdout, /baseline observations, not PASS\/FAIL thresholds/u);

    const json = await cli(["eval", "quality", "--json"], {
      cwd: project,
      dependencies: { qualityEvalRunner: async () => qualityEvalReport("pass") }
    });
    assert.equal(json.code, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as { version: number }).version, 1);

    const correctnessFailure = await cli(["eval", "quality"], {
      cwd: project,
      dependencies: { qualityEvalRunner: async () => qualityEvalReport("fail") }
    });
    assert.equal(correctnessFailure.code, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("LocalMemorySpaceClient enforces loopback and never retries failed Space writes", async () => {
  assert.throws(
    () => new LocalMemorySpaceClient({ endpoint: "https://memory.example.test" }),
    (error: unknown) => error instanceof CliError
      && error.code === "DAEMON_ENDPOINT_INVALID"
  );
  let calls = 0;
  const client = new LocalMemorySpaceClient({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { "content-type": "application/json" });
      return new Response(JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "Internal server error" }
      }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch
  });
  await assert.rejects(() => client.createSpace({ name: "No retry" }), CliError);
  assert.equal(calls, 1);
});

test("normal CLI modules cannot create a second durable-store owner", () => {
  const paths = readdirSync("src/cli", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join("src/cli", entry.name));
  assert.ok(paths.length >= 5);
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /createDefaultMemorySpace|SqliteMemoryStore/u, path);
  }
});

test("real CLI client uses one loopback daemon owner for init, doctor, and status", async () => {
  const { directory, project } = temporaryProject("loopback");
  let factoryCalls = 0;
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "memory.db"),
    mcpRuntime: { cwd: project },
    memorySpaceFactory(options) {
      factoryCalls += 1;
      return createDefaultMemorySpace(options);
    }
  });
  try {
    const address = await daemon.listen();
    const endpoint = `http://127.0.0.1:${address.port}`;
    const execute = async (args: string[]): Promise<CliRun> => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(args, {
        cwd: project,
        home: join(directory, "home"),
        env: { MEMORY_SPACE_URL: endpoint },
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line)
      });
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    };

    const initialized = await execute([
      "init", "--space-id", "real-cli-space", "--name", "Real CLI Space"
    ]);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal((await daemon.memorySpace.getSpace("real-cli-space")).name, "Real CLI Space");

    const doctor = await execute(["doctor", "--json"]);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /exact six tools discovered/u);

    const status = await execute(["status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /"id": "real-cli-space"/u);
    assert.equal(factoryCalls, 1);
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
