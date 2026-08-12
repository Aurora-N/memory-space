import assert from "node:assert/strict";
import test from "node:test";
import type { Memory, MemorySearchInput, MemorySearchResult } from "../../src/domain/types.ts";
import type { MemorySpace } from "../../src/application/memory-space.ts";
import { loadStageABaseline, stageABaselineSchema } from "./baseline.ts";
import { formatStageB1Comparison, runStageB1Comparison } from "./comparison.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import { LogicalMemoryIndex } from "./identity.ts";
import {
  aggregateNegativeRetrieval,
  aggregateRetrieval,
  duplicateRate,
  eligibleRetrievalKs,
  extractionMetric,
  pollutionRate,
  retrievalAtK,
  setCompleteness,
  staleRate
} from "./metrics.ts";
import { formatMemoryQualityReport } from "./report.ts";
import { evaluateRetrievalQueries, runMemoryQualityEval } from "./runner.ts";
import {
  extractionFixtureSchema,
  type RetrievalQueryFixture,
  type RetrievalQueryResult
} from "./types.ts";

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
  assert.throws(
    () => retrievalAtK([], [], 1),
    /requires at least one relevant Memory/u
  );
  assert.equal(pollutionRate([], []).value, 0);
  assert.equal(staleRate([], []).value, 0);
  assert.equal(duplicateRate(0, 0).value, 0);
});

function retrievalResult(input: Partial<RetrievalQueryResult>): RetrievalQueryResult {
  return {
    id: "query",
    query: "query",
    classification: "positive",
    expected: ["relevant"],
    returned: ["relevant"],
    returnedCount: 1,
    eligibleCorpusSize: 10,
    atK: [retrievalAtK(["relevant"], ["relevant"], 1)],
    note: "test query",
    ...input
  };
}

test("zero-relevant queries are excluded from P@K/R@K and measured separately", () => {
  const positive = retrievalResult({});
  const falsePositive = retrievalResult({
    id: "negative-false-positive",
    classification: "negative",
    expected: [],
    returned: ["unexpected"],
    returnedCount: 1,
    atK: []
  });
  const abstained = retrievalResult({
    id: "negative-abstained",
    classification: "negative",
    expected: [],
    returned: [],
    returnedCount: 0,
    atK: []
  });

  assert.deepEqual(aggregateRetrieval([positive, falsePositive, abstained], [1]), [{
    k: 1,
    precision: 1,
    recall: 1,
    queryCount: 1
  }]);
  assert.deepEqual(
    aggregateNegativeRetrieval([positive, falsePositive, abstained]),
    {
      queryCount: 2,
      falsePositiveQueries: 1,
      abstainedQueries: 1,
      falsePositiveRate: 0.5,
      abstentionRate: 0.5,
      queries: [
        {
          id: "negative-false-positive",
          query: "query",
          eligibleCorpusSize: 10,
          returned: ["unexpected"],
          returnedCount: 1,
          abstained: false
        },
        {
          id: "negative-abstained",
          query: "query",
          eligibleCorpusSize: 10,
          returned: [],
          returnedCount: 0,
          abstained: true
        }
      ]
    }
  );
  assert.deepEqual(aggregateNegativeRetrieval([positive]), {
    queryCount: 0,
    falsePositiveQueries: 0,
    abstainedQueries: 0,
    falsePositiveRate: 0,
    abstentionRate: 1,
    queries: []
  });
});

test("only K values supported by each eligible corpus enter macro retrieval", () => {
  assert.deepEqual(eligibleRetrievalKs([1, 3, 5, 10], 10), [1, 3, 5, 10]);
  assert.deepEqual(eligibleRetrievalKs([1, 3, 5, 10], 4), [1, 3]);

  const corpus10 = retrievalResult({
    id: "corpus-10",
    eligibleCorpusSize: 10,
    atK: [1, 3, 5, 10].map((k) => retrievalAtK(["relevant"], ["relevant"], k))
  });
  const corpus4 = retrievalResult({
    id: "corpus-4",
    eligibleCorpusSize: 4,
    atK: [1, 3].map((k) => retrievalAtK(["relevant"], ["relevant"], k))
  });
  const aggregate = aggregateRetrieval([corpus10, corpus4], [1, 3, 5, 10]);
  assert.deepEqual(aggregate.map((item) => item.queryCount), [2, 2, 1, 1]);
  assert.equal(aggregate.find((item) => item.k === 5)?.precision, 1 / 5);
  assert.equal(aggregate.find((item) => item.k === 10)?.precision, 1 / 10);
});

