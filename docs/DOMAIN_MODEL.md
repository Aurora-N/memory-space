# DOMAIN_MODEL — memory-space MVP v1

**Status:** Frozen domain contract for MVP implementation

## 1. Model overview

The model is deliberately **not** `Space → Session → Memory` as a strict ownership tree.

```text
                     Space
             ┌────────┼─────────┐
             ▼        ▼         ▼
          Sessions  Memories  Checkpoints
             │        ▲          │
             │ source │          ▼
             └────────┘     HandoffSnapshot
```

Key invariant:

> Session is where memory originates; Space is where durable memory belongs.

---

## 2. Aggregate: Space

Represents one shared cognitive/work context, such as a project.

```ts
interface Space {
  id: string;
  name: string;
  description?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### Invariants

- Every Session belongs to exactly one Space.
- Every durable Memory belongs to exactly one Space.
- Cross-session sharing occurs only within the same Space in MVP.
- Cross-space sharing is out of scope for MVP.

---

## 3. Aggregate: Session

Represents one agent conversation/execution context attached to a Space.

```ts
interface Session {
  id: string;
  spaceId: string;

  agentId?: string;
  provider?: string;
  externalSessionId?: string;

  summary?: string;

  lastCheckpointEventId?: string;
  latestHandoffSnapshotId?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### Notes

- Core correctness does not depend on a reliable `session.closed` event.
- Provider adapters may add their own lifecycle/status metadata later.
- `lastCheckpointEventId` defines the checkpoint processing boundary.

---

## 4. Entity: SessionEvent

Provider-specific inputs must be normalized before reaching the memory domain.

```ts
interface SessionEvent {
  id: string;
  sessionId: string;

  type:
    | "message"
    | "tool_call"
    | "artifact"
    | "memory"
    | "custom";

  payload: Record<string, unknown>;

  createdAt: Date;
}
```

### Invariants

- Events are append-oriented.
- Event IDs/order, not timestamps alone, determine checkpoint boundaries.
- Provider-specific raw payloads must be normalized/encapsulated so the core does not depend on Claude/Cursor/Codex-specific formats.
- Checkpoint is not modeled as a normal SessionEvent; it is a domain entity/process.

---

## 5. Entity: Memory

```ts
type MemoryFamily =
  | "knowledge"
  | "state"
  | "episode"
  | "procedure";

type MemoryTier =
  | "core"
  | "indexed";

type MemoryStatus =
  | "active"
  | "resolved"
  | "superseded"
  | "archived";

interface Memory {
  id: string;
  spaceId: string;

  family: MemoryFamily;
  type: string;

  /**
   * Optional stable semantic identity for structured/updatable memory.
   * Example: project.database
   */
  key?: string;

  content: string;
  data?: Record<string, unknown>;

  /** Defaults to "indexed" on remember(). */
  tier: MemoryTier;
  status: MemoryStatus;

  /** Domain scoring fields; exact scale is implementation-defined but must be consistent. */
  importance: number;
  confidence: number;

  sourceSessionId?: string;
  sourceAgentId?: string;

  /** Reserved now so advanced OCC can be added without reshaping the entity. */
  version: number;

  createdAt: Date;
  updatedAt: Date;
}
```

### Memory invariants

1. `remember()` defaults `tier = "indexed"`.
2. Tier is independent from status.
3. `core + superseded` / `core + archived` should normally trigger demotion by policy.
4. `version` starts at 1 and increments on mutation; MVP may not yet expose full OCC behavior.
5. `key` is optional.
6. Keyed memory is used for stable/unique semantic slots.
7. Unkeyed memory is valid for episodes/history/details.
8. A Memory is durable even if its source Session disappears.

---

## 6. Built-in taxonomy

### Knowledge

Typical types:

- `fact`
- `decision`
- `preference`
- `constraint`
- `convention`
- `assumption`

### State

Typical types:

- `goal`
- `task`
- `progress`
- `roadmap`
- `question`
- `blocker`

### Episode

Typical types:

- `session_summary`
- `incident`
- `interaction`

### Procedure

Typical types:

- `workflow`
- `instruction`
- `rule`
- `playbook`

### Extensibility rule

- `family` is constrained to the MVP family set.
- `type` is an extensible string.
- Custom types inherit family-level policy.

---

## 7. Core vs Indexed

### Indexed Memory

Purpose:

- durable storage;
- searchable on demand;
- progressive disclosure;
- default target of explicit `remember()`.

### Core Memory

Purpose:

- small default working context for every new session in the Space;
- raw memories rendered through a fixed deterministic template;
- no LLM summarization during bootstrap.

### Domain transitions

```text
indexed --promote--> core
core ----demote----> indexed
```

Promotion/demotion are explicit domain operations, not arbitrary field edits at API level.

---

## 8. Promotion rules

### User source

Explicit user instruction to keep information as project-wide/core context is authoritative.

### Agent source

Agent can request promotion with a reason. Policy validates:

- correct Space;
- active/eligible status;
- project-wide relevance;
- no obvious stale/superseded conflict;
- Core capacity policy.

### Checkpoint extractor source

Extractor may classify a candidate as Core when all relevant conditions are satisfied:

```text
cross-session relevance
AND global relevance
AND meaningful action impact
AND adequate stability/current-canonical-state
```

When uncertain, choose Indexed.

### Type defaults

High Core eligibility:

- goal
- roadmap
- project-level progress
- project-level active task
- blocker
- important decision
- constraint
- convention
- stable keyed project fact

Default Indexed:

- episode
- implementation detail
- debug trace
- temporary hypothesis
- tool output
- historical/local resolved question

---

## 9. Entity: Checkpoint

Checkpoint is a **Memory Commit Point**.

```ts
type CheckpointStatus =
  | "processing"
  | "completed"
  | "failed";

interface Checkpoint {
  id: string;
  spaceId: string;
  sessionId: string;

  fromEventId?: string;
  toEventId: string;

  /** Required at API boundary or mapped from an equivalent request key. */
  idempotencyKey: string;

  status: CheckpointStatus;

  handoffSnapshotId?: string;
  error?: string;

  createdAt: Date;
  completedAt?: Date;
}
```

### Checkpoint invariants

- Only events after the previous successful checkpoint boundary and up to `toEventId` are processed.
- A retry using the same idempotency key must not create duplicate memory effects.
- `Session.lastCheckpointEventId` advances only after the checkpoint commit succeeds.
- A failed checkpoint must not pretend that its event range has been committed.
- Checkpoint does not imply session termination.

### Logical pipeline

```text
new SessionEvents
      ↓
extract MemoryCandidate[]
      ↓
normalize / validate
      ↓
keyed update + dedup
      ↓
promotion policy
      ↓
commit Memory mutations
      ↓
generate HandoffSnapshot
      ↓
advance lastCheckpointEventId
```

The implementation should make the final commit boundary atomic at the persistence level where practical.

---

## 10. Internal model: MemoryCandidate

MemoryCandidate is not necessarily a public persisted aggregate in MVP, but the pipeline should model it explicitly for debuggability and future visualization.

```ts
interface MemoryCandidate {
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

  operation:
    | "create"
    | "update"
    | "supersede"
    | "ignore";

  targetMemoryId?: string;
}
```

Important rule:

> Extraction proposes candidates; domain policy decides durable effects.

Do not collapse the entire checkpoint pipeline into one opaque LLM prompt.

---

## 11. Entity: HandoffSnapshot

MVP generates a snapshot at checkpoint time.

```ts
interface HandoffSnapshot {
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

  createdAt: Date;
}
```

### MVP semantics

- generated only when checkpoint succeeds;
- represents the committed state at that checkpoint;
- no real-time incremental refresh between checkpoints;
- latest snapshot is used when bootstrapping a new Session in the same Space.

Future versions may store Memory IDs instead of denormalized strings or compute snapshot + delta.

---

## 12. Bootstrap context contract

`bootstrap(spaceId, ...)` is deterministic in MVP.

Conceptually:

```ts
bootstrap(spaceId)
  -> load active Core memories
  -> group by fixed sections
  -> load latest HandoffSnapshot
  -> render deterministic SpaceContext
```

Fixed sections:

1. Goal
2. Current Roadmap
3. Current Progress
4. Active Tasks
5. Decisions
6. Constraints / Conventions
7. Blockers
8. Open Questions
9. Latest Handoff

No LLM summarization is allowed in this step for MVP.

---

## 13. Retrieval contracts

### Search

```ts
interface MemorySearchInput {
  spaceId: string;
  query: string;
  families?: MemoryFamily[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
  limit?: number;
}

interface MemorySearchResult {
  memory: Memory;
  score?: number;
}
```

Exact ranking implementation is not a domain invariant.

### Context

`memory.context()` is agent-facing and may use search to build query-relevant structured context.

Requirements:

- may retrieve Indexed Memory;
- must identify Memory IDs/sources in its structured output where practical;
- must not mutate memory simply because it was recalled.

---

## 14. Keyed-memory semantics

`key` exists to prevent uncontrolled duplication of stable state.

Example:

```text
key = project.database
content = "PostgreSQL"
```

Later:

```text
key = project.database
content = "MySQL"
```

The system must not blindly retain both as simultaneously canonical active values. The exact update vs supersede rule can depend on type, but the domain operation must preserve history where needed.

MVP minimum behavior:

- same Space + same active key is detected;
- repeated equivalent value is deduplicated/update-touched rather than appended;
- changed value produces an update/supersede path;
- source provenance remains recoverable.

---

## 15. Versioning and future concurrency

`Memory.version` is included in v1 so later OCC can be introduced without reshaping the domain.

Post-MVP target:

```text
Space revision      → detect stale agent context
Memory version/OCC  → detect concurrent updates
Task claim/lease    → prevent duplicate exclusive work
Semantic resolver   → preserve/resolve logical contradictions
```

MVP must not implement the full model, but must avoid destructive last-write-only schemas that make history/concurrency impossible later.

---

## 16. Persistence notes (not product invariants)

Recommended implementation direction:

- relational primary store;
- append-oriented SessionEvents;
- Memory rows as current durable state;
- checkpoint/history metadata retained;
- vector/full-text index may be added for `search()`;
- modular monolith first, worker separation only where useful.

Specific DB, ORM, embedding model, and framework are implementation decisions and should be recorded separately rather than silently hard-coded as domain rules.
