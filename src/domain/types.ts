export type MemoryFamily = "knowledge" | "state" | "episode" | "procedure";
export type MemoryTier = "core" | "indexed";
export type MemoryStatus = "active" | "resolved" | "superseded" | "archived";
export type SessionEventType = "message" | "tool_call" | "artifact" | "memory" | "custom";
export type CheckpointStatus = "processing" | "completed" | "failed";
export type CandidateOperation = "create" | "update" | "supersede" | "ignore";

export interface Space {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  sequence: number;
}

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

export interface MemorySearchInput {
  spaceId: string;
  query: string;
  families?: MemoryFamily[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
  limit?: number;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}