function testMemory(id: string): Memory {
  return {
    id,
    spaceId: "quality-test-space",
    family: "knowledge",
    type: "fact",
    content: `Memory ${id}`,
    tier: "indexed",
    status: "resolved",
    importance: 0.5,
    confidence: 1,
    version: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
}

test("query evaluation uses filtered corpus eligibility and preserves production order", async () => {
  const productionOrder = [testMemory("runtime-z"), testMemory("runtime-a")];
  const eligible = [...productionOrder, testMemory("runtime-c"), testMemory("runtime-d")];
  const calls: MemorySearchInput[] = [];
  const search = async (input: MemorySearchInput): Promise<MemorySearchResult[]> => {
    calls.push(input);
    const memories = input.query === "" ? eligible : productionOrder;
    return memories.map((memory) => ({ memory, score: 1 }));
  };
  const index = new LogicalMemoryIndex();
  index.register("z-relevant", productionOrder[0]);
  index.register("a-distractor", productionOrder[1]);
  index.register("c-eligible", eligible[2]);
  index.register("d-eligible", eligible[3]);
  const query: RetrievalQueryFixture = {
    id: "filtered-production-order",
    query: "same score",
    relevantMemoryKeys: ["z-relevant"],
    families: ["knowledge"],
    types: ["fact"],
    tiers: ["indexed"],
    statuses: ["resolved"],
    note: "Logical keys must not replace production order."
  };

  const [result] = await evaluateRetrievalQueries(
    { search } as Pick<MemorySpace, "search">,
    "quality-test-space",
    index,
    [query],
    [1, 3, 5, 10]
  );

  assert.deepEqual(result.returned, ["z-relevant", "a-distractor"]);
  assert.equal(result.eligibleCorpusSize, 4);
  assert.deepEqual(result.atK.map((item) => item.k), [1, 3]);
  assert.equal(result.atK[0]?.precision, 1);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.families, ["knowledge"]);
    assert.deepEqual(call.types, ["fact"]);
    assert.deepEqual(call.tiers, ["indexed"]);
    assert.deepEqual(call.statuses, ["resolved"]);
  }
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

test("accepted Stage A snapshot has the frozen versioned comparison shape", async () => {
  const baseline = await loadStageABaseline();
  assert.equal(baseline.acceptedCommit, "9490ebce94928132a2fb16aca247c8ae4888a7cf");
  assert.equal(baseline.queries.length, 12);
  assert.equal(baseline.correctness.checks.length, 15);
  assert.equal(baseline.negativeRetrieval.falsePositiveRate, 1);
  assert.equal(stageABaselineSchema.safeParse({ ...baseline, version: 2 }).success, false);
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
  assert.equal(first.summary.negativeRetrieval.queryCount, 1);
  assert.ok(first.scenarios.every((scenario) =>
    scenario.observations.tieHandling === undefined
  ));
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
  assert.match(human, /Memory Quality v1 — Current evaluation/u);
  assert.match(human, /Sessions\s+20/u);
  assert.match(human, /Negative retrieval/u);
  assert.match(human, /Quality scores are observations/u);
});

test("Stage B1 comparison is deterministic and enforces accepted baseline deltas", async () => {
  const first = await runStageB1Comparison();
  const second = await runStageB1Comparison();
  assert.deepEqual(second, first);
  assert.equal(first.acceptance.overall, "pass");
  assert.ok(first.acceptance.checks.every((item) => item.status === "pass"));

  const metric = (name: string) => first.metrics.find((item) => item.metric === name);
  assert.equal(metric("P@1")?.baseline, 0.7272727272727273);
  assert.equal(metric("P@1")?.candidate, 0.8181818181818182);
  assert.equal(metric("R@1")?.candidate, 0.7727272727272727);
  assert.equal(metric("P@3")?.delta, 0);
  assert.equal(metric("R@10")?.delta, 0);
  assert.equal(first.baseline.negativeRetrieval.falsePositiveRate, 1);
  assert.equal(first.candidate.negativeRetrieval.falsePositiveRate, 0);
  assert.equal(first.candidate.negativeRetrieval.abstentionRate, 1);

  const semantic = first.queries.find((item) => item.id === "semantic-target-loses-to-overlap");
  assert.equal(semantic?.change, "improved");
  assert.equal(semantic?.baselineTop1Relevant, false);
  assert.equal(semantic?.candidateTop1Relevant, true);
  assert.equal(first.queries.some((item) => item.change === "regressed"), false);
  assert.deepEqual(first.failures.new, []);
  assert.deepEqual(first.failures.removed, [
    "saas-commerce-api-20-session-evolution:long-old-sqlite-decision:negative-query-false-positive"
  ]);

  const human = formatStageB1Comparison(first).join("\n");
  assert.match(human, /P6 Stage B1 — Retrieval comparison/u);
  assert.match(human, /Negative abstention/u);
  assert.match(human, /Overall PASS/u);
});
