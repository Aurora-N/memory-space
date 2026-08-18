import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    [event("前端框架使用 React。\nFrontend framework: Vue")],
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
    ]
  );
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
