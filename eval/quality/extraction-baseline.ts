import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";

const nonEmpty = z.string().trim().min(1);

const extractionMetricSchema = z.object({
  tp: z.number().int().nonnegative(),
  fp: z.number().int().nonnegative(),
  fn: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1)
}).strict();

const expectedMemoryContractSchema = z.object({
  logicalKey: nonEmpty,
  family: z.enum(["knowledge", "state", "episode", "procedure"]),
  type: nonEmpty,
  key: nonEmpty.optional(),
  content: nonEmpty,
  shouldBeCore: z.boolean()
}).strict();

export const stageAExtractionBaselineSchema = z.object({
  version: z.literal(1),
  id: z.literal("p6-stage-a-extraction"),
  acceptedCommit: nonEmpty,
  fixture: z.object({
    version: z.number().int().positive(),
    id: nonEmpty,
    events: z.array(nonEmpty).min(1),
    expectedMemories: z.array(expectedMemoryContractSchema).min(1),
    negativeEvidence: z.array(z.object({
      text: nonEmpty,
      reason: nonEmpty
    }).strict())
  }).strict(),
  acceptedResult: z.object({
    metrics: extractionMetricSchema,
    matchedMemoryKeys: z.array(nonEmpty),
    missingMemoryKeys: z.array(nonEmpty),
    unexpectedPredictions: z.array(nonEmpty)
  }).strict()
}).strict();

export type StageAExtractionBaseline = z.infer<typeof stageAExtractionBaselineSchema>;

const acceptedCommit = "9490ebce94928132a2fb16aca247c8ae4888a7cf";
const acceptedMetrics = {
  tp: 4,
  fp: 1,
  fn: 2,
  precision: 0.8,
  recall: 2 / 3
} as const;
const acceptedMatchedMemoryKeys = [
  "extraction.blocker.credentials",
  "extraction.decision.sqlite-default",
  "extraction.goal.quality-baseline",
  "extraction.knowledge.migration-path"
] as const;
const acceptedMissingMemoryKeys = [
  "extraction.constraint.api-compatibility",
  "extraction.decision.hosted-postgresql"
] as const;
const acceptedUnexpectedPredictions = [
  "state/task:Remove the temporary debug log after this command."
] as const;

export function assertAcceptedStageAExtractionBaseline(
  baseline: StageAExtractionBaseline
): void {
  if (baseline.acceptedCommit !== acceptedCommit) {
    throw new Error("Accepted Stage A extraction commit mutation");
  }
  for (const field of ["tp", "fp", "fn", "precision", "recall"] as const) {
    if (baseline.acceptedResult.metrics[field] !== acceptedMetrics[field]) {
      throw new Error(`Accepted Stage A extraction metric mutation: ${field}`);
    }
  }
  if (!isDeepStrictEqual(
    baseline.acceptedResult.matchedMemoryKeys,
    acceptedMatchedMemoryKeys
  )) {
    throw new Error("Accepted Stage A matched-memory result mutation");
  }
  if (!isDeepStrictEqual(
    baseline.acceptedResult.missingMemoryKeys,
    acceptedMissingMemoryKeys
  )) {
    throw new Error("Accepted Stage A missing-memory result mutation");
  }
  if (!isDeepStrictEqual(
    baseline.acceptedResult.unexpectedPredictions,
    acceptedUnexpectedPredictions
  )) {
    throw new Error("Accepted Stage A unexpected-prediction result mutation");
  }
}

export async function loadStageAExtractionBaseline(): Promise<StageAExtractionBaseline> {
  const content = await readFile(
    new URL("./baselines/p6-stage-a-extraction.json", import.meta.url),
    "utf8"
  );
  const baseline = stageAExtractionBaselineSchema.parse(JSON.parse(content));
  assertAcceptedStageAExtractionBaseline(baseline);
  return baseline;
}
