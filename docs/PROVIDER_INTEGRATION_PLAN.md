# Provider Integration v1 — Implementation Plan

**Status:** P2 implementation and automated validation complete; real-Codex smoke pending

**P0 status:** Frozen after CR-PHASE3

**P1 status:** Frozen after CR-PHASE4 runtime hardening

**P2 status:** NOT YET FROZEN — real-Codex smoke has not been recorded

**Spec:** [`PROVIDER_INTEGRATION_SPEC.md`](./PROVIDER_INTEGRATION_SPEC.md)  

**Normative guardrails:** [`PROVIDER_INTEGRATION_GUARDRAILS.md`](./PROVIDER_INTEGRATION_GUARDRAILS.md)

**Target branch:** `agent/provider-integration-v1`  
**Delivery model:** Incremental phases with code review between phases

---

## 1. Goal

Implement Provider Integration v1 without changing the frozen Memory Space product/domain semantics.

The implementation must prove that real coding-agent sessions can share one durable Space across provider boundaries while preserving:

- progressive disclosure;
- Session → exactly one Space;
- durable checkpoint/Handoff semantics;
- provider-independent Memory Core;
- explicit domain operations through MCP;
- fail-open lifecycle hooks;
- fail-visible MCP errors.

The Coding Agent must not implement all providers in one large pass.

Required delivery order:

```text
P0 — Integration Foundation
P1 — MCP Command Plane
P2 — Codex Provider Integration
P3 — Claude Code Provider Integration
P4 — Cross-provider Durable Eval
P5 — Optional Cursor MCP-first validation
```

Stop for review after P0/P1 and again after P2 before implementing Claude-specific behavior if requested by the reviewer.

---

# 2. Global Constraints

The normative Provider Integration guardrails are required reading before each
phase. In particular, P3 and P4 must not begin without re-reading
[`PROVIDER_INTEGRATION_GUARDRAILS.md`](./PROVIDER_INTEGRATION_GUARDRAILS.md).

Do not introduce in this implementation plan:

- distributed leases/locks;
- multi-process checkpoint ownership;
- Redis/PostgreSQL migration;
- vector search;
- embeddings;
- auth;
- remote team-space identity;
- automatic Git→Space creation;
- full tool trace ingestion;
- transcript replication;
- automatic transcript summarization by default;
- dashboard UI;
- multi-Space Session inheritance;
- Space federation;
- raw memory CRUD MCP tools;
- direct agent control of `tier`, `actor`, checkpoint boundaries, or idempotency keys.

Prefer adapting existing public `MemorySpace` methods instead of duplicating domain behavior.

---

# 3. Pre-flight

Before changing code:

1. Read:
   - `docs/PROVIDER_INTEGRATION_SPEC.md`;
   - `docs/DOMAIN_MODEL.md`;
   - `docs/PRODUCT_SPEC.md`;
   - `docs/MVP_PLAN.md`;
   - `docs/adr/0003-mvp-execution-and-candidate-trust-boundaries.md`;
   - CR-PHASE1/CR-PHASE2 docs.

2. Run the existing quality gate:

```bash
pnpm run check
```

3. Record the baseline result.

4. Do not weaken existing tests to accommodate Provider Integration.

5. Preserve the current single-active-process durable-store assumption.

---

# 4. P0 — Integration Foundation

## Objective

Create provider-independent integration primitives before adding MCP or a real provider adapter.

P0 must be testable with fake providers and a temporary/persistent SQLite store.

---

## P0.1 Provider types

Add integration-domain types, recommended location:

```text
src/provider/types.ts
```

Required concepts:

```ts
ProviderCapability
ProviderLifecycleEvent
ProviderEventBase
TranscriptRef
CheckpointTrigger
```

Do not move these into core `domain/types.ts` unless they are genuinely Memory-domain concepts.

Required lifecycle event types:

```text
session_start
user_prompt
assistant_turn
pre_compact
session_end
```

Provider-specific extra native events must remain adapter-local unless normalized into a currently supported common lifecycle event.

### Tests

- exhaustive/compile-level event discrimination;
- malformed normalized events rejected before Memory operations where appropriate.

---

## P0.2 ProviderAdapter interface

Add one capability-based Provider Adapter contract.

Conceptually:

```ts
interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;

  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null;

  renderBootstrap?(
    input: ProviderBootstrapRenderInput
  ): ProviderBootstrapOutput;
}
```

