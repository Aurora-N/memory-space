# Provider Integration v1 Specification

**Status:** Frozen for implementation  
**Scope:** Provider Integration v1  
**Target branch:** `agent/provider-integration-v1`  
**Depends on:** Frozen Memory Space MVP domain model, CR-PHASE1, CR-PHASE2

**Normative guardrails:** [`./PROVIDER_INTEGRATION_GUARDRAILS.md`](./PROVIDER_INTEGRATION_GUARDRAILS.md)

---

## 1. Purpose

Provider Integration v1 turns Memory Space from a standalone memory service into a provider-agnostic runtime that real coding agents can use across sessions and across providers.

The primary product proof is not that one provider can call a memory API. It is:

```text
Provider A / Session A
        ↓
     Space X
        ↓
 durable Memory + Checkpoint + Handoff
        ↓
Provider B / Session B
        ↓
bootstrap + recall
        ↓
continue the same project with relevant prior context
```

The first end-to-end target is:

```text
Codex Session A
        ↓
Memory Space
        ↓
Claude Code Session B
```

The inverse direction should also be possible once both adapters are implemented.

---

## 2. Architectural Principle

Provider integration is split into two planes.

```text
                         Agent Provider
                  Codex / Claude / Cursor
                       /             \
                      /               \
             Lifecycle Plane      Command Plane
              Provider Hooks            MCP
                      \               /
                       \             /
                    Provider Integration
                            ↓
                        MemorySpace
                            ↓
                         Store
```

### 2.1 Lifecycle Plane

Provider-specific lifecycle hooks are responsible for automatic integration behavior:

- resolving/binding a provider session;
- bootstrap injection at session start when supported;
- normalized conversation event capture;
- automatic checkpoint triggers such as `pre_compact` and `session_end`.

Lifecycle integration must be **fail-open**. Memory Space failure must not prevent the coding agent from starting, compacting, or ending its session.

### 2.2 Command Plane

MCP exposes explicit domain operations to the agent:

- bootstrap;
- contextual recall;
- exact/low-level search;
- remember;
- promote;
- checkpoint.

Explicit MCP tool failures are **fail-visible**. The tool should return a stable domain/integration error rather than silently pretending success.

### 2.3 Core Isolation

`MemorySpace` must remain provider-agnostic.

Forbidden dependency direction:

```text
MemorySpace
    ↓
CodexAdapter / ClaudeAdapter / CursorAdapter
```

Required direction:

```text
Provider Adapter
       ↓
Provider Integration
       ↓
MemorySpace
```

Provider-specific native payloads must not enter Memory Core directly.

---

## 3. Non-goals

Provider Integration v1 does **not** include:

- distributed checkpoint ownership / lease system;
- multi-process durable-store coordination;
- CRDT or semantic conflict merge;
- provider auth / user auth;
- team-shared remote deployment semantics;
- vector search / embeddings;
- full raw tool-event ingestion;
- full transcript replication;
- autonomous compaction engine;
- dashboard / visualization;
- Cursor lifecycle emulation through polling/wrappers;
- multi-Space Session inheritance/federation;
- automatic Git remote → Space identity;
- automatic Space creation based on repository identity.

The MVP execution limitation remains authoritative: one active `MemorySpace` process per durable store.

---

# 4. Provider Contract

## 4.1 Capability-based Provider Adapter

Provider adapters are capability-based rather than requiring every provider to implement the same complete lifecycle API.

```ts
export type ProviderCapability =
  | "session_identity"
  | "session_start"
  | "user_prompt"
  | "assistant_turn"
  | "pre_compact"
  | "session_end"
  | "bootstrap_injection"
  | "mcp";
```

Provider-specific capabilities may be added later without changing the common minimum lifecycle contract.

Examples of optional provider-specific capabilities that must not become v1 requirements:

```text
task_created
task_completed
file_changed
teammate_idle
post_tool_use
```

