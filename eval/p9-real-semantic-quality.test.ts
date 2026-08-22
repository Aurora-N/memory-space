import assert from "node:assert/strict";
import test from "node:test";
import type { SemanticExtractionModelInput } from "../src/ports/semantic-extraction-model.ts";
import {
  loadP9RealSemanticQualityFixture,
  runP9RealSemanticQualityEval,
} from "./p9-real-semantic-quality.ts";

test("real semantic quality dataset keeps independent positive, negative, and holdout floors", async () => {
  const fixture = await loadP9RealSemanticQualityFixture();
  assert.ok(fixture.scenarios.filter((item) => item.durable).length >= 20);
  assert.ok(fixture.scenarios.filter((item) => !item.durable).length >= 20);
  assert.ok(fixture.scenarios.some((item) => item.split === "holdout"));
});

test("real semantic quality model receives raw conversation and extraction contract only", async () => {
  const inputs: SemanticExtractionModelInput[] = [];
  const report = await runP9RealSemanticQualityEval({
    model: {
      async extract(input) {
        inputs.push(input);
        return {
          schemaVersion: 1,
          candidates: [
            {
              family: "knowledge",
              type: "fact",
              content: "PostgreSQL",
              assertion: "direct",
              durability: "durable",
              evidence: [{ eventId: "u0", quote: "项目数据库使用 PostgreSQL。" }],
            },
          ],
        };
      },
    },
    fixture: {
      version: 1,
      scenarios: [
        {
          scenarioId: "raw-only",
          split: "holdout",
          user: "项目数据库使用 PostgreSQL。",
          durable: true,
          anchors: ["PostgreSQL"],
        },
      ],
    },
  });
  assert.equal(report.status, "pass");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0]?.events, [
    { id: "u0", role: "user", content: "项目数据库使用 PostgreSQL。" },
  ]);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /anchors|expected|holdout/u);
});
