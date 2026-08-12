import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../../src/domain/types.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import { LogicalMemoryIndex } from "./identity.ts";
import {
  duplicateRate,
  extractionMetric,
  pollutionRate,
  retrievalAtK,
  setCompleteness,
  staleRate
} from "./metrics.ts";
import { formatMemoryQualityReport } from "./report.ts";
import { runMemoryQualityEval } from "./runner.ts";
import { extractionFixtureSchema } from "./types.ts";

test("quality metric formulas define stable zero-denominator behavior", () => {
  assert.deepEqual(extractionMetric(4, 1, 2), {
    tp: 4,
    fp: 1,
    fn: 2,
    precision: 0.8,
    recall: 2 / 3
  });
  assert.deepEqual(extractionMetric(0, 0, 0), {
    tp: 0,
    fp: 0,
    fn: 0,
    precision: 1,
    recall: 1
  });
  assert.deepEqual(retrievalAtK(["a", "b"], ["a", "x", "b"], 3), {
    k: 3,
    hits: 2,
    precision: 2 / 3,
    recall: 1
  });
  assert.equal(retrievalAtK([], [], 1).recall, 1);
  assert.equal(pollutionRate([], []).value, 0);
  assert.equal(staleRate([], []).value, 0);
  assert.equal(duplicateRate(0, 0).value, 0);
});

test("quality set completeness reports missing and unexpected atomic facts", () => {
  assert.deepEqual(setCompleteness(["goal:a", "task:b"], ["goal:a", "task:c"]), {
    numerator: 1,
    denominator: 2,
    value: 0.5,
    missing: ["task:b"],
    unexpected: ["task:c"]
  });
  assert.equal(setCompleteness([], []).value, 1);
});

test("quality fixtures validate independent ground truth and exactly 20 Sessions", async () => {
  const fixtures = await loadQualityFixtures();
  assert.equal(fixtures.longHorizon.steps.length, 20);
  assert.deepEqual(fixtures.retrieval.ks, [1, 3, 5, 10]);
  assert.ok(fixtures.extraction.expectedMemories.length > 0);
  assert.equal(extractionFixtureSchema.safeParse({ version: 1 }).success, false);
});

test("logical fixture identity remains stable across keyed runtime updates", () => {
  const index = new LogicalMemoryIndex();
  const runtime = { id: "runtime-memory-1" } as Pick<Memory, "id">;
  index.register("decision.database.sqlite", runtime);
  index.register("decision.database.postgresql", runtime);
  assert.equal(index.runtimeId("decision.database.sqlite"), runtime.id);
  assert.equal(index.runtimeId("decision.database.postgresql"), runtime.id);
  assert.equal(index.logicalKey(runtime.id), "decision.database.postgresql");
  assert.throws(
    () => index.register("decision.database.postgresql", { id: "runtime-memory-2" }),
    /multiple runtime IDs/u
  );
});

test("20-Session quality runner emits a deterministic report without random identities", async () => {
  const first = await runMemoryQualityEval();
  const second = await runMemoryQualityEval();
  assert.deepEqual(second, first);
  assert.equal(first.version, 1);
  assert.equal(first.summary.longHorizonSessions, 20);
  assert.deepEqual(first.summary.retrieval.map((item) => item.k), [1, 3, 5, 10]);
  assert.ok(first.summary.bootstrap.chars > 0);
  assert.ok(first.summary.bootstrap.bytes >= first.summary.bootstrap.chars);
  assert.equal(first.correctness.overall, "pass");
  assert.ok(first.correctness.checks.every((check) => check.status === "pass"));
  assert.doesNotMatch(
    JSON.stringify(first),
    /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
  );
  assert.ok(first.failures.length > 0, "Stage A must retain observed failure examples");

  const human = formatMemoryQualityReport(first).join("\n");
  assert.match(human, /Memory Quality v1 — Baseline/u);
  assert.match(human, /Sessions\s+20/u);
  assert.match(human, /Quality scores are baseline observations/u);
});
