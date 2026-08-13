import { readFile } from "node:fs/promises";
import * as z from "zod/v4";

const atKSchema = z.object({
  k: z.number().int().positive(),
  hits: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1)
}).strict();

const filtersSchema = z.object({
  families: z.array(z.enum(["knowledge", "state", "episode", "procedure"])).min(1).optional(),
  types: z.array(z.string().min(1)).min(1).optional(),
  tiers: z.array(z.enum(["core", "indexed"])).min(1).optional(),
  statuses: z.array(z.enum(["active", "resolved", "superseded", "archived"])).min(1).optional()
}).strict();

const querySchema = z.object({
  scenarioId: z.string().min(1),
  id: z.string().min(1),
  classification: z.enum(["positive", "negative"]),
  query: z.string(),
  relevantMemoryKeys: z.array(z.string().min(1)),
  filters: filtersSchema,
  eligibleCorpusSize: z.number().int().nonnegative(),
  returned: z.array(z.string().min(1)),
  atK: z.array(atKSchema)
}).strict().superRefine((query, context) => {
  const expectedClassification = query.relevantMemoryKeys.length > 0 ? "positive" : "negative";
  if (query.classification !== expectedClassification) {
    context.addIssue({
      code: "custom",
      message: "classification must match relevantMemoryKeys cardinality"
    });
  }
});

export const stageABaselineSchema = z.object({
  version: z.literal(2),
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