Do not put Memory operations on this interface.

### Acceptance

A fake provider can normalize a provider-native payload into the common event model without importing SQLite or mutating Memory directly.

---

## P0.3 SpaceResolver

Recommended location:

```text
src/binding/space-resolver.ts
```

Implement v1 resolution:

```text
1. explicit override
2. nearest ancestor .memory-space/config.json
3. unbound
```

Project config v1:

```json
{
  "version": 1,
  "spaceId": "sp_xxx"
}
```

### Required behavior

- start at supplied `cwd`;
- walk ancestors to filesystem root;
- first valid `.memory-space/config.json` wins;
- explicit override wins over all files;
- malformed config returns a stable validation/binding error;
- missing config returns `SPACE_NOT_BOUND` / equivalent result;
- do not infer from Git remote/repo name;
- do not create a Space automatically.

### Tests

Use temporary directories:

1. repository root binding resolves;
2. nested directory inherits ancestor binding;
3. nearest nested binding overrides root binding;
4. explicit override wins;
5. malformed config rejected;
6. no config → unbound;
7. monorepo root/web/api bindings resolve independently.

---

## P0.4 Durable provider Session resolution

Implement a `ProviderSessionResolver` or equivalent application component.

Recommended input:

```ts
{
  provider: string;
  externalSessionId?: string;
  spaceId: string;
  agentId?: string;
}
```

### Required persistence semantics

Stable provider identity should resolve atomically by:

```text
(provider, externalSessionId)
→ one Memory Session with a frozen Session.spaceId
```

Add/verify a durable uniqueness constraint sufficient to prevent duplicate Memory Sessions when duplicate `session_start` events race.

If a Provider exposes Session IDs that are scoped to a workspace or another namespace, its adapter must canonicalize that namespace into `externalSessionId` before calling the common integration layer.

Do not implement this as an unsafe application-level:

```text
find
→ none
→ create
```

without a durable uniqueness/get-or-create boundary.

### Required behavior

- repeated identical provider SessionStart → same Memory Session;
- concurrent identical resolution → one durable Session;
- different provider → distinct Session;
- same external ID under different providers → distinct Session;
- same provider-native session already bound to a conflicting Space → explicit conflict, never silent rebind;
- provider with no external Session ID → create internal Session; no claim of resume identity unless later binding mechanism is added.

### Store changes

Extend the existing store port only with the minimum provider-session lookup/get-or-create primitive actually required.

Do not create a separate Provider database/store abstraction.

---

## P0.5 CheckpointPolicy

Implement shared integration checkpoint orchestration.

Conceptual API:

```ts
checkpointIfNeeded({
  sessionId,
  trigger
})
```

Supported trigger values:

```text
explicit
pre_compact
session_end
task_completed // optional capability only
```

### Required semantics

1. read Session checkpoint boundary;
2. find latest event for Session;
3. no new event → `noop`;
4. new event → derive stable idempotency key;
5. call existing `MemorySpace.checkpoint()` through latest event;
6. do not duplicate checkpoint transaction logic.

Stable identity must derive from logical inputs, conceptually:

```text
sessionId + trigger + toEventId
```

No random UUID idempotency key per hook delivery.

### Tests

- no events → noop;
- all events already checkpointed → noop;
- one/multiple new events → completed through latest event;
- repeated same trigger/boundary → no duplicate logical checkpoint;
- different trigger on an already committed boundary does not create meaningless empty checkpoint;
- checkpoint domain failure propagates to caller component for lifecycle/MCP policy to handle.

---

## P0.6 LifecycleHandler

Implement provider-independent lifecycle orchestration.

Recommended behavior matrix:

```text
session_start
→ resolve Space
→ resolve/create Memory Session
→ bootstrap
→ return integration result for Provider renderer

user_prompt
→ resolve existing provider Session
→ append message(role=user)

assistant_turn
→ resolve existing provider Session
→ append message(role=assistant)

pre_compact
→ checkpointIfNeeded(trigger=pre_compact)

session_end
→ checkpointIfNeeded(trigger=session_end)
```

### Message persistence

Use Conversation-lite semantics.

Minimum normalized payload:

```ts
{
  role: "user" | "assistant",
  content: string,
  contentMode: "full",
  transcriptRef?: TranscriptRef
}
```

Do not ingest arbitrary tool calls/results.

### Fail-open responsibility

