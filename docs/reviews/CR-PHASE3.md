# CR-PHASE3 — Provider Integration P0 Final Hardening

**Status:** Ready for implementation  
**Target branch:** `agent/provider-integration-v1`  
**Scope:** Provider Integration P0 correctness + contract alignment only  
**Next phase gate:** P1 MCP Command Plane must not start until this CR is complete.

---

## 1. Review conclusion

The P0 Provider Integration foundation is structurally sound. The following parts are already directionally correct and should be preserved:

- capability-based Provider contract;
- nearest-ancestor Space binding for monorepos;
- Space binding frozen after provider Session creation;
- durable provider Session get-or-create;
- Conversation-lite SessionEvent mapping;
- shared CheckpointPolicy;
- lifecycle fail-open wrapper;
- provider-neutral TranscriptReader port;
- cache get/set/delete treated as best-effort derived state.

This CR does **not** ask for MCP implementation, Codex/Claude adapters, transcript-assisted extraction, advanced concurrency, or new Memory-domain concepts.

The purpose is to close the remaining correctness and contract-boundary gaps before P0 is frozen.

---

# 2. Hard constraints

Do not use this CR to implement:

- P1 MCP tools/server;
- Codex provider adapter;
- Claude Code provider adapter;
- Cursor integration;
- transcript-assisted checkpoint extraction;
- Session compression engine;
- distributed checkpoint leases;
- Memory OCC / Space revision;
- auth / ACL;
- Redis / PostgreSQL;
- dashboard / observability UI;
- Space hierarchy or cross-Space inheritance.

Preserve the following frozen invariants:

```text
SessionEvent = primary normalized evidence
Transcript   = supplementary richer evidence

Provider lifecycle failure → fail-open
Explicit domain/MCP failure → fail-visible

Provider native identity is not allowed to silently rebind Space

One provider Session has one frozen Memory Session identity
```

---

# 3. Required fixes

## FIX-01 — Preserve full message content exactly

**Priority:** P1 blocker  
**Category:** Conversation fidelity / SessionEvent correctness

### Problem

`validateProviderLifecycleEvent()` currently validates `user_prompt` and `assistant_turn` content through the generic `requiredString()` helper.

That helper trims the value before returning it:

```ts
return value.trim();
```

As a result, normalized Conversation-lite events do not preserve the provider turn exactly.

Example:

```text
input:
"\n  keep indentation\n\n"

persisted:
"keep indentation"
```

This violates the frozen v1 contract:

```text
UserPrompt      → full content
Assistant final → full content by default
```

Leading/trailing newlines and whitespace can be meaningful for Markdown, source snippets, indentation-sensitive prompts, code blocks, generated patches, and other coding-agent content.

### Required behavior

Validation may use `.trim()` only to determine whether the content is effectively empty.

The persisted/normalized `content` must remain byte-for-byte/string-for-string equivalent to the supplied string.

Recommended pattern:

```ts
function requiredContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}
```

Keep identifier-like fields such as provider names, external Session IDs, cwd/config values, etc. free to use trimmed normalization where appropriate. Do not globally change every string validator to preserve whitespace.

### Regression tests

Add both normalized-event and durable-lifecycle coverage.

#### Normalization

```ts
const content = "\n  hello\n\n";
const event = validateProviderLifecycleEvent({
  type: "user_prompt",
  provider: "fake",
  content
});
assert.equal(event.content, content);
```

#### Persistence

```text
ProviderLifecycleEvent
→ LifecycleHandler
→ SessionEvent
```

Assert exact `payload.content` equality including leading/trailing whitespace/newlines.

Also retain rejection of:

```text
""
"   "
"\n\t"
```

---

## FIX-02 — Enforce strict Provider Session identity when using an internal session handle

**Priority:** P1 blocker  
**Category:** Session identity / trust boundary

### Problem

Current `LifecycleHandler.#resolveExistingSession()` validates external identity only if both the event and Session already have `externalSessionId` values.

