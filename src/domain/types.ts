/** Top-level semantic family used to organize durable memories. */
export type MemoryFamily = "knowledge" | "state" | "episode" | "procedure";
/** Persistence tier controlling automatic bootstrap visibility. */
export type MemoryTier = "core" | "indexed";
/** Lifecycle state used to include or exclude a memory from active recall. */
export type MemoryStatus = "active" | "resolved" | "superseded" | "archived";
/** Provider-neutral kind assigned to an ordered Session event. */
export type SessionEventType = "message" | "tool_call" | "artifact" | "memory" | "custom";
/** Durable processing state of an idempotent checkpoint. */
export type CheckpointStatus = "processing" | "completed" | "failed";
/** Mutation requested by an extracted memory candidate. */
export type CandidateOperation = "create" | "update" | "supersede" | "ignore";

/** Isolated persistence namespace. Timestamps are ISO 8601 strings. */
export interface Space {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** Durable agent or provider session bound permanently to one Space. */
export interface Session {
  id: string;
  spaceId: string;
  agentId?: string;
  provider?: string;
  externalSessionId?: string;
  summary?: string;
  lastCheckpointEventId?: string;
  latestHandoffSnapshotId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Immutable event ordered by its monotonically increasing Session sequence. */
export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  sequence: number;
}

/** Versioned durable memory record scoped to exactly one Space. */
export interface Memory {
  id: string;
  spaceId: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
  tier: MemoryTier;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceSessionId?: string;
  sourceAgentId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Provider-neutral extraction proposal validated before persistence. */
export interface MemoryCandidate {
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
  confidence: number;
  importance?: number;
  recommendedTier: MemoryTier;
  promoteReason?: string;
  sourceEventIds: string[];
  operation: CandidateOperation;
  targetMemoryId?: string;
}

/** Idempotent durable boundary covering a contiguous range of Session events. */
export interface Checkpoint {
  id: string;
  spaceId: string;
  sessionId: string;
  fromEventId?: string;
  toEventId: string;
  idempotencyKey: string;
  status: CheckpointStatus;
  handoffSnapshotId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

/** Deterministic continuation projection produced by a completed checkpoint. */
export interface HandoffSnapshot {
  id: string;
  spaceId: string;
  sessionId: string;
  checkpointId: string;
  goal?: string;
  completed: string[];
  activeTasks: string[];
  decisions: string[];
  blockers: string[];
  openQuestions: string[];
  nextSteps: string[];
  createdAt: string;
}

/** Space-scoped memory query with optional filters and a bounded result limit. */
export interface MemorySearchInput {
  spaceId: string;
  query: string;
  families?: MemoryFamily[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
  limit?: number;
}

/** Ranked memory result; higher scores sort before lower scores. */
export interface MemorySearchResult {
  memory: Memory;
  score: number;
}
