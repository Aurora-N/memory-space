import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Checkpoint,
  HandoffSnapshot,
  Memory,
  MemoryFamily,
  MemoryStatus,
  MemoryTier,
  Session,
  SessionEvent,
  SessionEventType,
  Space
} from "../../domain/types.ts";
import type { SessionProjectBinding } from "../../ports/session-binding.ts";
import type { MemoryFilters, MemoryHistoryRecord, MemoryStore } from "../../ports/store.ts";
import { migrations } from "./migrations.ts";

// biome-ignore lint/suspicious/noExplicitAny: node:sqlite returns dynamically typed row columns at this adapter boundary.
type Row = Record<string, any>;

interface TransactionBarrier {
  current: Promise<void>;
}

const fileTransactionBarriers = new Map<string, TransactionBarrier>();

function transactionBarrier(path: string): TransactionBarrier {
  if (path === ":memory:") return { current: Promise.resolve() };
  const existing = fileTransactionBarriers.get(path);
  if (existing) return existing;
  const created = { current: Promise.resolve() };
  fileTransactionBarriers.set(path, created);
  return created;
}

function parseJson<T>(value: unknown, fallback?: T): T | undefined {
  return value === null || value === undefined ? fallback : JSON.parse(String(value)) as T;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function mapSpace(row?: Row): Space | undefined {
  if (!row) return undefined;
  return {
    id: row.id, name: row.name, description: row.description ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapSession(row?: Row): Session | undefined {
  if (!row) return undefined;
  return {
    id: row.id, spaceId: row.space_id, agentId: row.agent_id ?? undefined,
    provider: row.provider ?? undefined, externalSessionId: row.external_session_id ?? undefined,
    summary: row.summary ?? undefined, lastCheckpointEventId: row.last_checkpoint_event_id ?? undefined,
    latestHandoffSnapshotId: row.latest_handoff_snapshot_id ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapEvent(row?: Row): SessionEvent | undefined {
  if (!row) return undefined;
  return {
    id: row.id, sessionId: row.session_id, type: row.type as SessionEventType,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}) ?? {},
    createdAt: row.created_at, sequence: Number(row.sequence)
  };
}

function mapMemory(row?: Row): Memory | undefined {
  if (!row) return undefined;
  return {
    id: row.id, spaceId: row.space_id, family: row.family as MemoryFamily, type: row.type,
    key: row.key ?? undefined, content: row.content,
    data: parseJson<Record<string, unknown>>(row.data_json), tier: row.tier as MemoryTier,
    status: row.status as MemoryStatus, importance: Number(row.importance), confidence: Number(row.confidence),
    sourceSessionId: row.source_session_id ?? undefined, sourceAgentId: row.source_agent_id ?? undefined,
    version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapCheckpoint(row?: Row): Checkpoint | undefined {
  if (!row) return undefined;
  return {
    id: row.id, spaceId: row.space_id, sessionId: row.session_id,
    fromEventId: row.from_event_id ?? undefined, toEventId: row.to_event_id,
    idempotencyKey: row.idempotency_key, status: row.status,
    handoffSnapshotId: row.handoff_snapshot_id ?? undefined, error: row.error ?? undefined,
    createdAt: row.created_at, completedAt: row.completed_at ?? undefined
  } as Checkpoint;
}

function mapHandoff(row?: Row): HandoffSnapshot | undefined {
  if (!row) return undefined;
  return {
    id: row.id, spaceId: row.space_id, sessionId: row.session_id, checkpointId: row.checkpoint_id,
    goal: row.goal ?? undefined, completed: parseJson<string[]>(row.completed_json, []) ?? [],
    activeTasks: parseJson<string[]>(row.active_tasks_json, []) ?? [],
    decisions: parseJson<string[]>(row.decisions_json, []) ?? [],
    blockers: parseJson<string[]>(row.blockers_json, []) ?? [],
    openQuestions: parseJson<string[]>(row.open_questions_json, []) ?? [],
    nextSteps: parseJson<string[]>(row.next_steps_json, []) ?? [], createdAt: row.created_at
  };
}

/** SQLite source-of-truth adapter implementing the full MemoryStore contract. */
export class SqliteMemoryStore implements MemoryStore {
  readonly database: DatabaseSync;
  readonly #transactionContext = new AsyncLocalStorage<boolean>();
  readonly #barrier: TransactionBarrier;

  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#barrier = transactionBarrier(path);
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
  }

  async close(): Promise<void> {
    await this.#ready();
    this.database.close();
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#transactionContext.getStore()) return operation();
    const previous = this.#barrier.current;
    let release!: () => void;
    this.#barrier.current = new Promise((resolveBarrier) => { release = resolveBarrier; });
    await previous;
    let began = false;
    try {
      this.beginTransaction();
      began = true;
      const result = await this.#transactionContext.run(true, operation);
      this.commitTransaction();
      return result;
    } catch (error) {
      if (began) {
        try { this.rollbackTransaction(); }
        catch { /* Preserve the original transaction error. */ }
      }
      throw error;
    } finally {
      release();
    }
  }

  protected beginTransaction(): void { this.database.exec("BEGIN IMMEDIATE"); }
  protected commitTransaction(): void { this.database.exec("COMMIT"); }
  protected rollbackTransaction(): void { this.database.exec("ROLLBACK"); }

  async insertSpace(space: Space): Promise<void> {
    await this.#ready();
    this.database.prepare(
      "INSERT INTO spaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run(space.id, space.name, space.description ?? null, space.createdAt, space.updatedAt);
  }

  async findSpace(id: string): Promise<Space | undefined> {
    await this.#ready();
    return mapSpace(this.database.prepare("SELECT * FROM spaces WHERE id = ?").get(id) as Row | undefined);
  }

  async insertSession(session: Session): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT INTO sessions (
        id, space_id, agent_id, provider, external_session_id, summary,
        last_checkpoint_event_id, latest_handoff_snapshot_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.spaceId, session.agentId ?? null, session.provider ?? null,
      session.externalSessionId ?? null, session.summary ?? null,
      session.lastCheckpointEventId ?? null, session.latestHandoffSnapshotId ?? null,
      session.createdAt, session.updatedAt
    );
  }

  async getOrCreateProviderSession(session: Session): Promise<{ session: Session; created: boolean }> {
    await this.#ready();
    if (!session.provider || !session.externalSessionId) {
      throw new Error("Provider Session get-or-create requires provider and externalSessionId");
    }
    const result = this.database.prepare(`
      INSERT INTO sessions (
        id, space_id, agent_id, provider, external_session_id, summary,
        last_checkpoint_event_id, latest_handoff_snapshot_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, external_session_id)
        WHERE provider IS NOT NULL AND external_session_id IS NOT NULL
      DO NOTHING
    `).run(
      session.id, session.spaceId, session.agentId ?? null, session.provider,
      session.externalSessionId, session.summary ?? null,
      session.lastCheckpointEventId ?? null, session.latestHandoffSnapshotId ?? null,
      session.createdAt, session.updatedAt
    );
    const persisted = await this.findSessionByProviderIdentity(session.provider, session.externalSessionId);
    if (!persisted) throw new Error("Provider Session get-or-create did not return a persisted Session");
    return { session: persisted, created: Number(result.changes) === 1 };
  }

  async findSession(id: string): Promise<Session | undefined> {
    await this.#ready();
    return mapSession(this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined);
  }

  async findSessionByProviderIdentity(provider: string, externalSessionId: string): Promise<Session | undefined> {
    await this.#ready();
    return mapSession(this.database.prepare(
      "SELECT * FROM sessions WHERE provider = ? AND external_session_id = ?"
    ).get(provider, externalSessionId) as Row | undefined);
  }

  async listSessions(spaceId: string): Promise<Session[]> {
    await this.#ready();
    return (this.database.prepare(
      "SELECT * FROM sessions WHERE space_id = ? ORDER BY updated_at DESC, id ASC"
    ).all(spaceId) as Row[]).map((row) => {
      const session = mapSession(row);
      if (!session) throw new Error("SQLite returned an empty Session row");
      return session;
    });
  }

  async insertSessionProjectBinding(binding: SessionProjectBinding): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT OR IGNORE INTO session_project_bindings (
        session_id, space_id, source, config_path
      ) VALUES (?, ?, ?, ?)
    `).run(binding.sessionId, binding.spaceId, binding.source, binding.configPath ?? null);
  }

  async findSessionProjectBinding(sessionId: string): Promise<SessionProjectBinding | undefined> {
    await this.#ready();
    const row = this.database.prepare(
      "SELECT * FROM session_project_bindings WHERE session_id = ?"
    ).get(sessionId) as Row | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      spaceId: row.space_id,
      source: row.source,
      configPath: row.config_path ?? undefined
    } as SessionProjectBinding;
  }

  async updateSession(session: Session): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      UPDATE sessions SET agent_id = ?, provider = ?, external_session_id = ?, summary = ?,
        last_checkpoint_event_id = ?, latest_handoff_snapshot_id = ?, updated_at = ? WHERE id = ?
    `).run(
      session.agentId ?? null, session.provider ?? null, session.externalSessionId ?? null,
      session.summary ?? null, session.lastCheckpointEventId ?? null,
      session.latestHandoffSnapshotId ?? null, session.updatedAt, session.id
    );
  }

  async insertEvent(event: Omit<SessionEvent, "sequence">): Promise<SessionEvent> {
    await this.#ready();
    this.database.prepare(
      "INSERT INTO session_events (id, session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(event.id, event.sessionId, event.type, JSON.stringify(event.payload), event.createdAt);
    const persisted = await this.findEvent(event.sessionId, event.id);
    if (!persisted) throw new Error(`Inserted SessionEvent was not found: ${event.id}`);
    return persisted;
  }

  async findEvent(sessionId: string, eventId: string): Promise<SessionEvent | undefined> {
    await this.#ready();
    return mapEvent(this.database.prepare(
      "SELECT * FROM session_events WHERE session_id = ? AND id = ?"
    ).get(sessionId, eventId) as Row | undefined);
  }

  async findLatestEvent(sessionId: string): Promise<SessionEvent | undefined> {
    await this.#ready();
    return mapEvent(this.database.prepare(
      "SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1"
    ).get(sessionId) as Row | undefined);
  }

  async listEvents(sessionId: string, afterSequence = 0, throughSequence = Number.MAX_SAFE_INTEGER): Promise<SessionEvent[]> {
    await this.#ready();
    return (this.database.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence
    `).all(sessionId, afterSequence, throughSequence) as Row[]).map((row) => {
      const event = mapEvent(row);
      if (!event) throw new Error("SQLite returned an empty SessionEvent row");
      return event;
    });
  }

  async insertMemory(memory: Memory): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT INTO memories (
        id, space_id, family, type, key, content, data_json, tier, status,
        importance, confidence, source_session_id, source_agent_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id, memory.spaceId, memory.family, memory.type, memory.key ?? null,
      memory.content, json(memory.data), memory.tier, memory.status, memory.importance,
      memory.confidence, memory.sourceSessionId ?? null, memory.sourceAgentId ?? null,
      memory.version, memory.createdAt, memory.updatedAt
    );
  }

  async updateMemory(memory: Memory): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      UPDATE memories SET family = ?, type = ?, key = ?, content = ?, data_json = ?, tier = ?,
        status = ?, importance = ?, confidence = ?, source_session_id = ?, source_agent_id = ?,
        version = ?, updated_at = ? WHERE id = ?
    `).run(
      memory.family, memory.type, memory.key ?? null, memory.content, json(memory.data),
      memory.tier, memory.status, memory.importance, memory.confidence,
      memory.sourceSessionId ?? null, memory.sourceAgentId ?? null, memory.version,
      memory.updatedAt, memory.id
    );
  }

  async findMemory(id: string): Promise<Memory | undefined> {
    await this.#ready();
    return mapMemory(this.database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined);
  }

  async findActiveMemoryByKey(spaceId: string, key: string): Promise<Memory | undefined> {
    await this.#ready();
    return mapMemory(this.database.prepare(
      "SELECT * FROM memories WHERE space_id = ? AND key = ? AND status = 'active'"
    ).get(spaceId, key) as Row | undefined);
  }

  async listMemories(filters: MemoryFilters): Promise<Memory[]> {
    await this.#ready();
    const clauses = ["space_id = ?"];
    // biome-ignore lint/suspicious/noExplicitAny: node:sqlite accepts a heterogeneous positional parameter list.
    const parameters: any[] = [filters.spaceId];
    const add = (column: string, values?: string[]) => {
      if (!values) return;
      clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
      parameters.push(...values);
    };
    add("family", filters.families);
    add("type", filters.types);
    add("tier", filters.tiers);
    add("status", filters.statuses);
    return (this.database.prepare(
      `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY updated_at, id`
    ).all(...parameters) as Row[]).map((row) => {
      const memory = mapMemory(row);
      if (!memory) throw new Error("SQLite returned an empty Memory row");
      return memory;
    });
  }

  async addMemorySource(memoryId: string, eventId: string, createdAt: string): Promise<void> {
    await this.#ready();
    this.database.prepare(
      "INSERT OR IGNORE INTO memory_sources (memory_id, event_id, created_at) VALUES (?, ?, ?)"
    ).run(memoryId, eventId, createdAt);
  }

  async addMemoryHistory(record: Omit<MemoryHistoryRecord, "id">): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT INTO memory_history (
        memory_id, operation, before_json, after_json, reason, source_session_id,
        source_event_ids_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.memoryId, record.operation, json(record.before), json(record.after),
      record.reason ?? null, record.sourceSessionId ?? null,
      JSON.stringify(record.sourceEventIds), record.createdAt
    );
  }

  async listMemoryHistory(memoryId: string): Promise<MemoryHistoryRecord[]> {
    await this.#ready();
    return (this.database.prepare(
      "SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id"
    ).all(memoryId) as Row[]).map((row) => ({
      id: Number(row.id), memoryId: row.memory_id, operation: row.operation,
      before: parseJson<Memory>(row.before_json), after: parseJson<Memory>(row.after_json),
      reason: row.reason ?? undefined, sourceSessionId: row.source_session_id ?? undefined,
      sourceEventIds: parseJson<string[]>(row.source_event_ids_json, []) ?? [], createdAt: row.created_at
    }));
  }

  async insertCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT INTO checkpoints (
        id, space_id, session_id, from_event_id, to_event_id, idempotency_key, status,
        handoff_snapshot_id, error, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id, checkpoint.spaceId, checkpoint.sessionId, checkpoint.fromEventId ?? null,
      checkpoint.toEventId, checkpoint.idempotencyKey, checkpoint.status,
      checkpoint.handoffSnapshotId ?? null, checkpoint.error ?? null,
      checkpoint.createdAt, checkpoint.completedAt ?? null
    );
  }

  async getOrCreateCheckpoint(checkpoint: Checkpoint): Promise<{ checkpoint: Checkpoint; created: boolean }> {
    await this.#ready();
    const result = this.database.prepare(`
      INSERT INTO checkpoints (
        id, space_id, session_id, from_event_id, to_event_id, idempotency_key, status,
        handoff_snapshot_id, error, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, idempotency_key) DO NOTHING
    `).run(
      checkpoint.id, checkpoint.spaceId, checkpoint.sessionId, checkpoint.fromEventId ?? null,
      checkpoint.toEventId, checkpoint.idempotencyKey, checkpoint.status,
      checkpoint.handoffSnapshotId ?? null, checkpoint.error ?? null,
      checkpoint.createdAt, checkpoint.completedAt ?? null
    );
    const persisted = await this.findCheckpointByIdempotency(checkpoint.sessionId, checkpoint.idempotencyKey);
    if (!persisted) throw new Error("Checkpoint get-or-create did not return a persisted checkpoint");
    return { checkpoint: persisted, created: Number(result.changes) === 1 };
  }

  async updateCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      UPDATE checkpoints SET from_event_id = ?, to_event_id = ?, status = ?,
        handoff_snapshot_id = ?, error = ?, completed_at = ? WHERE id = ?
    `).run(
      checkpoint.fromEventId ?? null, checkpoint.toEventId, checkpoint.status,
      checkpoint.handoffSnapshotId ?? null, checkpoint.error ?? null,
      checkpoint.completedAt ?? null, checkpoint.id
    );
  }

  async findCheckpoint(id: string): Promise<Checkpoint | undefined> {
    await this.#ready();
    return mapCheckpoint(this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as Row | undefined);
  }

  async findCheckpointByIdempotency(sessionId: string, key: string): Promise<Checkpoint | undefined> {
    await this.#ready();
    return mapCheckpoint(this.database.prepare(
      "SELECT * FROM checkpoints WHERE session_id = ? AND idempotency_key = ?"
    ).get(sessionId, key) as Row | undefined);
  }

  async replaceCandidates(
    checkpointId: string,
    candidates: Array<{ candidate: unknown; accepted: boolean; rejectionReason?: string }>
  ): Promise<void> {
    await this.#ready();
    this.database.prepare("DELETE FROM extraction_candidates WHERE checkpoint_id = ?").run(checkpointId);
    const statement = this.database.prepare(`
      INSERT INTO extraction_candidates (
        checkpoint_id, candidate_json, accepted, rejection_reason, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const item of candidates) {
      statement.run(
        checkpointId, JSON.stringify(item.candidate), item.accepted ? 1 : 0,
        item.rejectionReason ?? null, new Date().toISOString()
      );
    }
  }

  async insertHandoff(snapshot: HandoffSnapshot): Promise<void> {
    await this.#ready();
    this.database.prepare(`
      INSERT INTO handoff_snapshots (
        id, space_id, session_id, checkpoint_id, goal, completed_json, active_tasks_json,
        decisions_json, blockers_json, open_questions_json, next_steps_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id, snapshot.spaceId, snapshot.sessionId, snapshot.checkpointId,
      snapshot.goal ?? null, JSON.stringify(snapshot.completed), JSON.stringify(snapshot.activeTasks),
      JSON.stringify(snapshot.decisions), JSON.stringify(snapshot.blockers),
      JSON.stringify(snapshot.openQuestions), JSON.stringify(snapshot.nextSteps), snapshot.createdAt
    );
  }

  async findHandoff(id: string): Promise<HandoffSnapshot | undefined> {
    await this.#ready();
    return mapHandoff(this.database.prepare(
      "SELECT * FROM handoff_snapshots WHERE id = ?"
    ).get(id) as Row | undefined);
  }

  async findLatestHandoff(spaceId: string): Promise<HandoffSnapshot | undefined> {
    await this.#ready();
    return mapHandoff(this.database.prepare(`
      SELECT * FROM handoff_snapshots WHERE space_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(spaceId) as Row | undefined);
  }

  async #ready(): Promise<void> {
    if (!this.#transactionContext.getStore()) await this.#barrier.current;
  }

  #migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );
    `);
    const rows = this.database.prepare("SELECT version FROM schema_migrations").all() as Row[];
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sql);
        this.database.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
        ).run(migration.version, migration.name, new Date().toISOString());
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}