Recommended provider interface:

```ts
export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;

  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null;

  renderBootstrap?(
    input: ProviderBootstrapRenderInput
  ): ProviderBootstrapOutput;
}
```

### ProviderAdapter responsibilities

ProviderAdapter may:

- validate/normalize provider-native hook payloads;
- extract native session identity;
- extract `cwd`;
- extract transcript reference information;
- translate bootstrap result into provider-native hook output.

ProviderAdapter must not:

- read/write SQLite directly;
- mutate Memory tiers directly;
- generate Memory rows directly;
- bypass `MemorySpace` domain operations;
- treat provider supplied candidate-like fields as privileged MemoryCandidate output;
- decide final Core eligibility.

---

# 5. Provider Lifecycle Event Contract

`ProviderLifecycleEvent` belongs to the Provider Integration domain, not the Memory domain.

Recommended base shape:

```ts
export interface ProviderEventBase {
  provider: string;
  externalSessionId?: string;
  cwd?: string;
  occurredAt?: string;
  transcriptRef?: TranscriptRef;
}
```

v1 lifecycle event set:

```ts
export type ProviderLifecycleEvent =
  | ProviderSessionStartEvent
  | ProviderUserPromptEvent
  | ProviderAssistantTurnEvent
  | ProviderPreCompactEvent
  | ProviderSessionEndEvent;
```

Conceptually:

```ts
interface ProviderSessionStartEvent extends ProviderEventBase {
  type: "session_start";
}

interface ProviderUserPromptEvent extends ProviderEventBase {
  type: "user_prompt";
  content: string;
}

interface ProviderAssistantTurnEvent extends ProviderEventBase {
  type: "assistant_turn";
  content: string;
}

interface ProviderPreCompactEvent extends ProviderEventBase {
  type: "pre_compact";
}

interface ProviderSessionEndEvent extends ProviderEventBase {
  type: "session_end";
}
```

Important invariant:

> `ProviderLifecycleEvent` is not `SessionEvent`.

Provider lifecycle events may trigger integration actions that do not persist as SessionEvents.

---

# 6. Space Binding

## 6.1 Binding model

Space binding is explicit/project-local rather than inferred from Git identity.

Default project binding file:

```text
.memory-space/config.json
```

v1 shape:

```json
{
  "version": 1,
  "spaceId": "sp_xxx"
}
```

No credential or secret is stored in this file.

Server endpoint/auth settings, when needed, belong in environment/global configuration rather than the project Space identity file.

## 6.2 Resolution precedence

Space resolution order is frozen as:

```text
1. Explicit override
2. Nearest ancestor .memory-space/config.json
3. No binding
```

Explicit override may be supplied through integration runtime configuration/environment.

Git remote, repo root, package manager workspace, and repository name are not authoritative Space identity in v1.

## 6.3 Nearest binding wins

Monorepos are supported by nearest-ancestor binding.

Example:

```text
monorepo/
├── .memory-space/config.json       → Space: repository-global
├── apps/
│   └── web/
│       └── .memory-space/config.json → Space: web
└── services/
    └── api/
        └── .memory-space/config.json → Space: api
```

Running from `apps/web` resolves `web`; running from `services/api` resolves `api`; running from repository root resolves the repository-global Space.

Binding path hierarchy does **not** create Memory Space inheritance.

```text
filesystem hierarchy != Space hierarchy
```

Spaces remain independent first-class domains.

## 6.4 Space binding freezes at Session creation

Critical invariant:

> Space is resolved once when the provider session is first bound to a Memory Space Session. That Space must not change for the lifetime/resume identity of the same provider session.

After Session creation:

```text
(provider, externalSessionId)
        ↓
existing Memory Session
        ↓
Session.spaceId
```

is authoritative.

`cwd` participates in Space resolution only when the provider-native identity
is first bound to a Memory Session.

