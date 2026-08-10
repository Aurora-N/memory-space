export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial-domain-model",
    sql: `
      CREATE TABLE spaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        agent_id TEXT, provider TEXT, external_session_id TEXT, summary TEXT,
        last_checkpoint_event_id TEXT, latest_handoff_snapshot_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX sessions_space_idx ON sessions(space_id, created_at);
      CREATE TABLE session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('message','tool_call','artifact','memory','custom')),
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX session_events_session_sequence_idx ON session_events(session_id, sequence);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        family TEXT NOT NULL CHECK (family IN ('knowledge','state','episode','procedure')),
        type TEXT NOT NULL, key TEXT, content TEXT NOT NULL, data_json TEXT,
        tier TEXT NOT NULL CHECK (tier IN ('core','indexed')),
        status TEXT NOT NULL CHECK (status IN ('active','resolved','superseded','archived')),
        importance REAL NOT NULL, confidence REAL NOT NULL,
        source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        source_agent_id TEXT, version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX memories_active_key_idx
        ON memories(space_id, key) WHERE key IS NOT NULL AND status = 'active';
      CREATE INDEX memories_search_idx ON memories(space_id, status, tier, type);
      CREATE TABLE memory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        operation TEXT NOT NULL, before_json TEXT, after_json TEXT, reason TEXT,
        source_session_id TEXT, source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX memory_history_memory_idx ON memory_history(memory_id, id);
      CREATE TABLE memory_sources (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES session_events(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, event_id)
      );
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        from_event_id TEXT, to_event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
        handoff_snapshot_id TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        UNIQUE (session_id, idempotency_key)
      );
      CREATE INDEX checkpoints_session_idx ON checkpoints(session_id, created_at);
      CREATE TABLE extraction_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        candidate_json TEXT NOT NULL, accepted INTEGER NOT NULL,
        rejection_reason TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE handoff_snapshots (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL UNIQUE REFERENCES checkpoints(id) ON DELETE CASCADE,
        goal TEXT, completed_json TEXT NOT NULL, active_tasks_json TEXT NOT NULL,
        decisions_json TEXT NOT NULL, blockers_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL, next_steps_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX handoff_space_created_idx ON handoff_snapshots(space_id, created_at);
    `
  }
];
