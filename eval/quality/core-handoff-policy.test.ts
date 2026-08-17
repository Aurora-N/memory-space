import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAcceptedB3Baseline,
  assertB3FixtureContract,
  loadStageB2CoreHandoffBaseline,
  normalizeB3FixtureContract,
  stageB2CoreHandoffBaselineSchema
} from "./core-handoff-baseline.ts";
import {
  formatStageB3CoreHandoffComparison,
  runStageB3CoreHandoffComparison
} from "./core-handoff-comparison.ts";
import { runB3PolicyEvaluation } from "./core-handoff-policy-eval.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import { runMemoryQualityEval } from "./runner.ts";

const corePolicyModule = "../../src/application/core-admission-policy.ts";
const handoffPolicyModule = "../../src/application/handoff-policy.ts";

test("pure Core admission policy keeps reason precedence and structural bounded-local scope", async () => {
  const policy = await import(corePolicyModule);
  const base = {
    family: "state",
    type: "task",
    key: "task.release",
    content: "Coordinate the cross-Session release rollout.",
    confidence: 1,
    importance: 0.5,
    recommendedTier: "core",
    promoteReason: "Required across Sessions",
    sourceEventIds: ["event"],
    operation: "create"
  };

  assert.deepEqual(policy.decideCoreAdmission(base), { tier: "core", reason: "eligible" });
  assert.deepEqual(policy.decideCoreAdmission({ ...base, importance: 0, confidence: 0 }), {
    tier: "core",
    reason: "eligible"
  });
  assert.deepEqual(policy.decideCoreAdmission({
    ...base,
    content: "Remove the generated report after this run.",
    recommendedTier: "indexed",
    promoteReason: undefined
  }), { tier: "indexed", reason: "bounded-local" });
  assert.deepEqual(policy.decideCoreAdmission({ ...base, recommendedTier: "indexed" }), {
    tier: "indexed",
    reason: "not-recommended"
  });
  assert.deepEqual(policy.decideCoreAdmission({ ...base, promoteReason: undefined }), {
    tier: "indexed",
    reason: "missing-promotion-reason"
  });
  assert.deepEqual(policy.decideCoreAdmission({
    ...base,
    family: "episode",
    type: "episode"
  }), { tier: "indexed", reason: "type-ineligible" });

  const boundedParaphrases = [
    "Delete the sandbox output after this command.",
    "This blocker applies only during the current tool call.",
    "本次测试完成后删除临时输出。",
    "这个问题只影响当前这一轮运行。"
  ];
  for (const content of boundedParaphrases) {
    assert.equal(policy.isBoundedLocalWorkingState({ ...base, content }), true, content);
  }
  assert.equal(policy.isBoundedLocalWorkingState({
    ...base,
    content: "Finish the rollout before the release window."
  }), false);
  assert.equal(policy.isBoundedLocalWorkingState({
    ...base,
    type: "decision",
    content: "Run this migration after this test."
  }), false);
});

test("pure promotion provenance and Handoff policy fail closed and use one task eligibility rule", async () => {
  const corePolicy = await import(corePolicyModule);
  const handoffPolicy = await import(handoffPolicyModule);
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote:automatic"), "AUTOMATIC");
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote:explicit-agent"), "EXPLICIT_AGENT");
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote:explicit-user"), "EXPLICIT_USER");
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote"), "AMBIGUOUS_LEGACY");
  assert.equal(corePolicy.promotionProvenanceFromOperation("unknown"), "AMBIGUOUS_LEGACY");

  const now = "2026-08-17T00:00:00.000Z";
  const memory = {
    id: "task",
    spaceId: "space",
    family: "state",
    type: "task",
    key: "task.cleanup",
    content: "Remove the generated file after this run.",
    data: { nextSteps: ["Delete the file.", "", 7] },
    tier: "core",
    status: "active",
    importance: 0.5,
    confidence: 1,
    version: 2,
    createdAt: now,
    updatedAt: now
  };
  const legacyHistory = [{
    id: 1,
    memoryId: memory.id,
    operation: "promote",
    before: { ...memory, tier: "indexed", version: 1 },
    after: memory,
    sourceEventIds: [],
    createdAt: now
  }];
  const explicitHistory = [{ ...legacyHistory[0], operation: "promote:explicit-agent" }];
  assert.equal(handoffPolicy.isHandoffContinuationTask(memory, legacyHistory), false);
  assert.equal(handoffPolicy.isHandoffContinuationTask(memory, explicitHistory), true);
  assert.deepEqual(handoffPolicy.handoffTaskValues(memory, explicitHistory), {
    activeTask: memory.content,
    nextSteps: [memory.content, "Delete the file."]
  });
});