Conceptually:

```ts
if (
  event.externalSessionId &&
  session.externalSessionId &&
  event.externalSessionId !== session.externalSessionId
) {
  throw ...
}
```

This allows an internal Session created without provider resume identity to later receive an event that suddenly asserts a provider-native external Session ID while using the internal `sessionId` handle.

Example:

```text
Session:
provider = fake
externalSessionId = undefined

later event:
provider = fake
externalSessionId = native-123
context.sessionId = internal-session-id

current behavior → accepted
```

That implicitly creates a new identity-binding mechanism which was explicitly deferred from P0.

A similar looseness exists for `provider`: a generic Session whose `provider` is undefined can currently be reused by a provider lifecycle event when addressed by internal `sessionId`.

### Required invariant

Once a provider Session is resolved/created, the Session identity tuple is authoritative.

For lifecycle events targeting an internal `sessionId`:

```text
event.provider MUST equal Session.provider
```

and, when the event supplies an external Session ID:

```text
event.externalSessionId MUST equal Session.externalSessionId
```

An internal Session without an external provider identity must not silently acquire one because a later event contains an ID.

If future provider identity attachment is needed, implement an explicit binding operation in a later phase. Do not smuggle it through lifecycle event resolution.

### Recommended behavior

Conceptually:

```ts
if (session.provider !== event.provider) {
  throw new ValidationError(
    "Provider lifecycle event does not match Session.provider"
  );
}

if (
  event.externalSessionId !== undefined &&
  event.externalSessionId !== session.externalSessionId
) {
  throw new ValidationError(
    "Provider lifecycle event does not match Session.externalSessionId"
  );
}
```

It is acceptable for an event to omit `externalSessionId` when the internal `sessionId` already identifies the Session.

### Regression tests

Add:

1. internal Session with `provider=fake`, no external ID + later event with `externalSessionId=native-1` → reject;
2. generic/core Session with no provider + provider lifecycle event addressed by internal Session ID → reject;
3. provider Session with matching provider and matching external ID → accept;
4. provider Session with matching provider and event omitting external ID → accept;
5. provider mismatch → reject;
6. external ID mismatch → reject.

---

## FIX-03 — Release the SQLite transaction barrier even when `BEGIN IMMEDIATE` fails

**Priority:** P1 blocker  
**Category:** Store robustness / local concurrency

### Problem

Current transaction structure is conceptually:

```ts
await previous;
this.database.exec("BEGIN IMMEDIATE");
try {
  ...
} finally {
  release();
}
```

If `BEGIN IMMEDIATE` throws, execution never enters the `try/finally`, so the newly installed barrier Promise is never released.

After that, later calls waiting through `#ready()` / `#barrier` may remain blocked indefinitely.

Provider Integration increases the number of concurrent lifecycle/store entry points, so this previously known MVP edge should be closed before P1.

### Required invariant

> Once a transaction invocation installs itself as the current local barrier, that barrier must always be released regardless of whether failure occurs during BEGIN, operation, COMMIT, or ROLLBACK.

### Recommended structure

Conceptually:

```ts
await previous;
let began = false;

try {
  this.database.exec("BEGIN IMMEDIATE");
  began = true;

  const result = await this.#transactionContext.run(true, operation);
  this.database.exec("COMMIT");
  return result;
} catch (error) {
  if (began) {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // preserve original transaction error
    }
  }
  throw error;
} finally {
  release();
}
```

Exact implementation may differ, but the release guarantee must hold.

Do not swallow the original transaction failure.

### Regression test

Create a deterministic test seam or controlled failure that makes transaction acquisition / `BEGIN IMMEDIATE` fail, then verify:

```text
first transaction fails
↓
barrier releases
↓
subsequent store operation does not hang behind the failed barrier
```

The test must fail fast rather than relying on a long real-time timeout.

Also keep existing nested transaction semantics and all checkpoint/provider-session concurrency tests green.

---

