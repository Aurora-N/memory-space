import { isDeepStrictEqual } from "node:util";
import { loadStageABaseline, type StageABaseline } from "./baseline.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import type {
  MemoryQualityReport,
  QualityFixtureBundle,
  RetrievalAggregate,
  RetrievalQueryFixture,
  RetrievalQueryResult
} from "./types.ts";

export interface RetrievalQueryFilters {
  families?: RetrievalQueryFixture["families"];
  types?: RetrievalQueryFixture["types"];
  tiers?: RetrievalQueryFixture["tiers"];
  statuses?: RetrievalQueryFixture["statuses"];
}

export interface RetrievalMetricDelta {
  metric: `P@${number}` | `R@${number}`;
  k: number;
  baseline: number;
  candidate: number;
  delta: number;
  baselineQueryCount: number;
  candidateQueryCount: number;
}

export interface RetrievalQueryComparison {
  scenarioId: string;
  id: string;
  classification: "positive" | "negative";
  query: string;
  relevantMemoryKeys: string[];
  filters: RetrievalQueryFilters;
  eligibleCorpusSize: { baseline: number; candidate: number };
  baselineReturned: string[];
  candidateReturned: string[];
  baselineTop1Relevant: boolean;
  candidateTop1Relevant: boolean;
  baselineFailure?: string;
  candidateFailure?: string;
  change: "improved" | "regressed" | "changed" | "unchanged";
}

export interface StageB1ComparisonReport {
  version: 1;
  baseline: {
    id: "p6-stage-a";
    acceptedCommit: string;
    retrieval: RetrievalAggregate[];
    negativeRetrieval: MemoryQualityReport["summary"]["negativeRetrieval"];
  };
  candidate: {
    reportVersion: 1;
    retrieval: RetrievalAggregate[];
    negativeRetrieval: MemoryQualityReport["summary"]["negativeRetrieval"];
  };
  metrics: RetrievalMetricDelta[];
  queries: RetrievalQueryComparison[];
  failures: {
    removed: string[];
    new: string[];
    unchanged: string[];
  };
  correctness: MemoryQualityReport["correctness"];
  acceptance: {
    overall: "pass" | "fail";
    checks: Array<{
      id: string;
      status: "pass" | "fail";
      detail: string;
    }>;
  };
}

export interface ComparableRetrievalQuery {
  scenarioId: string;
  id: string;
  classification: "positive" | "negative";
  query: string;
  relevantMemoryKeys: string[];
  filters: RetrievalQueryFilters;
  eligibleCorpusSize: number;
  returned: string[];
  atK: Array<{ k: number; hits: number; precision: number; recall: number }>;
}

function normalizedFilters(query: RetrievalQueryFixture): RetrievalQueryFilters {
  return {
    ...(query.families ? { families: [...query.families] } : {}),
    ...(query.types ? { types: [...query.types] } : {}),
    ...(query.tiers ? { tiers: [...query.tiers] } : {}),
    ...(query.statuses ? { statuses: [...query.statuses] } : {})
  };
}

function fixtureContracts(fixtures: QualityFixtureBundle): ComparableRetrievalQuery[] {
  const values: Array<{ scenarioId: string; query: RetrievalQueryFixture }> = [
    ...fixtures.retrieval.queries.map((query) => ({
      scenarioId: fixtures.retrieval.id,
      query
    })),
    ...fixtures.longHorizon.finalQueries.map((query) => ({
      scenarioId: fixtures.longHorizon.id,
      query
    }))
  ];
  return values.map(({ scenarioId, query }) => ({
    scenarioId,
    id: query.id,
    classification: query.relevantMemoryKeys.length > 0 ? "positive" : "negative",
    query: query.query,
    relevantMemoryKeys: [...query.relevantMemoryKeys],
    filters: normalizedFilters(query),
    eligibleCorpusSize: -1,
    returned: [],
    atK: []
  }));
}