test("pure Handoff working-state policy applies one provenance boundary to task, blocker, and question", async () => {
  const corePolicy = await import(corePolicyModule);
  const handoffPolicy = await import(handoffPolicyModule);
  const now = "2026-08-17T00:00:00.000Z";
  const memory = (input: {
    id: string;
    type: string;
    content: string;
    tier?: string;
    status?: string;
    data?: Record<string, unknown>;
  }) => ({
    id: input.id,
    spaceId: "space",
    family: "state",
    type: input.type,
    key: `operation.${input.type}.${input.id}`,
    content: input.content,
    ...(input.data === undefined ? {} : { data: input.data }),
    tier: input.tier ?? "core",
    status: input.status ?? "active",
    importance: 0.5,
    confidence: 1,
    version: 2,
    createdAt: now,
    updatedAt: now
  });
  const history = (value: ReturnType<typeof memory>, operation?: string) => operation === undefined
    ? []
    : [{
      id: 1,
      memoryId: value.id,
      operation,
      before: { ...value, tier: "indexed", version: 1 },
      after: value,
      sourceEventIds: [],
      createdAt: now
    }];

  const boundedTask = memory({
    id: "task",
    type: "task",
    content: "Remove the generated file after this run."
  });
  const boundedBlocker = memory({
    id: "blocker",
    type: "blocker",
    content: "This blocker applies only during the current tool call.",
    data: { nextStep: "blocker injection" }
  });
  const boundedQuestion = memory({
    id: "question",
    type: "question",
    content: "这个问题只影响当前这一轮运行。",
    data: { nextSteps: ["question injection"] }
  });
  const durableBlocker = memory({
    id: "durable-blocker",
    type: "blocker",
    content: "The release is blocked on production credentials."
  });
  const durableQuestion = memory({
    id: "durable-question",
    type: "question",
    content: "Which release window is approved?"
  });
  const progress = memory({
    id: "progress",
    type: "progress",
    content: "The project rollout is underway.",
    data: { nextStep: "progress injection" }
  });
  const indexedBlocker = memory({
    id: "indexed-blocker",
    type: "blocker",
    content: "The release remains blocked.",
    tier: "indexed"
  });
  const inactiveQuestion = memory({
    id: "inactive-question",
    type: "question",
    content: "Which release window was approved?",
    status: "resolved"
  });

  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedTask, history(boundedTask, "promote")
  ), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedBlocker, history(boundedBlocker, "promote:automatic")
  ), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedBlocker, history(boundedBlocker)
  ), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedQuestion, history(boundedQuestion, "promote:unknown")
  ), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedBlocker, history(boundedBlocker, "promote:explicit-agent")
  ), true);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(
    boundedQuestion, history(boundedQuestion, "promote:explicit-user")
  ), true);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(durableBlocker, []), true);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(durableQuestion, []), true);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(indexedBlocker, []), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(inactiveQuestion, []), false);
  assert.equal(handoffPolicy.isHandoffContinuationWorkingState(progress, []), false);
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote"), "AMBIGUOUS_LEGACY");
  assert.equal(corePolicy.promotionProvenanceFromOperation("promote:unknown"), "AMBIGUOUS_LEGACY");

  const histories = new Map([
    [boundedBlocker.id, history(boundedBlocker, "promote")],
    [boundedQuestion.id, history(boundedQuestion, "promote:explicit-user")]
  ]);
  const projection = handoffPolicy.buildHandoffProjection({
    activeCore: [
      boundedBlocker,
      boundedQuestion,
      durableBlocker,
      durableQuestion,
      progress,
      indexedBlocker,
      inactiveQuestion
    ],
    completedTasks: [],
    historiesByMemoryId: histories
  });
  assert.deepEqual(projection.blockers, [durableBlocker.content]);
  assert.deepEqual(projection.openQuestions, [boundedQuestion.content, durableQuestion.content]);
  assert.deepEqual(projection.activeTasks, []);
  assert.deepEqual(projection.nextSteps, []);
});

test("C1-C22, promotion provenance, prospective transitions, seeded upgrade, and H1-H4 all pass", async () => {
  const report = await runB3PolicyEvaluation();
  assert.deepEqual(report.cases.map((item) => item.id),
    Array.from({ length: 22 }, (_, index) => `C${index + 1}`));
  assert.deepEqual(report.cases.filter((item) => item.status === "fail"), []);
  assert.deepEqual(report.promotionProvenance.filter((item) => item.status === "fail"), []);
  assert.deepEqual(report.prospectiveTransitions.filter((item) => item.status === "fail"), []);
  assert.deepEqual(report.seededUpgrade.filter((item) => item.status === "fail"), []);
  assert.deepEqual(report.workingStateProvenance.map((item) => item.id), ["H1", "H2", "H3", "H4"]);
  assert.deepEqual(report.workingStateProvenance.filter((item) => item.status === "fail"), []);
});