## FIX-04 — Align Provider Session identity documentation with the implemented frozen-Space invariant

**Priority:** P1 contract alignment  
**Category:** Spec drift

### Problem

Current Provider Integration documentation describes durable identity conceptually as:

```text
spaceId + provider + externalSessionId
→ one Memory Session
```

and recommends:

```sql
UNIQUE(space_id, provider, external_session_id)
```

The implementation instead uses:

```sql
UNIQUE(provider, external_session_id)
```

and then treats `Session.spaceId` as a frozen attribute, returning a conflict if the same native provider Session later appears under another Space.

The implementation is more consistent with the other frozen invariant:

> A provider native Session must not silently rebind to another Space when cwd/binding changes.

If uniqueness includes `spaceId`, the same provider-native ID could create two durable Memory Sessions under two Spaces, defeating the frozen-Space guarantee.

### Required decision

Keep the stronger current implementation semantics and update the Provider Integration documents.

Freeze identity as:

```text
(provider, externalSessionId)
→ one Memory Session

Memory Session.spaceId
→ immutable/frozen binding for that provider-native Session identity
```

If a future Provider exposes IDs that are only unique inside another namespace/workspace, the **Provider adapter must namespace/canonicalize the external ID** before handing it to the common integration layer.

Example:

```text
workspace-x:session-123
```

Do not weaken the core identity contract merely to model provider-specific namespace rules.

### Required documentation changes

Update at least:

- `docs/specs/PROVIDER_INTEGRATION_SPEC.md`;
- `docs/plans/PROVIDER_INTEGRATION_PLAN.md`.

Remove contradictory recommendations for triple uniqueness.

Ensure all examples, acceptance criteria, and concurrency text agree with the implemented semantics.

### Verification

Search documentation for variants of:

```text
spaceId + provider + externalSessionId
UNIQUE(space_id, provider, external_session_id)
```

and ensure no stale contradictory normative statement remains.

---

## FIX-05 — Validate TranscriptRef provenance consistency

**Priority:** P2, required before P0 freeze  
**Category:** Evidence provenance / future transcript safety

### Problem

Normalized events currently validate `TranscriptRef` shape independently but do not ensure that its provider/session identity agrees with the lifecycle event carrying it.

A malformed normalized event can conceptually contain:

```ts
{
  type: "user_prompt",
  provider: "codex",
  externalSessionId: "codex-session",
  transcriptRef: {
    provider: "claude-code",
    externalSessionId: "other-session",
    locator: "..."
  }
}
```

P0 does not yet read transcript evidence during checkpoint extraction, so this is not currently an active data-read bug. However it would become a provenance bug immediately when provider-specific TranscriptReaders are introduced.

### Required invariant

When a lifecycle event contains `transcriptRef`:

```text
transcriptRef.provider === event.provider
```

When both values are available:

```text
transcriptRef.externalSessionId === event.externalSessionId
```

A TranscriptRef may omit `externalSessionId` if the provider reference format does not require it.

Do not parse or interpret `locator` in the common layer. It remains opaque.

### Regression tests

Add:

1. provider mismatch → reject;
2. externalSessionId mismatch when both present → reject;
3. matching provider/session → accept;
4. matching provider with TranscriptRef external ID omitted → accept.

---

## FIX-06 — Ensure the fail-open diagnostic sink cannot make lifecycle integration fail closed

**Priority:** P2, required before P0 freeze  
**Category:** Failure containment

### Problem

`handleFailOpen()` returns a non-blocking warning after catching lifecycle/memory failures, but invokes optional `onWarning` before returning.

If the logging/diagnostic callback itself throws, the fail-open wrapper can still reject and therefore block the provider workflow.

Conceptually:

```text
memory integration fails
→ handleFailOpen catches
→ onWarning throws
→ lifecycle call rejects
```

This violates:

```text
Lifecycle integration failure → fail-open
```

### Required behavior

Diagnostic/telemetry sinks are non-authoritative.

