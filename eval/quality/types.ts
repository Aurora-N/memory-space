import * as z from "zod/v4";

const nonEmpty = z.string().trim().min(1);
const memoryFamily = z.enum(["knowledge", "state", "episode", "procedure"]);
const memoryTier = z.enum(["core", "indexed"]);
const memoryStatus = z.enum(["active", "resolved", "superseded", "archived"]);

export const groundTruthMemorySchema = z.object({
  logicalKey: nonEmpty,
  family: memoryFamily,
  type: nonEmpty,
  key: nonEmpty.optional(),
  content: nonEmpty,
  shouldBeCore: z.boolean(),
  rationale: nonEmpty,
  duplicateGroup: nonEmpty.optional()
}).strict();

export const extractionFixtureSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  events: z.array(nonEmpty).min(1),
  expectedMemories: z.array(groundTruthMemorySchema),
  negativeEvidence: z.array(z.object({
    text: nonEmpty,
    reason: nonEmpty
  }).strict())
}).strict();

const retrievalQuerySchema = z.object({
  id: nonEmpty,
  query: z.string(),
  relevantMemoryKeys: z.array(nonEmpty),
  families: z.array(memoryFamily).min(1).optional(),
  types: z.array(nonEmpty).min(1).optional(),
  tiers: z.array(memoryTier).min(1).optional(),
  statuses: z.array(memoryStatus).min(1).optional(),
  note: nonEmpty
}).strict();

export const retrievalFixtureSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  ks: z.array(z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)])).min(1),
  memories: z.array(groundTruthMemorySchema).min(10),
  queries: z.array(retrievalQuerySchema).min(6)
}).strict();

export const supersessionFixtureSchema = z.object({
  version: z.literal(1),
  currentSlots: z.array(z.object({
    id: nonEmpty,
    currentLogicalKey: nonEmpty,
    staleContents: z.array(nonEmpty).min(1),
    searchQuery: nonEmpty
  }).strict()).min(2),
  expectedInactive: z.array(z.object({
    logicalKey: nonEmpty,
    status: memoryStatus
  }).strict()).min(1)
}).strict();

export const handoffFixtureSchema = z.object({
  version: z.literal(1),
  expected: z.object({
    goal: nonEmpty.optional(),
    completed: z.array(nonEmpty),
    activeTasks: z.array(nonEmpty),
    decisions: z.array(nonEmpty),
    blockers: z.array(nonEmpty),
    openQuestions: z.array(nonEmpty),
    nextSteps: z.array(nonEmpty)
  }).strict()
}).strict();

const explicitMemorySchema = groundTruthMemorySchema.extend({
  data: z.record(z.string(), z.unknown()).optional(),
  promote: z.boolean().optional()
}).strict();

export const longHorizonFixtureSchema = z.object({
  version: z.literal(1),
  id: nonEmpty,
  spaceId: nonEmpty,
  steps: z.array(z.object({
    id: nonEmpty,
    label: nonEmpty,
    events: z.array(nonEmpty).optional(),
    expectedExtracted: z.array(groundTruthMemorySchema).optional(),
    explicitMemories: z.array(explicitMemorySchema).optional(),
    statusChanges: z.array(z.object({
      logicalKey: nonEmpty,
      status: memoryStatus,
      reason: nonEmpty
    }).strict()).optional()
  }).strict()).length(20),
  criticalBootstrapKeys: z.array(nonEmpty).min(1),
  duplicateGroups: z.array(z.object({
    id: nonEmpty,
    memberKeys: z.array(nonEmpty).min(1),
    expectedCanonicalCount: z.number().int().min(0),
    note: nonEmpty
  }).strict()).min(2),
  finalQueries: z.array(retrievalQuerySchema).min(4)
}).strict();

export type GroundTruthMemory = z.infer<typeof groundTruthMemorySchema>;
export type ExtractionFixture = z.infer<typeof extractionFixtureSchema>;
export type RetrievalFixture = z.infer<typeof retrievalFixtureSchema>;
export type RetrievalQueryFixture = z.infer<typeof retrievalQuerySchema>;
export type SupersessionFixture = z.infer<typeof supersessionFixtureSchema>;
export type HandoffFixture = z.infer<typeof handoffFixtureSchema>;
export type LongHorizonFixture = z.infer<typeof longHorizonFixtureSchema>;

export interface CountedRatio {
  numerator: number;
  denominator: number;
  value: number;
}

export interface ExtractionMetric {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

export interface RetrievalAtKMetric {
  k: number;
  hits: number;
  precision: number;
  recall: number;
}

export interface RetrievalQueryResult {
  id: string;
  query: string;
  classification: "positive" | "negative";
  expected: string[];
  returned: string[];
  returnedCount: number;
  eligibleCorpusSize: number;
  atK: RetrievalAtKMetric[];
  note: string;
}

export interface RetrievalAggregate {
  k: number;
  precision: number;
  recall: number;
  queryCount: number;
}

export interface NegativeRetrievalQueryResult {
  id: string;
  query: string;
  eligibleCorpusSize: number;
  returned: string[];
  returnedCount: number;
  abstained: boolean;
}

export interface NegativeRetrievalAggregate {
  queryCount: number;
  falsePositiveQueries: number;
  abstainedQueries: number;
  falsePositiveRate: number;
  abstentionRate: number;
  queries: NegativeRetrievalQueryResult[];
}

export interface QualityFailureExample {
  scenario: string;
  metric: string;
  expected: unknown;
  observed: unknown;
  explanation: string;
}

export interface QualityScenarioResult {
  id: string;
  kind: "extraction" | "retrieval" | "long-horizon" | "provider-proof";
  observations: Record<string, unknown>;
}

export interface CorrectnessCheck {
  id: string;
  status: "pass" | "fail";
  detail: string;
}

export interface MemoryQualityReport {
  version: 1;
  summary: {
    extraction: ExtractionMetric;
    retrieval: RetrievalAggregate[];
    negativeRetrieval: NegativeRetrievalAggregate;
    corePollution: CountedRatio & { pollutedKeys: string[] };
    bootstrap: {
      criticalCoverage: CountedRatio;
      missingCriticalKeys: string[];
      unexpectedDefaultKeys: string[];
      coreItemCount: number;
      handoffFactCount: number;
      chars: number;
      bytes: number;
    };
    handoff: CountedRatio & { missingFacts: string[]; unexpectedFacts: string[] };
    staleMemory: CountedRatio & { staleKeys: string[] };
    duplicateMemory: CountedRatio & {
      groups: Array<{
        id: string;
        activeMembers: string[];
        avoidableDuplicates: number;
        note: string;
      }>;
    };
    contradiction: CountedRatio & {
      checks: Array<{ id: string; kind: "hard" | "quality"; passed: boolean }>;
    };
    longHorizonSessions: number;
  };
  correctness: {
    overall: "pass" | "fail";
    checks: CorrectnessCheck[];
  };
  scenarios: QualityScenarioResult[];
  failures: QualityFailureExample[];
}

export interface QualityFixtureBundle {
  extraction: ExtractionFixture;
  retrieval: RetrievalFixture;
  supersession: SupersessionFixture;
  handoff: HandoffFixture;
  longHorizon: LongHorizonFixture;
}
