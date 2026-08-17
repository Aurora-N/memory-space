import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as z from "zod/v4";
import type { LongHorizonFixture } from "./types.ts";

const nonEmpty = z.string().trim().min(1);
const family = z.enum(["knowledge", "state", "episode", "procedure"]);
const status = z.enum(["active", "resolved", "superseded", "archived"]);
const candidateOperation = z.enum(["create", "update", "supersede", "ignore"]);
const promotionProvenance = z.enum([
  "AUTOMATIC",
  "EXPLICIT_AGENT",
  "EXPLICIT_USER",
  "AMBIGUOUS_LEGACY"
]);
const transitionOperation = z.enum([
  "checkpoint",
  "remember",
  "automatic-promotion",
  "explicit-agent-promotion",
  "explicit-user-promotion",
  "idempotent-promote-noop",
  "demote",
  "status-change"
]);

const memoryContractSchema = z.object({
  logicalKey: nonEmpty,
  family,
  type: nonEmpty,
  key: nonEmpty.optional(),
  content: nonEmpty,
  status: z.literal("active"),
  shouldBeCore: z.boolean()
}).strict();

const statusAction = z.object({
  sourceMode: z.literal("status-change"),
  transitionOperations: z.tuple([z.literal("status-change")]),
  statusChange: z.object({
    logicalKey: nonEmpty,
    status,
    reason: nonEmpty
  }).strict()
}).strict();

const explicitAction = z.object({
  sourceMode: z.literal("explicit-remember"),
  transitionOperations: z.array(transitionOperation).min(1),
  explicitMemory: memoryContractSchema.extend({ promote: z.boolean() }).strict(),
  requestedPromotionProvenance: z.literal("EXPLICIT_USER").optional(),
  observedB2PromotionProvenance: z.literal("AMBIGUOUS_LEGACY").optional()
}).strict();

const checkpointAction = z.object({
  sourceMode: z.enum(["checkpoint-message", "checkpoint-structured-memory"]),
  transitionOperations: z.tuple([z.literal("checkpoint")]),
  events: z.array(nonEmpty).min(1),
  expectedMemories: z.array(memoryContractSchema.extend({
    candidateOperation
  }).strict())
}).strict();

const fixtureContractSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  spaceId: nonEmpty,
  steps: z.array(z.object({
    id: nonEmpty,
    label: nonEmpty,
    actions: z.array(z.union([statusAction, explicitAction, checkpointAction]))
  }).strict()).length(20),
  criticalBootstrapKeys: z.array(nonEmpty).min(1)
}).strict();

const ratio = z.object({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  value: z.number().min(0).max(1)
}).strict();

const retrievalMetric = z.object({
  k: z.number().int().positive(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  queryCount: z.number().int().nonnegative()
}).strict();

const extractionMetric = z.object({
  tp: z.number().int().nonnegative(),
  fp: z.number().int().nonnegative(),
  fn: z.number().int().nonnegative(),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1)
}).strict();

const acceptedResultSchema = z.object({
  activeCoreKeys: z.array(nonEmpty),
  corePollution: ratio.extend({ pollutedKeys: z.array(nonEmpty) }).strict(),
  bootstrap: z.object({
    criticalCoverage: ratio,
    coveredCriticalKeys: z.array(nonEmpty),
    missingCriticalKeys: z.array(nonEmpty),
    unexpectedDefaultKeys: z.array(nonEmpty),
    coreItemCount: z.number().int().nonnegative(),
    handoffFactCount: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  }).strict(),
  handoff: ratio.extend({
    observedFacts: z.array(nonEmpty),
    missingFacts: z.array(nonEmpty),
    unexpectedFacts: z.array(nonEmpty)
  }).strict(),
  retrieval: z.array(retrievalMetric),
  negativeRetrieval: z.object({
    queryCount: z.number().int().nonnegative(),
    falsePositiveQueries: z.number().int().nonnegative(),
    abstainedQueries: z.number().int().nonnegative(),
    falsePositiveRate: z.number().min(0).max(1),
    abstentionRate: z.number().min(0).max(1)
  }).strict(),
  extraction: extractionMetric,
  staleMemory: ratio.extend({ staleKeys: z.array(nonEmpty) }).strict(),
  duplicateMemory: ratio.extend({
    groups: z.array(z.object({
      id: nonEmpty,
      activeMembers: z.array(nonEmpty),
      avoidableDuplicates: z.number().int().nonnegative()
    }).strict())
  }).strict(),
  contradiction: ratio.extend({
    checks: z.array(z.object({
      id: nonEmpty,
      kind: z.enum(["hard", "quality"]),
      passed: z.boolean()
    }).strict())
  }).strict(),
  correctness: z.object({
    overall: z.literal("pass"),
    checks: z.array(z.object({
      id: nonEmpty,
      status: z.literal("pass")
    }).strict())
  }).strict()
}).strict();

const seededUpgradeSchema = z.object({
  id: nonEmpty,
  memory: memoryContractSchema.pick({
    logicalKey: true,
    family: true,
    type: true,
    content: true
  }).extend({
    tier: z.literal("core"),
    status: z.literal("active"),
    version: z.number().int().positive()
  }).strict(),
  history: z.array(z.object({
    operation: nonEmpty,
    semanticPromotionProvenance: promotionProvenance.nullable()
  }).strict()),
  latestHandoff: z.object({
    activeTasks: z.array(nonEmpty),
    nextSteps: z.array(nonEmpty)
  }).strict(),
  expectedAfterOpen: z.object({
    tier: z.literal("core"),
    status: z.literal("active"),
    version: z.number().int().positive(),
    historyOperations: z.array(nonEmpty),
    latestHandoffUnchanged: z.literal(true)
  }).strict(),
  expectedAfterFirstB3Checkpoint: z.object({
    tier: z.literal("core"),
    version: z.number().int().positive(),
    historyOperations: z.array(nonEmpty),
    activeTasks: z.array(nonEmpty),
    nextSteps: z.array(nonEmpty)
  }).strict()
}).strict();