An `onWarning` callback failure must not replace the original warning result and must not make the lifecycle integration fail closed.

Recommended pattern:

```ts
try {
  this.onWarning?.({ event, error, warning });
} catch {
  // diagnostics must not break fail-open lifecycle behavior
}

return warning;
```

A future observability system may count diagnostic sink failures separately; do not add such infrastructure in P0.

### Regression test

Inject an `onWarning` callback that throws and verify `handleFailOpen()` still resolves to the expected non-blocking warning.

---

# 4. Architecture cleanup

## ARCH-01 — Stop treating `memorySpace.store` as a long-term application-layer escape hatch

**Priority:** P2 / architecture hygiene  
**Blocking P1:** No, unless the cleanup is trivial

### Current observation

Integration components currently perform persistence-oriented queries through public access to:

```ts
memorySpace.store
```

Examples include provider-session get-or-create and latest-event lookup in CheckpointPolicy.

Functionally this works, but it creates an architectural path:

```text
Integration component
→ MemorySpace
→ public .store
→ persistence internals
```

which can become an attractive bypass once MCP and provider adapters are added.

### Acceptable directions

Choose one small direction; do not perform a large refactor.

#### Option A — Explicitly inject the Store port where integration persistence is genuinely needed

Example:

```ts
new ProviderSessionResolver(memorySpace, store)
new CheckpointPolicy(memorySpace, store)
```

or equivalent constructor dependency shapes.

This is appropriate because provider Session atomic identity resolution is itself persistence-oriented integration behavior, and the Store port was intentionally extended for it.

#### Option B — Add minimal application-level queries

For example:

```ts
MemorySpace.findLatestSessionEvent(...)
MemorySpace.resolveProviderSession(...)
```

Only do this if those operations genuinely belong to the application service contract.

### Do not

- duplicate Store abstractions;
- create a Provider database layer;
- hide arbitrary Store access behind dozens of forwarding methods;
- undertake a broad architectural rewrite during this CR.

### Minimum acceptance

If this is deferred, document the current `MemorySpace.store` exposure as a temporary P0 implementation detail and do not introduce additional direct Store access from P1 MCP code.

P1 MCP tools must go through domain/application/integration operations, not arbitrary Store CRUD.

---

# 5. Regression matrix

After this CR, automated coverage must include at least:

| Scenario | Expected |
|---|---|
| user content with leading/trailing whitespace | persisted exactly |
| assistant content with formatting/newlines | persisted exactly |
| whitespace-only provider content | rejected |
| internal Session without external ID + later external ID assertion | rejected |
| generic Session without provider + provider lifecycle event | rejected |
| matching provider Session via internal handle | accepted |
| external provider Session ID mismatch | rejected |
| failed SQLite BEGIN/acquisition path | local barrier still releases |
| transaction failure | original error remains observable |
| concurrent provider Session get-or-create | one durable Session |
| same provider+external ID under conflicting Space | explicit conflict |
| TranscriptRef provider mismatch | rejected |
| TranscriptRef external Session mismatch | rejected |
| matching TranscriptRef | accepted |
| memory integration failure | fail-open warning |
| onWarning callback throws | fail-open warning still returned |
| nearest monorepo binding | unchanged / green |
| cwd changes after Session creation | Session.spaceId remains frozen |
| PreCompact with new events | checkpoint completed |
| SessionEnd with no new events | noop |
| cache get/set/delete failure behavior | remains green |

Do not weaken existing tests to satisfy these cases.

---

# 6. Implementation order

Coding Agent should proceed in this order.

## Step 1 — Add failing regression tests

Before changing behavior, add tests for:

1. exact message content fidelity;
2. strict Session provider/external identity;
3. transaction barrier release on acquisition failure;
4. TranscriptRef provenance mismatch;
5. throwing `onWarning` sink.

At least the tests corresponding to current defects should fail against the current branch baseline.

## Step 2 — Fix message validation fidelity

Separate content validation from identifier normalization.