Keep fail-open policy at the lifecycle transport/integration boundary, not inside durable domain operations.

`MemorySpace` must continue to throw on real domain failure. Lifecycle endpoint/adapter catches/logs/translates it so provider workflow can continue.

### Tests

- SessionStart returns Session + bootstrap;
- duplicate SessionStart reuses Session;
- user/assistant events preserve order;
- event payload has role/content/full mode;
- cwd changes after Session binding do not change Session.spaceId;
- PreCompact and SessionEnd use shared CheckpointPolicy;
- lifecycle wrapper can convert service failure into a non-blocking provider result.

---

## P0.7 Transcript port only

Add provider-neutral TranscriptRef/TranscriptReader contract, but do **not** build a complex transcript-assisted extraction pipeline in P0.

Recommended port:

```ts
interface TranscriptReader {
  supports(provider: string): boolean;
  read(ref: TranscriptRef, options?: TranscriptReadOptions): Promise<TranscriptChunk[]>;
}
```

P0 acceptance is contract + fake test implementation if needed.

Do not make every checkpoint read the transcript.

---

## P0 Stop Condition

P0 is complete when:

- all integration foundation tests pass;
- Memory Core imports no provider-specific adapter;
- monorepo nearest binding works;
- provider Session get-or-create is durable/race-safe;
- Conversation-lite event mapping works;
- CheckpointPolicy returns completed/noop correctly;
- `pnpm run check` passes.

Stop and review architecture before provider-specific expansion if implementation required changing frozen invariants.

---

# 5. P1 — MCP Command Plane

## Objective

Expose the frozen six-tool MCP surface over one shared provider-neutral MCP server/gateway.

Do not create one MCP server per provider.

Recommended location:

```text
src/mcp/
├── server.ts
├── tools.ts
└── request-context.ts
```

Keep files proportional to implementation size.

---

## P1.1 MCP request context

Support integration context containing:

```ts
{
  cwd?: string;
  sessionId?: string;
}
```

Resolution invariant:

```text
sessionId present
→ Session.spaceId authoritative
→ cwd cannot rebind Space

sessionId absent
→ SpaceResolver from request/runtime cwd
```

Do not expose `spaceId` as an agent-controlled tool argument.

---

## P1.2 `memory_bootstrap`

Input:

```ts
{ sessionId?: string }
```

Behavior:

- Session path uses `Session.spaceId`;
- no-Session path uses SpaceResolver;
- return stable model-consumable context and minimal metadata.

Tests:

- Session-bound bootstrap;
- cwd-bound bootstrap;
- unbound error;
- cwd conflicting with Session Space cannot override Session.

---

## P1.3 `memory_context`

Input:

```ts
{
  query: string;
  sessionId?: string;
  maxItems?: number;
}
```

Use existing MemorySpace context/search semantics rather than creating a new retrieval engine.

Return rendered context plus memory refs useful for observability.

Tests:

- Core and relevant Indexed recall;
- current Space isolation;
- no cross-Space leakage.

---

## P1.4 `memory_search`

Input:

```ts
{
  query: string;
  sessionId?: string;
  families?: MemoryFamily[];
  types?: string[];
  limit?: number;
}
```

Agent must not control:

```text
spaceId
tier
status
sourceSessionId
raw DB filters
```

Default behavior must search active Core + Indexed in current Space.

Tests:

- Indexed memory explicitly recoverable;
- no unrelated Space results;
- request cannot inject unsupported tier/status/space fields if strict schema is used.

---

## P1.5 `memory_remember`

Input:

```ts
{
  sessionId: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
}
```

Must not expose:

```text
spaceId
tier
status
actor
confidence
importance
sourceAgentId
sourceEventIds
```

Call existing `MemorySpace.remember()` using Session-derived Space/provenance as appropriate.

Tests:

- no session → validation error;
- remember persists Indexed;
- unknown/cross-Space Session rejected;
- direct tier/status/actor spoof rejected by tool schema/boundary.

---

## P1.6 `memory_promote`

Input:

```ts
{
  sessionId: string;
  memoryId: string;
  reason: string;
}
```

Gateway enforces:

```text
actor = agent
```

Required validation:

- Session exists;
- target Memory belongs to Session Space;
- reason required;
- provider/agent cannot submit actor/tier/force.

Tests:

- eligible promotion succeeds;
- ineligible promotion rejected by domain policy;
- cross-Space memory ID rejected;
- actor spoof impossible.

