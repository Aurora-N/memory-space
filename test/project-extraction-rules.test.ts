import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeclarativeRuleExtractor,
  parseProjectExtractionRules,
} from "../src/adapters/declarative-rule-extractor.ts";
import {
  ProjectExtractionRulesInvalidError,
  readProjectExtractionRules,
} from "../src/binding/extraction-rules.ts";
import type { SpaceBinding } from "../src/binding/space-resolver.ts";
import { createDefaultMemorySpace } from "../src/composition.ts";
import { ValidationError } from "../src/domain/errors.ts";
import {
  createMemorySpaceDaemon,
  type ExtractionContext,
  type SessionEvent,
} from "../src/index.ts";
import { ProjectExtractionRuleExtractor } from "../src/integration/project-extraction-rule-extractor.ts";

const valuePlaceholder = "$" + "{value}";

const context: ExtractionContext = {
  trigger: "checkpoint",
  operationId: "checkpoint-project-rules",
  checkpointId: "checkpoint-project-rules",
  session: {
    id: "session-project-rules",
    spaceId: "space-project-rules",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  },
};

function event(text: string): SessionEvent {
  return {
    id: "event-project-rules",
    sessionId: context.session.id,
    type: "message",
    payload: { content: text },
    sequence: 1,
    createdAt: "2026-08-18T00:00:00.000Z",
  };
}

function ruleDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    rules: [
      {
        id: "project.frontend.framework",
        family: "knowledge",
        type: "decision",
        key: "project.frontend.framework",
        match: {
          kind: "prefix",
          prefixes: ["前端框架使用", "Frontend framework:"],
          value: "identifier",
        },
        contentTemplate: `前端框架使用 ${valuePlaceholder}`,
        coreCandidate: true,
        ...overrides,
      },
    ],
  };
}

test("project extraction rules parse a bounded prefix DSL and produce candidates", async () => {
  const parsed = parseProjectExtractionRules(ruleDocument());
  const candidates = await new DeclarativeRuleExtractor(parsed.rules).extract(
    [event("前端框架使用 React。\nFrontend framework: Vue.\nFrontend framework: C++.")],
    context
  );

  assert.deepEqual(
    candidates.map((candidate) => ({
      family: candidate.family,
      type: candidate.type,
      key: candidate.key,
      content: candidate.content,
      recommendedTier: candidate.recommendedTier,
      operation: candidate.operation,
    })),
    [
      {
        family: "knowledge",
        type: "decision",
        key: "project.frontend.framework",
        content: "前端框架使用 React",
        recommendedTier: "core",
        operation: "update",
      },
      {
        family: "knowledge",
        type: "decision",
        key: "project.frontend.framework",
        content: "前端框架使用 Vue",
        recommendedTier: "core",
        operation: "update",
      },
      {
        family: "knowledge",
        type: "decision",
        key: "project.frontend.framework",
        content: "前端框架使用 C++",
        recommendedTier: "core",
        operation: "update",
      },
    ]
  );
});

test("project extraction rules reject every conflicting built-in key schema", () => {
  for (const key of [
    "project.goal.primary",
    "project.roadmap.current",
    "project.progress.current",
    "project.task.current",
  ]) {
    assert.throws(
      () =>
        parseProjectExtractionRules(
          ruleDocument({
            id: `conflict.${key}`,
            family: "knowledge",
            type: "decision",
            key,
          })
        ),
      (error: unknown) =>
        error instanceof ValidationError &&
        /key conflicts with the built-in key schema/u.test(error.message)
    );
  }
});

test("domain-specific database extraction requires explicit project configuration", async () => {
  const parsed = parseProjectExtractionRules({
    version: 1,
    rules: [
      {
        id: "project.database",
        family: "knowledge",
        type: "decision",
        key: "project.database",
        match: {
          kind: "prefix",
          prefixes: ["数据库确定使用", "Database:"],
          value: "identifier",
        },
        contentTemplate: `数据库使用 ${valuePlaceholder}`,
        coreCandidate: true,
      },
    ],
  });
  const candidates = await new DeclarativeRuleExtractor(parsed.rules).extract(
    [event("数据库确定使用 PostgreSQL。")],
    context
  );

  assert.deepEqual(
    candidates.map(({ key, content, recommendedTier }) => ({
      key,
      content,
      recommendedTier,
    })),
    [
      {
        key: "project.database",
        content: "数据库使用 PostgreSQL",
        recommendedTier: "core",
      },
    ]
  );
});

