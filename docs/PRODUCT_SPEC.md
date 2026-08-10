# PRODUCT_SPEC — memory-space MVP

**Status:** Frozen for MVP v1  
**Primary validation target:** Cross-Session Handoff within one Space

## 1. Product definition

`memory-space` is an agent-independent memory layer that allows multiple sessions — potentially from different agent platforms — to share durable project/work context through a common **Space**.

The MVP does **not** try to build a complete autonomous memory operating system. It proves one concrete capability:

> A user can work in Session A, persist important state into a Space, leave that session, start Session B in the same Space, and Session B can correctly recover the essential working context and continue along the right path.

The core is provider-agnostic. Provider-specific hooks decide *when* to call memory APIs; the memory core only defines and executes those APIs.

---

## 2. MVP user story

1. Create a Space for a project/work context.
2. Start Session A under that Space.
3. Session A emits normalized `SessionEvent`s.
4. Important memories may be explicitly written during the session.
5. At a meaningful boundary, the caller invokes `checkpoint()`.
6. The checkpoint processes events since the previous successful checkpoint, extracts additional memory candidates, commits memories, and creates a `HandoffSnapshot`.
7. Session A can end, disappear, or simply stop being used; explicit session close is not required for correctness.
8. Start Session B under the same Space.
9. Session B calls `bootstrap()` / reads handoff + Core Memory.
10. Session B understands at least:
   - current goal;
   - current roadmap;
   - current progress;
   - active tasks;
   - important decisions;
   - constraints/conventions;
   - blockers;
   - unresolved questions;
   - recommended next steps.
11. Session B may use search/context APIs to progressively disclose Indexed Memory when deeper implementation detail is needed.

---

## 3. Core product principles

### 3.1 Space owns durable memory

Sessions are sources of memory, not parents of durable memory.

```text
Space
├── Sessions
├── Memories
├── Checkpoints
└── Handoff Snapshots
```

A Memory can originate from a Session but survives independently of that Session.

### 3.2 Persisted does not mean always exposed

All durable memories have a tier:

- `indexed` — durable and searchable; not loaded by default;
- `core` — durable and included in default Space bootstrap context.

`memory.remember()` defaults to `indexed`.

```text
remember()
   ↓
Indexed Memory
   ↓ promote()
Core Memory
```

This is the basis of progressive disclosure.

### 3.3 Core Memory is small, stable working context

Core Memory should contain information whose absence would likely make a new session misunderstand the Space, choose the wrong direction, or repeat already completed work.

Typical Core candidates:

- primary goal;
- current roadmap;
- project-wide progress;
- active high-level tasks;
- blockers;
- important project-wide decisions;
- technical stack choices;
- project-wide constraints and conventions;
- critical open questions.

Local implementation details, debugging traces, transient hypotheses, old episodes, and module-level details normally remain Indexed.

### 3.4 Bootstrap is deterministic

MVP bootstrap does not invoke an LLM to summarize Core Memory.

It loads raw Core Memory and renders it through a fixed template:

```text
# Space Context

## Goal
...

## Current Roadmap
...

## Current Progress
...

## Active Tasks
...

## Decisions
...

## Constraints
...

## Blockers
...

## Open Questions
...
```

The latest Handoff Snapshot is included separately or as a clearly delimited section.

### 3.5 Explicit write first, automatic extraction second

The primary write path is explicit:

```text
Agent/User → memory.remember(...)
```

Automatic extraction is supplementary and happens at checkpoint boundaries:

```text
new SessionEvents
   ↓ checkpoint
extract candidates
   ↓
commit/update memories
```

This keeps the MVP debuggable and prevents extraction quality from being confused with core storage/retrieval correctness.

### 3.6 Checkpoint timing belongs outside the core

The memory core exposes checkpoint capability. It does not own provider-specific lifecycle detection.

Callers/adapters may invoke checkpoint because of:

- an agent hook;
- a completed task;
- a major decision;
- context nearing its limit;
- user inactivity;
- provider exit hooks;
- explicit user action.

The core only guarantees correct checkpoint semantics.

---

## 4. Checkpoint semantics

A Checkpoint is a **Memory Commit Point**, not a session-close event.

Definition:

> Process the current Session's normalized events since its previous successful checkpoint, turn durable information into Memory updates, then produce the latest Handoff Snapshot.

A session may have many checkpoints:

```text
Session
  ├── events
  ├── checkpoint #1
  ├── more events
  ├── checkpoint #2
  ├── more events
  └── checkpoint #3
```

The MVP checkpoint pipeline is:

```text
SessionEvents since previous checkpoint
                ↓
        candidate extraction
                ↓
      normalize / validate
                ↓
       dedup / keyed update
                ↓
         tier decision
                ↓
        memory commit
                ↓
      handoff snapshot build
```

The core should track event boundaries by event identity/order rather than wall-clock timestamps alone.

Checkpoint must be retry-safe. The API should support an idempotency mechanism so retries cannot duplicate committed memory.

---

## 5. Promotion policy

Promotion is a first-class domain operation: `indexed → core`.

Promotion can be initiated by three actors:

### 5.1 User-initiated promotion

User intent is authoritative. If the user explicitly says a memory should become persistent project-wide working context, promote it unless the memory is invalid, archived, or otherwise violates a hard invariant.

Examples:

- “以后这个项目都遵守这个规则。”
- “把这个决定作为项目核心上下文。”

### 5.2 Agent-initiated promotion

An agent may explicitly call `promote()` and should provide a reason.

The core applies deterministic policy checks:

- memory belongs to the target Space;
- memory is active/eligible;
- memory is not superseded/archived;
- content is project-wide rather than obviously session-local;
- Core budget allows it, or a deterministic demotion/compaction policy is triggered.

