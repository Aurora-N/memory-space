import type { MemoryQualityReport } from "./types.ts";

function metric(value: number): string {
  return value.toFixed(3);
}

function compact(value: unknown): string {
  const rendered = JSON.stringify(value);
  return rendered.length > 100 ? `${rendered.slice(0, 97)}...` : rendered;
}

export function formatMemoryQualityReport(report: MemoryQualityReport): string[] {
  const lines = [
    "Memory Quality v1 — Baseline",
    "",
    "Extraction",
    `  Precision        ${metric(report.summary.extraction.precision)} (${report.summary.extraction.tp} TP / ${report.summary.extraction.fp} FP)`,
    `  Recall           ${metric(report.summary.extraction.recall)} (${report.summary.extraction.fn} FN)`,
    "",
    "Retrieval"
  ];
  for (const item of report.summary.retrieval) {
    lines.push(`  P@${String(item.k).padEnd(2)}             ${metric(item.precision)}`);
    lines.push(`  R@${String(item.k).padEnd(2)}             ${metric(item.recall)}`);
  }
  lines.push(
    "",
    `Core pollution     ${metric(report.summary.corePollution.value)} (${report.summary.corePollution.numerator}/${report.summary.corePollution.denominator})`,
    `Bootstrap coverage ${metric(report.summary.bootstrap.criticalCoverage.value)} (${report.summary.bootstrap.criticalCoverage.numerator}/${report.summary.bootstrap.criticalCoverage.denominator})`,
    `Handoff complete   ${metric(report.summary.handoff.value)} (${report.summary.handoff.numerator}/${report.summary.handoff.denominator})`,
    `Stale memory       ${metric(report.summary.staleMemory.value)} (${report.summary.staleMemory.numerator}/${report.summary.staleMemory.denominator})`,
    `Duplicate memory   ${metric(report.summary.duplicateMemory.value)} (${report.summary.duplicateMemory.numerator}/${report.summary.duplicateMemory.denominator})`,
    `Contradictions     ${metric(report.summary.contradiction.value)} (${report.summary.contradiction.numerator}/${report.summary.contradiction.denominator})`,
    "",
    "Long horizon",
    `  Sessions         ${report.summary.longHorizonSessions}`,
    `  Core items       ${report.summary.bootstrap.coreItemCount}`,
    `  Handoff facts    ${report.summary.bootstrap.handoffFactCount}`,
    `  Bootstrap chars  ${report.summary.bootstrap.chars}`,
    `  Bootstrap bytes  ${report.summary.bootstrap.bytes}`,
    "",
    `Correctness invariants                 ${report.correctness.overall.toUpperCase()}`,
    "",
    "Top observed failures"
  );
  if (report.failures.length === 0) {
    lines.push("(none recorded)");
  } else {
    for (const [index, failure] of report.failures.slice(0, 5).entries()) {
      lines.push(
        `${index + 1}. ${failure.metric} — ${failure.scenario}: expected ${compact(failure.expected)}, observed ${compact(failure.observed)}`
      );
    }
  }
  lines.push("", "Quality scores are baseline observations, not PASS/FAIL thresholds.");
  return lines;
}
