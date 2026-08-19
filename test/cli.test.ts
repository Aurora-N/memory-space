import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { P7ImplicitRecallReport } from "../eval/p7-implicit-recall.ts";
import type { P8ImplicitRememberReport } from "../eval/p8-implicit-remember.ts";
import { runStageB1Comparison } from "../eval/quality/comparison.ts";
import { runStageB3CoreHandoffComparison } from "../eval/quality/core-handoff-comparison.ts";
import { runStageB2ExtractionComparison } from "../eval/quality/extraction-comparison.ts";
import type { MemoryQualityReport } from "../eval/quality/types.ts";
import type { CrossSessionEvalReport } from "../eval/support/cross-session-runner.ts";
import { SpaceResolver } from "../src/binding/space-resolver.ts";
import { CliError } from "../src/cli/errors.ts";
import {
  type InspectorBinding,
  LocalMemorySpaceClient,
  type LocalMemorySpaceClientPort,
  MEMORY_MCP_TOOLS,
} from "../src/cli/local-client.ts";
import { type CliDependencies, runCli } from "../src/cli/main.ts";
import { detectProviderConfigs } from "../src/cli/provider-config.ts";
import type { HandoffSnapshot, Space } from "../src/domain/types.ts";
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
  inspectorCwd?: string;
  inspectorBinding?: InspectorBinding;
  inspectorError?: Error;

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
      updatedAt: now,
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

  async getDaemonIdentity(): Promise<{ cwd: string }> {
    return { cwd: this.inspectorCwd ?? process.cwd() };
  }

  async getInspectorBinding(): Promise<InspectorBinding> {
    if (this.inspectorError) throw this.inspectorError;
    if (this.inspectorBinding) return this.inspectorBinding;
    const space = [...this.spaces.values()][0];
    if (!space || !this.inspectorCwd) throw new Error("fake Inspector binding not configured");
    return {
      space,
      binding: { spaceId: space.id, source: "config" },
      cwd: this.inspectorCwd,
    };
  }

  async checkInspector(): Promise<void> {
    if (this.inspectorError) throw this.inspectorError;
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
    ...options.dependencies,
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
      SessionStart: [{ hooks: [{ type: "command", command }] }],
    },
  };
}

function claudeMcp(secret?: string): object {
  return {
    mcpServers: {
      memory_space: {
        type: "http",
        url: "http://127.0.0.1:4310/mcp",
        headers: secret ? { authorization: secret } : undefined,
      },
    },
  };
}

async function claudeConfigState(project: string, home: string): Promise<string> {
  return (
    (await detectProviderConfigs(project, home)).find(
      (provider) => provider.provider === "claude-code"
    )?.state ?? "missing"
  );
}