export const stageB2CoreHandoffBaselineSchema = z.object({
  version: z.literal(1),
  id: z.literal("p6-stage-b2-core-handoff"),
  sourceCommit: z.literal("e0ff2ac0248920c7c853162e4ea2f09dd2b7d260"),
  reportVersion: z.literal(1),
  fixture: fixtureContractSchema,
  expectedHandoffFacts: z.array(nonEmpty),
  acceptedResult: acceptedResultSchema,
  seededUpgrade: seededUpgradeSchema
}).strict();

export type StageB2CoreHandoffBaseline = z.infer<typeof stageB2CoreHandoffBaselineSchema>;
export type B3FixtureContract = StageB2CoreHandoffBaseline["fixture"];

const acceptedDigests = {
  fixture: "a34bcc43c8b08581bcc1915994d8fe363d01278b9d76a61a08a364bff3f4044b",
  expectedHandoffFacts: "1e97967165ec57f451e5b085345a4f1dd1d76bd48aa0cdaacd9550c7cda79dab",
  acceptedResult: "2201119c545fb233fc71baf26d4c9f78f21b8f885595b365b796e0d888a6c95b",
  seededUpgrade: "5d2872fd671103606fec84485e599422deb808d5728ec832710bbbc4507a639f"
} as const;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertAcceptedB3Baseline(baseline: StageB2CoreHandoffBaseline): void {
  for (const key of Object.keys(acceptedDigests) as Array<keyof typeof acceptedDigests>) {
    if (digest(baseline[key]) !== acceptedDigests[key]) {
      throw new Error(`Accepted B2 Core/Handoff baseline mutation: ${key}`);
    }
  }
}

type FixtureMemory = NonNullable<
  LongHorizonFixture["steps"][number]["expectedExtracted"]
>[number];

function normalizedMemoryContract(memory: FixtureMemory): z.infer<typeof memoryContractSchema> {
  return {
    logicalKey: memory.logicalKey,
    family: memory.family,
    type: memory.type,
    ...(memory.key === undefined ? {} : { key: memory.key }),
    content: memory.content,
    status: "active",
    shouldBeCore: memory.shouldBeCore
  };
}

export function normalizeB3FixtureContract(fixture: LongHorizonFixture): B3FixtureContract {
  const activeCoreKeys = new Set<string>();
  const steps: B3FixtureContract["steps"] = fixture.steps.map((step) => {
    const actions: B3FixtureContract["steps"][number]["actions"] = [];
    for (const change of step.statusChanges ?? []) {
      actions.push({
        sourceMode: "status-change",
        transitionOperations: ["status-change"],
        statusChange: { ...change }
      });
    }
    for (const explicit of step.explicitMemories ?? []) {
      const existingCore = explicit.key !== undefined && activeCoreKeys.has(explicit.key);
      const transitionOperations: z.infer<typeof transitionOperation>[] = ["remember"];
      if (explicit.promote) {
        transitionOperations.push(existingCore
          ? "idempotent-promote-noop"
          : "explicit-user-promotion");
      }
      actions.push({
        sourceMode: "explicit-remember",
        transitionOperations,
        explicitMemory: { ...normalizedMemoryContract(explicit), promote: Boolean(explicit.promote) },
        ...(!existingCore && explicit.promote
          ? {
              requestedPromotionProvenance: "EXPLICIT_USER" as const,
              observedB2PromotionProvenance: "AMBIGUOUS_LEGACY" as const
            }
          : {})
      });
      if (explicit.key && (existingCore || explicit.promote)) activeCoreKeys.add(explicit.key);
    }
    if ((step.events?.length ?? 0) > 0) {
      actions.push({
        sourceMode: "checkpoint-message",
        transitionOperations: ["checkpoint"],
        events: [...step.events!],
        expectedMemories: (step.expectedExtracted ?? []).map((memory) => ({
          ...normalizedMemoryContract(memory),
          candidateOperation: memory.key === undefined ? "create" : "update"
        }))
      });
    }
    return { id: step.id, label: step.label, actions };
  });
  return {
    version: fixture.version,
    id: fixture.id,
    spaceId: fixture.spaceId,
    steps,
    criticalBootstrapKeys: [...fixture.criticalBootstrapKeys]
  };
}

export function assertB3FixtureContract(
  baseline: B3FixtureContract,
  candidate: B3FixtureContract
): void {
  if (!isDeepStrictEqual(candidate, baseline)) {
    throw new Error("B3 fixture contract mutation");
  }
}

export async function loadStageB2CoreHandoffBaseline(): Promise<StageB2CoreHandoffBaseline> {
  const content = await readFile(
    new URL("./baselines/p6-stage-b2-core-handoff.json", import.meta.url),
    "utf8"
  );
  const baseline = stageB2CoreHandoffBaselineSchema.parse(JSON.parse(content));
  assertAcceptedB3Baseline(baseline);
  return baseline;
}
