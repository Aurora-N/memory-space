import { isDeepStrictEqual } from "node:util";
import {
  loadStageAExtractionBaseline,
  type StageAExtractionBaseline
} from "./extraction-baseline.ts";
import { loadQualityFixtures } from "./fixtures.ts";
import type {
  ExtractionFixture,
  ExtractionMetric,
  MemoryQualityReport
} from "./types.ts";

type ExtractionContract = StageAExtractionBaseline["fixture"];

interface ExtractionCases {
  fixedFalseNegatives: string[];
  removedFalsePositives: string[];
  newFalseNegatives: string[];
  newFalsePositives: string[];
  unchangedFalseNegatives: string[];
  unchangedFalsePositives: string[];
}

export interface StageB2ExtractionComparisonReport {
  version: 1;
  baseline: {
    id: "p6-stage-a-extraction";
    acceptedCommit: string;
    fixtureId: string;
    metrics: ExtractionMetric;
  };
  candidate: {
    reportVersion: 1;
    fixtureId: string;
    metrics: ExtractionMetric;
  };
  contract: {
    status: "pass";
    eventCount: number;
    expectedMemoryCount: number;
    negativeEvidenceCount: number;
    ordering: "normative";
    expectedRationale: "descriptive-not-frozen";
  };
  cases: ExtractionCases;
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

function expectedMemoryContract(memory: ExtractionFixture["expectedMemories"][number]) {
  return {
    logicalKey: memory.logicalKey,
    family: memory.family,
    type: memory.type,
    ...(memory.key === undefined ? {} : { key: memory.key }),
    content: memory.content,
    shouldBeCore: memory.shouldBeCore
  };
}

export function assertStageAExtractionContract(
  baseline: ExtractionContract,
  candidate: ExtractionFixture
): void {
  if (candidate.version !== baseline.version) {
    throw new Error("Stage A extraction fixture version mutation");
  }
  if (candidate.id !== baseline.id) {
    throw new Error("Stage A extraction fixture id mutation");
  }
  if (candidate.events.length !== baseline.events.length) {
    throw new Error("Stage A extraction event set mutation");
  }
  for (let index = 0; index < baseline.events.length; index += 1) {
    if (candidate.events[index] !== baseline.events[index]) {
      throw new Error(`Stage A extraction event text/order mutation at index ${index}`);
    }
  }
  if (candidate.expectedMemories.length !== baseline.expectedMemories.length) {
    throw new Error("Stage A extraction expected Memory set mutation");
  }
  for (let index = 0; index < baseline.expectedMemories.length; index += 1) {
    const before = baseline.expectedMemories[index]!;
    const after = expectedMemoryContract(candidate.expectedMemories[index]!);
    if (after.logicalKey !== before.logicalKey) {
      throw new Error(`Stage A extraction expected logical key/order mutation at index ${index}`);
    }
    if (after.family !== before.family) {
      throw new Error(`Stage A extraction expected family mutation: ${before.logicalKey}`);
    }
    if (after.type !== before.type) {
      throw new Error(`Stage A extraction expected type mutation: ${before.logicalKey}`);
    }
    if (after.key !== before.key) {
      throw new Error(`Stage A extraction expected key mutation: ${before.logicalKey}`);
    }
    if (after.content !== before.content) {
      throw new Error(`Stage A extraction expected content mutation: ${before.logicalKey}`);
    }
    if (after.shouldBeCore !== before.shouldBeCore) {
      throw new Error(`Stage A extraction expected shouldBeCore mutation: ${before.logicalKey}`);
    }
  }
  if (candidate.negativeEvidence.length !== baseline.negativeEvidence.length) {
    throw new Error("Stage A extraction negative-evidence set mutation");
  }
  for (let index = 0; index < baseline.negativeEvidence.length; index += 1) {
    const before = baseline.negativeEvidence[index]!;
    const after = candidate.negativeEvidence[index]!;
    if (after.text !== before.text) {
      throw new Error(`Stage A extraction negative-evidence text/order mutation at index ${index}`);
    }
    if (after.reason !== before.reason) {
      throw new Error(`Stage A extraction negative-evidence reason mutation at index ${index}`);
    }
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Candidate extraction observation is invalid: ${label}`);
  }
  return [...value];
}

function candidateCases(report: MemoryQualityReport, fixtureId: string): {
  matched: string[];
  missing: string[];
  unexpected: string[];
} {
  const scenario = report.scenarios.find((item) =>
    item.kind === "extraction" && item.id === fixtureId
  );
  if (!scenario) throw new Error(`Candidate extraction scenario is missing: ${fixtureId}`);
  return {
    matched: stringArray(scenario.observations.matchedKeys, "matchedKeys"),
    missing: stringArray(scenario.observations.missingKeys, "missingKeys"),
    unexpected: stringArray(
      scenario.observations.unexpectedPredictions,
      "unexpectedPredictions"
    )
  };
}

function removed(before: readonly string[], after: readonly string[]): string[] {
  const afterSet = new Set(after);
  return before.filter((value) => !afterSet.has(value)).sort();
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  return after.filter((value) => !beforeSet.has(value)).sort();
}

function unchanged(before: readonly string[], after: readonly string[]): string[] {
  const afterSet = new Set(after);
  return before.filter((value) => afterSet.has(value)).sort();
}

function check(
  id: string,
  passed: boolean,
  detail: string
): StageB2ExtractionComparisonReport["acceptance"]["checks"][number] {
  return { id, status: passed ? "pass" : "fail", detail };
}

export async function runStageB2ExtractionComparison(): Promise<StageB2ExtractionComparisonReport> {
  const baseline = await loadStageAExtractionBaseline();
  const fixtures = await loadQualityFixtures();
  assertStageAExtractionContract(baseline.fixture, fixtures.extraction);

  const { runMemoryQualityEval } = await import("./runner.ts");
  const candidateReport = await runMemoryQualityEval();
  const candidate = candidateCases(candidateReport, baseline.fixture.id);
  const expectedKeys = baseline.fixture.expectedMemories.map((memory) => memory.logicalKey).sort();
  if (!isDeepStrictEqual([...candidate.matched, ...candidate.missing].sort(), expectedKeys)) {
    throw new Error("Candidate extraction result does not cover the frozen expected Memory set");
  }

  const before = baseline.acceptedResult;
  const cases: ExtractionCases = {
    fixedFalseNegatives: removed(before.missingMemoryKeys, candidate.missing),
    removedFalsePositives: removed(before.unexpectedPredictions, candidate.unexpected),
    newFalseNegatives: added(before.missingMemoryKeys, candidate.missing),
    newFalsePositives: added(before.unexpectedPredictions, candidate.unexpected),
    unchangedFalseNegatives: unchanged(before.missingMemoryKeys, candidate.missing),
    unchangedFalsePositives: unchanged(before.unexpectedPredictions, candidate.unexpected)
  };
  const metrics = candidateReport.summary.extraction;
  if (metrics.tp !== candidate.matched.length
    || metrics.fn !== candidate.missing.length
    || metrics.fp !== candidate.unexpected.length) {
    throw new Error("Candidate extraction metrics do not match per-case results");
  }
  const checks = [
    check(
      "stage-a-extraction-contract",
      true,
      "Fixture version/id, ordered events, expected Memories, and negative evidence match Stage A."
    ),
    check(
      "hard-correctness",
      candidateReport.correctness.overall === "pass"
        && candidateReport.correctness.checks.every((item) => item.status === "pass"),
      "The full quality evaluator hard-correctness checks must remain PASS."
    ),
    check(
      "precision-non-regression",
      metrics.precision >= before.metrics.precision,
      "Extraction precision must equal or exceed accepted Stage A."
    ),
    check(
      "recall-strict-improvement",
      metrics.recall > before.metrics.recall,
      "Extraction recall must strictly exceed accepted Stage A."
    ),
    check(
      "false-negative-reduction",
      metrics.fn < 2 && cases.fixedFalseNegatives.length >= 1,
      "At least one accepted Stage A false negative must be fixed and FN must be below 2."
    ),
    check(
      "no-new-accepted-extraction-regression",
      cases.newFalseNegatives.length === 0 && cases.newFalsePositives.length === 0,
      "The candidate must add no accepted-fixture false negative or false positive."
    )
  ];
  return {
    version: 1,
    baseline: {
      id: baseline.id,
      acceptedCommit: baseline.acceptedCommit,
      fixtureId: baseline.fixture.id,
      metrics: { ...before.metrics }
    },
    candidate: {
      reportVersion: candidateReport.version,
      fixtureId: baseline.fixture.id,
      metrics: { ...metrics }
    },
    contract: {
      status: "pass",
      eventCount: baseline.fixture.events.length,
      expectedMemoryCount: baseline.fixture.expectedMemories.length,
      negativeEvidenceCount: baseline.fixture.negativeEvidence.length,
      ordering: "normative",
      expectedRationale: "descriptive-not-frozen"
    },
    cases,
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

export function formatStageB2ExtractionComparison(
  report: StageB2ExtractionComparisonReport
): string[] {
  const before = report.baseline.metrics;
  const after = report.candidate.metrics;
  const lines = [
    "P6 Stage B2 — Extraction comparison",
    `Accepted Stage A: ${report.baseline.acceptedCommit}`,
    `Contract: ${report.contract.status.toUpperCase()} (ordered fixture evidence frozen)`,
    "",
    "Metric       Stage A      Candidate    Delta"
  ];
  for (const [label, field] of [
    ["TP", "tp"],
    ["FP", "fp"],
    ["FN", "fn"],
    ["Precision", "precision"],
    ["Recall", "recall"]
  ] as const) {
    const baselineValue = before[field];
    const candidateValue = after[field];
    const render = field === "tp" || field === "fp" || field === "fn"
      ? (value: number) => String(value)
      : fixed;
    lines.push(
      `${label.padEnd(12)} ${render(baselineValue).padStart(8)}      ${render(candidateValue).padStart(8)}    ${(candidateValue - baselineValue >= 0 ? "+" : "") + render(candidateValue - baselineValue)}`
    );
  }
  lines.push(
    "",
    `Fixed false negatives:   ${report.cases.fixedFalseNegatives.length}`,
    `Removed false positives: ${report.cases.removedFalsePositives.length}`,
    `New false negatives:     ${report.cases.newFalseNegatives.length}`,
    `New false positives:     ${report.cases.newFalsePositives.length}`,
    `Unchanged failures:      ${report.cases.unchangedFalseNegatives.length + report.cases.unchangedFalsePositives.length}`,
    "",
    "Acceptance checks"
  );
  for (const item of report.acceptance.checks) {
    lines.push(`  ${item.status.toUpperCase().padEnd(4)} ${item.id}`);
  }
  lines.push("", `Overall ${report.acceptance.overall.toUpperCase()}`);
  return lines;
}