After that binding exists, later lifecycle events and repeated SessionStart
deliveries MUST resolve the existing provider Session before considering
filesystem-derived binding. A changed `cwd`, including a cwd that would resolve
to another nearest-ancestor `.memory-space/config.json`, MUST NOT migrate,
rebind, or conflict with the existing Session.

A trusted explicit Space override is different from cwd-derived runtime
evidence. If a trusted `explicitSpaceId` is supplied for an already-bound
provider Session and it does not match `Session.spaceId`, integration MUST
return an explicit Space binding conflict rather than silently migrate the
Session.

---

# 7. Session Binding

## 7.1 Hybrid identity

Memory Space owns its internal Session identity.

```ts
Session {
  id: string;
  spaceId: string;
  provider?: string;
  externalSessionId?: string;
  ...
}
```

Provider native session IDs are external identifiers, not primary Memory Space IDs.

## 7.2 Resolution semantics

When a stable provider native session ID is available:

```text
(provider, externalSessionId)
             ↓
      one Memory Session

Memory Session.spaceId
             ↓
frozen for that provider-native identity
```

Durable uniqueness invariant:

```text
UNIQUE(provider, external_session_id)
```

Resolution must be atomic/get-or-create safe against duplicate session-start delivery.

If a Provider's native Session IDs are only unique inside another namespace or workspace, its adapter must canonicalize the external ID before normalization, for example `workspace-x:session-123`. The common integration layer does not weaken identity or create multiple Memory Sessions for the same canonical provider-native identity across Spaces.

When the provider has no stable external session ID, integration may create an internal Memory Space Session and surface the opaque internal `sessionId` to the agent/provider integration context.

## 7.3 Session handle injection

At session start, the integration should inject a minimal memory control envelope when the provider supports bootstrap injection.

Conceptually:

```text
<memory_space>
Session: ses_123
Persistent project memory is available through MCP tools.
Use memory_context for relevant prior project context.
Use memory_remember for durable information.
Use memory_promote only for project-wide working context.
</memory_space>

# Space Context
...
```

The agent does not need to know or supply `spaceId`.

The `sessionId` is an opaque handle.

---

# 8. SessionEvent Strategy

## 8.1 Frozen strategy: Conversation-lite

Provider Integration v1 persists normalized conversation turns, not the complete provider execution trace.

Persist by default:

```text
UserPrompt
→ SessionEvent.message(role=user, full content)

Assistant final turn
→ SessionEvent.message(role=assistant, full content by default)

Explicit Memory operation
→ Memory domain operation / relevant memory event semantics
```

Do not persist by default:

```text
PreToolUse
PostToolUse
individual shell commands
shell stdout/stderr
grep/read-file events
raw tool results
full file diffs
provider internal traces
```

Tool-event ingestion may be introduced later only after evidence shows it improves extraction/recall quality enough to justify noise and cost.

## 8.2 Normalized message payload

Recommended payload:

```ts
export interface MessageEventPayload {
  role: "user" | "assistant";
  content: string;
  contentMode: "full" | "compressed" | "summary";
  originalLength?: number;
  truncated?: boolean;
  transcriptRef?: TranscriptRef;
  compression?: {
    reason: "size_limit" | "user_request" | "auto_summary";
    algorithm?: string;
    compressedAt: string;
  };
}
```

v1 may implement only `contentMode: "full"`, but the persisted shape must not block later compression/summary behavior.

---

# 9. Assistant Content and Compression

## 9.1 Default behavior

Assistant final turns are stored in full by default.

No automatic summary is required for v1.

## 9.2 Future-compatible compression policy

Compression may occur later when:

- persisted content reaches configured storage/context limits;
- the user explicitly requests compression;
- the user opts into automatic summarization.

Automatic summarization is opt-in, not default.

Compression is a separate lifecycle concern from Checkpoint.

```text
Checkpoint
= SessionEvent → durable Memory

Compression
= historical SessionEvent storage/context optimization
```

