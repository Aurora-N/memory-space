# CR-PHASE2 — MVP Hardening Follow-up

**Status:** Ready for implementation  
**Scope:** MVP correctness hardening only  
**Baseline reviewed commit:** `3bb2475eed6d7990269c594e50363cf6e73d38fc`  
**Primary goal:** Close the remaining correctness gaps found after CR-PHASE1 without expanding into advanced concurrency, provider integration, vector retrieval, or dashboard work.

---

## 1. Context

CR-PHASE1 successfully hardened the MVP around:

- `remember()` defaulting to Indexed and no longer allowing direct Core writes;
- HTTP promotion actor spoofing;
- Handoff current-state construction from active Core Memory;
- checkpoint idempotency and fixed `toEventId` identity;
- stale `processing` checkpoint recovery after restart;
- keyed-memory family/type invariants;
- durable reopen-based Cross-Session Handoff evaluation;
- composition-root cleanup.

The current architecture should be preserved. This review only addresses the remaining issues discovered after that hardening pass.

---

# 2. Hard Constraints

Do **not** use this task to introduce:

- Space revision;
- full Memory OCC / `expectedVersion` API;
- distributed locks or leases;
- CRDT;
- semantic conflict resolver;
- PostgreSQL;
- Redis;
- worker queues;
- vector search / embeddings;
- provider adapters;
- MCP integration;
- auth;
- dashboard / visualization;
- new framework / ORM;
- large-scale package or directory restructuring.

Preserve the frozen MVP domain contract unless this spec explicitly says otherwise.

The following invariants remain authoritative:

```text
Persisted != default-exposed
Indexed   = durable + on-demand
Core      = default working context
Checkpoint = durable Memory Commit Point
Cache      = optimization, never source of truth
```

---

# 3. Required Fixes

## FIX-01 — Prevent resolved Indexed tasks leaking through Handoff.completed

**Priority:** P1  
**Category:** Domain correctness / progressive disclosure

### Problem

Current Handoff construction correctly derives active state from:

```text
tier = core
AND status = active
```

However `completed` is currently built from every resolved task in the Space, regardless of whether that task was ever Core.

Conceptually:

```text
Indexed low-level task
  ↓ setMemoryStatus("resolved")
resolved + indexed
  ↓ checkpoint
Handoff.completed
  ↓ bootstrap
Default exposed
```

This reintroduces the same progressive-disclosure bypass that CR-PHASE1 fixed for active task/decision/blocker/question state.

Example:

```text
Indexed task:
"修改 auth.ts 第 183 行"

→ resolved
→ checkpoint
→ Session B bootstrap
```

The detail must **not** appear in default Handoff context merely because it became resolved.

### Required behavior

A resolved task may enter `HandoffSnapshot.completed` only if it qualifies as previously default-exposed project state.

For MVP, use the already persisted Memory history to determine whether the Memory was ever Core.

Required semantic rule:

```text
resolved task
AND
memory was Core at some point
→ eligible for Handoff.completed
```

Otherwise:

```text
resolved Indexed task
→ remains searchable/history-visible
→ does NOT enter bootstrap/Handoff default context
```

### Recommended implementation

Do not add a new database column solely for this MVP fix.

Use `memory_history` / `listMemoryHistory(memoryId)`.

A helper may be introduced, conceptually:

```ts
async function wasEverCore(memoryId: string): Promise<boolean> {
  const history = await store.listMemoryHistory(memoryId);
  return history.some((entry) =>
    entry.before?.tier === "core" ||
    entry.after?.tier === "core"
  );
}
```

Then Handoff construction filters resolved tasks through this predicate.

The exact helper placement is implementation-defined; keep it inside the application/domain boundary rather than exposing it as a public API.

### Important note

`setMemoryStatus()` currently demotes inactive memories to Indexed. Therefore checking only the task's **current tier** is insufficient:

```text
Core task
→ resolved
→ current tier becomes indexed
```