function candidateQueries(
  report: MemoryQualityReport,
  contracts: readonly ComparableRetrievalQuery[]
): ComparableRetrievalQuery[] {
  const contractByKey = new Map(contracts.map((query) => [queryKey(query), query]));
  const queries: ComparableRetrievalQuery[] = [];
  for (const scenario of report.scenarios) {
    const value = scenario.kind === "retrieval"
      ? scenario.observations.queries
      : scenario.kind === "long-horizon"
        ? scenario.observations.finalQueries
        : undefined;
    if (!Array.isArray(value)) continue;
    for (const query of value as RetrievalQueryResult[]) {
      const contract = contractByKey.get(`${scenario.id}:${query.id}`);
      if (!contract) throw new Error(`Candidate report contains an unknown query: ${scenario.id}:${query.id}`);
      if (query.query !== contract.query) {
        throw new Error(`Candidate runner query text differs from its fixture: ${scenario.id}:${query.id}`);
      }
      if (!isDeepStrictEqual(query.expected, contract.relevantMemoryKeys)) {
        throw new Error(`Candidate runner relevant keys differ from its fixture: ${scenario.id}:${query.id}`);
      }
      if (query.classification !== contract.classification) {
        throw new Error(`Candidate runner classification differs from its fixture: ${scenario.id}:${query.id}`);
      }
      queries.push({
        scenarioId: scenario.id,
        id: query.id,
        classification: query.classification,
        query: contract.query,
        relevantMemoryKeys: [...contract.relevantMemoryKeys],
        filters: contract.filters,
        eligibleCorpusSize: query.eligibleCorpusSize,
        returned: [...query.returned],
        atK: query.atK.map((item) => ({ ...item }))
      });
    }
  }
  return queries;
}

function queryKey(query: Pick<ComparableRetrievalQuery, "scenarioId" | "id">): string {
  return `${query.scenarioId}:${query.id}`;
}

function top1Relevant(query: ComparableRetrievalQuery): boolean {
  return query.classification === "positive"
    && (query.atK.find((item) => item.k === 1)?.hits ?? 0) > 0;
}

function queryFailure(query: ComparableRetrievalQuery): string | undefined {
  const key = queryKey(query);
  if (query.classification === "negative") {
    return query.returned.length > 0 ? `${key}:negative-query-false-positive` : undefined;
  }
  const metric = query.atK.find((item) => item.k === 3) ?? query.atK[0];
  return metric && metric.recall < 1 ? `${key}:Recall@${metric.k}` : undefined;
}

function retrievalMetric(
  values: readonly RetrievalAggregate[],
  k: number
): RetrievalAggregate {
  const value = values.find((item) => item.k === k);
  if (!value) throw new Error(`Retrieval report is missing K=${k}`);
  return value;
}

function check(
  id: string,
  passed: boolean,
  detail: string
): StageB1ComparisonReport["acceptance"]["checks"][number] {
  return { id, status: passed ? "pass" : "fail", detail };
}

function buildMetrics(
  baseline: readonly RetrievalAggregate[],
  candidate: readonly RetrievalAggregate[]
): RetrievalMetricDelta[] {
  const metrics: RetrievalMetricDelta[] = [];
  for (const baselineItem of baseline) {
    const candidateItem = retrievalMetric(candidate, baselineItem.k);
    for (const field of ["precision", "recall"] as const) {
      const prefix = field === "precision" ? "P" : "R";
      metrics.push({
        metric: `${prefix}@${baselineItem.k}`,
        k: baselineItem.k,
        baseline: baselineItem[field],
        candidate: candidateItem[field],
        delta: candidateItem[field] - baselineItem[field],
        baselineQueryCount: baselineItem.queryCount,
        candidateQueryCount: candidateItem.queryCount
      });
    }
  }
  return metrics;
}

function compareQueries(
  baseline: readonly ComparableRetrievalQuery[],
  candidate: readonly ComparableRetrievalQuery[]
): RetrievalQueryComparison[] {
  const candidateByKey = new Map(candidate.map((query) => [queryKey(query), query]));
  if (candidateByKey.size !== baseline.length || candidate.length !== baseline.length) {
    throw new Error("Candidate retrieval query set differs from the accepted Stage A snapshot");
  }
  return baseline.map((before) => {
    const after = candidateByKey.get(queryKey(before));
    if (!after || after.classification !== before.classification) {
      throw new Error(`Candidate retrieval query is missing or reclassified: ${queryKey(before)}`);
    }
    const baselineFailure = queryFailure(before);
    const candidateFailure = queryFailure(after);
    const baselineTop1 = top1Relevant(before);
    const candidateTop1 = top1Relevant(after);
    let change: RetrievalQueryComparison["change"] = "unchanged";
    if ((!baselineTop1 && candidateTop1) || (baselineFailure && !candidateFailure)) {
      change = "improved";
    } else if ((baselineTop1 && !candidateTop1) || (!baselineFailure && candidateFailure)) {
      change = "regressed";
    } else if (JSON.stringify(before.returned) !== JSON.stringify(after.returned)) {
      change = "changed";
    }
    return {
      scenarioId: before.scenarioId,
      id: before.id,
      classification: before.classification,
      query: before.query,
      relevantMemoryKeys: [...before.relevantMemoryKeys],
      filters: before.filters,
      eligibleCorpusSize: {
        baseline: before.eligibleCorpusSize,
        candidate: after.eligibleCorpusSize
      },
      baselineReturned: [...before.returned],
      candidateReturned: [...after.returned],
      baselineTop1Relevant: baselineTop1,
      candidateTop1Relevant: candidateTop1,
      ...(baselineFailure ? { baselineFailure } : {}),
      ...(candidateFailure ? { candidateFailure } : {}),
      change
    };
  });
}