Checkpoint must not implicitly become the Session compression engine.

## 9.3 Transcript preserves richer evidence

Compressed/summary SessionEvents do not imply that original provider evidence must be destroyed. When a transcript reference remains valid, richer source evidence may still be retrieved on demand.

---

# 10. Transcript Contract

## 10.1 Transcript role

Frozen invariant:

> SessionEvent is primary normalized evidence. Provider Transcript is supplementary richer evidence.

Memory Space does not copy the full provider transcript into its durable SessionEvent store by default.

## 10.2 TranscriptRef

Do not model this as only a filesystem path.

Recommended provider-neutral reference:

```ts
export interface TranscriptRef {
  provider: string;
  locator: string;
  externalSessionId?: string;
  cursor?: string;
  updatedAt?: string;
}
```

`locator` is opaque to Memory Core.

Possible implementations include local transcript paths, provider resource identifiers, or future remote/API-backed references.

## 10.3 TranscriptReader Port

```ts
export interface TranscriptReader {
  supports(provider: string): boolean;

  read(
    ref: TranscriptRef,
    options?: TranscriptReadOptions
  ): Promise<TranscriptChunk[]>;
}
```

Provider-specific implementations may include:

```text
CodexTranscriptReader
ClaudeCodeTranscriptReader
```

## 10.4 Read policy

v1 default policy is conceptually:

```ts
{
  mode: "fallback"
}
```

Supported future modes:

```text
disabled
fallback
always
```

Checkpoint must not read the complete transcript on every invocation by default.

Preferred behavior:

```text
normalized SessionEvents
        ↓
normal extraction path
        ↓
only if richer evidence is needed/supported
        ↓
TranscriptReader with bounded range
```

Provider Integration v1 does not require transcript-assisted extraction to be implemented in the first foundation milestone. The contract is frozen now so later support does not require redesigning Session/Event identity.

---

# 11. Lifecycle → SessionEvent / Action Mapping

Frozen v1 mapping:

| Provider lifecycle event | Memory Space behavior |
|---|---|
| `session_start` | resolve Space; resolve/create Session; bootstrap; optionally inject context |
| `user_prompt` | append normalized user `SessionEvent.message` |
| `assistant_turn` | append normalized assistant `SessionEvent.message` |
| `pre_compact` | `checkpointIfNeeded(trigger=pre_compact)` |
| `session_end` | `checkpointIfNeeded(trigger=session_end)` |

`session_start`, `pre_compact`, and `session_end` do not need to become durable SessionEvents merely because hooks fired.

Provider-specific events such as `task_completed` may later call the common checkpoint policy but are optional capabilities and disabled by default in v1.

---

# 12. Checkpoint Trigger Policy

## 12.1 Supported automatic/explicit triggers

v1:

```text
Explicit MCP checkpoint      → enabled
PreCompact                   → enabled
SessionEnd                   → enabled
TaskCompleted                → optional / disabled by default
Assistant Stop               → no checkpoint
Idle timer                   → no checkpoint
Periodic timer               → no checkpoint
```

## 12.2 No empty checkpoint

All integration-driven checkpoints must go through one shared policy:

```ts
checkpointIfNeeded({ sessionId, trigger })
```

Semantic rule:

```text
latest SessionEvent == Session.lastCheckpointEventId
→ noop

new uncommitted SessionEvent exists
→ checkpoint through latest event
```

Do not create empty Checkpoints/Handoff snapshots for lifecycle noise.

## 12.3 Integration-level idempotency key

Providers/agents must not generate checkpoint idempotency keys directly.

Gateway/policy derives a stable key from logical identity, e.g.:

```text
sessionId + trigger + toEventId
```

The specific serialization/hash format is internal.

Repeated delivery of the same provider lifecycle event must resolve to the same logical checkpoint identity.

Explicit MCP checkpoint should similarly derive identity from:

```text
explicit + sessionId + latestEventId
```

## 12.4 Trigger metadata

Recording checkpoint trigger is recommended for observability:

```ts
type CheckpointTrigger =
  | "explicit"
  | "pre_compact"
  | "session_end"
  | "task_completed";
```

If adding a persisted `trigger` field causes unnecessary MVP-domain migration, it may be stored in integration metadata/history instead. Trigger metadata must not change Checkpoint identity semantics.

---

# 13. MCP Tool Contract

## 13.1 MCP surface

Provider Integration v1 exposes exactly these domain tools:

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

Do not expose raw CRUD, direct tier mutation, direct status mutation, candidate insertion, or checkpoint internals.

## 13.2 General request context

Internally MCP requests may have:

```ts
interface MCPRequestContext {
  cwd?: string;
  sessionId?: string;
}
```

Space resolution rule:

```text
if sessionId is supplied
→ Session.spaceId is authoritative
→ cwd MUST NOT rebind Space

else
→ explicit override / nearest ancestor project binding
```

## 13.3 Session requirement matrix

| Tool | `sessionId` | Space source |
|---|---|---|
| `memory_bootstrap` | optional | Session or binding resolver |
| `memory_context` | optional | Session or binding resolver |
| `memory_search` | optional | Session or binding resolver |
| `memory_remember` | required | Session.spaceId |
| `memory_promote` | required | Session.spaceId |
| `memory_checkpoint` | required | Session.spaceId |

All durable-state-producing MCP operations require a Session.

The agent never supplies `spaceId`.

---

## 13.4 `memory_bootstrap`

Input:

```ts
{
  sessionId?: string;
}
```

Behavior:

- with session: resolve through `Session.spaceId`;
- without session: resolve project Space from MCP request cwd/binding context;
- return deterministic Space bootstrap context.

Recommended output:

```ts
{
  space: {
    id: string;
    name: string;
  };
  session?: {
    id: string;
    provider?: string;
  };
  context: string;
  handoff?: {
    checkpointId: string;
    createdAt: string;
  };
}
```

Do not default to returning the entire internal Core Memory row set unless required by current application API compatibility.

---

## 13.5 `memory_context`

High-level recall tool intended for normal agent use.

Input:

```ts
{
  query: string;
  sessionId?: string;
  maxItems?: number;
}
```

Recommended output:

```ts
{
  context: string;
  memories: Array<{
    id: string;
    type: string;
    key?: string;
    tier: "core" | "indexed";
  }>;
}
```

The rendered context is model-consumable; memory references support debugging/observability.

---

## 13.6 `memory_search`

Low-level/exact recall tool.

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

Default search semantics:

```text
Space = resolved from Session or binding
status = active
tier = Core + Indexed
```

Search must include Indexed memory by default because explicit recall is the progressive-disclosure mechanism.

v1 agent input must not expose:

```text
spaceId
tier
status
sourceSessionId
raw storage filters
```

Recommended output exposes only useful stable fields:

```ts
{
  results: Array<{
    id: string;
    family: MemoryFamily;
    type: string;
    key?: string;
    content: string;
    tier: "core" | "indexed";
    score: number;
    updatedAt: string;
  }>;
}
```

---

## 13.7 `memory_remember`

Input:

```ts
{
  sessionId: string;
  family: "knowledge" | "state" | "episode" | "procedure";
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
}
```

Forbidden agent-controlled fields:

```text
spaceId
tier
status
actor
confidence
importance
sourceAgentId
sourceEventIds
version
```

Domain semantics remain:

```text
remember → Indexed by default
```

No MCP-level bypass may reintroduce direct Core creation.

---

## 13.8 `memory_promote`

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

The agent may not supply:

```text
actor
tier
force
```

The promotion remains subject to the frozen domain eligibility/capacity rules.

`sessionId` is required even if the current Core promotion API does not yet use it directly, so future provenance/observability can attribute the action without breaking the MCP contract.

