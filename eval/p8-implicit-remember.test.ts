import assert from "node:assert/strict";
import test from "node:test";
import {
  loadP8Fixture,
  runP8ImplicitRememberEval,
  validateP8Fixture,
} from "./p8-implicit-remember.ts";

test("P8 deterministic implicit remember eval passes all frozen metrics", async () => {
  const first = await runP8ImplicitRememberEval();
  const second = await runP8ImplicitRememberEval();
  assert.deepEqual(second, first);
  assert.equal(first.hardCorrectness, "pass");
  assert.equal(first.metrics.implicitRememberPrecision, 1);
  assert.equal(first.metrics.implicitCoreWriteRate, 0);
  assert.equal(first.metrics.sameEvidenceDuplicateRate, 0);
  assert.equal(first.metrics.replayDuplicateRate, 0);
  assert.equal(first.metrics.assistantOnlyPersistenceRate, 0);
  assert.equal(first.metrics.lifecycleBlockingFailureRate, 0);
  assert.equal(first.metrics.explicitOptOutViolationRate, 0);
  assert.equal(first.metrics.longAssistantUserEvidenceRetention, "pass");
  assert.equal(first.metrics.checkpointHistoricalReplayCount, 0);
  assert.equal(first.metrics.secretLikeAutoPersistenceRate, 0);
  assert.equal(first.metrics.crossTurnOptOutViolationRate, 0);
  assert.equal(first.scenarios.length, 15);
});

test("P8 fixture requires exactly one scenario for every required category", async () => {
  const fixture = await loadP8Fixture();
  const missing = structuredClone(fixture) as unknown as Record<string, unknown>;
  (missing.scenarios as unknown[]).pop();
  assert.throws(() => validateP8Fixture(missing));

  const duplicate = structuredClone(fixture) as unknown as Record<string, unknown>;
  const scenarios = duplicate.scenarios as Array<Record<string, unknown>>;
  scenarios[1]!.category = scenarios[0]!.category;
  assert.throws(() => validateP8Fixture(duplicate), /duplicate P8 category/u);
});
