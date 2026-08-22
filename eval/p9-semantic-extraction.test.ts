import assert from "node:assert/strict";
import test from "node:test";
import {
  loadP9Fixture,
  runP9SemanticExtractionEval,
  validateP9Fixture,
} from "./p9-semantic-extraction.ts";

test("P9 deterministic pipeline and admission eval meets correctness gates", async () => {
  const first = await runP9SemanticExtractionEval();
  const second = await runP9SemanticExtractionEval();
  assert.deepEqual(second, first);
  assert.equal(first.hardCorrectness, "pass");
  assert.equal(first.metrics.pipelinePersistencePrecision, 1);
  assert.equal(first.metrics.pipelineDurableAcceptanceRate, 1);
  assert.equal(first.metrics.groundingAcceptanceCorrectness, 1);
  assert.equal(first.metrics.unsupportedClaimPersistenceRate, 0);
  assert.equal(first.metrics.assistantOnlySemanticPersistenceRate, 0);
  assert.equal(first.metrics.transientSemanticPersistenceRate, 0);
  assert.equal(first.metrics.speculativeSemanticPersistenceRate, 0);
  assert.equal(first.metrics.sensitiveSemanticPersistenceRate, 0);
  assert.equal(first.metrics.optOutSemanticViolationRate, 0);
  assert.equal(first.metrics.crossTurnOptOutSemanticViolationRate, 0);
  assert.equal(first.metrics.implicitCoreWriteRate, 0);
  assert.equal(first.metrics.sameEvidenceDuplicateRate, 0);
  assert.equal(first.metrics.checkpointHistoricalReplayCount, 0);
  assert.equal(first.metrics.deterministicFallbackSuccessRate, 1);
  assert.equal(first.metrics.semanticLifecycleBlockingFailureRate, 0);
  assert.equal(first.metrics.crossSessionRecallSuccessRate, 1);
});

test("P9 fixture retains required positive and negative classes", async () => {
  const fixture = await loadP9Fixture();
  const missing = structuredClone(fixture) as unknown as Record<string, unknown>;
  (missing.scenarios as unknown[]).splice(
    (missing.scenarios as Array<Record<string, unknown>>).findIndex(
      (item) => item.category === "sensitive"
    ),
    1
  );
  assert.throws(() => validateP9Fixture(missing));
});