---

## 13.9 `memory_checkpoint`

Input:

```ts
{
  sessionId: string;
}
```

The agent does not supply:

```text
toEventId
fromEventId
idempotencyKey
trigger
```

Gateway uses `CheckpointPolicy` with trigger `explicit`.

Recommended result:

```ts
type MemoryCheckpointOutput =
  | {
      status: "completed";
      checkpointId: string;
      committedThroughEventId: string;
    }
  | {
      status: "noop";
      reason: "no_uncommitted_events";
    };
```

A no-op must be explicit rather than pretending a new Checkpoint was created.

---

# 14. MCP / Integration Error Contract

Provider-native/SQLite/internal errors should not be leaked directly to the agent as the stable public MCP contract.

Recommended stable error envelope:

```ts
interface MCPError {
  code:
    | "SESSION_NOT_FOUND"
    | "SPACE_NOT_BOUND"
    | "SPACE_BINDING_CONFLICT"
    | "MEMORY_NOT_FOUND"
    | "VALIDATION_ERROR"
    | "PROMOTION_REJECTED"
    | "CORE_CAPACITY_REACHED"
    | "MEMORY_SERVICE_UNAVAILABLE";
  message: string;
  retryable: boolean;
}
```

P1 transport-boundary clarification:

```text
MCP protocol/schema validation failure
→ MCP SDK/protocol validation error

schema-valid domain/integration execution failure
→ stable MCPError structured tool result
```

Both cases are fail-visible. Strict tool schemas must not be weakened to force protocol-level validation failures through the domain error envelope. SQLite and unexpected internal failures remain hidden behind `MEMORY_SERVICE_UNAVAILABLE`.

The exact list may reuse existing domain error codes where already stable.

Invariant:

```text
Lifecycle integration failure → fail-open
Explicit MCP tool failure     → fail-visible
```

---

# 15. Internal Module Boundaries

Recommended structure:

```text
src/
├── application/
│   └── memory-space.ts
├── domain/
│   ├── types.ts
│   └── errors.ts
├── provider/
│   ├── types.ts
│   ├── provider-adapter.ts
│   ├── lifecycle-handler.ts
│   ├── session-resolver.ts
│   └── checkpoint-policy.ts
├── ports/
│   ├── store.ts
│   ├── cache.ts
│   ├── extractor.ts
│   └── transcript.ts
├── adapters/
│   ├── sqlite/
│   └── providers/
│       ├── codex/
│       │   ├── adapter.ts
│       │   ├── bootstrap-renderer.ts
│       │   └── transcript-reader.ts
│       └── claude-code/
│           ├── adapter.ts
│           ├── bootstrap-renderer.ts
│           └── transcript-reader.ts
├── binding/
│   └── space-resolver.ts
├── mcp/
│   ├── server.ts
│   ├── tools.ts
│   └── request-context.ts
├── http/
│   └── server.ts
├── composition.ts
└── index.ts
```

This is a directional guide, not a mandate to create empty files or one-file-per-15-lines abstractions.

Only abstractions with real polymorphism/replacement value should become ports/interfaces.

### Required responsibility boundaries

`SpaceResolver`
- resolves explicit/nearest ancestor project binding;
- does not create Session.

`ProviderSessionResolver`
- atomic provider-session get-or-create;
- enforces frozen Space binding;
- does not normalize provider-native payloads.

`LifecycleHandler`
- orchestrates normalized lifecycle actions;
- delegates Memory operations to `MemorySpace`;
- does not contain provider-native parsing.

`CheckpointPolicy`
- checks for uncommitted events;
- derives stable idempotency identity;
- invokes `MemorySpace.checkpoint()`;
- returns completed/noop semantics.

`ProviderAdapter`
- native payload normalization/bootstrap rendering only.

`TranscriptReader`
- provider-specific supplementary evidence retrieval.

