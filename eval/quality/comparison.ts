import { loadStageABaseline, type StageABaseline } from "./baseline.ts";
import type {
  MemoryQualityReport,
  RetrievalAggregate,
  RetrievalQueryResult
} from "./types.ts";

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

interface ComparableQuery {
  scenarioId: string;
  id: string;
  classification: "positive" | "negative";
  eligibleCorpusSize: number;
  returned: string[];
  atK: Array<{ k: number; hits: number; precision: number; recall: number }>;
}

function candidateQueries(report: MemoryQualityReport): ComparableQuery[] {
  const queries: ComparableQuery[] = [];
  for (const scenario of report.scenarios) {
    const value = scenario.kind === "retrieval"
      ? scenario.observations.queries
      : scenario.kind === "long-horizon"
        ? scenario.observations.finalQueries
        : undefined;
    if (!Array.isArray(value)) continue;
    for (const query of value as RetrievalQueryResult[]) {
      queries.push({
        scenarioId: scenario.id,
        id: query.id,
        classification: query.classification,
        eligibleCorpusSize: query.eligibleCorpusSize,
        returned: [...query.returned],
        atK: query.atK.map((item) => ({ ...item }))
      });
    }
  }
  return queries;
}

function queryKey(query: Pick<ComparableQuery, "scenarioId" | "id">): string {
  return `${query.scenarioId}:${query.id}`;
}

function top1Relevant(query: ComparableQuery): boolean {
  return query.classification === "positive"
    && (query.atK.find((item) => item.k === 1)?.hits ?? 0) > 0;
}

function queryFailure(query: ComparableQuery): string | undefined {
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
  baseline: readonly ComparableQuery[],
  candidate: readonly ComparableQuery[]
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

function baselineQueries(baseline: StageABaseline): ComparableQuery[] {
  return baseline.queries.map((query) => ({
    scenarioId: query.scenarioId,
    id: query.id,
    classification: query.classification,
    eligibleCorpusSize: query.eligibleCorpusSize,
    returned: [...query.returned],
    atK: query.atK.map((item) => ({ ...item }))
  }));
}

export async function runStageB1Comparison(): Promise<StageB1ComparisonReport> {
  const { runMemoryQualityEval } = await import("./runner.ts");
  const baseline = await loadStageABaseline();
  const candidateReport = await runMemoryQualityEval();
  const metrics = buildMetrics(baseline.retrieval, candidateReport.summary.retrieval);
  const queries = compareQueries(baselineQueries(baseline), candidateQueries(candidateReport));
  const baselineFailures = new Set(
    baselineQueries(baseline).map(queryFailure).filter((value): value is string => Boolean(value))
  );
  const candidateFailures = new Set(
    candidateQueries(candidateReport).map(queryFailure).filter((value): value is string => Boolean(value))
  );
  const removed = [...baselineFailures].filter((value) => !candidateFailures.has(value)).sort();
  const added = [...candidateFailures].filter((value) => !baselineFailures.has(value)).sort();
  const unchanged = [...baselineFailures].filter((value) => candidateFailures.has(value)).sort();
  const metric = (name: RetrievalMetricDelta["metric"]): RetrievalMetricDelta => {
    const value = metrics.find((item) => item.metric === name);
    if (!value) throw new Error(`Comparison is missing ${name}`);
    return value;
  };
  const positiveRemoved = removed.filter((value) => !value.endsWith("negative-query-false-positive"));
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
      "positive-precision-strict-improvement",
      metric("P@1").candidate > metric("P@1").baseline
        || metric("P@3").candidate > metric("P@3").baseline
        || (positiveRemoved.length > 0 && top1Regressions.length === 0),
      "P@1, P@3, or positive top-K failures must strictly improve without top-1 regression."
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