---

## P1.7 `memory_checkpoint`

Input:

```ts
{ sessionId: string }
```

Route exclusively through shared `CheckpointPolicy` with trigger `explicit`.

Return:

```text
completed
or
noop:no_uncommitted_events
```

Tool must not expose:

```text
toEventId
fromEventId
idempotencyKey
trigger
```

Tests:

- no new event → noop;
- new events → completed;
- repeated explicit call → noop/idempotent behavior;
- no direct boundary injection.

---

## P1.8 MCP error envelope

Translate stable domain/integration failures into an MCP-level error contract.

At minimum distinguish:

```text
SESSION_NOT_FOUND
SPACE_NOT_BOUND
SPACE_BINDING_CONFLICT
MEMORY_NOT_FOUND
VALIDATION_ERROR
PROMOTION_REJECTED / domain equivalent
CORE_CAPACITY_REACHED / domain equivalent
MEMORY_SERVICE_UNAVAILABLE
```

Do not expose raw SQLite errors as the intended public tool contract.

### Fail-visible

An MCP tool must not silently succeed if the operation failed.

---

## P1 Stop Condition

P1 is complete when:

- exactly six intended domain tools are available;
- no raw CRUD tool exists;
- durable writes require Session;
- agent cannot pass `spaceId`;
- remember cannot create Core directly;
- promote actor is fixed to agent;
- checkpoint internals are hidden;
- `pnpm run check` passes.

---

# 6. P2 — Codex Provider Integration

**Implementation status:** The native hook bridge, daemon lifecycle route,
bootstrap injection, Conversation-lite capture, fail-open behavior, and Codex
lifecycle eval are implemented and pass automated validation. A real Codex
smoke has not yet been recorded, so P2 is not Frozen and P3 has not started.

## Objective

Implement the first real provider adapter and prove automatic lifecycle integration against the common P0/P1 foundation.

Provider-specific implementation belongs under:

```text
src/adapters/providers/codex/
```

Recommended modules only when justified by actual code size:

```text
adapter.ts
bootstrap-renderer.ts
transcript-reader.ts
```

---

## P2.1 Codex native event normalization

Map supported native lifecycle inputs to common events:

```text
SessionStart    → session_start
UserPromptSubmit → user_prompt
Stop/final turn → assistant_turn when reliable final content is available
PreCompact      → pre_compact
SessionEnd      → session_end
```

Do not ingest PreToolUse/PostToolUse into SessionEvent by default.

If native assistant final content is not reliably available from the chosen hook payload, document the limitation and preserve TranscriptRef rather than inventing content.

---

## P2.2 Codex bootstrap injection

On SessionStart:

```text
native payload
→ CodexAdapter.normalize
→ LifecycleHandler session_start
→ SpaceResolver
→ ProviderSessionResolver
→ MemorySpace.bootstrap
→ Codex bootstrap renderer
→ provider-native additional context/output
```

Injected context must include the opaque internal Memory Space `sessionId` plus Memory bootstrap context.

Do not expose or require the agent to reason about `spaceId`.

---

## P2.3 Codex lifecycle fail-open

Memory service failures in Codex lifecycle handling must:

- produce warning/diagnostic output when possible;
- allow Codex workflow to continue;
- never report a durable Memory write/checkpoint as successful when it was not.

Tests should use a fake/failing Memory integration dependency where practical.

---

## P2.4 Transcript reference

Capture a provider-neutral `TranscriptRef` if Codex exposes a durable transcript/session locator.

Do not read/copy the full transcript automatically in every hook.

A Codex TranscriptReader may be implemented if sufficiently stable/needed for the acceptance eval, but transcript-assisted extraction is not required to block P2 if Conversation-lite evidence is sufficient.

---

## P2.5 Codex integration eval

Create an automated fixture/eval that approximates native payloads without requiring interactive Codex in CI.

Validate:

1. SessionStart creates/binds Session;
2. duplicate start reuses it;
3. user/assistant turns append normalized events;
4. PreCompact checkpoint runs only with uncommitted events;
5. SessionEnd with no new events no-ops;
6. bootstrap includes Core + latest Handoff;
7. changing cwd after binding does not migrate Space.

Also document a manual real-Codex smoke-test procedure.

---

## P2 Stop Condition

P2 is complete when one real Codex session can be manually configured to:

```text
start
→ receive Memory bootstrap
→ use shared MCP tools
→ persist conversation-lite events
→ checkpoint automatically on supported lifecycle boundary
→ resume without duplicate provider Session
```

and automated adapter/integration tests pass.

---

# 7. P3 — Claude Code Provider Integration

## Objective

Prove the Provider Contract is not Codex-specific.

Do **not** redesign the common integration model to exploit Claude-only hooks.

---

## P3.1 Claude native normalization

Map common lifecycle capabilities to the same common event set:

```text
SessionStart
UserPromptSubmit
assistant/final turn hook
PreCompact
SessionEnd
```

Provider-specific hooks such as task completion may remain adapter-local and disabled by default.

Do not make `task_completed` a required capability.

---

## P3.2 Bootstrap/session behavior

Same semantics as Codex:

- nearest Space binding at first Session resolution;
- provider external identity maps to one internal Session;
- Session Space frozen;
- opaque internal session handle injected where provider supports startup context;
- same shared MCP server/tool surface.

---

## P3.3 Claude transcript reference

Capture provider-neutral reference; optional reader implementation as appropriate.

No full transcript replication.

---

## P3.4 Adapter parity tests

Run common provider contract tests against both Codex and Claude adapters where practical.

A provider capability absent from one adapter must not cause common-contract failure unless it is a required v1 capability for that provider integration target.

---

## P3 Stop Condition

P3 is complete when Claude Code can use the same Memory Space daemon/MCP tools and automatic lifecycle flow without Codex-specific branches leaking into `MemorySpace` or MCP contracts.

---

# 8. P4 — Cross-provider Durable Eval

## Objective

Prove the actual product promise: cross-provider Handoff and progressive recall.

Use a persistent SQLite temp database and two distinct provider sessions.

---

## Required eval scenario

### Session A — Codex

```text
Bind working directory → Space X
Start Codex Session A
Append user/assistant Conversation-lite events
Remember one low-level Indexed detail
Remember/promote one project-wide Core item
Checkpoint through latest event
Close/reopen durable store if possible
```

Example semantic content:

```text
Core decision:
"Use PostgreSQL as the production database"

Indexed detail:
"Migration helper lives in scripts/db/migrate.ts"
```

### Session B — Claude Code

```text
Same Space binding
Different provider native Session
Start Claude Session B
Bootstrap
```

Assert:

- Core decision appears in default bootstrap;
- latest Handoff points to Session A checkpoint;
- Indexed migration detail is absent from default bootstrap;
- `memory_context`/`memory_search` can recover Indexed detail;
- Session B is distinct from Session A;
- no provider-specific object is required by Memory Core.

### Reverse direction

If implementation cost is low, repeat:

```text
Claude Session → checkpoint → Codex Session bootstrap/recall
```

This is recommended but may follow the first cross-provider proof.

---

# 9. P5 — Cursor MCP-first Validation (Optional after v1 proof)

Cursor should initially consume the common MCP Command Plane.

Do not implement polling/wrapper lifecycle emulation merely to claim parity.

Minimum validation:

- project Space resolution works;
- shared MCP server is usable;
- bootstrap/context/search/remember/promote/checkpoint tools work;
- limitations in automatic lifecycle capture are documented as capability differences.

Only deepen Cursor lifecycle integration if a stable native lifecycle mechanism is selected later.

---

# 10. Suggested Test Layout

Do not mechanically create every file below if existing test organization is better; preserve current repository conventions.

Conceptual coverage:

```text
test/
├── provider-space-resolver.test.ts
├── provider-session-resolver.test.ts
├── provider-lifecycle.test.ts
├── provider-checkpoint-policy.test.ts
├── mcp-tools.test.ts
├── provider-codex.test.ts
├── provider-claude.test.ts
└── ... existing MVP tests

eval/
├── provider-codex-handoff.test.ts
└── cross-provider-handoff.test.ts
```

Keep durable reopen eval separate from only in-memory tests.

---

# 11. Required Regression Matrix