test("accepted B2 Core/Handoff baseline matches the live frozen fixture contract", async () => {
  const [baseline, fixtures] = await Promise.all([
    loadStageB2CoreHandoffBaseline(),
    loadQualityFixtures()
  ]);
  assert.equal(baseline.sourceCommit, "e0ff2ac0248920c7c853162e4ea2f09dd2b7d260");
  assert.equal(baseline.fixture.steps.length, 20);
  assert.deepEqual(normalizeB3FixtureContract(fixtures.longHorizon), baseline.fixture);
  assert.equal(baseline.acceptedResult.corePollution.value, 1 / 9);
  assert.deepEqual(baseline.acceptedResult.corePollution.pollutedKeys, [
    "task.temporary-debug-cleanup"
  ]);
  assert.equal(baseline.acceptedResult.handoff.unexpectedFacts.length, 2);
  assert.deepEqual(baseline.seededUpgrade.history.map((entry) => entry.semanticPromotionProvenance), [
    null,
    "AMBIGUOUS_LEGACY"
  ]);
});

test("B3 baseline rejects immutable result and upgrade-state mutation", async () => {
  const baseline = await loadStageB2CoreHandoffBaseline();
  const mutations: Array<[string, (value: typeof baseline) => void]> = [
    ["accepted metric", (value) => { value.acceptedResult.corePollution.value = 0; }],
    ["correctness status", (value) => {
      (value.acceptedResult.correctness.checks[0] as { status: string }).status = "fail";
    }],
    ["Handoff expected set", (value) => { value.expectedHandoffFacts.reverse(); }],
    ["upgrade tier", (value) => { (value.seededUpgrade.memory as { tier: string }).tier = "indexed"; }],
    ["upgrade version", (value) => { value.seededUpgrade.memory.version += 1; }],
    ["upgrade history", (value) => { value.seededUpgrade.history[1]!.operation = "promote:explicit-user"; }],
    ["upgrade provenance", (value) => { value.seededUpgrade.history[1]!.semanticPromotionProvenance = "EXPLICIT_USER"; }],
    ["upgrade latest Handoff", (value) => { value.seededUpgrade.latestHandoff.nextSteps = []; }]
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(
      () => assertAcceptedB3Baseline(changed),
      /baseline mutation/u,
      label
    );
  }
  const wrongVersion = { ...baseline, version: 2 };
  assert.equal(stageB2CoreHandoffBaselineSchema.safeParse(wrongVersion).success, false);
  const wrongCommit = { ...baseline, sourceCommit: "wrong" };
  assert.equal(stageB2CoreHandoffBaselineSchema.safeParse(wrongCommit).success, false);
});

