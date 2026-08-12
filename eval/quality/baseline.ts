import { readFile } from "node:fs/promises";
import * as z from "zod/v4";

const atKSchema = z.object({
  k: z.number().int().positive(),
  hits: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1)
}).strict();

const querySchema = z.object({
  scenarioId: z.string().min(1),
  id: z.string().min(1),
  classification: z.enum(["positive", "negative"]),
  eligibleCorpusSize: z.number().int().nonnegative(),
  returned: z.array(z.string().min(1)),
  atK: z.array(atKSchema)
}).strict();

export const stageABaselineSchema = z.object({
  version: z.literal(1),
  id: z.literal("p6-stage-a"),
  acceptedCommit: z.literal("9490ebce94928132a2fb16aca247c8ae4888a7cf"),
  reportVersion: z.literal(1),
  retrieval: z.array(z.object({
    k: z.number().int().positive(),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    queryCount: z.number().int().nonnegative()
  }).strict()),
  negativeRetrieval: z.object({
    queryCount: z.number().int().nonnegative(),
    falsePositiveQueries: z.number().int().nonnegative(),
    abstainedQueries: z.number().int().nonnegative(),
    falsePositiveRate: z.number().min(0).max(1),
    abstentionRate: z.number().min(0).max(1),
    queries: z.array(z.object({
      id: z.string().min(1),
      query: z.string(),
      eligibleCorpusSize: z.number().int().nonnegative(),
      returned: z.array(z.string().min(1)),
      returnedCount: z.number().int().nonnegative(),
      abstained: z.boolean()
    }).strict())
  }).strict(),
  queries: z.array(querySchema),
  correctness: z.object({
    overall: z.literal("pass"),
    checks: z.array(z.object({
      id: z.string().min(1),
      status: z.literal("pass")
    }).strict())
  }).strict()
}).strict();

export type StageABaseline = z.infer<typeof stageABaselineSchema>;

export async function loadStageABaseline(): Promise<StageABaseline> {
  const content = await readFile(new URL("./baselines/p6-stage-a.json", import.meta.url), "utf8");
  return stageABaselineSchema.parse(JSON.parse(content));
}