Do not alter normalized identifier semantics unnecessarily.

## Step 3 — Harden lifecycle Session identity

Make internal handle resolution strict and preserve frozen provider/native identity semantics.

Do not create an implicit identity attachment/rebinding feature.

## Step 4 — Fix transaction barrier release

Guarantee barrier release across all failure paths while preserving original errors and nested transaction behavior.

## Step 5 — Align Spec/Plan identity language

Keep `(provider, externalSessionId)` uniqueness and frozen `Session.spaceId` semantics.

Update all normative documentation consistently.

## Step 6 — Add transcript provenance validation + diagnostic sink containment

Keep transcript locator opaque and fail-open diagnostics non-authoritative.

## Step 7 — Address or explicitly defer ARCH-01

Prefer a minimal cleanup if it is low-risk. Otherwise document the temporary boundary and forbid new direct Store escape usage in P1.

## Step 8 — Run the full quality gate

Run:

```bash
pnpm run check
```

If `check:workspace` is valid/non-recursive in the current workspace, also run:

```bash
pnpm run check:workspace
```

Do not claim success from static inspection alone.

---

# 7. P0 final acceptance criteria

P0 is ready to freeze only when all of the following are true.

## Conversation fidelity

- user and assistant full content is preserved exactly;
- empty/whitespace-only turns remain rejected;
- Conversation-lite continues to exclude arbitrary tool traces.

## Session identity

- repeated same provider-native Session resolves to one durable Memory Session;
- provider/native identity cannot be silently attached or changed through lifecycle events;
- conflicting Space binding is rejected;
- cwd changes after binding do not alter Session.spaceId;
- documentation agrees with actual uniqueness semantics.

## Store safety

- failed transaction acquisition cannot permanently block the local store barrier;
- existing checkpoint/provider-session concurrency tests remain green.

## Transcript boundary

- TranscriptRef provenance matches the carrying provider lifecycle event;
- locator remains provider-specific/opaque;
- transcript is still supplementary evidence only;
- no automatic transcript-assisted extraction is added.

## Failure semantics

- lifecycle wrapper remains fail-open;
- diagnostic sink failure cannot make lifecycle behavior fail closed;
- domain operations still throw real failures outside the fail-open transport wrapper.

## Architecture

- Memory Core imports no provider-specific adapter;
- ProviderAdapter still performs normalization/rendering only;
- no P1 MCP implementation is included in this CR;
- no new arbitrary Store CRUD path is introduced.

## Quality gate

- all old tests/evals remain green;
- all new regression tests are green;
- `pnpm run check` passes;
- any available branch CI check passes before claiming P0 complete.

---

# 8. Coding Agent completion report

Before declaring this CR complete, report:

1. files changed;
2. FIX-01 message fidelity implementation;
3. FIX-02 Session identity implementation;
4. FIX-03 SQLite barrier implementation;
5. exact Spec/Plan identity wording changed for FIX-04;
6. FIX-05 transcript provenance rules;
7. FIX-06 fail-open diagnostic behavior;
8. ARCH-01 decision: implemented or explicitly deferred, with reason;
9. regression tests added;
10. `pnpm run check` result;
11. `pnpm run check:workspace` result if applicable;
12. CI result if available;
13. remaining known limitations;
14. confirmation that no P1 MCP/provider-specific feature was implemented.

If a frozen Provider Integration invariant had to change, explicitly report:

```text
Original invariant
New invariant
Why change was required
Compatibility impact
```

Expected outcome: no intentional change to frozen v1 product semantics other than correcting the contradictory provider identity wording in the documents.

---

# 9. Stop condition

After these fixes pass, **freeze Provider Integration P0**.

Do not continue P0 hardening unless a new demonstrated correctness regression appears.

The next implementation milestone is then:

```text
P1 — MCP Command Plane
```

with the already frozen six-tool public surface:

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

P1 must consume the P0 integration/application boundaries rather than bypassing them with direct database CRUD.
