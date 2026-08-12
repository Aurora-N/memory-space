import assert from "node:assert/strict";
import test from "node:test";
import {
  crossSessionScenarios,
  runCrossSessionEval,
  runCrossSessionMultiHop,
  runCrossSessionScenario
} from "./support/cross-session-runner.ts";

for (const [sourceProvider, targetProvider] of crossSessionScenarios) {
  test(`P4 durable matrix: ${sourceProvider} -> ${targetProvider}`, async () => {
    await runCrossSessionScenario(sourceProvider, targetProvider);
  });
}

test("P4 multi-hop: Codex A -> Claude B -> Codex C -> Claude D", async () => {
  await runCrossSessionMultiHop();
});

test("canonical P4 runner reports the complete product proof", async () => {
  const report = await runCrossSessionEval();
  assert.equal(report.overall, "pass");
  assert.equal(report.claudeRealMcp, "waived");
  assert.equal(report.checks.length, 10);
  assert.ok(report.checks.every((check) => check.status === "pass"));
});
