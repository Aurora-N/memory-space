import {
  assertB3FixtureContract,
  loadStageB2CoreHandoffBaseline,
  normalizeB3FixtureContract,
  type StageB2CoreHandoffBaseline
} from "./core-handoff-baseline.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import type { MemoryQualityReport, QualityFixtureBundle, RetrievalAggregate } from "./types.ts";

export interface B3PolicyCheck {
  id: string;
  status: "pass" | "fail";
  detail: string;
}

export interface B3PolicyEvaluationReport {
  version: 1;
  cases: B3PolicyCheck[];
  promotionProvenance: B3PolicyCheck[];
  prospectiveTransitions: B3PolicyCheck[];
  seededUpgrade: B3PolicyCheck[];
  workingStateProvenance: B3PolicyCheck[];
}

export interface StageB3CoreHandoffComparisonReport {
  version: 1;
  baseline: {
    id: "p6-stage-b2-core-handoff";
    sourceCommit: string;
    corePollution: StageB2CoreHandoffBaseline["acceptedResult"]["corePollution"];
    handoff: StageB2CoreHandoffBaseline["acceptedResult"]["handoff"];
  };
  candidate: {
    reportVersion: 1;
    corePollution: MemoryQualityReport["summary"]["corePollution"];
    handoff: MemoryQualityReport["summary"]["handoff"];
  };
  pollutedKeys: {
    removed: string[];
    new: string[];
    unchanged: string[];
  };
  unexpectedHandoffFacts: {
    removed: string[];
    new: string[];
    unchanged: string[];
  };
  missingHandoffFacts: {
    new: string[];
    unchanged: string[];
  };
  bootstrapCriticalCoverage: {
    baseline: number;
    candidate: number;
    baselineMissingKeys: string[];
    candidateMissingKeys: string[];
  };
  coreItemCount: { baseline: number; candidate: number };
  handoffRequiredCoverage: { baseline: number; candidate: number };
  retrieval: {
    baseline: RetrievalAggregate[];
    candidate: RetrievalAggregate[];
  };
  extraction: {
    baseline: StageB2CoreHandoffBaseline["acceptedResult"]["extraction"];
    candidate: MemoryQualityReport["summary"]["extraction"];
  };
  policy: B3PolicyEvaluationReport;
  correctness: MemoryQualityReport["correctness"];
  acceptance: {
    overall: "pass" | "fail";
    checks: B3PolicyCheck[];
  };
}

function removed(before: readonly string[], after: readonly string[]): string[] {
  const values = new Set(after);
  return before.filter((value) => !values.has(value)).sort();
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const values = new Set(before);
  return after.filter((value) => !values.has(value)).sort();
}

function unchanged(before: readonly string[], after: readonly string[]): string[] {
  const values = new Set(after);
  return before.filter((value) => values.has(value)).sort();
}

function check(id: string, passed: boolean, detail: string): B3PolicyCheck {
  return { id, status: passed ? "pass" : "fail", detail };
}

function retrievalNonRegression(
  baseline: readonly RetrievalAggregate[],
  candidate: readonly RetrievalAggregate[]
): boolean {
  return baseline.every((before) => {
    const after = candidate.find((value) => value.k === before.k);
    return after !== undefined
      && after.precision >= before.precision
      && after.recall >= before.recall
      && after.queryCount === before.queryCount;
  });
}

function allPolicyChecks(report: B3PolicyEvaluationReport): B3PolicyCheck[] {
  return [
    ...report.cases,
    ...report.promotionProvenance,
    ...report.prospectiveTransitions,
    ...report.seededUpgrade,
    ...report.workingStateProvenance
  ];
}

