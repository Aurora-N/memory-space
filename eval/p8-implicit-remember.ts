import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckpointPolicy,
  createDefaultMemorySpace,
  ImplicitRememberService,
  LifecycleHandler,
  type Memory,
  type MemorySpace,
  ProviderSessionResolver,
  SpaceResolver,
} from "../src/index.ts";

export type P8ScenarioCategory =
  | "opaque-assignment"
  | "natural-decision"
  | "transient"
  | "assistant-only"
  | "recalled-repetition"
  | "opt-out"
  | "invalid-config"
  | "replay"
  | "stop-checkpoint"
  | "core-collision"
  | "space-mismatch"
  | "long-assistant"
  | "checkpoint-replay"
  | "secret-like"
  | "cross-turn-opt-out";

export interface P8ImplicitRememberScenario {
  scenarioId: string;
  category: P8ScenarioCategory;
  durable: boolean;
  expectedMemoryRows: number;
}

export interface P8ImplicitRememberFixture {
  version: 1;
  scenarios: P8ImplicitRememberScenario[];
}

export interface P8ImplicitRememberScenarioResult {
  scenarioId: string;
  category: P8ScenarioCategory;
  durable: boolean;
  committed: number;
  memoryRows: number;
  coreRows: number;
  blockedLifecycle: boolean;
  replayDuplicateSideEffects: number;
  sameEvidenceDuplicateRows: number;
  optOutViolations: number;
  userEvidenceRetained: boolean;
  checkpointHistoricalReplayCount: number;
  secretLikeAutoPersistence: number;
  crossTurnOptOutViolations: number;
  optedOutEvidenceRejected: boolean;
  passed: boolean;
}

export interface P8ImplicitRememberReport {
  version: 1;
  fixtureVersion: 1;
  metrics: {
    implicitRememberPrecision: number;
    implicitCoreWriteRate: number;
    sameEvidenceDuplicateRate: number;
    replayDuplicateRate: number;
    assistantOnlyPersistenceRate: number;
    lifecycleBlockingFailureRate: number;
    explicitOptOutViolationRate: number;
    longAssistantUserEvidenceRetention: "pass" | "fail";
    checkpointHistoricalReplayCount: number;
    secretLikeAutoPersistenceRate: number;
    crossTurnOptOutViolationRate: number;
  };
  scenarios: P8ImplicitRememberScenarioResult[];
  hardCorrectness: "pass" | "fail";
}

const fixtureUrl = new URL("./fixtures/p8-implicit-remember.json", import.meta.url);
const categories = new Set<P8ScenarioCategory>([
  "opaque-assignment",
  "natural-decision",
  "transient",
  "assistant-only",
  "recalled-repetition",
  "opt-out",
  "invalid-config",
  "replay",
  "stop-checkpoint",
  "core-collision",
  "space-mismatch",
  "long-assistant",
  "checkpoint-replay",
  "secret-like",
  "cross-turn-opt-out",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  );
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value, "", `${label} must not be empty`);
  return value as string;
}

export function validateP8Fixture(value: unknown): P8ImplicitRememberFixture {
  const root = object(value, "fixture");
  assert.equal(root.version, 1, "fixture.version must be 1");
  assert.ok(Array.isArray(root.scenarios), "fixture.scenarios must be an array");
  assert.equal(root.scenarios.length, categories.size, "fixture must cover each required category");
  const ids = new Set<string>();
  const seenCategories = new Set<P8ScenarioCategory>();
  const scenarios = root.scenarios.map((raw, index): P8ImplicitRememberScenario => {
    const item = object(raw, `scenarios[${index}]`);
    const scenarioId = string(item.scenarioId, `scenarios[${index}].scenarioId`);
    const category = string(item.category, `scenarios[${index}].category`) as P8ScenarioCategory;
    assert.ok(categories.has(category), `unsupported P8 category: ${category}`);
    assert.equal(ids.has(scenarioId), false, `duplicate scenarioId: ${scenarioId}`);
    assert.equal(seenCategories.has(category), false, `duplicate P8 category: ${category}`);
    assert.equal(typeof item.durable, "boolean");
    assert.ok(Number.isInteger(item.expectedMemoryRows));
    assert.ok((item.expectedMemoryRows as number) >= 0);
    ids.add(scenarioId);
    seenCategories.add(category);
    return {
      scenarioId,
      category,
      durable: item.durable as boolean,
      expectedMemoryRows: item.expectedMemoryRows as number,
    };
  });
  assert.deepEqual(seenCategories, categories);
  return { version: 1, scenarios };
}