test("B3 fixture contract rejects every frozen transition and source-mode mutation", async () => {
  const baseline = await loadStageB2CoreHandoffBaseline();
  type Mutable = Record<string, unknown>;
  const mutationCases: Array<[string, (fixture: Mutable) => void]> = [
    ["event text", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      (action.events as string[])[0] = "mutated evidence";
    }],
    ["event order", (fixture) => {
      const steps = fixture.steps as Mutable[];
      [steps[0], steps[1]] = [steps[1]!, steps[0]!];
    }],
    ["event set", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      (action.events as string[]).push("additional evidence");
    }],
    ["event removed", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      (action.events as string[]).pop();
    }],
    ["logical key", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).logicalKey = "mutated.logical.key";
    }],
    ["family", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).family = "episode";
    }],
    ["type", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).type = "question";
    }],
    ["key", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).key = "mutated.key";
    }],
    ["content", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).content = "mutated content";
    }],
    ["status", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).status = "archived";
    }],
    ["Core label", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      const memory = (action.expectedMemories as Mutable[])[0]!;
      memory.shouldBeCore = !memory.shouldBeCore;
    }],
    ["critical set", (fixture) => { (fixture.criticalBootstrapKeys as string[]).reverse(); }],
    ["scenario set", (fixture) => { (fixture.steps as Mutable[]).pop(); }],
    ["promote true", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => value.sourceMode === "explicit-remember"
          && (value.explicitMemory as Mutable).promote === false)!;
      (action.explicitMemory as Mutable).promote = true;
    }],
    ["promote false", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => value.sourceMode === "explicit-remember"
          && (value.explicitMemory as Mutable).promote === true)!;
      (action.explicitMemory as Mutable).promote = false;
    }],
    ["promote removed/default drift", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => value.sourceMode === "explicit-remember")!;
      delete (action.explicitMemory as Mutable).promote;
    }],
    ["status change", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => value.sourceMode === "status-change")!;
      (action.statusChange as Mutable).reason = "mutated reason";
    }],
    ["status change added", (fixture) => {
      const steps = fixture.steps as Mutable[];
      const source = steps.flatMap((step) => step.actions as Mutable[])
        .find((value) => value.sourceMode === "status-change")!;
      (steps[0]!.actions as Mutable[]).unshift(structuredClone(source));
    }],
    ["status change removed", (fixture) => {
      const step = (fixture.steps as Mutable[]).find((value) =>
        (value.actions as Mutable[]).some((action) => action.sourceMode === "status-change"))!;
      const index = (step.actions as Mutable[]).findIndex((value) => value.sourceMode === "status-change");
      (step.actions as Mutable[]).splice(index, 1);
    }],
    ["status change order", (fixture) => {
      const step = (fixture.steps as Mutable[]).find((value) =>
        (value.actions as Mutable[]).length > 1
          && (value.actions as Mutable[]).some((action) => action.sourceMode === "status-change"))!;
      (step.actions as Mutable[]).reverse();
    }],
    ["candidate operation", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      ((action.expectedMemories as Mutable[])[0]!).candidateOperation = "ignore";
    }],
    ["transition order", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => (value.transitionOperations as string[]).length > 1)!;
      (action.transitionOperations as string[]).reverse();
    }],
    ["transition added", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => (value.transitionOperations as string[]).length > 1)!;
      (action.transitionOperations as string[]).push("demote");
    }],
    ["transition removed", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => (value.transitionOperations as string[]).length > 1)!;
      (action.transitionOperations as string[]).pop();
    }],
    ["source mode", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      action.sourceMode = "checkpoint-structured-memory";
    }],
    ["checkpoint to explicit source", (fixture) => {
      const action = (((fixture.steps as Mutable[])[0]!.actions as Mutable[]).at(-1)!);
      action.sourceMode = "explicit-remember";
    }],
    ["promotion provenance", (fixture) => {
      const action = (fixture.steps as Mutable[])
        .flatMap((step) => step.actions as Mutable[])
        .find((value) => value.requestedPromotionProvenance === "EXPLICIT_USER")!;
      action.requestedPromotionProvenance = "AUTOMATIC";
    }]
  ];

  for (const [label, mutate] of mutationCases) {
    const changed = structuredClone(baseline.fixture) as unknown as Mutable;
    mutate(changed);
    assert.throws(
      () => assertB3FixtureContract(baseline.fixture, changed as never),
      /fixture contract mutation/u,
      label
    );
  }
});

test("B3 comparison rejects fixture drift before candidate policy or metrics run", async () => {
  const fixtures = await loadQualityFixtures();
  const changed = structuredClone(fixtures);
  changed.longHorizon.steps[0]!.events![0] = "mutated before comparison";
  let policyRan = false;
  let qualityRan = false;
  await assert.rejects(
    runStageB3CoreHandoffComparison(
      async () => {
        policyRan = true;
        return runB3PolicyEvaluation();
      },
      async () => {
        qualityRan = true;
        return runMemoryQualityEval();
      },
      { fixtureLoader: async () => changed }
    ),
    /fixture contract mutation/u
  );
  assert.equal(policyRan, false);
  assert.equal(qualityRan, false);
});

test("B3 comparison is deterministic, case-complete, and passes the frozen delta gate", async () => {
  const first = await runStageB3CoreHandoffComparison();
  const second = await runStageB3CoreHandoffComparison();
  assert.deepEqual(second, first);
  assert.equal(first.acceptance.overall, "pass");
  assert.equal(first.baseline.corePollution.value, 1 / 9);
  assert.equal(first.candidate.corePollution.value, 0);
  assert.deepEqual(first.pollutedKeys.removed, ["task.temporary-debug-cleanup"]);
  assert.equal(first.baseline.handoff.unexpectedFacts.length, 2);
  assert.deepEqual(first.candidate.handoff.unexpectedFacts, []);
  assert.deepEqual(first.policy.cases.map((item) => item.id),
    Array.from({ length: 22 }, (_, index) => `C${index + 1}`));
  assert.ok(first.acceptance.checks.every((item) => item.status === "pass"));
  assert.match(
    formatStageB3CoreHandoffComparison(first).join("\n"),
    /P6 Stage B3 — Core\/Handoff comparison/u
  );
});
