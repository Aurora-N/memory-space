import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySpaceDaemon, type Memory, type MemorySpaceDaemon } from "../src/index.ts";

export type P9ScenarioCategory =
  | "durable"
  | "unsupported"
  | "assistant-only"
  | "transient"
  | "speculative"
  | "sensitive"
  | "opt-out"
  | "cross-turn-opt-out";

export interface P9SemanticScenario {
  scenarioId: string;
  category: P9ScenarioCategory;
  split: "fixture" | "holdout";
  user: string;
  assistant?: string;
  content: string;
  quote?: string;
  family?: "knowledge" | "state";
  type?: string;
  assertion?: "direct" | "uncertain" | "hypothetical";
  durability?: "durable" | "interaction_local";
  evidenceRole?: "user" | "assistant";
  unknownEvent?: boolean;
}

export interface P9SemanticFixture {
  version: 1;
  scenarios: P9SemanticScenario[];
}

export interface P9SemanticScenarioResult {
  scenarioId: string;
  category: P9ScenarioCategory;
  split: "fixture" | "holdout";
  expectedPersistence: boolean;
  persisted: boolean;
  indexedOnly: boolean;
  lifecycleBlocked: boolean;
  modelRequests: number;
  passed: boolean;
}

export interface P9SemanticExtractionReport {
  version: 1;
  fixtureVersion: 1;
  metrics: {
    semanticDurablePrecision: number;
    semanticDurableRecall: number;
    fixtureDurableRecall: number;
    holdoutDurableRecall: number;
    unsupportedClaimPersistenceRate: number;
    assistantOnlySemanticPersistenceRate: number;
    transientSemanticPersistenceRate: number;
    speculativeSemanticPersistenceRate: number;
    sensitiveSemanticPersistenceRate: number;
    optOutSemanticViolationRate: number;
    crossTurnOptOutSemanticViolationRate: number;
    implicitCoreWriteRate: number;
    sameEvidenceDuplicateRate: number;
    checkpointHistoricalReplayCount: number;
    deterministicFallbackSuccessRate: number;
    semanticLifecycleBlockingFailureRate: number;
    crossSessionRecallSuccessRate: number;
  };
  scenarios: P9SemanticScenarioResult[];
  hardCorrectness: "pass" | "fail";
}