export async function loadP8Fixture(): Promise<P8ImplicitRememberFixture> {
  return validateP8Fixture(JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown);
}

function bind(directory: string, spaceId: string, implicitRemember: unknown): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(
    join(bindingDirectory, "config.json"),
    JSON.stringify({
      version: 1,
      spaceId,
      implicitRecall: { mode: "exact" },
      implicitRemember,
    })
  );
}

function lifecycle(memorySpace: MemorySpace): LifecycleHandler {
  return new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    implicitRemember: new ImplicitRememberService(memorySpace),
  });
}

async function activeMemories(memorySpace: MemorySpace, spaceId: string): Promise<Memory[]> {
  return (await memorySpace.search({ spaceId, query: "", statuses: ["active"] })).map(
    (result) => result.memory
  );
}

async function runScenario(
  scenario: P8ImplicitRememberScenario
): Promise<P8ImplicitRememberScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), `memory-space-p8-eval-${scenario.category}-`));
  const primary = join(root, "primary");
  const other = join(root, "other");
  mkdirSync(primary);
  mkdirSync(other);
  bind(
    primary,
    "p8-primary",
    scenario.category === "invalid-config" ? { mode: "semantic" } : { mode: "conservative" }
  );
  bind(other, "p8-other", { mode: "conservative" });
  const memorySpace = createDefaultMemorySpace();
  const handler = lifecycle(memorySpace);
  let committed = 0;
  let blockedLifecycle = false;
  let replayDuplicateSideEffects = 0;
  let sameEvidenceDuplicateRows = 0;
  let optOutViolations = 0;
  let userEvidenceRetained = true;
  let checkpointHistoricalReplayCount = 0;
  let secretLikeAutoPersistence = 0;
  let crossTurnOptOutViolations = 0;
  let optedOutEvidenceRejected = true;
  try {
    await memorySpace.createSpace({ id: "p8-primary", name: "P8 Primary" });
    await memorySpace.createSpace({ id: "p8-other", name: "P8 Other" });
    const externalSessionId = `eval-${scenario.scenarioId}`;

    if (scenario.category === "assistant-only") {
      const session = await memorySpace.createSession({ spaceId: "p8-primary" });
      const assistant = await memorySpace.appendEvent({
        sessionId: session.id,
        type: "message",
        payload: { role: "assistant", content: "ASSISTANT_ONLY_1 = invented" },
      });
      const result = await new ImplicitRememberService(memorySpace).rememberTurn({
        sessionId: session.id,
        throughEventId: assistant.id,
        mode: "conservative",
      });
      committed = result.committed.length;
    } else {
      if (scenario.category === "recalled-repetition") {
        await memorySpace.remember({
          spaceId: "p8-primary",
          family: "knowledge",
          type: "fact",
          key: "RECALLED_TEST_1",
          content: "RECALLED_TEST_1 = historical",
        });
      }
      if (scenario.category === "core-collision") {
        const stored = await memorySpace.remember({
          spaceId: "p8-primary",
          family: "knowledge",
          type: "fact",
          key: "CORE_COLLISION_1",
          content: "CORE_COLLISION_1 = original",
        });
        await memorySpace.promote(stored.id, { actor: "user" });
      }
      await handler.handle({
        type: "session_start",
        provider: "eval",
        externalSessionId,
        cwd: primary,
      });
      const promptByCategory: Partial<Record<P8ScenarioCategory, string>> = {
        "opaque-assignment": "CROSS_AGENT_TEST_20260817 = lavender-731",
        "natural-decision": "项目已经决定使用 pnpm 作为包管理器。",
        transient: "Task: I am currently checking this file.",
        "recalled-repetition": "RECALLED_TEST_1",
        "opt-out": [
          "Do not remember this turn",
          "x".repeat(30_000),
          "OPT_OUT_TEST_1 = private",
        ].join("\n"),
        "invalid-config": "INVALID_CONFIG_TEST_1 = durable",
        replay: "REPLAY_TEST_1 = durable",
        "stop-checkpoint": "CHECKPOINT_TEST_1 = durable",
        "core-collision": "CORE_COLLISION_1 = changed",
        "space-mismatch": "SPACE_MISMATCH_1 = durable",
        "long-assistant": "LONG_ASSISTANT_TEST_1 = durable",
        "checkpoint-replay": "CHECKPOINT_REPLAY_TEST_1 = v1",
        "secret-like": "OPENAI_API_KEY = secret-eval-value",
        "cross-turn-opt-out":
          "Do not remember this turn\nCROSS_TURN_OPT_OUT_1 = should-not-persist",
      };
      await handler.handle({
        type: "user_prompt",
        provider: "eval",
        externalSessionId,
        cwd: primary,
        content: promptByCategory[scenario.category] ?? "",
      });
      const before = await activeMemories(memorySpace, "p8-primary");
      const response = await handler.handleFailOpen({
        type: "assistant_turn",
        provider: "eval",
        externalSessionId,
        cwd: scenario.category === "space-mismatch" ? other : primary,
        content:
          scenario.category === "recalled-repetition"
            ? "RECALLED_TEST_1 = historical"
            : scenario.category === "long-assistant"
              ? "a".repeat(30_000)
              : "done",
      });
      blockedLifecycle = response.status !== "ok" || response.type !== "assistant_turn";
      if (response.status === "ok" && response.type === "assistant_turn") {
        committed = response.implicitRemember?.committed.length ?? 0;
      }
      if (scenario.category === "replay") {
        const replay = await handler.handle({
          type: "assistant_turn",
          provider: "eval",
          externalSessionId,
          cwd: primary,
          content: "done",
        });
        if (replay.type !== "assistant_turn") throw new Error("Expected replay assistant_turn");
        const memories = await activeMemories(memorySpace, "p8-primary");
        replayDuplicateSideEffects =
          Math.max(0, memories.length - before.length - 1) +
          Math.max(0, (memories[0]?.version ?? 1) - 1);
      }
      if (scenario.category === "stop-checkpoint") {
        const ended = await handler.handle({
          type: "session_end",
          provider: "eval",
          externalSessionId,
          cwd: primary,
        });
        if (ended.type !== "session_end" || ended.checkpoint.status !== "completed") {
          throw new Error("Expected completed SessionEnd checkpoint");
        }
        const memories = await activeMemories(memorySpace, "p8-primary");
        sameEvidenceDuplicateRows = Math.max(0, memories.length - before.length - 1);
      }
      if (scenario.category === "checkpoint-replay") {
        await handler.handle({
          type: "user_prompt",
          provider: "eval",
          externalSessionId,
          cwd: primary,
          content: "CHECKPOINT_REPLAY_TEST_1 = v2",
        });
        await handler.handle({
          type: "assistant_turn",
          provider: "eval",
          externalSessionId,
          cwd: primary,
          content: "done",
        });
        const beforeCheckpoint = (await activeMemories(memorySpace, "p8-primary"))[0];
        const beforeVersion = beforeCheckpoint?.version ?? 0;
        const ended = await handler.handle({
          type: "session_end",
          provider: "eval",
          externalSessionId,
          cwd: primary,
        });
        if (ended.type !== "session_end" || ended.checkpoint.status !== "completed") {
          throw new Error("Expected completed convergence checkpoint");
        }
        const afterCheckpoint = (await activeMemories(memorySpace, "p8-primary"))[0];
        checkpointHistoricalReplayCount = Math.max(
          0,
          (afterCheckpoint?.version ?? 0) - beforeVersion
        );
      }
      if (scenario.category === "cross-turn-opt-out") {
        await handler.handle({
          type: "user_prompt",
          provider: "eval",
          externalSessionId,
          cwd: primary,
          content: "continue",
        });
        const later = await handler.handle({
          type: "assistant_turn",
          provider: "eval",
          externalSessionId,
          cwd: primary,
          content: "done",
        });
        if (later.type !== "assistant_turn") throw new Error("Expected later assistant_turn");
        optedOutEvidenceRejected =
          later.implicitRemember?.rejected.some((item) => item.reason === "opted_out_evidence") ??
          false;
      }
    }

    const memories = await activeMemories(memorySpace, "p8-primary");
    if (scenario.category === "opt-out") optOutViolations = memories.length;
    if (scenario.category === "long-assistant") {
      userEvidenceRetained = memories.length === 1 && memories[0]?.key === "LONG_ASSISTANT_TEST_1";
    }
    if (scenario.category === "secret-like") secretLikeAutoPersistence = memories.length;
    if (scenario.category === "cross-turn-opt-out") {
      crossTurnOptOutViolations = memories.length;
    }
    const coreRows = memories.filter((memory) => memory.tier === "core").length;
    const expectedCoreRows = scenario.category === "core-collision" ? 1 : 0;
    const passed =
      memories.length === scenario.expectedMemoryRows &&
      coreRows === expectedCoreRows &&
      !blockedLifecycle &&
      replayDuplicateSideEffects === 0 &&
      sameEvidenceDuplicateRows === 0 &&
      optOutViolations === 0 &&
      userEvidenceRetained &&
      checkpointHistoricalReplayCount === 0 &&
      secretLikeAutoPersistence === 0 &&
      crossTurnOptOutViolations === 0 &&
      optedOutEvidenceRejected;
    return {
      scenarioId: scenario.scenarioId,
      category: scenario.category,
      durable: scenario.durable,
      committed,
      memoryRows: memories.length,
      coreRows,
      blockedLifecycle,
      replayDuplicateSideEffects,
      sameEvidenceDuplicateRows,
      optOutViolations,
      userEvidenceRetained,
      checkpointHistoricalReplayCount,
      secretLikeAutoPersistence,
      crossTurnOptOutViolations,
      optedOutEvidenceRejected,
      passed,
    };
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function runP8ImplicitRememberEval(
  fixture?: P8ImplicitRememberFixture
): Promise<P8ImplicitRememberReport> {
  fixture ??= await loadP8Fixture();
  const scenarios: P8ImplicitRememberScenarioResult[] = [];
  for (const scenario of fixture.scenarios) scenarios.push(await runScenario(scenario));
  const accepted = scenarios.filter((scenario) => scenario.committed > 0);
  const commits = accepted.reduce((total, scenario) => total + scenario.committed, 0);
  const assistantOnly = scenarios.filter(
    (scenario) =>
      scenario.category === "assistant-only" || scenario.category === "recalled-repetition"
  );
  const lifecycleFailureCases = scenarios.filter(
    (scenario) => scenario.category === "invalid-config" || scenario.category === "space-mismatch"
  );
  const optOutCases = scenarios.filter((scenario) => scenario.category === "opt-out");
  const longAssistantCases = scenarios.filter((scenario) => scenario.category === "long-assistant");
  const secretLikeCases = scenarios.filter((scenario) => scenario.category === "secret-like");
  const crossTurnOptOutCases = scenarios.filter(
    (scenario) => scenario.category === "cross-turn-opt-out"
  );
  return {
    version: 1,
    fixtureVersion: fixture.version,
    metrics: {
      implicitRememberPrecision: ratio(
        accepted.filter((scenario) => scenario.durable).length,
        accepted.length
      ),
      implicitCoreWriteRate: ratio(
        accepted.reduce((total, scenario) => total + scenario.coreRows, 0),
        commits
      ),
      sameEvidenceDuplicateRate: ratio(
        scenarios.reduce((total, scenario) => total + scenario.sameEvidenceDuplicateRows, 0),
        scenarios.filter((scenario) => scenario.category === "stop-checkpoint").length
      ),
      replayDuplicateRate: ratio(
        scenarios.reduce((total, scenario) => total + scenario.replayDuplicateSideEffects, 0),
        scenarios.filter((scenario) => scenario.category === "replay").length
      ),
      assistantOnlyPersistenceRate: ratio(
        assistantOnly.reduce((total, scenario) => total + scenario.committed, 0),
        assistantOnly.length
      ),
      lifecycleBlockingFailureRate: ratio(
        lifecycleFailureCases.filter((scenario) => scenario.blockedLifecycle).length,
        lifecycleFailureCases.length
      ),
      explicitOptOutViolationRate: ratio(
        optOutCases.reduce((total, scenario) => total + scenario.optOutViolations, 0),
        optOutCases.length
      ),
      longAssistantUserEvidenceRetention: longAssistantCases.every(
        (scenario) => scenario.userEvidenceRetained
      )
        ? "pass"
        : "fail",
      checkpointHistoricalReplayCount: scenarios.reduce(
        (total, scenario) => total + scenario.checkpointHistoricalReplayCount,
        0
      ),
      secretLikeAutoPersistenceRate: ratio(
        secretLikeCases.reduce((total, scenario) => total + scenario.secretLikeAutoPersistence, 0),
        secretLikeCases.length
      ),
      crossTurnOptOutViolationRate: ratio(
        crossTurnOptOutCases.reduce(
          (total, scenario) => total + scenario.crossTurnOptOutViolations,
          0
        ),
        crossTurnOptOutCases.length
      ),
    },
    scenarios,
    hardCorrectness: scenarios.every((scenario) => scenario.passed) ? "pass" : "fail",
  };
}