test("init creates an atomic v1 binding and is idempotent for the same Space", async () => {
  const { directory, project } = temporaryProject("init");
  const client = new FakeClient();
  try {
    const first = await cli(
      ["init", "--cwd", project, "--name", "Unicode Project", "--space-id", "space-init"],
      { cwd: project, client }
    );
    assert.equal(first.code, 0);
    assert.equal(client.createCalls, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(project, ".memory-space", "config.json"), "utf8")),
      {
        version: 1,
        spaceId: "space-init",
        implicitRecall: { mode: "exact" },
        implicitRemember: { mode: "conservative" },
      }
    );
    assert.match(first.stdout, /global configuration was not modified/u);

    const second = await cli(["init", "--cwd", project, "--space-id", "space-init"], {
      cwd: project,
      client,
    });
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
    const conflict = await cli(["init", "--cwd", project, "--space-id", "space-other"], {
      cwd: project,
      client,
    });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /BINDING_CONFLICT/u);
    assert.equal(
      readFileSync(path, "utf8"),
      JSON.stringify({
        version: 1,
        spaceId: "space-existing",
      })
    );
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

    const explicitSame = await cli(["init", "--cwd", nested, "--space-id", "space-a"], {
      cwd: nested,
      client,
    });
    assert.equal(explicitSame.code, 0, explicitSame.stderr);
    assert.match(explicitSame.stdout, /inherited binding/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(nested, ".memory-space", "config.json")), false);

    const override = await cli(
      ["init", "--cwd", nested, "--space-id", "space-b", "--name", "Nested Space B"],
      { cwd: nested, client }
    );
    assert.equal(override.code, 0, override.stderr);
    assert.equal(client.createCalls, 1);
    assert.equal((await resolver.resolve({ cwd: project })).spaceId, "space-a");
    assert.equal((await resolver.resolve({ cwd: nested })).spaceId, "space-b");
    assert.equal(readFileSync(rootConfigPath, "utf8"), rootConfigBefore);

    const repeated = await cli(["init", "--cwd", nested, "--space-id", "space-b"], {
      cwd: nested,
      client,
    });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /already initialized/u);
    assert.equal(client.createCalls, 1);

    const nestedConfigPath = join(nested, ".memory-space", "config.json");
    const nestedConfigBefore = readFileSync(nestedConfigPath, "utf8");
    const conflict = await cli(["init", "--cwd", nested, "--space-id", "space-c"], {
      cwd: nested,
      client,
    });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /BINDING_CONFLICT/u);
    assert.equal(readFileSync(nestedConfigPath, "utf8"), nestedConfigBefore);
    assert.equal(readFileSync(rootConfigPath, "utf8"), rootConfigBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unbind removes only the exact local binding and preserves ancestor and Memory data", async () => {
  const { directory, project } = temporaryProject("unbind-nested");
  const nested = join(project, "apps", "web");
  const client = new FakeClient();
  try {
    mkdirSync(nested, { recursive: true });
    const rootPath = bind(project, { version: 1, spaceId: "space-a" });
    const rootBefore = readFileSync(rootPath, "utf8");
    const nestedPath = bind(nested, { version: 1, spaceId: "space-b" });
    addSpace(client, "space-a");
    addSpace(client, "space-b");

    const result = await cli(["unbind", nested, "--space-id", "space-b"], {
      cwd: project,
      client,
      dependencies: {
        clientFactory: () => {
          throw new Error("unbind must not contact or open the daemon");
        },
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(nestedPath), false);
    assert.equal(readFileSync(rootPath, "utf8"), rootBefore);
    assert.match(result.stdout, /Memory data and the Space were preserved/u);
    assert.match(result.stdout, /inherits Space space-a/u);
    assert.equal((await new SpaceResolver().resolve({ cwd: nested })).spaceId, "space-a");
    assert.equal(client.spaces.size, 2);

    const repeated = await cli(["unbind", nested], { cwd: project, client });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /No local binding to remove/u);
    assert.equal(readFileSync(rootPath, "utf8"), rootBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unbind preserves mismatched and malformed local bindings", async () => {
  const { directory, project } = temporaryProject("unbind-guard");
  try {
    const path = bind(project, { version: 1, spaceId: "space-actual" });
    const before = readFileSync(path, "utf8");
    const mismatch = await cli(["unbind", "--cwd", project, "--space-id", "space-other"], {
      cwd: project,
    });
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.stderr, /BINDING_CONFLICT/u);
    assert.equal(readFileSync(path, "utf8"), before);

    writeFileSync(path, "{broken-json");
    const malformed = await cli(["unbind", project], { cwd: project });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /BINDING_INVALID/u);
    assert.equal(readFileSync(path, "utf8"), "{broken-json");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure codex creates project hooks and MCP configuration and is idempotent", async () => {
  const { directory, project } = temporaryProject("configure-codex-create");
  const installationRoot = join(directory, "memory-space installation");
  try {
    const dryRun = await cli(["configure", "codex", project, "--dry-run"], {
      cwd: directory,
      dependencies: { installationRoot },
    });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /would be created/u);
    assert.match(dryRun.stdout, /No files were changed/u);
    assert.equal(existsSync(join(project, ".codex")), false);

    const configured = await cli(["configure", "codex", project], {
      cwd: directory,
      dependencies: { installationRoot },
    });
    assert.equal(configured.code, 0, configured.stderr);
    const hooksPath = join(project, ".codex", "hooks.json");
    const mcpPath = join(project, ".codex", "config.toml");
    const hooksBefore = readFileSync(hooksPath, "utf8");
    const mcpBefore = readFileSync(mcpPath, "utf8");
    const hooks = JSON.parse(hooksBefore) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    assert.deepEqual(Object.keys(hooks.hooks), [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "SessionEnd",
    ]);
    assert.equal(
      hooks.hooks.SessionStart?.[0]?.hooks[0]?.command,
      `pnpm --dir '${installationRoot}' --silent codex:hook`
    );
    assert.equal(
      mcpBefore,
      ["[mcp_servers.memory_space]", 'url = "http://127.0.0.1:4310/mcp"', ""].join("\n")
    );
    assert.equal(
      (await detectProviderConfigs(project, join(directory, "home"))).find(
        (value) => value.provider === "codex"
      )?.state,
      "detected"
    );

    const repeated = await cli(["configure", "codex", project], {
      cwd: directory,
      dependencies: { installationRoot },
    });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /was unchanged/u);
    assert.equal(readFileSync(hooksPath, "utf8"), hooksBefore);
    assert.equal(readFileSync(mcpPath, "utf8"), mcpBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure codex preserves unrelated hooks, TOML, and secret values without disclosure", async () => {
  const { directory, project } = temporaryProject("configure-codex-merge");
  const codexDirectory = join(project, ".codex");
  const secret = "never-print-provider-token";
  try {
    mkdirSync(codexDirectory);
    writeFileSync(
      join(codexDirectory, "hooks.json"),
      JSON.stringify(
        {
          description: "existing",
          token: secret,
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "pnpm lint" }] }],
          },
        },
        null,
        2
      )
    );
    writeFileSync(
      join(codexDirectory, "config.toml"),
      [
        "# memory_space is configured below by the project command",
        "[mcp_servers.other]",
        'url = "http://127.0.0.1:9999/mcp"',
        `authorization_token = "${secret}"`,
        "",
      ].join("\n")
    );

    const result = await cli(["configure", "codex", project], {
      cwd: directory,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, "u"));
    const hooks = JSON.parse(readFileSync(join(codexDirectory, "hooks.json"), "utf8")) as {
      description: string;
      token: string;
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(hooks.description, "existing");
    assert.equal(hooks.token, secret);
    assert.equal(hooks.hooks.UserPromptSubmit[0]?.hooks[0]?.command, "pnpm lint");
    assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
    const toml = readFileSync(join(codexDirectory, "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.other\]/u);
    assert.match(toml, new RegExp(secret, "u"));
    assert.match(toml, /\[mcp_servers\.memory_space\]/u);

    const repeated = await cli(["configure", "codex", project], {
      cwd: directory,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /was unchanged/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure codex rejects hook or MCP conflicts before changing either file", async () => {
  const hookFixture = temporaryProject("configure-codex-hook-conflict");
  const mcpFixture = temporaryProject("configure-codex-mcp-conflict");
  try {
    const hookDirectory = join(hookFixture.project, ".codex");
    mkdirSync(hookDirectory);
    const conflictingHooks = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "pnpm --dir /other codex:hook" }],
          },
        ],
      },
    });
    writeFileSync(join(hookDirectory, "hooks.json"), conflictingHooks);
    const hookConflict = await cli(["configure", "codex", hookFixture.project], {
      cwd: hookFixture.project,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(hookConflict.code, 1);
    assert.match(hookConflict.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.equal(readFileSync(join(hookDirectory, "hooks.json"), "utf8"), conflictingHooks);
    assert.equal(existsSync(join(hookDirectory, "config.toml")), false);

    const mcpDirectory = join(mcpFixture.project, ".codex");
    mkdirSync(mcpDirectory);
    const secret = "Bearer conflict-secret";
    const conflictingMcp = [
      "[mcp_servers.memory_space]",
      'url = "http://127.0.0.1:9999/mcp"',
      `authorization_token = "${secret}"`,
      "",
    ].join("\n");
    writeFileSync(join(mcpDirectory, "config.toml"), conflictingMcp);
    const mcpConflict = await cli(["configure", "codex", mcpFixture.project], {
      cwd: mcpFixture.project,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(mcpConflict.code, 1);
    assert.match(mcpConflict.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.doesNotMatch(mcpConflict.stderr, /conflict-secret/u);
    assert.equal(readFileSync(join(mcpDirectory, "config.toml"), "utf8"), conflictingMcp);
    assert.equal(existsSync(join(mcpDirectory, "hooks.json")), false);
  } finally {
    rmSync(hookFixture.directory, { recursive: true, force: true });
    rmSync(mcpFixture.directory, { recursive: true, force: true });
  }
});

test("configure codex preserves malformed project hooks and rejects unsupported providers", async () => {
  const { directory, project } = temporaryProject("configure-codex-invalid");
  const codexDirectory = join(project, ".codex");
  try {
    mkdirSync(codexDirectory);
    writeFileSync(join(codexDirectory, "hooks.json"), "{malformed");
    const invalid = await cli(["configure", "codex", project], { cwd: project });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /PROVIDER_CONFIG_INVALID/u);
    assert.equal(readFileSync(join(codexDirectory, "hooks.json"), "utf8"), "{malformed");
    assert.equal(existsSync(join(codexDirectory, "config.toml")), false);

    const unsupported = await cli(["configure", "other-agent", project], { cwd: project });
    assert.equal(unsupported.code, 2);
    assert.match(unsupported.stderr, /requires the codex or claude-code provider/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure claude-code creates project hooks and MCP configuration and is idempotent", async () => {
  const { directory, project } = temporaryProject("configure-claude-create");
  const installationRoot = join(directory, "memory-space installation");
  const home = join(directory, "home");
  try {
    const dryRun = await cli(["configure", "claude-code", project, "--dry-run"], {
      cwd: directory,
      home,
      dependencies: { installationRoot },
    });
    assert.equal(dryRun.code, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /would be created/u);
    assert.match(dryRun.stdout, /No files were changed/u);
    assert.equal(existsSync(join(project, ".claude")), false);
    assert.equal(existsSync(join(project, ".mcp.json")), false);

    const configured = await cli(["configure", "claude-code", project], {
      cwd: directory,
      home,
      dependencies: { installationRoot },
    });
    assert.equal(configured.code, 0, configured.stderr);
    const hooksPath = join(project, ".claude", "settings.json");
    const mcpPath = join(project, ".mcp.json");
    const hooksBefore = readFileSync(hooksPath, "utf8");
    const mcpBefore = readFileSync(mcpPath, "utf8");
    const hooks = JSON.parse(hooksBefore) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout: number }> }>>;
    };
    assert.deepEqual(Object.keys(hooks.hooks), [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "PreCompact",
      "SessionEnd",
    ]);
    assert.equal(
      hooks.hooks.SessionStart?.[0]?.hooks[0]?.command,
      `pnpm --dir '${installationRoot}' --silent claude-code:hook`
    );
    assert.equal(hooks.hooks.SessionEnd?.[0]?.hooks[0]?.timeout, 8);
    assert.deepEqual(JSON.parse(mcpBefore), {
      mcpServers: {
        memory_space: { type: "http", url: "http://127.0.0.1:4310/mcp" },
      },
    });
    assert.equal(await claudeConfigState(project, home), "detected");

    const repeated = await cli(["configure", "claude-code", project], {
      cwd: directory,
      home,
      dependencies: { installationRoot },
    });
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /was unchanged/u);
    assert.equal(readFileSync(hooksPath, "utf8"), hooksBefore);
    assert.equal(readFileSync(mcpPath, "utf8"), mcpBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure claude-code preserves unrelated JSON and secrets without disclosure", async () => {
  const { directory, project } = temporaryProject("configure-claude-merge");
  const claudeDirectory = join(project, ".claude");
  const secret = "never-print-claude-token";
  try {
    mkdirSync(claudeDirectory);
    writeFileSync(
      join(claudeDirectory, "settings.json"),
      JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          env: { PROVIDER_TOKEN: secret },
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: "pnpm lint" }] }],
          },
        },
        null,
        2
      )
    );
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify(
        {
          note: secret,
          mcpServers: {
            other: { type: "http", url: "http://127.0.0.1:9999/mcp", headers: { token: secret } },
          },
        },
        null,
        2
      )
    );

    const result = await cli(["configure", "claude-code", project], {
      cwd: directory,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret, "u"));
    const settings = JSON.parse(readFileSync(join(claudeDirectory, "settings.json"), "utf8")) as {
      env: { PROVIDER_TOKEN: string };
      hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(settings.env.PROVIDER_TOKEN, secret);
    assert.equal(settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command, "pnpm lint");
    assert.equal(settings.hooks.UserPromptSubmit.length, 2);
    const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")) as {
      note: string;
      mcpServers: Record<string, unknown>;
    };
    assert.equal(mcp.note, secret);
    assert.ok(mcp.mcpServers.other);
    assert.deepEqual(mcp.mcpServers.memory_space, {
      type: "http",
      url: "http://127.0.0.1:4310/mcp",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure claude-code rejects hook or MCP conflicts before changing either file", async () => {
  const hookFixture = temporaryProject("configure-claude-hook-conflict");
  const mcpFixture = temporaryProject("configure-claude-mcp-conflict");
  try {
    const hookDirectory = join(hookFixture.project, ".claude");
    mkdirSync(hookDirectory);
    const conflictingHooks = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "pnpm --dir /other claude-code:hook" }],
          },
        ],
      },
    });
    writeFileSync(join(hookDirectory, "settings.json"), conflictingHooks);
    const hookConflict = await cli(["configure", "claude-code", hookFixture.project], {
      cwd: hookFixture.project,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(hookConflict.code, 1);
    assert.match(hookConflict.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.equal(readFileSync(join(hookDirectory, "settings.json"), "utf8"), conflictingHooks);
    assert.equal(existsSync(join(hookFixture.project, ".mcp.json")), false);

    const secret = "claude-conflict-secret";
    const conflictingMcp = JSON.stringify({
      mcpServers: {
        memory_space: {
          type: "http",
          url: "http://127.0.0.1:9999/mcp",
          headers: { authorization: secret },
        },
      },
    });
    writeFileSync(join(mcpFixture.project, ".mcp.json"), conflictingMcp);
    const mcpConflict = await cli(["configure", "claude-code", mcpFixture.project], {
      cwd: mcpFixture.project,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(mcpConflict.code, 1);
    assert.match(mcpConflict.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.doesNotMatch(mcpConflict.stderr, new RegExp(secret, "u"));
    assert.equal(readFileSync(join(mcpFixture.project, ".mcp.json"), "utf8"), conflictingMcp);
    assert.equal(existsSync(join(mcpFixture.project, ".claude")), false);
  } finally {
    rmSync(hookFixture.directory, { recursive: true, force: true });
    rmSync(mcpFixture.directory, { recursive: true, force: true });
  }
});

test("configure claude-code rejects duplicate active scopes but ignores unrelated projects", async () => {
  const localFixture = temporaryProject("configure-claude-local-scope");
  const globalFixture = temporaryProject("configure-claude-global-scope");
  try {
    mkdirSync(join(localFixture.project, ".claude"));
    writeFileSync(
      join(localFixture.project, ".claude", "settings.local.json"),
      JSON.stringify(claudeHook("pnpm --dir /existing claude-code:hook"))
    );
    const localConflict = await cli(["configure", "claude-code", localFixture.project], {
      cwd: localFixture.project,
    });
    assert.equal(localConflict.code, 1);
    assert.match(localConflict.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.equal(existsSync(join(localFixture.project, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(localFixture.project, ".mcp.json")), false);

    const home = join(globalFixture.directory, "home");
    mkdirSync(home);
    const unrelatedProject = join(globalFixture.directory, "unrelated");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [unrelatedProject]: claudeMcp("unrelated-secret") },
      })
    );
    const unrelated = await cli(["configure", "claude-code", globalFixture.project], {
      cwd: globalFixture.project,
      home,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(unrelated.code, 0, unrelated.stderr);

    rmSync(join(globalFixture.project, ".claude"), { recursive: true, force: true });
    rmSync(join(globalFixture.project, ".mcp.json"));
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [globalFixture.project]: claudeMcp("current-project-secret") },
      })
    );
    const currentProject = await cli(["configure", "claude-code", globalFixture.project], {
      cwd: globalFixture.project,
      home,
    });
    assert.equal(currentProject.code, 1);
    assert.match(currentProject.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.doesNotMatch(currentProject.stderr, /current-project-secret/u);
    assert.equal(existsSync(join(globalFixture.project, ".claude")), false);
    assert.equal(existsSync(join(globalFixture.project, ".mcp.json")), false);

    writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeMcp("user-mcp-secret")));
    const userMcp = await cli(["configure", "claude-code", globalFixture.project], {
      cwd: globalFixture.project,
      home,
    });
    assert.equal(userMcp.code, 1);
    assert.match(userMcp.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.doesNotMatch(userMcp.stderr, /user-mcp-secret/u);

    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: {} }));
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(claudeHook("pnpm --dir /user claude-code:hook"))
    );
    const userHook = await cli(["configure", "claude-code", globalFixture.project], {
      cwd: globalFixture.project,
      home,
    });
    assert.equal(userHook.code, 1);
    assert.match(userHook.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.equal(existsSync(join(globalFixture.project, ".claude")), false);
    assert.equal(existsSync(join(globalFixture.project, ".mcp.json")), false);
  } finally {
    rmSync(localFixture.directory, { recursive: true, force: true });
    rmSync(globalFixture.directory, { recursive: true, force: true });
  }
});