export async function runStageB3CoreHandoffComparison(
  policyRunner?: () => Promise<B3PolicyEvaluationReport>,
  qualityRunner?: () => Promise<MemoryQualityReport>,
  dependencies: {
    baselineLoader?: () => Promise<StageB2CoreHandoffBaseline>;
    fixtureLoader?: () => Promise<QualityFixtureBundle>;
  } = {}
): Promise<StageB3CoreHandoffComparisonReport> {
  const baseline = await (dependencies.baselineLoader ?? loadStageB2CoreHandoffBaseline)();
  const fixtures = await (dependencies.fixtureLoader ?? loadQualityFixtures)();
  assertB3FixtureContract(baseline.fixture, normalizeB3FixtureContract(fixtures.longHorizon));

  const runQuality = qualityRunner ?? (await import("./runner.ts")).runMemoryQualityEval;
  const runPolicy = policyRunner ?? (await import("./core-handoff-policy-eval.ts")).runB3PolicyEvaluation;
  const [candidate, policy] = await Promise.all([runQuality(), runPolicy()]);
  const before = baseline.acceptedResult;
  const pollutedKeys = {
    removed: removed(before.corePollution.pollutedKeys, candidate.summary.corePollution.pollutedKeys),
    new: added(before.corePollution.pollutedKeys, candidate.summary.corePollution.pollutedKeys),
    unchanged: unchanged(
      before.corePollution.pollutedKeys,
      candidate.summary.corePollution.pollutedKeys
    )
  };
  const unexpectedHandoffFacts = {
    removed: removed(before.handoff.unexpectedFacts, candidate.summary.handoff.unexpectedFacts),
    new: added(before.handoff.unexpectedFacts, candidate.summary.handoff.unexpectedFacts),
    unchanged: unchanged(
      before.handoff.unexpectedFacts,
      candidate.summary.handoff.unexpectedFacts
    )
  };
  const missingHandoffFacts = {
    new: added(before.handoff.missingFacts, candidate.summary.handoff.missingFacts),
    unchanged: unchanged(before.handoff.missingFacts, candidate.summary.handoff.missingFacts)
  };
  const policyChecks = allPolicyChecks(policy);
  const caseIds = policy.cases.map((item) => item.id);
  const expectedCaseIds = Array.from({ length: 22 }, (_, index) => `C${index + 1}`);
  const acceptance = [
    check(
      "core-pollution-strict-improvement",
      candidate.summary.corePollution.value < before.corePollution.value
        && candidate.summary.corePollution.pollutedKeys.length
          < before.corePollution.pollutedKeys.length,
      "Core pollution rate and polluted logical-key count must strictly decrease."
    ),
    check(
      "handoff-unexpected-strict-improvement",
      candidate.summary.handoff.unexpectedFacts.length < before.handoff.unexpectedFacts.length,
      "Unexpected Handoff fact count must strictly decrease."
    ),
    check(
      "no-new-pollution-or-missing-handoff",
      pollutedKeys.new.length === 0 && missingHandoffFacts.new.length === 0,
      "No new polluted Core key or missing required Handoff fact is allowed."
    ),
    check(
      "bootstrap-and-handoff-coverage",
      candidate.summary.bootstrap.criticalCoverage.value
        >= before.bootstrap.criticalCoverage.value
        && candidate.summary.handoff.value >= before.handoff.value,
      "Bootstrap critical and Handoff required-fact coverage must not regress."
    ),
    check(
      "c1-c22",
      JSON.stringify(caseIds) === JSON.stringify(expectedCaseIds)
        && policy.cases.every((item) => item.status === "pass"),
      "C1-C22 must be present in normative order and PASS."
    ),
    check(
      "promotion-provenance",
      policy.promotionProvenance.length > 0
        && policy.promotionProvenance.every((item) => item.status === "pass"),
      "Automatic, explicit-agent, explicit-user, and legacy promotion provenance must pass."
    ),
    check(
      "prospective-transitions",
      policy.prospectiveTransitions.length > 0
        && policy.prospectiveTransitions.every((item) => item.status === "pass"),
      "Changed and equivalent existing-Core transitions must follow the reason matrix."
    ),
    check(
      "seeded-upgrade",
      policy.seededUpgrade.length > 0
        && policy.seededUpgrade.every((item) => item.status === "pass"),
      "Seeded B2-to-B3 upgrade behavior must preserve legacy state and apply new Handoff policy."
    ),
    check(
      "working-state-provenance",
      JSON.stringify(policy.workingStateProvenance.map((item) => item.id))
        === JSON.stringify(["H1", "H2", "H3", "H4"])
        && policy.workingStateProvenance.every((item) => item.status === "pass"),
      "Seeded blocker/question Handoff provenance holdouts H1-H4 must pass."
    ),
    check(
      "retrieval-non-regression",
      retrievalNonRegression(before.retrieval, candidate.summary.retrieval)
        && candidate.summary.negativeRetrieval.falsePositiveRate
          <= before.negativeRetrieval.falsePositiveRate
        && candidate.summary.negativeRetrieval.abstentionRate
          >= before.negativeRetrieval.abstentionRate,
      "Frozen B1 positive and negative retrieval metrics must not regress."
    ),
    check(
      "extraction-frozen",
      JSON.stringify(candidate.summary.extraction) === JSON.stringify(before.extraction),
      "Frozen B2 extraction must remain TP=6, FP=0, FN=0, precision=1, recall=1."
    ),
    check(
      "quality-non-regression",
      candidate.summary.staleMemory.value <= before.staleMemory.value
        && candidate.summary.duplicateMemory.value <= before.duplicateMemory.value
        && candidate.summary.contradiction.value >= before.contradiction.value,
      "Stale, duplicate, and contradiction metrics must not regress."
    ),
    check(
      "hard-correctness",
      candidate.correctness.overall === "pass"
        && candidate.correctness.checks.every((item) => item.status === "pass")
        && policyChecks.every((item) => item.status === "pass"),
      "Whole-quality and B3 policy correctness must PASS."
    )
  ];

  return {
    version: 1,
    baseline: {
      id: baseline.id,
      sourceCommit: baseline.sourceCommit,
      corePollution: before.corePollution,
      handoff: before.handoff
    },
    candidate: {
      reportVersion: candidate.version,
      corePollution: candidate.summary.corePollution,
      handoff: candidate.summary.handoff
    },
    pollutedKeys,
    unexpectedHandoffFacts,
    missingHandoffFacts,
    bootstrapCriticalCoverage: {
      baseline: before.bootstrap.criticalCoverage.value,
      candidate: candidate.summary.bootstrap.criticalCoverage.value,
      baselineMissingKeys: before.bootstrap.missingCriticalKeys,
      candidateMissingKeys: candidate.summary.bootstrap.missingCriticalKeys
    },
    coreItemCount: {
      baseline: before.bootstrap.coreItemCount,
      candidate: candidate.summary.bootstrap.coreItemCount
    },
    handoffRequiredCoverage: {
      baseline: before.handoff.value,
      candidate: candidate.summary.handoff.value
    },
    retrieval: { baseline: before.retrieval, candidate: candidate.summary.retrieval },
    extraction: { baseline: before.extraction, candidate: candidate.summary.extraction },
    policy,
    correctness: candidate.correctness,
    acceptance: {
      overall: acceptance.every((item) => item.status === "pass") ? "pass" : "fail",
      checks: acceptance
    }
  };
}

