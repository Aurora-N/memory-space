import assert from "node:assert/strict";
import test from "node:test";
import {
  assertP7FixtureContract,
  loadP7Fixture,
  runP7ImplicitRecallEval,
  validateP7Fixture,
  type P7ImplicitRecallFixture
} from "./p7-implicit-recall.ts";

function clone(value: P7ImplicitRecallFixture): P7ImplicitRecallFixture {
  return structuredClone(value);
}

test("P7 deterministic implicit recall eval passes the frozen 4x4 contract", async () => {
  const first = await runP7ImplicitRecallEval();
  const second = await runP7ImplicitRecallEval();
  assert.deepEqual(second, first);
  assert.equal(first.hardCorrectness, "pass");
  assert.deepEqual(first.metrics.crossProviderMatrix, { passed: 4, total: 4 });
  assert.equal(first.metrics.bareIdentifierHitRate, 1);
  assert.equal(first.metrics.exactKeyHitRate, 1);
  assert.equal(first.metrics.implicitRecallPrecisionAt1, 1);
  assert.equal(first.metrics.negativeAbstentionRate, 1);
  assert.equal(first.metrics.coreReinjectionRate, 0);
  assert.equal(first.metrics.metadataLeakageRate, 0);
  assert.equal(first.metrics.optOutComplianceRate, 1);
  assert.equal(first.metrics.budgetComplianceRate, 1);
});

test("P7 fixture schema rejects malformed or incomplete fields", async () => {
  const fixture = await loadP7Fixture();
  for (const mutate of [
    (value: Record<string, unknown>) => { value.version = 2; },
    (value: Record<string, unknown>) => { delete value.memoryCatalog; },
    (value: Record<string, unknown>) => { value.scenarios = []; }
  ]) {
    const candidate = structuredClone(fixture) as unknown as Record<string, unknown>;
    mutate(candidate);
    assert.throws(() => validateP7Fixture(candidate));
  }
});

test("P7 frozen contract detects independent scenario mutations", async () => {
  const accepted = await loadP7Fixture();
  const mutations: Array<(fixture: P7ImplicitRecallFixture) => void> = [
    (fixture) => { fixture.scenarios[0]!.prompt += " changed"; },
    (fixture) => { fixture.scenarios[0]!.classification = "negative"; },
    (fixture) => { fixture.scenarios[0]!.sourceProvider = "claude-code"; },
    (fixture) => { fixture.scenarios[0]!.targetProvider = "claude-code"; },
    (fixture) => { fixture.scenarios[0]!.expectedInjectedKeys = []; },
    (fixture) => { fixture.scenarios[0]!.expectedFirstKey = "upload.variant.types"; },
    (fixture) => { fixture.scenarios[0]!.expectedAbstention = true; },
    (fixture) => { fixture.scenarios.pop(); }
  ];
  for (const mutate of mutations) {
    const candidate = clone(accepted);
    mutate(candidate);
    assert.throws(() => assertP7FixtureContract(candidate, accepted), /frozen fixture/u);
  }
});