function baselineQueries(baseline: StageABaseline): ComparableRetrievalQuery[] {
  return baseline.queries.map((query) => ({
    scenarioId: query.scenarioId,
    id: query.id,
    classification: query.classification,
    query: query.query,
    relevantMemoryKeys: [...query.relevantMemoryKeys],
    filters: query.filters,
    eligibleCorpusSize: query.eligibleCorpusSize,
    returned: [...query.returned],
    atK: query.atK.map((item) => ({ ...item }))
  }));
}

export function assertStageAQueryContract(
  baseline: readonly ComparableRetrievalQuery[],
  candidate: readonly ComparableRetrievalQuery[]
): void {
  const candidateByKey = new Map<string, ComparableRetrievalQuery>();
  for (const query of candidate) {
    const key = queryKey(query);
    if (candidateByKey.has(key)) throw new Error(`Candidate query set contains a duplicate: ${key}`);
    candidateByKey.set(key, query);
  }
  if (candidate.length !== baseline.length || candidateByKey.size !== baseline.length) {
    throw new Error("Candidate query set differs from the accepted Stage A snapshot");
  }
  for (const before of baseline) {
    const key = queryKey(before);
    const after = candidateByKey.get(key);
    if (!after) throw new Error(`Candidate query set is missing: ${key}`);
    if (after.query !== before.query) throw new Error(`Candidate query text mutation: ${key}`);
    if (!isDeepStrictEqual(after.relevantMemoryKeys, before.relevantMemoryKeys)) {
      throw new Error(`Candidate relevant keys mutation: ${key}`);
    }
    if (after.classification !== before.classification) {
      throw new Error(`Candidate classification mutation: ${key}`);
    }
    if (!isDeepStrictEqual(after.filters, before.filters)) {
      throw new Error(`Candidate filter mutation: ${key}`);
    }
    if (after.eligibleCorpusSize !== before.eligibleCorpusSize) {
      throw new Error(`Candidate eligible corpus mutation: ${key}`);
    }
  }
}

export async function runStageB1Comparison(): Promise<StageB1ComparisonReport> {
  const { runMemoryQualityEval } = await import("./runner.ts");
  const baseline = await loadStageABaseline();
  const [candidateReport, fixtures] = await Promise.all([
    runMemoryQualityEval(),
    loadQualityFixtures()
  ]);
  const beforeQueries = baselineQueries(baseline);
  const afterQueries = candidateQueries(candidateReport, fixtureContracts(fixtures));
  assertStageAQueryContract(beforeQueries, afterQueries);
  const metrics = buildMetrics(baseline.retrieval, candidateReport.summary.retrieval);
  const queries = compareQueries(beforeQueries, afterQueries);
  const baselineFailures = new Set(
    beforeQueries.map(queryFailure).filter((value): value is string => Boolean(value))
  );
  const candidateFailures = new Set(
    afterQueries.map(queryFailure).filter((value): value is string => Boolean(value))
  );
  const removed = [...baselineFailures].filter((value) => !candidateFailures.has(value)).sort();
  const added = [...candidateFailures].filter((value) => !baselineFailures.has(value)).sort();
  const unchanged = [...baselineFailures].filter((value) => candidateFailures.has(value)).sort();
  const metric = (name: RetrievalMetricDelta["metric"]): RetrievalMetricDelta => {
    const value = metrics.find((item) => item.metric === name);
    if (!value) throw new Error(`Comparison is missing ${name}`);
    return value;
  };
  const top1Regressions = queries.filter((query) =>
    query.classification === "positive"
    && query.baselineTop1Relevant
    && !query.candidateTop1Relevant
  );
  const correctnessIds = new Map(candidateReport.correctness.checks.map((item) => [item.id, item.status]));
  const checks = [
    check(
      "hard-correctness",
      candidateReport.correctness.overall === "pass"
        && baseline.correctness.checks.every((item) => correctnessIds.get(item.id) === "pass"),
      "All accepted Stage A hard-correctness checks remain PASS."
    ),
    check(
      "query-set-and-counts-stable",
      queries.every((query) =>
        query.eligibleCorpusSize.baseline === query.eligibleCorpusSize.candidate
      ) && metrics.every((item) => item.baselineQueryCount === item.candidateQueryCount),
      "Query identities, eligible corpus sizes, and per-K participant counts remain stable."
    ),
    check(
      "negative-false-positive-improves",
      candidateReport.summary.negativeRetrieval.falsePositiveRate
        < baseline.negativeRetrieval.falsePositiveRate,
      "Negative-query false-positive rate must strictly decrease."
    ),
    check(
      "negative-abstention-improves",
      candidateReport.summary.negativeRetrieval.abstentionRate
        > baseline.negativeRetrieval.abstentionRate,
      "Negative-query abstention rate must strictly increase."
    ),
    ...(["P@1", "R@1", "P@3", "R@3"] as const).map((name) => check(
      `${name.toLowerCase()}-non-regression`,
      metric(name).candidate >= metric(name).baseline,
      `${name} must equal or exceed the accepted Stage A baseline.`
    )),
    check(
      "no-new-retrieval-failures",
      added.length === 0,
      "The candidate must not add an accepted-fixture retrieval failure."
    ),
    check(
      "per-query-top1-non-regression",
      top1Regressions.length === 0,
      "Every previously top-1-correct positive query remains top-1 correct."
    ),
    check(
      "deep-rank-diagnostics-non-regression",
      (["P@5", "R@5", "P@10", "R@10"] as const).every((name) =>
        metric(name).candidate >= metric(name).baseline
      ),
      "Reported P@5/R@5/P@10/R@10 diagnostics do not regress."
    )
  ];
  return {
    version: 1,
    baseline: {
      id: baseline.id,
      acceptedCommit: baseline.acceptedCommit,
      retrieval: baseline.retrieval.map((item) => ({ ...item })),
      negativeRetrieval: baseline.negativeRetrieval
    },
    candidate: {
      reportVersion: candidateReport.version,
      retrieval: candidateReport.summary.retrieval,
      negativeRetrieval: candidateReport.summary.negativeRetrieval
    },
    metrics,
    queries,
    failures: { removed, new: added, unchanged },
    correctness: candidateReport.correctness,
    acceptance: {
      overall: checks.every((item) => item.status === "pass") ? "pass" : "fail",
      checks
    }
  };
}