The implementation must distinguish:

```text
formerly Core + now resolved
```

from:

```text
always Indexed + now resolved
```

### Regression tests required

Add both cases:

#### Case A — resolved Indexed task stays hidden

```text
remember(task) // indexed
→ set status resolved
→ checkpoint
→ bootstrap
```

Assert:

- task is absent from `handoff.completed`;
- task is absent from bootstrap default context;
- task remains recoverable through explicit search/history as appropriate.

#### Case B — resolved former-Core task appears in completed

```text
remember(task)
→ promote(task)
→ set status resolved
→ checkpoint
```

Assert:

- task appears exactly once in `handoff.completed`;
- task does not appear as an active task;
- bootstrap exposes it only via the Handoff completed section, not as active Core Memory.

---

## FIX-02 — Cache failure must never turn a successful durable operation into failure

**Priority:** P1  
**Category:** Transaction correctness

### Problem

Current mutation flows generally perform:

```text
Durable database mutation
→ await cache invalidation
→ return success
```

Checkpoint is more dangerous because its outer `try/catch` can currently encompass cache invalidation after the durable transaction has already committed.

Failure scenario:

```text
DB transaction succeeds:
✓ Memory committed
✓ HandoffSnapshot inserted
✓ Checkpoint status = completed
✓ Session checkpoint boundary advanced

then

cache.delete("bootstrap:...") throws

then outer catch runs
→ checkpoint may be rewritten as failed
→ caller receives failure
```

This creates a contradictory durable state:

```text
Memory committed
Session boundary advanced
Snapshot exists
Checkpoint reported/marked failed
```

That violates the Checkpoint invariant.

The same general semantic issue exists for explicit memory mutations: cache invalidation failure must not make the caller believe a durable mutation failed after it actually committed.

### Required invariant

> Cache is best-effort derived state. Cache failure must never change the success/failure of a successfully committed domain operation.

This applies to at least:

- `remember()`;
- `promote()`;
- `demote()`;
- `setMemoryStatus()`;
- successful `checkpoint()`.

### Required checkpoint structure

The durable operation and failure handling must be separated from post-commit cache work.

Conceptually:

```ts
let completed: Checkpoint;

try {
  completed = await store.transaction(async () => {
    // durable Memory effects
    // history/provenance
    // HandoffSnapshot
    // checkpoint = completed
    // Session boundary advance
  });
} catch (error) {
  // only durable/extraction/checkpoint-processing failure reaches here
  // mark failed as appropriate
  throw error;
}

await safeInvalidate(spaceId);
return completed;
```

Cache invalidation must happen **after** the durable failure boundary has closed.

### Recommended helper

Introduce one best-effort helper, e.g.:

```ts
async #safeInvalidate(spaceId: string): Promise<void> {
  try {
    await this.cache.delete(`bootstrap:${spaceId}`);
  } catch (error) {
    // log / observe, but do not fail the domain operation
  }
}
```

The exact logging mechanism may remain minimal in MVP.

Do not introduce Redis or a retry queue in this phase.

### Behavior for cache failure

For a successful durable mutation:

```text
cache invalidation fails
```

Expected API behavior:

```text
operation still resolves successfully
```

The next uncached/restarted read must reflect durable truth.

A future observability layer may surface cache-invalidation errors separately.

### Regression tests required

Create a test CachePort whose `delete()` throws.

#### Checkpoint test

Run:

```text
append event
→ checkpoint
→ cache.delete throws
```

Assert:

- checkpoint call resolves as `completed`;
- persisted checkpoint remains `completed`;
- Session `lastCheckpointEventId` advanced;
- HandoffSnapshot exists;
- Memory effects exist;
- checkpoint is never rewritten to `failed`.

#### Explicit mutation test

At least one explicit memory mutation (`remember()` recommended) should also be tested with a throwing cache.

Assert:

- call resolves with the persisted Memory;
- Memory is present in storage;
- no false domain failure is reported.

