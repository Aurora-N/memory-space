# MVP_PLAN — AI Coding execution plan

**Goal:** Build the smallest end-to-end system that proves reliable Cross-Session Handoff inside one Space.

This file is intentionally written as execution guidance for an AI Coding Agent.

---

## 1. AI Coding rules

### 1.1 Do not redesign frozen domain decisions

Treat `../specs/PRODUCT_SPEC.md` and `../specs/DOMAIN_MODEL.md` as source of truth.

Do not silently:

- replace Space/Session/Memory relationships;
- make Memory a child record owned only by Session;
- change `remember()` default from `indexed`;
- remove Core/Indexed tiering;
- make bootstrap depend on LLM summarization;
- make checkpoint synonymous with session close;
- remove `Memory.key?`;
- skip `SessionEvent` normalization;
- implement advanced concurrency/CRDT before requested.

If an implementation detail is unspecified, prefer the simplest reversible choice and document it.

### 1.2 Work in vertical slices

Each slice must:

1. implement one user-observable capability end to end;
2. include automated tests;
3. leave the repo runnable;
4. avoid unrelated refactors;
5. be small enough for code review.

Do not scaffold every future subsystem before the first end-to-end slice works.

### 1.3 Tests are part of implementation

No slice is complete without its acceptance tests.

The MVP must include data-driven evaluation scenarios, not only unit tests.

---

## 2. Implementation sequence

### Phase 0 — Repository foundation

Deliverables:

- application/package skeleton;
- formatter/linter/test runner;
- environment configuration example;
- persistence migration mechanism;
- `/docs` specs retained unchanged;
- basic CI command documented.

Rules:

- choose a modular monolith structure;
- do not introduce distributed infrastructure unless required by a current slice;
- record major framework/storage decisions in a short ADR or README section.

Acceptance:

- install succeeds;
- lint/typecheck/tests run with one documented command;
- empty application starts.

---

## 3. Vertical Slice 1 — Space + Session + explicit Indexed Memory

### User scenario

```text
Create Space
→ Create Session A
→ memory.remember(decision)
→ Read memory from same Space
```

### Required behavior

- Create/read Space.
- Create Session under Space.
- `remember()` accepts explicit Memory input.
- Omitted tier becomes `indexed`.
- Memory is owned by Space and may reference source Session.
- `version = 1` on create.

### Acceptance tests

- memory persists after Session object is reloaded;
- memory belongs to the Space, not a session-local store;
- default tier is `indexed`;
- invalid Space/Session references fail clearly.

---

## 4. Vertical Slice 2 — Core promotion + deterministic bootstrap

### User scenario

```text
Session A writes indexed project goal
→ promote(goal)
→ Create Session B in same Space
→ bootstrap()
→ Session B receives goal in Core context
```

### Required behavior

- `promote(memoryId, reason?)` domain operation.
- `demote(memoryId, reason?)` operation.
- bootstrap loads active Core Memory.
- bootstrap renders fixed sections only.
- no LLM call occurs in bootstrap.

### Acceptance tests

- Indexed Memory is absent from default Core context.
- Promoted Memory appears in correct fixed section.
- Demoted Memory disappears from Core bootstrap but remains searchable/persisted.
- Superseded/archived Core Memory is not treated as active default context.
- bootstrap output is snapshot-testable/deterministic.

---

## 5. Vertical Slice 3 — SessionEvent append + checkpoint boundary

### User scenario

```text
Session A
→ append e1,e2,e3
→ checkpoint(to=e3)
→ append e4,e5
→ checkpoint(to=e5)
```

### Required behavior

- append normalized SessionEvents;
- checkpoint stores `fromEventId`/`toEventId` boundary;
- second checkpoint processes only events after first successful checkpoint;
- checkpoint has status lifecycle;
- checkpoint request supports idempotency key;
- `Session.lastCheckpointEventId` advances only on successful commit.

### Acceptance tests

- retrying same checkpoint does not duplicate side effects;
- failed checkpoint does not advance boundary;
- later checkpoint does not reprocess earlier events;
- checkpoint does not close Session.

Initially, extraction may be implemented with a deterministic fake/stub so checkpoint mechanics can be proven before LLM behavior is introduced.

---

## 6. Vertical Slice 4 — MemoryCandidate extraction at checkpoint

### User scenario

Session events contain:

```text
"数据库确定使用 PostgreSQL。"
"先完成 recall API。"
```

Checkpoint should be capable of producing candidate memories such as:

```text
decision: project database = PostgreSQL
task: implement recall API
```

### Required behavior

- extractor interface is isolated behind a port/adapter;
- extractor returns `MemoryCandidate[]`;
- candidates include source event IDs;
- extraction does not directly write arbitrary database rows;
- domain layer validates/commits candidate operations.

### Promote behavior

Extractor may recommend Core only if promotion rules pass.

When ambiguous:

```text
recommendedTier = indexed
```

### Acceptance tests

- fixture events generate expected candidates using test extractor/fake;
- source provenance is preserved;
- invalid candidate is rejected without corrupting checkpoint state;
- checkpoint can succeed with zero candidates.

---

## 7. Vertical Slice 5 — Keyed update + minimal dedup

### User scenario A: repetition

```text
Session A: project.database = PostgreSQL
Session B: project.database = PostgreSQL
```

Expected: no uncontrolled duplicate canonical memory.

### User scenario B: changed value

```text
old: project.database = PostgreSQL
new: project.database = MySQL
```

Expected: update/supersede semantics preserve a single current canonical value while retaining enough history/provenance for future debugging.

### Required behavior

- optional `Memory.key` supported;
- active keyed memory lookup scoped by Space;
- equivalent repeated value deduplicated;
- changed value handled by update/supersede operation;
- unkeyed memory can coexist normally.

### Acceptance tests

- same key + same meaning does not append duplicates;
- same key + changed value leaves only one canonical active value;
- prior source/history is not silently lost.

Do not implement general semantic conflict resolution in MVP.

---

## 8. Vertical Slice 6 — Checkpoint-generated Handoff Snapshot

### User scenario

Session A has committed memories representing:

- current goal;
- completed work;
- active task;
- important decision;
- blocker/open question;
- next step.

After checkpoint, a Handoff Snapshot is stored.

### Required behavior

- snapshot generated only after committed memory state is available;
- Session points to latest snapshot;
- snapshot is associated with checkpoint;
- MVP snapshot is checkpoint-time only; no incremental refresh.

### Acceptance tests

- failed checkpoint produces no successful latest snapshot;
- later successful checkpoint becomes latest;
- snapshot reflects committed state at checkpoint boundary;
- snapshot can be loaded without source Session being active.

---

## 9. Vertical Slice 7 — Cross-Session Handoff end to end

This is the primary MVP validation slice.

### Scenario

```text
Create Space P

Create Session A
→ append events
→ remember important decision (defaults indexed)
→ promote project-wide goal/decision as needed
→ checkpoint
→ HandoffSnapshot generated

Create Session B in Space P
→ bootstrap
→ receives deterministic Core context
→ receives latest Handoff Snapshot
→ asks for module detail
→ search/context retrieves Indexed Memory
```

### Acceptance criteria

Session B can correctly answer from stored state:

- What is the current goal?
- What has already been completed?
- What is the current roadmap/current task?
- What important decisions/constraints must not be lost?
- What is the next step?
- Where can it retrieve deeper details that are not Core?

This scenario must be automated as an integration/eval fixture.

---

## 10. Vertical Slice 8 — `memory.search()`

### MVP requirements

The exact ranking implementation is intentionally not frozen.

Minimum capability:

- query within a Space;
- filter by family/type/tier/status;
- return stable Memory IDs + content + metadata;
- retrieve Indexed Memory that bootstrap does not expose.

Implementation can begin with the simplest measurable retrieval approach and later add vector/full-text hybrid search.

### Acceptance tests

- search never returns another Space's Memory;
- active Indexed detail is retrievable;
- filters work;
- resolved/superseded content is controllable by status filter.

---

## 11. Vertical Slice 9 — `memory.context()`

### Purpose

Agent-facing query context built from retrieved Memory.

MVP requirements:

- uses `search()` or equivalent retrieval abstraction;
- produces structured, deterministic-enough output;
- includes Memory IDs/source metadata where practical;
- does not mutate tier/status just because a memory was recalled.

Do not build a sophisticated LLM reranker unless evaluation demonstrates need.

---

## 12. Evaluation harness

### Directory contract

Recommended shape:

```text
eval/
├── fixtures/
├── scenarios/
├── runners/
└── metrics/
```

Equivalent organization is acceptable if responsibilities remain clear.