function fixed(value: number): string {
  return value.toFixed(6);
}

export function formatStageB1Comparison(report: StageB1ComparisonReport): string[] {
  const lines = [
    "P6 Stage B1 — Retrieval comparison",
    `Accepted Stage A: ${report.baseline.acceptedCommit}`,
    "",
    "Metric                 Baseline    Candidate   Delta"
  ];
  for (const item of report.metrics) {
    lines.push(
      `${item.metric.padEnd(22)} ${fixed(item.baseline).padStart(8)}    ${fixed(item.candidate).padStart(8)}   ${(item.delta >= 0 ? "+" : "") + fixed(item.delta)}`
    );
  }
  lines.push(
    `${"Negative FP".padEnd(22)} ${fixed(report.baseline.negativeRetrieval.falsePositiveRate).padStart(8)}    ${fixed(report.candidate.negativeRetrieval.falsePositiveRate).padStart(8)}   ${(report.candidate.negativeRetrieval.falsePositiveRate - report.baseline.negativeRetrieval.falsePositiveRate >= 0 ? "+" : "") + fixed(report.candidate.negativeRetrieval.falsePositiveRate - report.baseline.negativeRetrieval.falsePositiveRate)}`,
    `${"Negative abstention".padEnd(22)} ${fixed(report.baseline.negativeRetrieval.abstentionRate).padStart(8)}    ${fixed(report.candidate.negativeRetrieval.abstentionRate).padStart(8)}   ${(report.candidate.negativeRetrieval.abstentionRate - report.baseline.negativeRetrieval.abstentionRate >= 0 ? "+" : "") + fixed(report.candidate.negativeRetrieval.abstentionRate - report.baseline.negativeRetrieval.abstentionRate)}`,
    "",
    "Per-query changes"
  );
  for (const query of report.queries.filter((item) => item.change !== "unchanged")) {
    lines.push(`  ${query.change.toUpperCase().padEnd(9)} ${query.scenarioId}:${query.id}`);
  }
  lines.push(
    "",
    `Removed failures:   ${report.failures.removed.length}`,
    `New failures:       ${report.failures.new.length}`,
    `Unchanged failures: ${report.failures.unchanged.length}`,
    "",
    "Acceptance checks"
  );
  for (const item of report.acceptance.checks) {
    lines.push(`  ${item.status.toUpperCase().padEnd(4)} ${item.id}`);
  }
  lines.push("", `Overall ${report.acceptance.overall.toUpperCase()}`);
  return lines;
}