Agents must not indirectly force Core membership merely by setting a high importance score.

### 5.3 Checkpoint-extractor promotion

The extractor may recommend/promote memories when the following criteria are met:

1. **Cross-session relevance** — likely useful in future sessions;
2. **Global relevance** — relevant to the Space/project, not only a local implementation detail;
3. **Action impact** — omission could cause wrong direction, repeated work, or broken constraints;
4. **Stability** — sufficiently stable to deserve default exposure, or represents the canonical current state.

For MVP, deterministic policy should dominate. Ambiguous items remain Indexed rather than being aggressively promoted.

### 5.4 Suggested default type policy

Normally Core-eligible:

- `goal`
- `roadmap`
- project-wide `progress`
- high-level active `task`
- `blocker`
- important `decision`
- `constraint`
- project-wide `convention`
- stable project-wide `fact`, especially when keyed

Normally Indexed unless explicitly promoted:

- session episodes;
- module implementation details;
- debugging traces;
- temporary hypotheses;
- tool outputs;
- historical/resolved local questions;
- low-level completed tasks.

### 5.5 Demotion

`core → indexed` is a supported domain transition.

Typical demotion triggers:

- a Core task is completed and no longer needs default exposure;
- a roadmap becomes historical;
- a memory becomes `superseded`, `resolved`, or `archived`;
- Core budget requires removing lower-current-value items.

Tier and status are orthogonal.

---

## 6. Recall surface

MVP exposes both low-level and agent-oriented retrieval.

### `memory.search()`

Returns Memory entities/candidates relevant to a query and filters.

Purpose: precise retrieval and tool use.

### `memory.context()`

Uses retrieval results to produce structured agent context for a specific query/intent.

Purpose: progressive disclosure of Indexed Memory.

### `bootstrap()` / handoff read

Returns default Space working context:

- deterministic fixed-template Core Memory;
- latest checkpoint-generated Handoff Snapshot.

MVP does not perform incremental refresh of the Handoff Snapshot between checkpoints. That is a post-MVP enhancement.

---

## 7. Memory identity

Some Memory represents a stable slot/value that should be updated rather than duplicated.

For these cases, `Memory.key?: string` is supported.

Examples:

```text
project.goal.primary
project.database
project.stack.frontend
project.roadmap.current
project.progress.current
```

A key is optional. Episodic or historical memories do not need keys.

Rules:

- uniqueness is scoped to a Space plus the relevant memory domain/status policy;
- creating a new value for an existing stable key should update/supersede according to the memory type rather than blindly append duplicates;
- unkeyed memories may coexist if semantically distinct.

---

## 8. Built-in memory taxonomy

MVP keeps stable top-level families and extensible string types.

Families:

- `knowledge`
- `state`
- `episode`
- `procedure`

Built-in types should cover at least:

- `goal`
- `decision`
- `fact`
- `progress`
- `task`
- `roadmap`
- `question`
- `preference`
- `constraint`
- `convention`
- `blocker`
- `assumption`

Implementations may add custom `type` values while keeping `family` constrained to the stable family set in MVP.

Artifacts/files/commits may be represented as normalized SessionEvents and referenced in memory payloads in MVP. A first-class Artifact aggregate can be added later without changing the core Space/Session/Memory relationship.

---

## 9. Evaluation requirements

Evaluation is part of MVP, even if the first dataset is small.

The evaluation harness must be extensible and initially test four abilities:

1. **Extraction** — expected durable memories are created at checkpoint;
2. **Dedup/keyed update** — repeated information does not create uncontrolled duplicates;
3. **Recall** — a later session can retrieve relevant Indexed/Core memory;
4. **Handoff** — a later session recovers the correct current working state.

Suggested future metrics, not all required for first implementation:

- extraction precision/recall;
- Recall Precision@K;
- recall coverage;
- stale-memory rate;
- conflict error rate;
- handoff completeness;
- duplicate-memory rate;
- Core-context token cost.

Scenario fixtures should be data-driven so a future benchmark suite can expand without rewriting the runner.

---

## 10. MVP success criteria

MVP is successful when automated scenarios prove that:

1. A Space can contain multiple sessions.
2. Session A can append events and explicitly remember information.
3. `remember()` defaults to Indexed.
4. An eligible Memory can be promoted to Core.
5. `checkpoint()` only processes new events since the prior successful checkpoint.
6. Checkpoint creates/updates memories without duplicating retry attempts.
7. Checkpoint generates a Handoff Snapshot.
8. Session B in the same Space can bootstrap deterministic Core context + latest handoff.
9. Session B can search Indexed Memory for details not exposed by default.
10. The evaluation suite automatically verifies the cross-session recovery scenario.

---

## 11. MVP non-goals

Do not implement these unless explicitly promoted into scope later:

- full CRDT support;
- advanced multi-session semantic conflict resolution;
- distributed locking / task leases;
- Memory branches / Git-style merge UI;
- Graph DB;
- automatic memory decay;
- complex ACL / organization tenancy;
- multi-region deployment;
- sophisticated autonomous Core compaction;
- full visual dashboard;
- many provider-specific integrations;
- real-time incremental Handoff refresh;
- agent scheduler;
- fully autonomous “remember everything” behavior.

The data model should avoid blocking these future capabilities, but the MVP must not pre-build them.

---

## 12. Implementation decisions not frozen by product spec

Coding agents must **not silently invent irreversible choices** for the following unless an implementation task explicitly chooses them:

- server framework;
- ORM/query builder;
- exact database/vector implementation;
- embedding provider/model;
- queue/worker technology;
- auth strategy;
- MCP transport details;
- deployment platform.

Recommended direction from design discussions is a modular monolith + worker with PostgreSQL/pgvector, but this is an implementation default, not a product invariant.
