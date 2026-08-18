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
import type { SessionProjectBinding } from "./session-binding.ts";

/** Immutable audit record for a memory state transition. */
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

/** Source-of-truth query filters shared by storage adapters. */
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
  /** Releases adapter resources after the caller has stopped issuing work. */
  close(): Promise<void>;
  /** Commits operation writes atomically; nested calls join the active transaction. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;

  insertSpace(space: Space): Promise<void>;
  findSpace(id: string): Promise<Space | undefined>;
  insertSession(session: Session): Promise<void>;
  /** Atomically returns the existing provider identity or creates it once. */
  getOrCreateProviderSession(session: Session): Promise<{ session: Session; created: boolean }>;
  findSession(id: string): Promise<Session | undefined>;
  findSessionByProviderIdentity(provider: string, externalSessionId: string): Promise<Session | undefined>;
  /** Preserves the first trusted project binding recorded for a Session. */
  insertSessionProjectBinding(binding: SessionProjectBinding): Promise<void>;
  findSessionProjectBinding(sessionId: string): Promise<SessionProjectBinding | undefined>;
  updateSession(session: Session): Promise<void>;

  insertEvent(event: Omit<SessionEvent, "sequence">): Promise<SessionEvent>;
  findEvent(sessionId: string, eventId: string): Promise<SessionEvent | undefined>;
  findLatestEvent(sessionId: string): Promise<SessionEvent | undefined>;
  /** Returns events in ascending sequence order within inclusive upper and exclusive lower bounds. */
  listEvents(sessionId: string, afterSequence?: number, throughSequence?: number): Promise<SessionEvent[]>;

  insertMemory(memory: Memory): Promise<void>;
  updateMemory(memory: Memory): Promise<void>;
  findMemory(id: string): Promise<Memory | undefined>;
  findActiveMemoryByKey(spaceId: string, key: string): Promise<Memory | undefined>;
  /** Returns matching memories; callers apply use-case-specific ranking and ordering. */
  listMemories(filters: MemoryFilters): Promise<Memory[]>;
  addMemorySource(memoryId: string, eventId: string, createdAt: string): Promise<void>;
  addMemoryHistory(record: Omit<MemoryHistoryRecord, "id">): Promise<void>;
  /** Returns immutable history in ascending persistence order. */
  listMemoryHistory(memoryId: string): Promise<MemoryHistoryRecord[]>;

  insertCheckpoint(checkpoint: Checkpoint): Promise<void>;
  /** Atomically returns the checkpoint for an idempotency key or creates it once. */
  getOrCreateCheckpoint(checkpoint: Checkpoint): Promise<{ checkpoint: Checkpoint; created: boolean }>;
  updateCheckpoint(checkpoint: Checkpoint): Promise<void>;
  findCheckpoint(id: string): Promise<Checkpoint | undefined>;
  findCheckpointByIdempotency(sessionId: string, key: string): Promise<Checkpoint | undefined>;
  /** Replaces the complete candidate decision set for one checkpoint. */
  replaceCandidates(checkpointId: string, candidates: Array<{ candidate: unknown; accepted: boolean; rejectionReason?: string }>): Promise<void>;

  insertHandoff(snapshot: HandoffSnapshot): Promise<void>;
  findHandoff(id: string): Promise<HandoffSnapshot | undefined>;
  /** Returns the most recently created Handoff using deterministic tie-breaking. */
  findLatestHandoff(spaceId: string): Promise<HandoffSnapshot | undefined>;
}