interface ModelEvent {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const fixtureUrl = new URL("./fixtures/p9-semantic-extraction.json", import.meta.url);
const categories = new Set<P9ScenarioCategory>([
  "durable",
  "unsupported",
  "assistant-only",
  "transient",
  "speculative",
  "sensitive",
  "opt-out",
  "cross-turn-opt-out",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be string`);
  assert.notEqual(value, "", `${label} must not be empty`);
  return value as string;
}

export function validateP9Fixture(value: unknown): P9SemanticFixture {
  const root = object(value, "fixture");
  assert.equal(root.version, 1);
  assert.ok(Array.isArray(root.scenarios));
  const ids = new Set<string>();
  const seenCategories = new Set<P9ScenarioCategory>();
  const scenarios = root.scenarios.map((raw, index): P9SemanticScenario => {
    const item = object(raw, `scenarios[${index}]`);
    const scenarioId = requiredString(item.scenarioId, `scenarios[${index}].scenarioId`);
    const category = requiredString(
      item.category,
      `scenarios[${index}].category`
    ) as P9ScenarioCategory;
    const split = requiredString(item.split, `scenarios[${index}].split`);
    assert.ok(categories.has(category), `unsupported P9 category: ${category}`);
    assert.ok(split === "fixture" || split === "holdout");
    assert.equal(ids.has(scenarioId), false, `duplicate scenarioId: ${scenarioId}`);
    ids.add(scenarioId);
    seenCategories.add(category);
    return {
      scenarioId,
      category,
      split,
      user: requiredString(item.user, `scenarios[${index}].user`),
      assistant:
        item.assistant === undefined
          ? undefined
          : requiredString(item.assistant, `scenarios[${index}].assistant`),
      content: requiredString(item.content, `scenarios[${index}].content`),
      quote:
        item.quote === undefined
          ? undefined
          : requiredString(item.quote, `scenarios[${index}].quote`),
      family: item.family === "state" ? "state" : "knowledge",
      type: typeof item.type === "string" ? item.type : "fact",
      assertion:
        item.assertion === "uncertain" || item.assertion === "hypothetical"
          ? item.assertion
          : "direct",
      durability: item.durability === "interaction_local" ? "interaction_local" : "durable",
      evidenceRole: item.evidenceRole === "assistant" ? "assistant" : "user",
      unknownEvent: item.unknownEvent === true,
    };
  });
  assert.deepEqual(seenCategories, categories);
  assert.ok(scenarios.filter((item) => item.category === "durable").length >= 7);
  return { version: 1, scenarios };
}

export async function loadP9Fixture(): Promise<P9SemanticFixture> {
  return validateP9Fixture(JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown);
}

function bind(project: string, spaceId: string): void {
  mkdirSync(join(project, ".memory-space"), { recursive: true });
  writeFileSync(
    join(project, ".memory-space", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        spaceId,
        implicitRecall: { mode: "lexical" },
        implicitRemember: { mode: "conservative" },
        semanticExtraction: {
          mode: "grounded",
          model: {
            backend: "external",
            adapter: "openai-compatible",
            baseUrl: "https://semantic.eval.invalid/v1",
            model: "p9-deterministic-fake",
          },
          timeoutMs: 1_000,
        },
      },
      null,
      2
    )}\n`
  );
}

function modelEvents(init?: RequestInit): ModelEvent[] {
  const body = JSON.parse(String(init?.body)) as {
    messages?: Array<{ content?: string }>;
  };
  const input = JSON.parse(body.messages?.[1]?.content ?? "{}") as {
    events?: ModelEvent[];
  };
  return input.events ?? [];
}

function response(candidate?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              schemaVersion: 1,
              candidates: candidate ? [candidate] : [],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function proposal(scenario: P9SemanticScenario, events: ModelEvent[]): Record<string, unknown> {
  const evidenceEvent =
    scenario.unknownEvent === true
      ? undefined
      : events.find(
          (event) =>
            event.role === (scenario.evidenceRole ?? "user") &&
            event.content.includes(scenario.content)
        );
  return {
    family: scenario.family ?? "knowledge",
    type: scenario.type ?? "fact",
    content: scenario.content,
    assertion: scenario.assertion ?? "direct",
    durability: scenario.durability ?? "durable",
    evidence: [
      {
        eventId:
          scenario.unknownEvent === true ? "unknown-event" : (evidenceEvent?.id ?? "missing"),
        quote: scenario.quote ?? scenario.content,
      },
    ],
  };
}

async function start(
  daemon: MemorySpaceDaemon,
  project: string,
  spaceId: string,
  externalSessionId: string
): Promise<void> {
  await daemon.memorySpace.createSpace({ id: spaceId, name: spaceId });
  await daemon.lifecycleHandler.handle({
    type: "session_start",
    provider: "eval",
    externalSessionId,
    cwd: project,
  });
}

async function memories(daemon: MemorySpaceDaemon, spaceId: string): Promise<Memory[]> {
  return (await daemon.memorySpace.browseMemories({ spaceId })).items;
}

async function runScenario(scenario: P9SemanticScenario): Promise<P9SemanticScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), `memory-space-p9-eval-${scenario.scenarioId}-`));
  const project = join(root, "project");
  const spaceId = `p9-${scenario.scenarioId}`;
  const externalSessionId = `p9-${scenario.scenarioId}`;
  mkdirSync(project);
  bind(project, spaceId);
  let requests = 0;
  const daemon = createMemorySpaceDaemon({
    databasePath: join(root, "memory.db"),
    mcpRuntime: { cwd: project },
    semanticFetch: async (_url, init) => {
      requests += 1;
      return response(proposal(scenario, modelEvents(init)));
    },
  });
  let lifecycleBlocked = false;
  try {
    await start(daemon, project, spaceId, externalSessionId);
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "eval",
      externalSessionId,
      cwd: project,
      content: scenario.user,
    });
    const turn = await daemon.lifecycleHandler.handleFailOpen({
      type: "assistant_turn",
      provider: "eval",
      externalSessionId,
      cwd: project,
      content: scenario.assistant ?? "收到。",
    });
    lifecycleBlocked = turn.status !== "ok";
    if (scenario.category === "cross-turn-opt-out") {
      await daemon.lifecycleHandler.handle({
        type: "user_prompt",
        provider: "eval",
        externalSessionId,
        cwd: project,
        content: "继续。",
      });
      const later = await daemon.lifecycleHandler.handleFailOpen({
        type: "assistant_turn",
        provider: "eval",
        externalSessionId,
        cwd: project,
        content: "done",
      });
      lifecycleBlocked ||= later.status !== "ok";
    }
    const stored = await memories(daemon, spaceId);
    const expectedPersistence = scenario.category === "durable";
    const persisted = stored.some((memory) => memory.content === scenario.content);
    const indexedOnly = stored.every((memory) => memory.tier === "indexed");
    return {
      scenarioId: scenario.scenarioId,
      category: scenario.category,
      split: scenario.split,
      expectedPersistence,
      persisted,
      indexedOnly,
      lifecycleBlocked,
      modelRequests: requests,
      passed:
        persisted === expectedPersistence &&
        indexedOnly &&
        !lifecycleBlocked &&
        (scenario.category === "opt-out" ? requests === 0 : true),
    };
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function persistenceRate(
  results: readonly P9SemanticScenarioResult[],
  category: P9ScenarioCategory
): number {
  const selected = results.filter((item) => item.category === category);
  return ratio(selected.filter((item) => item.persisted).length, selected.length);
}