If practical, reuse the same `safeInvalidate` path for all mutation operations.

---

# 4. Boundary Documentation Required Before MVP Freeze

The following two items are **not requests to implement advanced infrastructure**. They are explicit limitations/trust boundaries that must be documented so future Coding Agents do not accidentally assume guarantees the MVP does not provide.

## DOC-01 — Document the single-active-process checkpoint assumption

**Priority:** P2 documentation / future concurrency guardrail

### Current behavior

`MemorySpace` uses an in-process map to ensure duplicate calls sharing:

```text
sessionId + idempotencyKey
```

share one local Promise/extraction operation.

SQLite `getOrCreateCheckpoint()` guarantees a single durable checkpoint row via uniqueness / `ON CONFLICT DO NOTHING`.

However this does **not** guarantee single execution across two independent MemorySpace processes.

Possible future scenario:

```text
Process A                 Process B
   │                         │
getOrCreate(K)          getOrCreate(K)
   │                         │
 same persisted checkpoint row
   │                         │
extract()                extract()
```

The MVP intentionally does not solve this with leases/distributed locking.

### Required documentation

Add an ADR or an explicit section in existing architecture/runtime documentation stating:

> MVP checkpoint execution assumes one active `MemorySpace` process per durable store. Database uniqueness guarantees checkpoint identity, while the single-execution guarantee is currently process-local. Multi-process checkpoint execution requires a future distributed execution/lease design.

Do **not** implement the future design now.

Recommended location:

```text
docs/adr/...
```

or a clearly discoverable section in the existing MVP ADR.

---

## DOC-02 — Freeze the future Provider → MemoryCandidate trust boundary

**Priority:** P2 design guardrail

### Current risk

Checkpoint candidates may contain:

```text
recommendedTier = core
promoteReason
core-eligible type
```

The domain policy then determines final tier.

Today this is acceptable because candidate production is internal to the MVP extractor path.

Future provider integration creates a trust question:

```text
Provider/Agent event
→ structured MemoryCandidate
→ recommendedTier = core
```

If provider-supplied structured data is treated as trusted extractor output, an Agent may indirectly force information toward Core by crafting a `memory` event.

### Required decision record

Document now, without implementing Provider adapters:

> Provider-normalized events are evidence/input, not automatically trusted memory commands. Provider-originated candidate-like payloads must pass an explicit trust/policy boundary before they can exercise privileged Core-promotion semantics.

The record should distinguish at least:

```text
raw/provider evidence
trusted explicit memory command
extractor-generated candidate
user-authoritative action
```

No auth/provider implementation is required in this CR.

The purpose is to prevent the next phase from silently equating:

```text
"provider supplied recommendedTier=core"
```

with:

```text
"trusted checkpoint extractor recommends Core"
```

---

# 5. CI Quality Gate

**Priority:** P2 engineering reliability

The reviewed commit currently has no GitHub status checks associated with it.

Before declaring the MVP frozen, add a minimal GitHub Actions workflow if the repository does not already contain one.

Required workflow behavior:

```text
push / pull_request
→ setup supported Node version (>= 22.13)
→ enable Corepack
→ pnpm install --frozen-lockfile
→ pnpm run check
```

If `check:workspace` is meaningful and non-recursive in CI, it may also be run, but do not create an infinite self-recursive workspace script configuration.

The workflow should remain small and deterministic.

No deployment/CD workflow is required.

---

# 6. Tests / Evaluation Matrix

At minimum, after this CR the automated suite must cover:

| Scenario | Expected |
|---|---|
| resolved Indexed task → checkpoint | not in Handoff.completed |
| resolved Indexed task → bootstrap | not default-exposed |
| resolved former-Core task → checkpoint | appears in Handoff.completed |
| resolved former-Core task | absent from active task section |
| cache delete throws after checkpoint commit | checkpoint remains completed |
| cache delete throws after checkpoint commit | Session boundary remains advanced |
| cache delete throws after checkpoint commit | snapshot/memory effects remain durable |
| cache delete throws after explicit remember | remember still resolves successfully |
| persistent reopen Handoff eval | remains green |
| all CR-PHASE1 regression tests | remain green |