function fixed(value: number): string {
  return value.toFixed(6);
}

export function formatStageB3CoreHandoffComparison(
  report: StageB3CoreHandoffComparisonReport
): string[] {
  const lines = [
    "P6 Stage B3 — Core/Handoff comparison",
    `Frozen B2 source: ${report.baseline.sourceCommit}`,
    "",
    "Fresh-store candidate",
    `Core items        ${report.coreItemCount.baseline} → ${report.coreItemCount.candidate}`,
    `Core pollution    ${fixed(report.baseline.corePollution.value)} → ${fixed(report.candidate.corePollution.value)}`,
    `Handoff coverage  ${fixed(report.handoffRequiredCoverage.baseline)} → ${fixed(report.handoffRequiredCoverage.candidate)}`,
    `Handoff unexpected ${report.baseline.handoff.unexpectedFacts.length} → ${report.candidate.handoff.unexpectedFacts.length}`,
    `Bootstrap coverage ${fixed(report.bootstrapCriticalCoverage.baseline)} → ${fixed(report.bootstrapCriticalCoverage.candidate)}`,
    `Bootstrap missing: ${report.bootstrapCriticalCoverage.candidateMissingKeys.join(", ") || "none"}`,
    `Removed polluted keys: ${report.pollutedKeys.removed.join(", ") || "none"}`,
    `New polluted keys:     ${report.pollutedKeys.new.join(", ") || "none"}`,
    `Unchanged polluted:     ${report.pollutedKeys.unchanged.join(", ") || "none"}`,
    `Removed unexpected:    ${report.unexpectedHandoffFacts.removed.join(" | ") || "none"}`,
    `New unexpected:        ${report.unexpectedHandoffFacts.new.join(" | ") || "none"}`,
    `Unchanged unexpected:  ${report.unexpectedHandoffFacts.unchanged.join(" | ") || "none"}`,
    `New missing facts:     ${report.missingHandoffFacts.new.join(" | ") || "none"}`,
    `Unchanged missing:     ${report.missingHandoffFacts.unchanged.join(" | ") || "none"}`,
    "",
    `Extraction TP/FP/FN ${report.extraction.baseline.tp}/${report.extraction.baseline.fp}/${report.extraction.baseline.fn} → ${report.extraction.candidate.tp}/${report.extraction.candidate.fp}/${report.extraction.candidate.fn}`,
    "Retrieval non-regression"
  ];
  for (const before of report.retrieval.baseline) {
    const after = report.retrieval.candidate.find((item) => item.k === before.k)!;
    lines.push(`  K=${before.k} P ${fixed(before.precision)} → ${fixed(after.precision)} | R ${fixed(before.recall)} → ${fixed(after.recall)}`);
  }
  lines.push(
    "",
    "C1-C22"
  );
  for (const item of report.policy.cases) lines.push(`  ${item.status.toUpperCase()} ${item.id}`);
  lines.push("", "Promotion provenance");
  for (const item of report.policy.promotionProvenance) {
    lines.push(`  ${item.status.toUpperCase()} ${item.id}`);
  }
  lines.push("", "Prospective existing-Core transitions");
  for (const item of report.policy.prospectiveTransitions) {
    lines.push(`  ${item.status.toUpperCase()} ${item.id}`);
  }
  lines.push("", "Seeded B2 → B3 upgrade (legacy state; no retroactive tier claim)");
  for (const item of report.policy.seededUpgrade) {
    lines.push(`  ${item.status.toUpperCase()} ${item.id}`);
  }
  lines.push("", "Acceptance checks");
  for (const item of report.acceptance.checks) {
    lines.push(`  ${item.status.toUpperCase().padEnd(4)} ${item.id}`);
  }
  lines.push("", `Overall ${report.acceptance.overall.toUpperCase()}`);
  return lines;
}