### MVP scenario categories

#### Extraction

Given event fixtures, expected candidate memories are produced.

#### Dedup / keyed update

Repeated stable facts do not create duplicate canonical memories.

#### Recall

A later session can retrieve relevant indexed detail.

#### Handoff

A later session recovers current project state and next actions.

### Example scenario schema

```yaml
name: recover-project-database-decision
space: project-a
sessions:
  - id: session-a
    events:
      - "数据库确定使用 PostgreSQL"
    checkpoint: true

next_session:
  id: session-b
  query: "数据库之前怎么决定的？"

expected:
  contains:
    - PostgreSQL
```

The runner design must make it easy to add future metrics without rewriting all fixtures.

---

## 13. Suggested API surface for MVP

Exact HTTP paths/RPC syntax are implementation details, but domain capabilities should map to:

```text
space.create
space.get

session.create
session.appendEvent
session.get

memory.remember
memory.get
memory.search
memory.context
memory.promote
memory.demote

checkpoint.create
checkpoint.get

handoff.getLatest
bootstrap
```

### Important defaults

```text
memory.remember(...).tier default = indexed
bootstrap = Core + latest Handoff
checkpoint != close session
```

---

## 14. Provider boundary

Provider integration is not a core MVP dependency beyond one thin demo adapter/interface.

Core contract:

```text
Provider/Agent hook
      ↓
normalized SessionEvent / explicit Memory API
      ↓
Memory Core
```

Provider is responsible for deciding when to call checkpoint.

Post-MVP provider work may add:

- Claude Code hooks;
- Cursor integration;
- Codex integration;
- additional MCP/provider adapters;
- inactivity-triggered checkpoint orchestration.

Do not move those lifecycle policies into Core.

---

## 15. Advanced concurrency — deliberately deferred

MVP prepares for, but does not fully implement:

```text
Space revision
Memory OCC/version checks
semantic conflict resolution
task claim + lease
shared-memory branch/merge
```

What MVP must do now:

- keep `Memory.version`;
- avoid whole-Space last-write replacement documents;
- keep Memory reasonably atomic;
- preserve checkpoint/event history sufficient for later evolution.

---

## 16. Visualization — deferred but observable data required

A future visualization layer should be able to explain:

- which Session/Event produced a Memory;
- whether it is Core or Indexed;
- when/why it was promoted/demoted;
- checkpoint history;
- latest Handoff Snapshot;
- keyed update/supersede history;
- extraction candidates and rejected candidates.

Therefore the MVP implementation should preserve provenance and operation metadata instead of making opaque destructive updates.

Do not build the full dashboard during MVP.

---

## 17. Definition of done for MVP

The MVP is done only when all are true:

- [ ] Space supports multiple Sessions.
- [ ] SessionEvent normalization/append works.
- [ ] Explicit `remember()` works and defaults to Indexed.
- [ ] Promote/Demote works.
- [ ] Fixed-template Core bootstrap works without LLM summarization.
- [ ] Checkpoint is a retry-safe Memory Commit Point.
- [ ] Checkpoint processes only events since prior successful checkpoint.
- [ ] Checkpoint extraction is behind an isolated interface.
- [ ] `Memory.key?` supports stable keyed update/dedup behavior.
- [ ] Checkpoint generates Handoff Snapshot.
- [ ] Session B can recover Session A's working state in same Space.
- [ ] Indexed detail is retrievable on demand.
- [ ] Evaluation scenarios cover extraction, dedup, recall, handoff.
- [ ] No advanced concurrency/dashboard/provider scope has leaked into MVP without a documented decision.

---

## 18. Recommended first AI Coding prompt

Use this after repository foundation exists:

```text
Read docs/specs/PRODUCT_SPEC.md and docs/specs/DOMAIN_MODEL.md first. Treat their MVP decisions as frozen.

Implement Vertical Slice 1 from docs/plans/MVP_PLAN.md only:
- create Space;
- create Session in a Space;
- explicit memory.remember();
- default Memory tier to indexed;
- Memory belongs to Space and optionally references source Session;
- Memory.version starts at 1.

Before coding, inspect the existing repository and state the smallest set of files you need to change. Do not scaffold future checkpoint, provider, dashboard, CRDT, Graph DB, or advanced concurrency systems. Add automated tests covering the slice's acceptance criteria. Run tests/typecheck/lint before finishing.
```
