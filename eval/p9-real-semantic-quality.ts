import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ClaudeCodeHostSemanticExtractionModel } from "../src/adapters/semantic-models/claude-code-host.ts";
import { OpenAiCompatibleSemanticExtractionModel } from "../src/adapters/semantic-models/openai-compatible.ts";
import type { MemoryCandidate, Session, SessionEvent } from "../src/domain/types.ts";
import { probeHostAgentCapability } from "../src/integration/host-agent-capability.ts";
import { SemanticMemoryExtractor } from "../src/integration/semantic-memory-extractor.ts";
import type { SemanticExtractionModel } from "../src/ports/semantic-extraction-model.ts";

interface RealQualityScenario {
  scenarioId: string;
  split: "fixture" | "holdout";
  user: string;
  assistant?: string;
  durable: boolean;
  anchors: string[];
}

export interface P9RealSemanticQualityFixture {
  version: 1;
  scenarios: RealQualityScenario[];
}

export type P9RealSemanticQualityReport =
  | { status: "blocked"; reason: string }
  | {
      status: "pass" | "fail";
      backend: "external" | "host-agent" | "injected";
      dataset: { positives: number; negatives: number; fixture: number; holdout: number };
      semanticDurablePrecision: number;
      semanticDurableRecall: number;
      scenarios: Array<{ scenarioId: string; accepted: string[]; passed: boolean }>;
    };

const fixtureUrl = new URL("./fixtures/p9-real-semantic-quality.json", import.meta.url);

export function validateP9RealSemanticQualityFixture(value: unknown): P9RealSemanticQualityFixture {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const root = value as Record<string, unknown>;
  assert.equal(root.version, 1);
  assert.ok(Array.isArray(root.scenarios));
  const scenarios = root.scenarios as RealQualityScenario[];
  assert.ok(scenarios.filter((item) => item.durable).length >= 20);
  assert.ok(scenarios.filter((item) => !item.durable).length >= 20);
  assert.ok(scenarios.every((item) => item.split === "fixture" || item.split === "holdout"));
  assert.ok(scenarios.every((item) => typeof item.user === "string" && item.user.length > 0));
  assert.ok(scenarios.every((item) => Array.isArray(item.anchors)));
  return { version: 1, scenarios };
}

export async function loadP9RealSemanticQualityFixture(): Promise<P9RealSemanticQualityFixture> {
  return validateP9RealSemanticQualityFixture(
    JSON.parse(await readFile(fixtureUrl, "utf8")) as unknown
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export async function runP9RealSemanticQualityEval(options: {
  model: SemanticExtractionModel;
  backend?: "external" | "host-agent" | "injected";
  fixture?: P9RealSemanticQualityFixture;
}): Promise<Exclude<P9RealSemanticQualityReport, { status: "blocked" }>> {
  const fixture = options.fixture ?? (await loadP9RealSemanticQualityFixture());
  const session: Session = {
    id: "p9-real-quality",
    spaceId: "p9-real-quality",
    provider: "quality-eval",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
  const extractor = new SemanticMemoryExtractor({
    configurationResolver: {
      async resolve() {
        return {
          configuredMode: "grounded",
          effectiveMode: "grounded",
          source: "explicit",
          timeoutMs: 30_000,
          model: {
            backend: "external",
            adapter: "openai-compatible",
            baseUrl: "https://quality.eval.invalid/v1",
            model: "real-quality-eval",
          },
        };
      },
    },
    modelResolver: {
      async resolve() {
        return {
          available: true,
          backend: options.backend === "host-agent" ? "host-agent" : "external",
          adapter: "quality-eval",
          model: options.model,
        };
      },
    },
  });
  const results: Array<{ scenarioId: string; accepted: string[]; passed: boolean }> = [];
  let truePositiveCandidates = 0;
  let acceptedCandidates = 0;
  let recalledPositives = 0;
  for (const [index, scenario] of fixture.scenarios.entries()) {
    const events: SessionEvent[] = [
      {
        id: `u${index}`,
        sessionId: session.id,
        type: "message",
        payload: { role: "user", content: scenario.user },
        sequence: 1,
        createdAt: "2026-08-22T00:00:00.000Z",
      },
      ...(scenario.assistant
        ? [
            {
              id: `a${index}`,
              sessionId: session.id,
              type: "message" as const,
              payload: { role: "assistant", content: scenario.assistant },
              sequence: 2,
              createdAt: "2026-08-22T00:00:01.000Z",
            },
          ]
        : []),
    ];
    const candidates: MemoryCandidate[] = await extractor.extract(events, {
      session,
      trigger: "implicit_remember",
      operationId: `quality-${scenario.scenarioId}`,
      sourceEvents: events,
    });
    const correct = candidates.filter((candidate) =>
      scenario.anchors.some((anchor) => candidate.content.includes(anchor))
    );
    acceptedCandidates += candidates.length;
    truePositiveCandidates += correct.length;
    if (scenario.durable && correct.length > 0) recalledPositives += 1;
    const passed = scenario.durable ? correct.length > 0 : candidates.length === 0;
    results.push({
      scenarioId: scenario.scenarioId,
      accepted: candidates.map((candidate) => candidate.content),
      passed,
    });
  }
  const positives = fixture.scenarios.filter((item) => item.durable).length;
  const precision = ratio(truePositiveCandidates, acceptedCandidates);
  const recall = ratio(recalledPositives, positives);
  return {
    status: precision >= 0.95 && recall >= 0.75 ? "pass" : "fail",
    backend: options.backend ?? "injected",
    dataset: {
      positives,
      negatives: fixture.scenarios.length - positives,
      fixture: fixture.scenarios.filter((item) => item.split === "fixture").length,
      holdout: fixture.scenarios.filter((item) => item.split === "holdout").length,
    },
    semanticDurablePrecision: precision,
    semanticDurableRecall: recall,
    scenarios: results,
  };
}

export async function runConfiguredP9RealSemanticQualityEval(
  env: NodeJS.ProcessEnv = process.env
): Promise<P9RealSemanticQualityReport> {
  const backend = env.MEMORY_SPACE_P9_QUALITY_BACKEND;
  if (backend === "host-agent") {
    const capability = await probeHostAgentCapability("claude-code");
    if (capability.status !== "reviewed") {
      return { status: "blocked", reason: `Claude Code capability is ${capability.status}.` };
    }
    return runP9RealSemanticQualityEval({
      backend: "host-agent",
      model: new ClaudeCodeHostSemanticExtractionModel({ timeoutMs: 30_000, env }),
    });
  }
  if (backend === "external") {
    const baseUrl = env.MEMORY_SPACE_P9_QUALITY_BASE_URL;
    const model = env.MEMORY_SPACE_P9_QUALITY_MODEL;
    const apiKey = env.MEMORY_SPACE_P9_QUALITY_API_KEY;
    if (!baseUrl || !model) {
      return {
        status: "blocked",
        reason:
          "External quality eval requires MEMORY_SPACE_P9_QUALITY_BASE_URL and MEMORY_SPACE_P9_QUALITY_MODEL.",
      };
    }
    return runP9RealSemanticQualityEval({
      backend: "external",
      model: new OpenAiCompatibleSemanticExtractionModel({
        baseUrl,
        model,
        apiKey,
        timeoutMs: 30_000,
      }),
    });
  }
  return {
    status: "blocked",
    reason: "Set MEMORY_SPACE_P9_QUALITY_BACKEND to host-agent or external.",
  };
}