| Scenario | Expected |
|---|---|
| nearest nested config | nearest Space wins |
| explicit Space override | override wins |
| no binding | stable `SPACE_NOT_BOUND` behavior |
| same provider native session start twice | same internal Session |
| concurrent duplicate native session resolution | one durable Session |
| same provider session presented under different Space | conflict |
| provider session changes cwd after bind | Space unchanged |
| user prompt | one normalized user SessionEvent |
| assistant final turn | one normalized assistant SessionEvent/full mode |
| tool calls | not persisted by default |
| pre_compact without new event | checkpoint noop |
| pre_compact with new event | checkpoint completed |
| repeated lifecycle delivery | no duplicate logical checkpoint |
| MCP search | active Core + Indexed searchable |
| MCP remember | Indexed only |
| MCP promote actor spoof | impossible/rejected |
| MCP checkpoint boundary injection | impossible/rejected |
| lifecycle Memory outage | provider flow fail-open |
| explicit MCP Memory outage | fail-visible |
| Codex → Claude same Space | Handoff visible |
| Codex Indexed detail → Claude bootstrap | hidden |
| Codex Indexed detail → Claude explicit recall | recoverable |
| all existing MVP tests | remain green |

---

# 12. Security / Trust Tests

At minimum add tests proving that provider-originated/native payloads cannot bypass trust policy.

Required cases:

```text
Provider payload includes:
recommendedTier = core
actor = user
tier = core
force = true
```

Expected:

- fields remain untrusted provider evidence;
- they do not become privileged Memory commands;
- MCP schemas do not expose privileged fields;
- only existing `MemorySpace` promotion policy can create/retain Core.

Do not build full prompt-injection detection in this phase.

---

# 13. Observability Minimum

Do not build a dashboard, but make debugging possible.

Recommended structured diagnostics/log fields:

```text
provider
externalSessionId
memorySessionId
spaceId
lifecycleEventType
checkpointTrigger
checkpointResult: completed | noop | failed
bindingSource
```

Never log secrets/credentials.

Avoid logging complete conversation content by default in operational logs; SessionEvents already persist normalized content.

---

# 14. Manual Developer Workflow Target

By the end of v1, desired local workflow should conceptually be:

```bash
memory-space server

cd repo/apps/web
# .memory-space/config.json exists

codex
```

SessionStart should automatically bind and inject context when the provider adapter is installed/configured.

The agent should then be able to use:

```text
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

A later setup command such as:

```bash
memory-space init
memory-space provider install codex
memory-space provider install claude
memory-space doctor
```

is desirable product UX but not required for the core v1 implementation unless specifically added in a later plan.

---

# 15. Phase Review Checklist

At the end of each phase, Coding Agent must report:

1. files changed;
2. public types/contracts added or changed;
3. persistence/schema changes;
4. tests added;
5. `pnpm run check` result;
6. manual validation performed;
7. frozen Spec invariant changes, if any;
8. known limitations;
9. what is intentionally deferred to the next phase.

If a frozen invariant was changed, report explicitly:

```text
Original invariant
Implemented change
Why the original could not be preserved
Compatibility impact
Alternative considered
```

---

# 16. Definition of Done — Provider Integration v1

Provider Integration v1 is done when:

### Architecture

- Memory Core remains provider-agnostic;
- provider lifecycle and MCP command planes are separated;
- common Provider Contract is capability-based;
- provider adapters only normalize/render provider-native concerns.

### Binding

- explicit + nearest ancestor Space binding works;
- monorepo nested Spaces work;
- Session Space freezes after initial provider binding;
- duplicate/resumed native Sessions resolve durably and safely.

### Conversation evidence

- Conversation-lite user/assistant events persist;
- assistant final content is full by default;
- raw tool traces are not ingested by default;
- TranscriptRef is provider-neutral and does not require full transcript replication.

### Checkpoint

- explicit/PreCompact/SessionEnd share one policy;
- no empty checkpoint is created;
- logical hook retries are idempotent;
- existing durable checkpoint guarantees remain intact.

### MCP

- six intended domain tools exist;
- no raw CRUD surface exists;
- durable writes require Session;
- agent cannot supply Space/tier/actor/checkpoint internals;
- errors are fail-visible and stable enough for agent use.

### Provider proof

- Codex integration works;
- Claude Code integration works;
- Cross-provider durable Handoff eval passes;
- Indexed detail remains on-demand rather than default-exposed.

### Quality

```bash
pnpm run check
```

passes, and existing MVP durable evals remain green.

---

# 17. Stop Condition

After the Cross-provider Eval passes, stop Provider Integration v1.

Do not immediately expand into:

```text
advanced provider automation
all tool-event capture
full transcript ingestion
Space federation
team auth
remote sync
vector retrieval
distributed checkpoint ownership
UI dashboard
```

Select the next phase based on observed integration/eval pain rather than speculative architecture.