test("project extraction rules reject executable or unbounded matcher shapes", () => {
  assert.throws(
    () =>
      parseProjectExtractionRules(
        ruleDocument({
          match: {
            kind: "regex",
            pattern: ".*",
            prefixes: ["ignored"],
          },
        })
      ),
    (error: unknown) =>
      error instanceof ValidationError && /match\.(?:pattern|kind)/u.test(error.message)
  );
  assert.throws(
    () => parseProjectExtractionRules(ruleDocument({ command: "node arbitrary.js" })),
    (error: unknown) =>
      error instanceof ValidationError && /command is not supported/u.test(error.message)
  );
  assert.throws(
    () =>
      parseProjectExtractionRules({
        ...ruleDocument(),
        rules: [...(ruleDocument().rules as unknown[]), ...(ruleDocument().rules as unknown[])],
      }),
    (error: unknown) =>
      error instanceof ValidationError && /Duplicate extraction rule id/u.test(error.message)
  );
});

test("project extraction rules reject duplicate enabled Memory keys", () => {
  const first = (ruleDocument().rules as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.throws(
    () =>
      parseProjectExtractionRules({
        version: 1,
        rules: [
          first,
          {
            ...first,
            id: "project.frontend.framework.alias",
            match: {
              kind: "prefix",
              prefixes: ["Frontend stack:"],
              value: "identifier",
            },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.message === "Duplicate extraction rule key: project.frontend.framework"
  );

  assert.throws(
    () =>
      parseProjectExtractionRules({
        version: 1,
        rules: [
          first,
          {
            ...first,
            id: "project.frontend.framework.state",
            family: "state",
            type: "task",
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.message === "Duplicate extraction rule key: project.frontend.framework"
  );
});

test("disabled duplicate keys are ignored and one rule may own several prefixes", () => {
  const first = (ruleDocument().rules as Record<string, unknown>[])[0] as Record<string, unknown>;
  const parsed = parseProjectExtractionRules({
    version: 1,
    rules: [
      first,
      {
        ...first,
        id: "project.frontend.framework.disabled",
        enabled: false,
      },
    ],
  });

  assert.equal(parsed.rules.length, 1);
  assert.deepEqual(parsed.rules[0]?.match.prefixes, ["前端框架使用", "Frontend framework:"]);
});

test("coreCandidate remains subject to application admission policy", async () => {
  const parsed = parseProjectExtractionRules(
    ruleDocument({
      id: "project.custom.detail",
      type: "custom_detail",
      key: "project.custom.detail",
    })
  );
  const memorySpace = createDefaultMemorySpace({
    extractor: new DeclarativeRuleExtractor(parsed.rules),
  });
  try {
    const space = await memorySpace.createSpace({ name: "Configured rules" });
    const session = await memorySpace.createSession({ spaceId: space.id });
    const source = await memorySpace.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { content: "前端框架使用 React" },
    });
    await memorySpace.checkpoint({
      sessionId: session.id,
      toEventId: source.id,
      idempotencyKey: "configured-rule-admission",
    });
    const memories = await memorySpace.browseMemories({ spaceId: space.id });
    assert.equal(memories.items.length, 1);
    assert.equal(memories.items[0]?.tier, "indexed");
  } finally {
    await memorySpace.close();
  }
});

test("project rule files reject malformed, oversized, and symlinked input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-space-rules-"));
  const memoryDirectory = join(directory, ".memory-space");
  const configPath = join(memoryDirectory, "config.json");
  const rulesPath = join(memoryDirectory, "extraction-rules.json");
  const binding: SpaceBinding = {
    spaceId: context.session.spaceId,
    source: "config",
    configPath,
  };
  try {
    await mkdir(memoryDirectory, { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 1, spaceId: binding.spaceId }));
    assert.equal((await readProjectExtractionRules(binding)).status, "absent");

    await writeFile(rulesPath, JSON.stringify(ruleDocument()));
    const configured = await readProjectExtractionRules(binding);
    assert.equal(configured.status, "configured");
    assert.equal(configured.rules.length, 1);

    await writeFile(rulesPath, "not-json");
    await assert.rejects(
      readProjectExtractionRules(binding),
      (error: unknown) =>
        error instanceof ProjectExtractionRulesInvalidError &&
        error.reason === "file is not valid JSON"
    );

    await writeFile(rulesPath, "x".repeat(64 * 1024 + 1));
    await assert.rejects(
      readProjectExtractionRules(binding),
      (error: unknown) =>
        error instanceof ProjectExtractionRulesInvalidError &&
        /exceeds 65536 bytes/u.test(error.reason)
    );

    await rm(rulesPath);
    const target = join(directory, "outside-rules.json");
    await writeFile(target, JSON.stringify(ruleDocument()));
    await symlink(target, rulesPath);
    await assert.rejects(
      readProjectExtractionRules(binding),
      (error: unknown) =>
        error instanceof ProjectExtractionRulesInvalidError && /non-symlink/u.test(error.reason)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("project rule injection is disabled for explicit or mismatched Space identity", async () => {
  let loads = 0;
  const loadRules = async (): Promise<{
    status: "configured";
    path: string;
    rules: ReturnType<typeof parseProjectExtractionRules>["rules"];
  }> => {
    loads += 1;
    return {
      status: "configured",
      path: "/project/.memory-space/extraction-rules.json",
      rules: parseProjectExtractionRules(ruleDocument()).rules,
    };
  };
  const resolver = {
    async resolve(): Promise<SpaceBinding> {
      return {
        spaceId: "another-space",
        source: "config",
        configPath: "/project/.memory-space/config.json",
      };
    },
  };
  const mismatched = new ProjectExtractionRuleExtractor({
    cwd: "/project",
    spaceResolver: resolver,
    loadRules,
  });
  assert.deepEqual(await mismatched.extract([event("前端框架使用 React")], context), []);
  assert.equal(loads, 0);

  const explicit = new ProjectExtractionRuleExtractor({
    cwd: "/project",
    explicitSpaceId: context.session.spaceId,
    spaceResolver: resolver,
    loadRules,
  });
  assert.deepEqual(await explicit.extract([event("前端框架使用 React")], context), []);
  assert.equal(loads, 0);
});

test("default daemon composition applies matching project rules at checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-space-rules-daemon-"));
  const project = join(directory, "project");
  const memoryDirectory = join(project, ".memory-space");
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(
    join(memoryDirectory, "config.json"),
    JSON.stringify({ version: 1, spaceId: "configured-rule-space" })
  );
  await writeFile(join(memoryDirectory, "extraction-rules.json"), JSON.stringify(ruleDocument()));
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "memory.db"),
    mcpRuntime: { cwd: project },
  });
  try {
    await daemon.listen();
    await daemon.memorySpace.createSpace({
      id: "configured-rule-space",
      name: "Configured rule space",
    });
    const common = {
      session_id: "configured-rule-native-session",
      transcript_path: join(directory, "opaque-transcript.jsonl"),
      cwd: project,
    };
    const started = await daemon.codexIntegration.handleNative({
      ...common,
      hook_event_name: "SessionStart",
      source: "startup",
    });
    assert.equal(started.status, "ok");
    const prompted = await daemon.codexIntegration.handleNative({
      ...common,
      hook_event_name: "UserPromptSubmit",
      turn_id: "configured-rule-turn",
      prompt: "前端框架使用 React。",
    });
    assert.equal(prompted.status, "ok");
    const checkpointed = await daemon.codexIntegration.handleNative({
      ...common,
      hook_event_name: "PreCompact",
      turn_id: "configured-rule-turn",
      trigger: "manual",
    });
    assert.equal(checkpointed.status, "ok");

    const memories = await daemon.memorySpace.browseMemories({
      spaceId: "configured-rule-space",
    });
    assert.deepEqual(
      memories.items.map(({ key, content, tier }) => ({ key, content, tier })),
      [
        {
          key: "project.frontend.framework",
          content: "前端框架使用 React",
          tier: "core",
        },
      ]
    );
  } finally {
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface ProviderRuleCheckpointFixture {
  directory: string;
  project: string;
  memoryDirectory: string;
  configPath: string;
  rulesPath: string;
  daemon: ReturnType<typeof createMemorySpaceDaemon>;
  common: {
    session_id: string;
    transcript_path: string;
    cwd: string;
  };
  internalSessionId: string;
}

async function providerRuleCheckpointFixture(name: string): Promise<ProviderRuleCheckpointFixture> {
  const directory = await mkdtemp(join(tmpdir(), `memory-space-rules-${name}-`));
  const project = join(directory, "project");
  const memoryDirectory = join(project, ".memory-space");
  const configPath = join(memoryDirectory, "config.json");
  const rulesPath = join(memoryDirectory, "extraction-rules.json");
  await mkdir(memoryDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({ version: 1, spaceId: "space-a" }));
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "memory.db"),
    mcpRuntime: { cwd: project },
  });
  await daemon.memorySpace.createSpace({ id: "space-a", name: "Project A" });
  const common = {
    session_id: `${name}-native-session`,
    transcript_path: join(directory, "opaque-transcript.jsonl"),
    cwd: project,
  };
  const started = await daemon.codexIntegration.handleNative({
    ...common,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  if (started.status !== "ok") throw new Error("Expected provider Session to start");
  const prompted = await daemon.codexIntegration.handleNative({
    ...common,
    hook_event_name: "UserPromptSubmit",
    turn_id: `${name}-turn`,
    prompt: "前端框架使用 React。",
  });
  assert.equal(prompted.status, "ok");
  return {
    directory,
    project,
    memoryDirectory,
    configPath,
    rulesPath,
    daemon,
    common,
    internalSessionId: started.sessionId,
  };
}

async function checkpointProviderRuleFixture(
  fixture: ProviderRuleCheckpointFixture
): Promise<void> {
  const checkpointed = await fixture.daemon.codexIntegration.handleNative({
    ...fixture.common,
    hook_event_name: "PreCompact",
    turn_id: `${fixture.common.session_id}-checkpoint`,
    trigger: "manual",
  });
  assert.equal(checkpointed.status, "ok");
}

async function closeProviderRuleFixture(fixture: ProviderRuleCheckpointFixture): Promise<void> {
  await fixture.daemon.close();
  await rm(fixture.directory, { recursive: true, force: true });
}

test("old provider Session cannot consume rules after its exact config path is rebound", async () => {
  const fixture = await providerRuleCheckpointFixture("rebound-binding");
  try {
    await fixture.daemon.memorySpace.createSpace({ id: "space-b", name: "Project B" });
    await writeFile(fixture.configPath, JSON.stringify({ version: 1, spaceId: "space-b" }));
    await writeFile(fixture.rulesPath, JSON.stringify(ruleDocument()));

    await checkpointProviderRuleFixture(fixture);

    const spaceA = await fixture.daemon.memorySpace.browseMemories({ spaceId: "space-a" });
    const spaceB = await fixture.daemon.memorySpace.browseMemories({ spaceId: "space-b" });
    assert.deepEqual(spaceA.items, []);
    assert.deepEqual(spaceB.items, []);
  } finally {
    await closeProviderRuleFixture(fixture);
  }
});

test("old provider Session does not fall back to cwd when its persisted config is removed", async () => {
  const fixture = await providerRuleCheckpointFixture("removed-binding");
  try {
    await writeFile(fixture.rulesPath, JSON.stringify(ruleDocument()));
    const fallbackDirectory = join(fixture.directory, ".memory-space");
    await mkdir(fallbackDirectory);
    await writeFile(
      join(fallbackDirectory, "config.json"),
      JSON.stringify({ version: 1, spaceId: "space-a" })
    );
    await writeFile(
      join(fallbackDirectory, "extraction-rules.json"),
      JSON.stringify(ruleDocument())
    );
    await unlink(fixture.configPath);

    await checkpointProviderRuleFixture(fixture);

    const memories = await fixture.daemon.memorySpace.browseMemories({ spaceId: "space-a" });
    assert.deepEqual(memories.items, []);
  } finally {
    await closeProviderRuleFixture(fixture);
  }
});

test("old provider Session does not fall back to cwd when its persisted config is malformed", async () => {
  const fixture = await providerRuleCheckpointFixture("malformed-binding");
  try {
    await writeFile(fixture.rulesPath, JSON.stringify(ruleDocument()));
    await writeFile(fixture.configPath, "{broken");

    await checkpointProviderRuleFixture(fixture);

    const memories = await fixture.daemon.memorySpace.browseMemories({ spaceId: "space-a" });
    assert.deepEqual(memories.items, []);
  } finally {
    await closeProviderRuleFixture(fixture);
  }
});

test("provider Session hot-reloads rules while its exact binding still owns the Space", async () => {
  const fixture = await providerRuleCheckpointFixture("hot-reload");
  try {
    await writeFile(fixture.rulesPath, JSON.stringify(ruleDocument()));

    await checkpointProviderRuleFixture(fixture);

    const memories = await fixture.daemon.memorySpace.browseMemories({ spaceId: "space-a" });
    assert.deepEqual(
      memories.items.map(({ key, content, tier }) => ({ key, content, tier })),
      [
        {
          key: "project.frontend.framework",
          content: "前端框架使用 React",
          tier: "core",
        },
      ]
    );
  } finally {
    await closeProviderRuleFixture(fixture);
  }
});

test("owned malformed rule files remain fail-open for lifecycle and fail-visible explicitly", async () => {
  const fixture = await providerRuleCheckpointFixture("malformed-rules");
  try {
    await writeFile(fixture.rulesPath, "not-json");

    const lifecycle = await fixture.daemon.codexIntegration.handleNative({
      ...fixture.common,
      hook_event_name: "PreCompact",
      turn_id: "malformed-rules-turn",
      trigger: "manual",
    });
    assert.equal(lifecycle.status, "warning");
    if (lifecycle.status === "warning") {
      assert.equal(lifecycle.warning.error.code, "EXTRACTION_RULES_INVALID");
      assert.equal(lifecycle.warning.nonBlocking, true);
    }

    await assert.rejects(
      fixture.daemon.memorySpace.checkpoint({
        sessionId: fixture.internalSessionId,
        idempotencyKey: "malformed-rules-explicit",
      }),
      (error: unknown) =>
        error instanceof ProjectExtractionRulesInvalidError &&
        error.reason === "file is not valid JSON"
    );
  } finally {
    await closeProviderRuleFixture(fixture);
  }
});

test("provider Session keeps its project rule binding across daemon restart and cwd changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-space-rules-multi-project-"));
  const projectA = join(directory, "project-a");
  const projectB = join(directory, "project-b");
  const databasePath = join(directory, "memory.db");
  await mkdir(join(projectA, ".memory-space"), { recursive: true });
  await mkdir(join(projectB, ".memory-space"), { recursive: true });
  await writeFile(
    join(projectA, ".memory-space", "config.json"),
    JSON.stringify({ version: 1, spaceId: "space-a" })
  );
  await writeFile(
    join(projectB, ".memory-space", "config.json"),
    JSON.stringify({ version: 1, spaceId: "space-b" })
  );
  await writeFile(
    join(projectB, ".memory-space", "extraction-rules.json"),
    JSON.stringify(ruleDocument())
  );

  const first = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath,
    mcpRuntime: { cwd: projectA },
  });
  try {
    await first.memorySpace.createSpace({ id: "space-a", name: "Project A" });
    await first.memorySpace.createSpace({ id: "space-b", name: "Project B" });
    const common = {
      session_id: "multi-project-native-session",
      transcript_path: join(directory, "opaque-transcript.jsonl"),
      cwd: projectB,
    };
    assert.equal(
      (
        await first.codexIntegration.handleNative({
          ...common,
          hook_event_name: "SessionStart",
          source: "startup",
        })
      ).status,
      "ok"
    );
    assert.equal(
      (
        await first.codexIntegration.handleNative({
          ...common,
          hook_event_name: "UserPromptSubmit",
          turn_id: "multi-project-turn",
          prompt: "前端框架使用 React。",
        })
      ).status,
      "ok"
    );
  } finally {
    await first.close();
  }

  const reopened = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath,
    mcpRuntime: { cwd: projectA },
  });
  try {
    const checkpointed = await reopened.codexIntegration.handleNative({
      session_id: "multi-project-native-session",
      transcript_path: join(directory, "opaque-transcript.jsonl"),
      cwd: projectA,
      hook_event_name: "PreCompact",
      turn_id: "multi-project-turn",
      trigger: "manual",
    });
    assert.equal(checkpointed.status, "ok");
    const memories = await reopened.memorySpace.browseMemories({ spaceId: "space-b" });
    assert.deepEqual(
      memories.items.map(({ key, content }) => ({ key, content })),
      [
        {
          key: "project.frontend.framework",
          content: "前端框架使用 React",
        },
      ]
    );
  } finally {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});