test("configure claude-code preserves malformed and symlinked files and rejects remote endpoints", async () => {
  const malformedFixture = temporaryProject("configure-claude-malformed");
  const symlinkFixture = temporaryProject("configure-claude-symlink");
  const endpointFixture = temporaryProject("configure-claude-endpoint");
  try {
    mkdirSync(join(malformedFixture.project, ".claude"));
    writeFileSync(join(malformedFixture.project, ".claude", "settings.json"), "{malformed");
    const malformed = await cli(["configure", "claude-code", malformedFixture.project], {
      cwd: malformedFixture.project,
    });
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /PROVIDER_CONFIG_INVALID/u);
    assert.equal(
      readFileSync(join(malformedFixture.project, ".claude", "settings.json"), "utf8"),
      "{malformed"
    );
    assert.equal(existsSync(join(malformedFixture.project, ".mcp.json")), false);

    const ownedMcp = join(symlinkFixture.directory, "owned-mcp.json");
    writeFileSync(ownedMcp, JSON.stringify({ mcpServers: {} }));
    symlinkSync(ownedMcp, join(symlinkFixture.project, ".mcp.json"));
    const symlink = await cli(["configure", "claude-code", symlinkFixture.project], {
      cwd: symlinkFixture.project,
    });
    assert.equal(symlink.code, 1);
    assert.match(symlink.stderr, /PROVIDER_CONFIG_INVALID/u);
    assert.equal(readFileSync(ownedMcp, "utf8"), JSON.stringify({ mcpServers: {} }));
    assert.equal(existsSync(join(symlinkFixture.project, ".claude")), false);

    const endpoint = await cli(
      [
        "configure",
        "claude-code",
        endpointFixture.project,
        "--endpoint",
        "https://memory.example.test",
      ],
      { cwd: endpointFixture.project }
    );
    assert.equal(endpoint.code, 1);
    assert.match(endpoint.stderr, /DAEMON_ENDPOINT_INVALID/u);
    assert.equal(existsSync(join(endpointFixture.project, ".claude")), false);
    assert.equal(existsSync(join(endpointFixture.project, ".mcp.json")), false);
  } finally {
    rmSync(malformedFixture.directory, { recursive: true, force: true });
    rmSync(symlinkFixture.directory, { recursive: true, force: true });
    rmSync(endpointFixture.directory, { recursive: true, force: true });
  }
});

