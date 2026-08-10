import type {
  Checkpoint,
  HandoffSnapshot,
  Memory,
  MemoryStatus,
  MemoryTier,
  Session,
  SessionEvent,
  Space
} from "../domain/types.ts";

export interface MemoryHistoryRecord {
  id: number;
  memoryId: string;
  operation: string;
  before?: Memory;
  after?: Memory;
  reason?: string;
  sourceSessionId?: string;
  sourceEventIds: string[];
  createdAt: string;
}

export interface MemoryFilters {
  spaceId: string;
  families?: string[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
}

/**
 * Persistence boundary for the domain/application layer.
 * PostgreSQL implementations must provide the same transaction semantics;
 * Redis deliberately implements CachePort instead of this source-of-truth port.
 */
export interface MemoryStore {
  close(): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;

  insertSpace(space: Space): Promise<void>;
  findSpace(id: string): Promise<Space | undefined>;
  insertSession(session: Session): Promise<void>;
  findSession(id: string): Promise<Session | undefined>;
  updateSession(session: Session): Promise<void>;

  insertEvent(event: Omit<SessionEvent, "sequence">): Promise<SessionEvent>;
  findEvent(sessionId: string, eventId: string): Promise<SessionEvent | undefined>;
  findLatestEvent(sessionId: string): Promise<SessionEvent | undefined>;
  listEvents(sessionId: string, afterSequence?: number, throughSequence?: number): Promise<SessionEvent[]>;

  insertMemory(memory: Memory): Promise<void>;
  updateMemory(memory: Memory): Promise<void>;
  findMemory(id: string): Promise<Memory | undefined>;
  findActiveMemoryByKey(spaceId: string, key: string): Promise<Memory | undefined>;
  listMemories(filters: MemoryFilters): Promise<Memory[]>;
  addMemorySource(memoryId: string, eventId: string, createdAt: string): Promise<void>;
  addMemoryHistory(record: Omit<MemoryHistoryRecord, "id">): Promise<void>;
  listMemoryHistory(memoryId: string): Promise<MemoryHistoryRecord[]>;

  insertCheckpoint(checkpoint: Checkpoint): Promise<void>;
  updateCheckpoint(checkpoint: Checkpoint): Promise<void>;
  findCheckpoint(id: string): Promise<Checkpoint | undefined>;
  findCheckpointByIdempotency(sessionId: string, key: string): Promise<Checkpoint | undefined>;
  replaceCandidates(checkpointId: string, candidates: Array<{ candidate: unknown; accepted: boolean; rejectionReason?: string }>): Promise<void>;

  insertHandoff(snapshot: HandoffSnapshot): Promise<void>;
  findHandoff(id: string): Promise<HandoffSnapshot | undefined>;
  findLatestHandoff(spaceId: string): Promise<HandoffSnapshot | undefined>;
}