`MCP Gateway`
- public domain tool contract;
- request context/session resolution;
- no raw CRUD exposure.

---

# 16. Provider Order

Implementation order is intentionally asymmetric:

```text
1. Provider Integration foundation
2. MCP command plane
3. Codex adapter
4. Claude Code adapter
5. Cross-provider eval
6. Cursor MCP-first integration
```

Codex first provides a concrete lifecycle target while keeping the common contract relatively small. Claude Code second validates that the contract is not Codex-specific. Cursor is treated MCP-first until lifecycle capabilities justify deeper automation.

No provider-specific capability may be promoted into the required Provider Contract solely because one provider supports it.

---

# 17. Trust Boundary

ADR 0003 remains authoritative.

Provider-native events are evidence/input, not privileged memory commands.

Forbidden flow:

```text
Provider payload says recommendedTier=core
              ↓
trusted candidate
              ↓
Core
```

Required conceptual boundary:

```text
Provider evidence
      ↓
normalized SessionEvent / trusted integration boundary
      ↓
extractor / explicit Memory command
      ↓
MemorySpace domain policy
      ↓
final tier/state
```

MCP `memory_promote` always acts as `actor=agent`; provider payloads cannot self-declare user authority.

---

# 18. Acceptance Scenario

Provider Integration v1 is considered product-valid when the following vertical slice passes against a persistent durable store:

```text
1. Bind repository/package to Space X.

2. Start Codex Session A.
   → Space X resolved.
   → provider session atomically resolves/creates Memory Session A.
   → Core + latest Handoff bootstrap is injected when supported.

3. User and assistant final turns become Conversation-lite SessionEvents.

4. Agent explicitly remembers Indexed detail and promotes an eligible project-wide item.

5. PreCompact, SessionEnd, or explicit MCP checkpoint commits uncommitted events.

6. End/resume boundary does not rebind Space if cwd changes.

7. Start Claude Code Session B from the same Space binding.
   → Memory Session B is distinct.
   → bootstrap exposes Core + latest Handoff from Session A.

8. Claude calls memory_context/search.
   → Indexed detail from Session A is recoverable on demand.

9. Indexed detail is not default-exposed merely because it exists.

10. Memory service lifecycle-hook failure does not block provider workflow.
```

---

# 19. Frozen Invariants Summary

```text
Provider Adapter is capability-based.

Command Plane = shared MCP.
Lifecycle Plane = provider-specific optional hooks.

Nearest ancestor Space binding wins.
Explicit override wins over project binding.
Filesystem nesting does not create Space inheritance.

Space is resolved once per provider Session and then frozen.
Session.spaceId is authoritative after binding.

Provider native session ID is external identity.
Memory Space owns internal Session ID.

SessionEvent strategy = Conversation-lite.
User prompt = full by default.
Assistant final turn = full by default.
Tool traces = not persisted by default.

Compression is independent from Checkpoint.
Automatic summarization is opt-in.

SessionEvent = primary normalized evidence.
Transcript = supplementary reference/on-demand evidence.

Explicit / PreCompact / SessionEnd checkpoint only when uncommitted events exist.
Assistant Stop does not checkpoint.
Idle/periodic checkpoint is out of v1.

Agent never supplies spaceId.
Durable MCP writes require sessionId.
remember cannot supply tier/status/actor.
promote cannot supply actor/tier/force.
checkpoint cannot supply event boundary/idempotency internals.

Lifecycle failures are fail-open.
Explicit MCP failures are fail-visible.

Provider evidence cannot self-declare trusted Core authority.
```

---

# 20. Change Control

Coding Agents implementing this specification must not silently alter these frozen contracts.

If implementation reveals a blocking incompatibility, report:

```text
Frozen invariant
Observed implementation constraint
Proposed change
Why an adapter/local workaround is insufficient
Compatibility impact
```

Do not broaden Provider Integration v1 scope without an explicit review decision.