test("configure codex refuses to create a duplicate active user/project scope", async () => {
  const { directory, project } = temporaryProject("configure-codex-user-scope");
  const home = join(directory, "home");
  const secret = "user-scope-config-secret";
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "pnpm --dir /existing memory-space codex:hook",
                  env: { TOKEN: secret },
                },
              ],
            },
          ],
        },
      })
    );
    const result = await cli(["configure", "codex", project], {
      cwd: project,
      home,
      dependencies: { installationRoot: "/safe/memory-space" },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PROVIDER_CONFIG_CONFLICT/u);
    assert.match(result.stderr, /User-level Codex Memory Space configuration/u);
    assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
    assert.equal(existsSync(join(project, ".codex")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configure codex rejects non-loopback endpoints and symlink configuration files", async () => {
  const endpointFixture = temporaryProject("configure-codex-endpoint");
  const symlinkFixture = temporaryProject("configure-codex-symlink");
  try {
    const endpoint = await cli(
      ["configure", "codex", endpointFixture.project, "--endpoint", "https://memory.example.test"],
      { cwd: endpointFixture.project }
    );
    assert.equal(endpoint.code, 1);
    assert.match(endpoint.stderr, /DAEMON_ENDPOINT_INVALID/u);
    assert.equal(existsSync(join(endpointFixture.project, ".codex")), false);

    const codexDirectory = join(symlinkFixture.project, ".codex");
    const ownedFile = join(symlinkFixture.directory, "owned-hooks.json");
    mkdirSync(codexDirectory);
    writeFileSync(ownedFile, JSON.stringify({ hooks: {} }));
    symlinkSync(ownedFile, join(codexDirectory, "hooks.json"));
    const symlink = await cli(["configure", "codex", symlinkFixture.project], {
      cwd: symlinkFixture.project,
    });
    assert.equal(symlink.code, 1);
    assert.match(symlink.stderr, /PROVIDER_CONFIG_INVALID/u);
    assert.equal(readFileSync(ownedFile, "utf8"), JSON.stringify({ hooks: {} }));
    assert.equal(existsSync(join(codexDirectory, "config.toml")), false);
  } finally {
    rmSync(endpointFixture.directory, { recursive: true, force: true });
    rmSync(symlinkFixture.directory, { recursive: true, force: true });
  }
});

test("inspect validates an existing binding and opens the running daemon UI", async () => {
  const { directory, project } = temporaryProject("inspect-open");
  const client = new FakeClient();
  const browserUrls: string[] = [];
  try {
    bind(project, { version: 1, spaceId: "inspect-space" });
    addSpace(client, "inspect-space", "Inspector Space");
    client.inspectorCwd = project;
    const result = await cli(["inspect", project], {
      cwd: directory,
      client,
      dependencies: {
        openBrowser: async (url) => {
          browserUrls.push(url);
        },
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(browserUrls, ["http://127.0.0.1:4310/inspector/"]);
    assert.equal(client.createCalls, 0);
    assert.match(result.stdout, /Memory Space Inspector ready/u);
    assert.match(result.stdout, /press Ctrl\+C in the pnpm start terminal/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("inspect never starts or initializes when daemon or binding is unavailable", async () => {
  const offlineFixture = temporaryProject("inspect-offline");
  const unboundFixture = temporaryProject("inspect-unbound");
  const client = new FakeClient();
  try {
    client.healthError = new CliError("DAEMON_UNAVAILABLE", "offline");
    client.inspectorCwd = offlineFixture.project;
    const offline = await cli(["inspect", offlineFixture.project, "--no-open"], {
      cwd: offlineFixture.project,
      client,
      dependencies: { openBrowser: async () => undefined },
    });
    assert.equal(offline.code, 1);
    assert.match(offline.stderr, /DAEMON_UNAVAILABLE/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(offlineFixture.project, ".memory-space", "config.json")), false);

    client.healthError = undefined;
    client.inspectorCwd = unboundFixture.project;
    const unbound = await cli(["inspect", unboundFixture.project, "--no-open"], {
      cwd: unboundFixture.project,
      client,
      dependencies: { openBrowser: async () => undefined },
    });
    assert.equal(unbound.code, 1);
    assert.match(unbound.stderr, /BINDING_NOT_FOUND/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(unboundFixture.project, ".memory-space", "config.json")), false);
  } finally {
    rmSync(offlineFixture.directory, { recursive: true, force: true });
    rmSync(unboundFixture.directory, { recursive: true, force: true });
  }
});

test("inspect rejects a daemon attached to another project before any mutation", async () => {
  const { directory, project } = temporaryProject("inspect-preflight");
  const other = join(directory, "other");
  const client = new FakeClient();
  try {
    mkdirSync(other);
    client.inspectorCwd = other;
    const result = await cli(["inspect", project, "--no-open"], {
      cwd: project,
      client,
      dependencies: { openBrowser: async () => undefined },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /different project/u);
    assert.equal(client.createCalls, 0);
    assert.equal(existsSync(join(project, ".memory-space", "config.json")), false);
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
      client: offlineClient,
    });
    assert.equal(offline.code, 1);
    assert.equal(offlineClient.createCalls, 0);
    assert.throws(() => readFileSync(join(unavailable.project, ".memory-space", "config.json")));

    const createClient = new FakeClient();
    createClient.createError = new CliError("DAEMON_REQUEST_FAILED", "Space creation rejected.");
    const creation = await cli(["init", "--cwd", failedCreate.project], {
      cwd: failedCreate.project,
      client: createClient,
    });
    assert.equal(creation.code, 1);
    assert.equal(createClient.createCalls, 1);
    assert.throws(() => readFileSync(join(failedCreate.project, ".memory-space", "config.json")));
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
    const code = await runCli(["init", "--cwd", project, "--space-id", "orphan-space"], {
      cwd: project,
      home: join(directory, "home"),
      env: {},
      clientFactory: () => client,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      writeBinding: async () => {
        throw new CliError("BINDING_WRITE_FAILED", "simulated write failure", {
          remediation: "write the binding manually",
        });
      },
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
    writeFileSync(
      join(project, ".codex", "hooks.json"),
      JSON.stringify({
        command: "pnpm codex:hook",
        token: "codex-super-secret",
      })
    );
    writeFileSync(
      join(project, ".codex", "config.toml"),
      ["[mcp_servers.memory_space]", "token = 'codex-mcp-secret'"].join("\n")
    );
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({
        ...claudeHook(),
        apiKey: "claude-super-secret",
      })
    );
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify(claudeMcp("Bearer claude-mcp-secret"))
    );
    writeFileSync(
      join(project, ".memory-space", "extraction-rules.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "project.frontend.framework",
            family: "knowledge",
            type: "decision",
            key: "project.frontend.framework",
            match: {
              kind: "prefix",
              prefixes: ["前端框架使用"],
              value: "identifier",
            },
            contentTemplate: "前端框架使用 $" + "{value}",
            coreCandidate: true,
          },
        ],
      })
    );
    const result = await cli(["doctor", "--cwd", project, "--json"], {
      cwd: project,
      home,
      client,
    });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout) as { checks: Array<{ id: string; status: string }> };
    assert.equal(parsed.checks.find((item) => item.id === "mcp")?.status, "ok");
    assert.equal(parsed.checks.find((item) => item.id === "codex")?.status, "ok");
    assert.equal(parsed.checks.find((item) => item.id === "claude-code")?.status, "ok");
    assert.equal(parsed.checks.find((item) => item.id === "extraction-rules")?.status, "ok");
    assert.match(result.stdout, /Configured project extraction rules: 1 enabled/u);
    assert.equal(
      parsed.checks.find((item) => item.id === "claude-real-mcp-waiver")?.status,
      "warn"
    );
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
    writeFileSync(
      join(project, ".claude", "settings.local.json"),
      JSON.stringify(claudeHook("pnpm claude-code:hook --local"))
    );
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
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [unrelated]: claudeMcp("Bearer unrelated-secret"),
          [join(project, ".")]: claudeMcp("Bearer current-project-secret"),
        },
      })
    );
    assert.equal(await claudeConfigState(project, home), "detected");

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: { [unrelated]: claudeMcp("Bearer unrelated-secret") },
      })
    );
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
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        ...claudeMcp("Bearer user-scope-api-key"),
        env: { ANTHROPIC_API_KEY: "user-scope-env-secret" },
      })
    );

    const result = await cli(["doctor", "--cwd", project, "--json"], {
      cwd: project,
      home,
      client,
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
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify(claudeHook("pnpm claude-code:hook --project"))
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(claudeHook("pnpm claude-code:hook --user"))
    );
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
      client: offline,
    });
    assert.equal(unbound.code, 1);
    assert.match(unbound.stdout, /"id": "daemon"[\s\S]*"status": "error"/u);
    assert.match(unbound.stdout, /"id": "binding"[\s\S]*"status": "error"/u);
    assert.match(unbound.stdout, /"id": "mcp"[\s\S]*"status": "error"/u);

    const malformedText = "not-json";
    const malformedPath = bind(malformed.project, malformedText);
    const invalid = await cli(["doctor", "--cwd", malformed.project, "--json"], {
      cwd: malformed.project,
    });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stdout, /Project binding is malformed/u);
    assert.equal(readFileSync(malformedPath, "utf8"), malformedText);

    bind(missingSpace.project, { version: 1, spaceId: "missing-space" });
    writeFileSync(join(missingSpace.project, ".memory-space", "extraction-rules.json"), "not-json");
    const mismatchClient = new FakeClient();
    mismatchClient.tools = ["memory_bootstrap", "unexpected_tool"];
    const missing = await cli(["doctor", "--cwd", missingSpace.project, "--json"], {
      cwd: missingSpace.project,
      client: mismatchClient,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Bound Space does not exist/u);
    assert.match(missing.stdout, /file is not valid JSON/u);
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
      createdAt: new Date(0).toISOString(),
    };
    const result = await cli(["status", "--cwd", project, "--json"], {
      cwd: project,
      client,
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
      cwd: unbound.project,
    });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /BINDING_NOT_FOUND/u);

    bind(offline.project, { version: 1, spaceId: "space-offline" });
    const client = new FakeClient();
    addSpace(client, "space-offline");
    client.healthError = new CliError("DAEMON_UNAVAILABLE", "Daemon unavailable.");
    const unavailable = await cli(["status", "--cwd", offline.project], {
      cwd: offline.project,
      client,
    });
    assert.equal(unavailable.code, 1);
    assert.match(unavailable.stderr, /DAEMON_UNAVAILABLE/u);
    assert.equal(client.readCalls, 0);
  } finally {
    rmSync(unbound.directory, { recursive: true, force: true });
    rmSync(offline.directory, { recursive: true, force: true });
  }
});