async function runClosureChecks(): Promise<{
  deterministicFallbackSuccessRate: number;
  sameEvidenceDuplicateRate: number;
  checkpointHistoricalReplayCount: number;
  crossSessionRecallSuccessRate: number;
}> {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p9-eval-closure-"));
  const project = join(root, "project");
  const spaceId = "p9-closure";
  mkdirSync(project);
  bind(project, spaceId);
  const variant =
    "上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。";
  let failSemantic = false;
  const daemon = createMemorySpaceDaemon({
    databasePath: join(root, "memory.db"),
    mcpRuntime: { cwd: project },
    semanticFetch: async (_url, init) => {
      if (failSemantic) return new Response("unavailable", { status: 503 });
      const events = modelEvents(init);
      const user = events.find(
        (event) => event.role === "user" && event.content.includes("variant")
      );
      return response(
        user
          ? {
              family: "knowledge",
              type: "fact",
              content: variant,
              assertion: "direct",
              durability: "durable",
              evidence: [{ eventId: user.id, quote: variant }],
            }
          : undefined
      );
    },
  });
  try {
    await start(daemon, project, spaceId, "p9-closure-a");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "eval",
      externalSessionId: "p9-closure-a",
      cwd: project,
      content: variant,
    });
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "eval",
      externalSessionId: "p9-closure-a",
      cwd: project,
      content: "收到。",
    });
    const beforeReplay = (await memories(daemon, spaceId))[0];
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "eval",
      externalSessionId: "p9-closure-a",
      cwd: project,
      content: "收到。",
    });
    const afterReplay = (await memories(daemon, spaceId))[0];
    const sameEvidenceDuplicateRate =
      beforeReplay &&
      afterReplay &&
      beforeReplay.id === afterReplay.id &&
      beforeReplay.version === afterReplay.version
        ? 0
        : 1;
    const beforeCheckpointVersion = afterReplay?.version ?? 0;
    const ended = await daemon.lifecycleHandler.handle({
      type: "session_end",
      provider: "eval",
      externalSessionId: "p9-closure-a",
      cwd: project,
    });
    const afterCheckpoint = (await memories(daemon, spaceId))[0];
    const checkpointHistoricalReplayCount =
      ended.type === "session_end" && ended.checkpoint.status === "completed"
        ? Math.max(0, (afterCheckpoint?.version ?? 0) - beforeCheckpointVersion)
        : 1;

    await daemon.lifecycleHandler.handle({
      type: "session_start",
      provider: "eval",
      externalSessionId: "p9-closure-b",
      cwd: project,
    });
    const recalled = await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "eval",
      externalSessionId: "p9-closure-b",
      cwd: project,
      content: "上传模块的 variant 有什么类型？",
    });
    const crossSessionRecallSuccessRate =
      recalled.type === "user_prompt" && /a、b、c/u.test(recalled.recall?.context ?? "") ? 1 : 0;

    failSemantic = true;
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "eval",
      externalSessionId: "p9-closure-b",
      cwd: project,
      content: "P9_DETERMINISTIC_FALLBACK = works",
    });
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "eval",
      externalSessionId: "p9-closure-b",
      cwd: project,
      content: "done",
    });
    const deterministicFallbackSuccessRate = (await memories(daemon, spaceId)).some(
      (memory) => memory.key === "P9_DETERMINISTIC_FALLBACK"
    )
      ? 1
      : 0;
    return {
      deterministicFallbackSuccessRate,
      sameEvidenceDuplicateRate,
      checkpointHistoricalReplayCount,
      crossSessionRecallSuccessRate,
    };
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runP9SemanticExtractionEval(
  fixture?: P9SemanticFixture
): Promise<P9SemanticExtractionReport> {
  const selected = fixture ?? (await loadP9Fixture());
  const scenarios: P9SemanticScenarioResult[] = [];
  for (const scenario of selected.scenarios) scenarios.push(await runScenario(scenario));
  const durable = scenarios.filter((item) => item.expectedPersistence);
  const persisted = scenarios.filter((item) => item.persisted);
  const fixtureDurable = durable.filter((item) => item.split === "fixture");
  const holdoutDurable = durable.filter((item) => item.split === "holdout");
  const closure = await runClosureChecks();
  const metrics: P9SemanticExtractionReport["metrics"] = {
    semanticDurablePrecision: ratio(
      persisted.filter((item) => item.expectedPersistence).length,
      persisted.length
    ),
    semanticDurableRecall: ratio(durable.filter((item) => item.persisted).length, durable.length),
    fixtureDurableRecall: ratio(
      fixtureDurable.filter((item) => item.persisted).length,
      fixtureDurable.length
    ),
    holdoutDurableRecall: ratio(
      holdoutDurable.filter((item) => item.persisted).length,
      holdoutDurable.length
    ),
    unsupportedClaimPersistenceRate: persistenceRate(scenarios, "unsupported"),
    assistantOnlySemanticPersistenceRate: persistenceRate(scenarios, "assistant-only"),
    transientSemanticPersistenceRate: persistenceRate(scenarios, "transient"),
    speculativeSemanticPersistenceRate: persistenceRate(scenarios, "speculative"),
    sensitiveSemanticPersistenceRate: persistenceRate(scenarios, "sensitive"),
    optOutSemanticViolationRate: persistenceRate(scenarios, "opt-out"),
    crossTurnOptOutSemanticViolationRate: persistenceRate(scenarios, "cross-turn-opt-out"),
    implicitCoreWriteRate: ratio(
      scenarios.filter((item) => !item.indexedOnly).length,
      scenarios.length
    ),
    sameEvidenceDuplicateRate: closure.sameEvidenceDuplicateRate,
    checkpointHistoricalReplayCount: closure.checkpointHistoricalReplayCount,
    deterministicFallbackSuccessRate: closure.deterministicFallbackSuccessRate,
    semanticLifecycleBlockingFailureRate: ratio(
      scenarios.filter((item) => item.lifecycleBlocked).length,
      scenarios.length
    ),
    crossSessionRecallSuccessRate: closure.crossSessionRecallSuccessRate,
  };
  const hardCorrectness =
    metrics.semanticDurablePrecision >= 0.95 &&
    metrics.semanticDurableRecall >= 0.75 &&
    metrics.unsupportedClaimPersistenceRate === 0 &&
    metrics.assistantOnlySemanticPersistenceRate === 0 &&
    metrics.transientSemanticPersistenceRate === 0 &&
    metrics.speculativeSemanticPersistenceRate === 0 &&
    metrics.sensitiveSemanticPersistenceRate === 0 &&
    metrics.optOutSemanticViolationRate === 0 &&
    metrics.crossTurnOptOutSemanticViolationRate === 0 &&
    metrics.implicitCoreWriteRate === 0 &&
    metrics.sameEvidenceDuplicateRate === 0 &&
    metrics.checkpointHistoricalReplayCount === 0 &&
    metrics.deterministicFallbackSuccessRate === 1 &&
    metrics.semanticLifecycleBlockingFailureRate === 0 &&
    metrics.crossSessionRecallSuccessRate === 1 &&
    scenarios.every((item) => item.passed)
      ? "pass"
      : "fail";
  return {
    version: 1,
    fixtureVersion: selected.version,
    metrics,
    scenarios,
    hardCorrectness,
  };
}