Do not weaken or delete existing CR-PHASE1 tests to make this phase pass.

---

# 7. Implementation Order

Coding Agent should implement in this order:

## Step 1 — Add failing regression tests

Add tests for:

1. resolved Indexed task leakage;
2. former-Core resolved task completion;
3. checkpoint cache-invalidation failure;
4. explicit-memory cache-invalidation failure.

Confirm that at least the tests corresponding to existing defects fail against the current baseline before changing implementation.

## Step 2 — Fix Handoff completed eligibility

Use existing Memory history to distinguish formerly-Core tasks from always-Indexed tasks.

Do not add new persistence fields unless unavoidable.

## Step 3 — Separate durable success from cache invalidation

Refactor mutation/checkpoint completion so cache errors cannot alter durable operation outcomes.

## Step 4 — Add architecture/trust-boundary documentation

Document:

- single-active-process-per-store checkpoint execution assumption;
- Provider evidence vs trusted MemoryCandidate/Core-promotion boundary.

Do not implement advanced concurrency/provider integration.

## Step 5 — Add minimal CI

Add GitHub Actions running the existing quality gate.

## Step 6 — Run all quality gates

Run:

```bash
pnpm run check
```

and, if valid for the workspace setup:

```bash
pnpm run check:workspace
```

Also ensure the GitHub Actions workflow uses the same supported Node range/runtime assumptions as `package.json` and README.

---

# 8. Acceptance Criteria

This CR is complete only when all of the following hold.

## Progressive disclosure

- Indexed active state does not leak through Handoff;
- resolved Indexed tasks also do not leak through Handoff;
- formerly-Core high-level tasks may appear in `completed` after resolution;
- Indexed details remain retrievable on demand.

## Checkpoint correctness

- durable checkpoint commit is the authoritative success boundary;
- cache invalidation failure cannot rewrite a committed checkpoint to failed;
- cache invalidation failure cannot cause a false failure response after durable success;
- existing retry/idempotency/restart semantics remain green.

## Architecture boundaries

- MVP multi-process limitation is explicitly documented;
- future Provider candidate trust boundary is explicitly documented;
- no distributed coordination or Provider integration is implemented in this phase.

## Engineering gate

- regression suite passes;
- durable Handoff eval passes;
- `pnpm run check` passes;
- minimal CI exists and runs the quality gate.

---

# 9. Definition of Done Report

Before finishing, Coding Agent must report:

1. files changed;
2. implementation summary for FIX-01 and FIX-02;
3. documentation added for DOC-01 and DOC-02;
4. regression tests added;
5. `pnpm run check` result;
6. `pnpm run check:workspace` result, if applicable;
7. GitHub Actions workflow added/updated;
8. any remaining known limitation;
9. whether any frozen MVP Domain Contract was changed.

If the Domain Contract was changed, do not hide it. Report:

```text
Original invariant
Proposed/implemented change
Why it was required
Compatibility impact
```

The expected outcome of this CR is **no Domain Contract change**.

---

# 10. Stop Condition

After this CR passes, stop hardening the current MVP unless a new correctness regression is demonstrated.

Do not continue directly into:

```text
Space revision
Memory OCC
Task leases
Distributed checkpoint ownership
Semantic conflict merging
Provider adapters
MCP
Vector retrieval
PostgreSQL migration
Visualization/dashboard
```

Those belong to the post-MVP roadmap discussion.

The purpose of CR-PHASE2 is narrowly defined:

> **Close the last known progressive-disclosure and post-commit consistency gaps, document the MVP's execution/trust boundaries, and establish an automated quality gate so the MVP can be formally frozen.**