test("doctor and status expose invalid recall config as effective off without invalidating binding", async () => {
  const { directory, project } = temporaryProject("invalid-recall-status");
  const client = new FakeClient();
  try {
    bind(project, {
      version: 1,
      spaceId: "space-invalid-recall",
      implicitRecall: { mode: "surprise" },
    });
    addSpace(client, "space-invalid-recall");

    const doctor = await cli(["doctor", "--cwd", project, "--json"], {
      cwd: project,
      client,
    });
    assert.equal(doctor.code, 1);
    const checks = (
      JSON.parse(doctor.stdout) as {
        checks: Array<{ id: string; status: string; message: string }>;
      }
    ).checks;
    const recall = checks.find((item) => item.id === "implicit-recall");
    assert.equal(recall?.status, "error");
    assert.match(recall?.message ?? "", /effective mode is off/u);

    const status = await cli(["status", "--cwd", project, "--json"], {
      cwd: project,
      client,
    });
    assert.equal(status.code, 1);
    const report = JSON.parse(status.stdout) as {
      space: { id: string };
      implicitRecall: { effectiveMode: string; source: string; error: string };
    };
    assert.equal(report.space.id, "space-invalid-recall");
    assert.deepEqual(
      {
        effectiveMode: report.implicitRecall.effectiveMode,
        source: report.implicitRecall.source,
      },
      { effectiveMode: "off", source: "invalid" }
    );
    assert.doesNotMatch(status.stdout, /token|authorization|api[_-]?key/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor and status expose missing, explicit, and invalid implicit remember modes", async () => {
  const scenarios = [
    {
      name: "missing",
      implicitRemember: undefined,
      expected: { effectiveMode: "off", source: "default", doctorStatus: "warn", exitCode: 0 },
    },
    {
      name: "off",
      implicitRemember: { mode: "off" },
      expected: { effectiveMode: "off", source: "explicit", doctorStatus: "warn", exitCode: 0 },
    },
    {
      name: "conservative",
      implicitRemember: { mode: "conservative" },
      expected: {
        effectiveMode: "conservative",
        source: "explicit",
        doctorStatus: "ok",
        exitCode: 0,
      },
    },
    {
      name: "invalid",
      implicitRemember: { mode: "semantic" },
      expected: { effectiveMode: "off", source: "invalid", doctorStatus: "error", exitCode: 1 },
    },
  ] as const;
  for (const scenario of scenarios) {
    const { directory, project } = temporaryProject(`remember-${scenario.name}`);
    const client = new FakeClient();
    try {
      bind(project, {
        version: 1,
        spaceId: `space-remember-${scenario.name}`,
        ...(scenario.implicitRemember === undefined
          ? {}
          : { implicitRemember: scenario.implicitRemember }),
      });
      addSpace(client, `space-remember-${scenario.name}`);
      const doctor = await cli(["doctor", "--cwd", project, "--json"], {
        cwd: project,
        client,
      });
      assert.equal(doctor.code, scenario.expected.exitCode);
      const rememberCheck = (
        JSON.parse(doctor.stdout) as {
          checks: Array<{ id: string; status: string; message: string }>;
        }
      ).checks.find((item) => item.id === "implicit-remember");
      assert.equal(rememberCheck?.status, scenario.expected.doctorStatus);
      if (scenario.name === "invalid") {
        assert.match(rememberCheck?.message ?? "", /effective mode is off/u);
      }

      const status = await cli(["status", "--cwd", project, "--json"], {
        cwd: project,
        client,
      });
      assert.equal(status.code, scenario.expected.exitCode);
      const report = JSON.parse(status.stdout) as {
        implicitRemember: { effectiveMode: string; source: string; error?: string };
      };
      assert.equal(report.implicitRemember.effectiveMode, scenario.expected.effectiveMode);
      assert.equal(report.implicitRemember.source, scenario.expected.source);
      if (scenario.name === "invalid") assert.match(report.implicitRemember.error ?? "", /mode/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function evalReport(status: "pass" | "fail"): CrossSessionEvalReport {
  return {
    checks: [{ id: "matrix.codex.codex", label: "Codex → Codex", status }],
    overall: status,
    claudeRealMcp: "waived",
  };
}

function qualityEvalReport(status: "pass" | "fail"): MemoryQualityReport {
  return {
    version: 1,
    summary: {
      extraction: { tp: 1, fp: 0, fn: 0, precision: 1, recall: 1 },
      retrieval: [{ k: 1, precision: 1, recall: 1, queryCount: 1 }],
      negativeRetrieval: {
        queryCount: 0,
        falsePositiveQueries: 0,
        abstainedQueries: 0,
        falsePositiveRate: 0,
        abstentionRate: 1,
        queries: [],
      },
      corePollution: {
        numerator: 0,
        denominator: 1,
        value: 0,
        pollutedKeys: [],
      },
      bootstrap: {
        criticalCoverage: { numerator: 1, denominator: 1, value: 1 },
        missingCriticalKeys: [],
        unexpectedDefaultKeys: [],
        coreItemCount: 1,
        handoffFactCount: 1,
        chars: 100,
        bytes: 100,
      },
      handoff: {
        numerator: 1,
        denominator: 1,
        value: 1,
        missingFacts: [],
        unexpectedFacts: [],
      },
      staleMemory: { numerator: 0, denominator: 1, value: 0, staleKeys: [] },
      duplicateMemory: {
        numerator: 0,
        denominator: 1,
        value: 0,
        groups: [],
      },
      contradiction: { numerator: 1, denominator: 1, value: 1, checks: [] },
      longHorizonSessions: 20,
    },
    correctness: { overall: status, checks: [] },
    scenarios: [],
    failures: [],
  };
}

function p7EvalReport(status: "pass" | "fail"): P7ImplicitRecallReport {
  return {
    version: 1,
    fixtureVersion: 1,
    metrics: {
      bareIdentifierHitRate: 1,
      exactKeyHitRate: 1,
      implicitRecallPrecisionAt1: 1,
      negativeAbstentionRate: 1,
      coreReinjectionRate: 0,
      metadataLeakageRate: 0,
      optOutComplianceRate: 1,
      budgetComplianceRate: 1,
      crossProviderMatrix: { passed: 4, total: 4 },
    },
    scenarios: [],
    hardCorrectness: status,
  };
}

function p8EvalReport(status: "pass" | "fail"): P8ImplicitRememberReport {
  return {
    version: 1,
    fixtureVersion: 1,
    metrics: {
      implicitRememberPrecision: 1,
      implicitCoreWriteRate: 0,
      sameEvidenceDuplicateRate: 0,
      replayDuplicateRate: 0,
      assistantOnlyPersistenceRate: 0,
      lifecycleBlockingFailureRate: 0,
      explicitOptOutViolationRate: 0,
      longAssistantUserEvidenceRetention: "pass",
      checkpointHistoricalReplayCount: 0,
      secretLikeAutoPersistenceRate: 0,
      crossTurnOptOutViolationRate: 0,
    },
    scenarios: [],
    hardCorrectness: status,
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
        },
      },
    });
    assert.equal(success.code, 0);
    assert.equal(calls, 1);
    assert.match(success.stdout, /Overall\s+PASS/u);
    assert.match(success.stdout, /WAIVED/u);

    const failure = await cli(["eval", "cross-session", "--json"], {
      cwd: project,
      dependencies: { evalRunner: async () => evalReport("fail") },
    });
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /"overall": "fail"/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("implicit recall eval CLI is daemon-independent and supports human/JSON output", async () => {
  const { directory, project } = temporaryProject("p7-eval");
  try {
    let calls = 0;
    const human = await cli(["eval", "implicit-recall"], {
      cwd: project,
      dependencies: {
        p7ImplicitRecallEvalRunner: async () => {
          calls += 1;
          return p7EvalReport("pass");
        },
        clientFactory: () => {
          throw new Error("P7 eval must not construct a daemon client");
        },
      },
    });
    assert.equal(human.code, 0, human.stderr);
    assert.equal(calls, 1);
    assert.match(human.stdout, /P7 implicit prompt-time recall eval/u);
    assert.match(human.stdout, /Cross-provider matrix\s+4\/4/u);
    assert.match(human.stdout, /Hard correctness\s+PASS/u);

    const json = await cli(["eval", "implicit-recall", "--json"], {
      cwd: project,
      dependencies: { p7ImplicitRecallEvalRunner: async () => p7EvalReport("fail") },
    });
    assert.equal(json.code, 1);
    assert.equal((JSON.parse(json.stdout) as { hardCorrectness: string }).hardCorrectness, "fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("implicit remember eval CLI is daemon-independent and supports human/JSON output", async () => {
  const { directory, project } = temporaryProject("p8-eval");
  try {
    let calls = 0;
    const human = await cli(["eval", "implicit-remember"], {
      cwd: project,
      dependencies: {
        p8ImplicitRememberEvalRunner: async () => {
          calls += 1;
          return p8EvalReport("pass");
        },
        clientFactory: () => {
          throw new Error("P8 eval must not construct a daemon client");
        },
      },
    });
    assert.equal(human.code, 0, human.stderr);
    assert.equal(calls, 1);
    assert.match(human.stdout, /P8 implicit turn-time remember eval/u);
    assert.match(human.stdout, /Implicit Remember Precision\s+1\.000000/u);
    assert.match(human.stdout, /Hard correctness\s+PASS/u);

    const json = await cli(["eval", "implicit-remember", "--json"], {
      cwd: project,
      dependencies: { p8ImplicitRememberEvalRunner: async () => p8EvalReport("fail") },
    });
    assert.equal(json.code, 1);
    assert.equal((JSON.parse(json.stdout) as { hardCorrectness: string }).hardCorrectness, "fail");
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
        },
      },
    });
    assert.equal(success.code, 0, success.stderr);
    assert.equal(calls, 1);
    assert.match(success.stdout, /Memory Quality v1 — Current evaluation/u);
    assert.match(success.stdout, /observations, not universal PASS\/FAIL thresholds/u);

    const json = await cli(["eval", "quality", "--json"], {
      cwd: project,
      dependencies: { qualityEvalRunner: async () => qualityEvalReport("pass") },
    });
    assert.equal(json.code, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as { version: number }).version, 1);

    const correctnessFailure = await cli(["eval", "quality"], {
      cwd: project,
      dependencies: { qualityEvalRunner: async () => qualityEvalReport("fail") },
    });
    assert.equal(correctnessFailure.code, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quality eval CLI exposes deterministic Stage A comparison in human and JSON forms", async () => {
  const { directory, project } = temporaryProject("quality-comparison");
  try {
    const report = await runStageB1Comparison();
    let calls = 0;
    const human = await cli(["eval", "quality", "--compare-stage-a"], {
      cwd: project,
      dependencies: {
        qualityComparisonRunner: async () => {
          calls += 1;
          return report;
        },
        clientFactory: () => {
          throw new Error("quality comparison must not construct a daemon client");
        },
      },
    });
    assert.equal(human.code, 0, human.stderr);
    assert.equal(calls, 1);
    assert.match(human.stdout, /P6 Stage B1 — Retrieval comparison/u);
    assert.match(human.stdout, /Overall PASS/u);

    const json = await cli(["eval", "quality", "--json", "--compare-stage-a"], {
      cwd: project,
      dependencies: { qualityComparisonRunner: async () => report },
    });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(
      (JSON.parse(json.stdout) as { acceptance: { overall: string } }).acceptance.overall,
      "pass"
    );

    const invalid = await cli(["eval", "cross-session", "--compare-stage-a"], {
      cwd: project,
    });
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /Unknown option/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quality eval CLI exposes a distinct B2 extraction comparison", async () => {
  const { directory, project } = temporaryProject("quality-extraction-comparison");
  try {
    const report = await runStageB2ExtractionComparison();
    let calls = 0;
    const human = await cli(["eval", "quality", "--compare-stage-a-extraction"], {
      cwd: project,
      dependencies: {
        qualityExtractionComparisonRunner: async () => {
          calls += 1;
          return report;
        },
        clientFactory: () => {
          throw new Error("extraction comparison must not construct a daemon client");
        },
      },
    });
    assert.equal(human.code, 0, human.stderr);
    assert.equal(calls, 1);
    assert.match(human.stdout, /P6 Stage B2 — Extraction comparison/u);
    assert.doesNotMatch(human.stdout, /Retrieval comparison/u);
    assert.match(human.stdout, /Overall PASS/u);

    const json = await cli(["eval", "quality", "--compare-stage-a-extraction", "--json"], {
      cwd: project,
      dependencies: { qualityExtractionComparisonRunner: async () => report },
    });
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as {
      contract: { status: string };
      acceptance: { overall: string };
    };
    assert.equal(parsed.contract.status, "pass");
    assert.equal(parsed.acceptance.overall, "pass");

    const ambiguous = await cli(
      ["eval", "quality", "--compare-stage-a", "--compare-stage-a-extraction"],
      { cwd: project }
    );
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /only one Stage A comparison mode/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quality eval CLI exposes a distinct B3 Core/Handoff comparison", async () => {
  const { directory, project } = temporaryProject("quality-core-handoff-comparison");
  try {
    const report = await runStageB3CoreHandoffComparison();
    let calls = 0;
    const human = await cli(["eval", "quality", "--compare-stage-b2-core-handoff"], {
      cwd: project,
      dependencies: {
        qualityCoreHandoffComparisonRunner: async () => {
          calls += 1;
          return report;
        },
        clientFactory: () => {
          throw new Error("Core/Handoff comparison must not construct a daemon client");
        },
      },
    });
    assert.equal(human.code, 0, human.stderr);
    assert.equal(calls, 1);
    assert.match(human.stdout, /P6 Stage B3 — Core\/Handoff comparison/u);
    assert.doesNotMatch(human.stdout, /Retrieval comparison|Extraction comparison/u);
    assert.match(human.stdout, /Overall PASS/u);

    const json = await cli(["eval", "quality", "--compare-stage-b2-core-handoff", "--json"], {
      cwd: project,
      dependencies: { qualityCoreHandoffComparisonRunner: async () => report },
    });
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as { acceptance: { overall: string } };
    assert.equal(parsed.acceptance.overall, "pass");

    const ambiguous = await cli(
      ["eval", "quality", "--compare-stage-a", "--compare-stage-b2-core-handoff"],
      { cwd: project }
    );
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /only one Stage A comparison mode/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("LocalMemorySpaceClient enforces loopback and never retries failed Space writes", async () => {
  assert.throws(
    () => new LocalMemorySpaceClient({ endpoint: "https://memory.example.test" }),
    (error: unknown) => error instanceof CliError && error.code === "DAEMON_ENDPOINT_INVALID"
  );
  let calls = 0;
  const client = new LocalMemorySpaceClient({
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { "content-type": "application/json" });
      return new Response(
        JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch,
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
    },
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
        stderr: (line) => stderr.push(line),
      });
      return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    };

    const initialized = await execute([
      "init",
      "--space-id",
      "real-cli-space",
      "--name",
      "Real CLI Space",
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
