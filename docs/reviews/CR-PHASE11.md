# CR-PHASE11 — P8 Implicit Remember Hardening Review

**Reviewed branch:** `main`  
**Reviewed commit:** `c8ba9625d3a4af0b00c3793cb9bf251fb85e1287`  
**P8 spec baseline:** `1cac6a5658cc920413d83fa876ffb0aa1a7ebb15`  
**Review date:** 2026-08-19  
**Status:** CLOSED / REVIEW PASS
**Primary goal:** 修复 P8 当前实现中影响显式用户控制、长轮次自动记忆召回率、checkpoint 语义幂等和自动敏感信息持久化边界的问题；保持 P8 已通过的 lifecycle、Indexed-only、Core protection、receipt durability 与 P7 + P8 closure 架构不变。

---

# 1. Review conclusion

P8 主体实现方向正确，以下能力已经获得本轮 review 的架构认可：

```text
provider-neutral ImplicitRememberService                  PASS
assistant event persisted before implicit remember        PASS
implicit lifecycle fail-open                              PASS
project-level implicitRemember configuration              PASS
missing config defaults to off                            PASS
new init explicitly enables conservative                  PASS
P8 accepted writes are Indexed-only                       PASS
existing Core target is protected                         PASS
assistant-only evidence is rejected                       PASS
recalled-only assistant repetition cannot self-reinforce  PASS
candidate fingerprint is versioned and deterministic      PASS
receipt durability across SQLite reopen                   PASS
receipt + Memory mutation share one transaction           PASS
single Stop replay deduplicates                            PASS
single Stop + later checkpoint reuses Memory identity     PASS
P7 + P8 cross-Session closure                              PASS
Claude real-provider smoke                                PASS
Codex smoke honestly recorded as BLOCKED                   PASS
```

Initial review findings:

Required review findings:

```text
FIX-01  Opt-out must be evaluated from full authoritative user evidence    P0 BLOCKER
FIX-02  Bounded extraction must preserve latest user evidence               P1 REQUIRED
FIX-03  Checkpoint must not replay already-materialized old content          P1 REQUIRED
FIX-04  Conservative implicit remember must reject secret-like assignments   P1 REQUIRED HARDENING
FIX-05  Quality report must point to the actual implementation commit         P2 REQUIRED DOC FIX
```

All required CR-PHASE11 findings below were subsequently closed.

---

# 2. Hard constraints

This CR is a hardening pass, not a new phase redesign.

## 2.1 Preserve P8 architecture

Keep:

```text
assistant_turn
  -> persist SessionEvent
  -> resolve trusted project policy
  -> implicit remember
  -> deterministic extraction
  -> strict admission
  -> Indexed-only commit
```

Keep checkpoint separate:

```text
PreCompact / SessionEnd / explicit checkpoint
  -> full uncheckpointed range
  -> extraction
  -> Core admission
  -> Handoff
  -> checkpoint boundary advancement
```

Do not make Assistant Stop a checkpoint.

## 2.2 Do not expand scope

This CR must not introduce:

```text
LLM extractor
embedding/vector search
semantic reranker
periodic/timer writes
provider-specific extraction policy
new MCP tools
durable privacy watermark
full secret scanner / DLP engine
external secret-manager integration
new database/ORM
background workers
large directory rewrite
```

A future durable privacy watermark remains separate work. FIX-01 only guarantees that the existing P8 per-turn opt-out is correctly enforced before bounded extraction.

## 2.3 Preserve already accepted invariants

```text
implicit remember never directly writes/promotes Core
existing Core is not modified by implicit remember
assistant-only evidence remains insufficient
recalled P7 context remains non-authoritative evidence
receipt and Memory mutation remain transactionally consistent
checkpoint still advances boundary only on successful checkpoint
MCP remains exactly six tools
lifecycle remains fail-open
```

---

# 3. FIX-01 — Opt-out must use full authoritative user evidence

**Priority:** P0 / RELEASE BLOCKER

## 3.1 Current problem

Current order is effectively:

```text
getImplicitRememberEventWindow(... bounded ...)
        ↓
latestUserContent(window.events)
        ↓
promptRememberDirective(prompt)
```

The event window applies:

```text
maxEventsPerImplicitRemember = 32
maxInputCharsPerImplicitRemember = 24_000
```

and content truncation retains a suffix of an oversized event.

Therefore an explicit opt-out at the beginning of a long user prompt can be removed before the directive policy sees it.

Example:

```text
User:
不要记住这次内容
<very long content>
PRIVATE_TEST_1 = durable-looking-value

Assistant:
<response>
```

A bounded suffix may become:

```text
PRIVATE_TEST_1 = durable-looking-value
```

which changes:

```text
explicit user control
```

into:

```text
allow
```

and can cause an implicit Memory write.

This violates the product rule:

> Workload bounding may reduce extraction recall, but it must never weaken an explicit user control decision.

## 3.2 Required invariant

Control-plane decisions MUST use untruncated authoritative evidence.

Required order:

```text
assistant_turn persisted
        ↓
resolve latest relevant full user SessionEvent
        ↓
run PromptRememberDirective on full user content
        ↓
if disable_for_turn:
    bypass P8 immediately
        ↓
else:
    construct bounded extraction window
```

Do not run the opt-out classifier on `boundEventContent()` output.

## 3.3 Recommended API direction

Prefer a MemorySpace/application method that returns the latest full user event before/through the assistant boundary, for example conceptually:

```ts
getLatestUserEventBefore(input: {
  sessionId: string;
  throughEventId: string;
  afterCheckpointBoundary?: boolean;
}): Promise<SessionEvent | undefined>
```

or return control evidence separately from the bounded extraction window:

```ts
getImplicitRememberTurnContext(...): Promise<{
  session: Session;
  fullLatestUserEvent?: SessionEvent;
  boundedEvents: SessionEvent[];
}>
```

Exact naming is implementation-owned.

Do not solve this by simply raising `maxInputChars`.

## 3.4 Required tests

### Long user prompt — opt-out at prefix

Construct a user message larger than the extraction character budget:

```text
不要记住这次内容
<more than maxInputChars>
LONG_OPT_OUT_1 = should-not-persist
```

Then persist assistant turn.

Assert:

```text
implicitRemember.bypassed === true
committed.length === 0
Memory count === 0
no candidate receipt created
all SessionEvents remain persisted
```

### Long assistant response must not affect control decision

User prompt contains opt-out and durable-looking assignment.
Assistant response exceeds `maxInputChars`.

Assert the same zero-write outcome.

### Negative control

A long user prompt mentioning Memory but not an explicit disable phrase must not be bypassed merely due to size.

---

# 4. FIX-02 — Bounded extraction must preserve latest user evidence

**Priority:** P1 / REQUIRED

## 4.1 Current problem

The current bounded window walks newest events backwards and consumes the shared character budget from the newest event first.

Typical coding-agent case:

```text
User:
LONG_ASSISTANT_TEST_1 = durable

Assistant:
<30,000+ character final answer>
```

With a 24,000-character total budget, the assistant suffix may consume the entire budget before the latest user event is added.

P8 admission then correctly enforces:

```text
candidate must have user evidence
```

but the user evidence has been removed by the workload-bounding strategy itself.

Result:

```text
explicit durable user fact
  -> assistant is long
  -> no user event in extraction window
  -> implicit remember misses the turn
```

For coding agents, long final replies are common enough that this is not an exotic edge case.

## 4.2 Required invariant

When P8 is enabled and a latest uncheckpointed user message exists for the assistant turn:

> The bounded extraction context must preserve a bounded representation of that latest user evidence before optional assistant/history context is allowed to consume the remaining budget.

This is a recall-quality invariant, not permission to exceed the global bounded-work goal.

## 4.3 Acceptable designs

Either of the following is acceptable.

### Option A — Reserved user budget

Conceptually:

```text
maxInputChars = 24,000

latest user evidence reserve = bounded share
assistant/history = remaining share
```

Example only:

```text
user reserve: 12,000
remaining context: 12,000
```

The exact split may differ, but tests must prove that an ordinary short user fact survives even when the assistant response alone exceeds the total budget.

### Option B — Priority inclusion

Build the event selection order as:

```text
1. latest user event first
2. current assistant event
3. earlier events newest-first
```

Apply bounded content and total work limits without dropping the latest user event entirely.

## 4.4 Requirements

- Do not make the event window unbounded.
- Do not store truncated content back into SessionEvents.
- Keep UTF-16/surrogate-safe truncation behavior.
- Preserve deterministic event order passed to the extractor.
- The extractor must still receive persisted-event identities for provenance.

## 4.5 Required tests

### Long assistant

```text
User:
LONG_ASSISTANT_TEST_1 = durable

Assistant:
<larger than maxInputChars>
```

Assert:

```text
latest user event is present in extraction input
LONG_ASSISTANT_TEST_1 Memory is created
Memory tier === indexed
```

### Long user + long assistant

Both exceed their practical per-event shares.

Assert:

```text
bounded input total does not exceed configured limit
latest user event remains represented
original persisted SessionEvents remain unmodified
```

### Existing bounded-window regression

Retain coverage for:

```text
maxEvents
maxInputChars
newest relevant range after checkpoint boundary
```

---

# 5. FIX-03 — Checkpoint must not replay already-materialized old content

**Priority:** P1 / REQUIRED

## 5.1 Current behavior

P8 receipt correctly provides:

```text
candidate fingerprint
  -> memoryId
```

Checkpoint currently does approximately:

```text
for each checkpoint candidate:
  fingerprint = candidate fingerprint
  receipt = find receipt
  commitMemory({
    ...candidate,
    targetMemoryId: receipt?.memoryId
  })
```

This prevents duplicate Memory identity, but a receipt currently means only:

```text
reuse this Memory ID
```

rather than:

```text
this candidate's content mutation was already materialized
```

## 5.2 Failure scenario

Before checkpoint:

```text
Turn 1:
KEY_1 = v1
  -> implicit remember
  -> Memory M version 1
  -> receipt R1

Turn 2:
KEY_1 = v2
  -> implicit remember
  -> same Memory M version 2
  -> receipt R2
```

Then checkpoint processes the whole uncheckpointed range:

```text
candidate v1
candidate v2
```

If checkpoint replays both content mutations:

```text
M(v2) -> v1 -> v2
version 2 -> 3 -> 4
```

The final content is correct, but the history is semantically false/noisy:

```text
newer materialized state
  -> old state replay
  -> newer state replay
```

This violates the intended meaning of extractor commit receipts.

## 5.3 Required invariant

A successful receipt means:

> The create/update/deduplicate content side effect for that exact candidate/evidence fingerprint has already been materialized.

Checkpoint encountering an existing receipt MUST NOT blindly replay that candidate's historical content mutation.

Checkpoint still owns:

```text
checkpoint candidate audit
Core admission
Handoff generation
checkpoint boundary advancement
```

Therefore receipt reuse must separate:

```text
content materialization
```

from:

```text
checkpoint-only admission/convergence semantics
```

## 5.4 Required behavior

For an already-materialized receipt:

```text
DO NOT reapply an older content value merely because the checkpoint sees the old candidate again
```

The checkpoint must converge to the final effective Memory state for the checkpoint range and only apply any still-needed checkpoint semantics.

### Stable-key multiple candidates

For multiple candidates targeting the same Memory/key inside one checkpoint range:

```text
v1
v2
v3
```

the checkpoint must not produce historical rewind side effects after P8 has already materialized them.

The final effective state should remain the newest applicable candidate state.

### Core admission

If checkpoint policy decides that the final effective candidate is Core eligible, checkpoint may still promote the existing Indexed Memory according to the frozen P6 policy.

A content receipt must not suppress legitimate checkpoint-only tier admission.

## 5.5 Implementation guidance

Do not patch this by special-casing one key in tests.

Preferred conceptual approaches include:

### Approach A — Collapse checkpoint candidates by target identity before mutation

Within one checkpoint transaction:

```text
validate candidates
resolve receipt/target identity
compute final effective candidate per canonical Memory identity
apply content mutation only when not already materialized / still needed
apply checkpoint admission to final effective state
```

### Approach B — Explicit receipt-aware commit semantics

Introduce a shared candidate commit/result path that can distinguish:

```text
materialization already satisfied
checkpoint admission still required
```

The exact abstraction is implementation-owned.

Do not remove candidate audit records for historical candidates; checkpoint audit may still record all extracted candidates even when no content mutation is replayed.

## 5.6 Required tests

### Two implicit updates then checkpoint

```text
KEY_1 = v1
Stop

KEY_1 = v2
Stop
```

Before checkpoint:

```text
content === v2
version === 2
```

Then SessionEnd checkpoint.

Assert:

```text
one Memory identity
content === v2
no v2 -> v1 -> v2 history replay
version does not increase solely from replayed content
```

If checkpoint legitimately changes only the tier, version may increase exactly for that tier change according to existing domain semantics.

### Three updates

Repeat with v1 -> v2 -> v3 before checkpoint.

Assert final state remains v3 and history has no backward content replay.

### Unkeyed same-evidence case

Existing Stop + checkpoint receipt dedup coverage must remain green.

### Checkpoint-first case

A candidate first materialized by checkpoint still creates a receipt and remains retry-safe.

---

# 6. FIX-04 — Reject secret-like assignments from conservative implicit writes

**Priority:** P1 / REQUIRED HARDENING

## 6.1 Current problem

P8's new opaque assignment rule intentionally supports:

```text
CROSS_AGENT_TEST_20260817 = lavender-731
```

But the same shape also accepts common credential-like assignments:

```text
OPENAI_API_KEY = <value>
DATABASE_PASSWORD = <value>
PROD_ACCESS_TOKEN = <value>
SERVICE_PRIVATE_KEY = <value>
```

Newly initialized projects explicitly enable:

```json
"implicitRemember": { "mode": "conservative" }
```

so this is an automatic durable side effect.

This CR does not require a complete secret/DLP system, but `conservative` should not automatically persist obvious credential-shaped assignments.

## 6.2 Required scope

Apply this guard only to **implicit remember admission/extraction**.

Do not change explicit `memory_remember` semantics in this CR.

Do not globally hide/delete existing Memory.

## 6.3 Required policy

Introduce a narrow deterministic `secret-like stable key` policy.

At minimum reject obvious credential key classes such as normalized keys containing or ending in concepts equivalent to:

```text
PASSWORD
PASSWD
API_KEY
ACCESS_TOKEN
REFRESH_TOKEN
PRIVATE_KEY
CLIENT_SECRET
AUTH_SECRET
CREDENTIAL
CREDENTIALS
```

The exact normalization should account for common separators:

```text
_
-
.
/
:
```

Examples that MUST be rejected implicitly:

```text
OPENAI_API_KEY = ...
DATABASE_PASSWORD = ...
prod.access-token = ...
service/private_key = ...
OAUTH_CLIENT_SECRET = ...
```

## 6.4 False-positive constraint

Do not reject every use of the word `token`.

Examples that should remain eligible when otherwise durable:

```text
DESIGN_TOKEN_VERSION = v3
TOKEN_BUDGET_LIMIT = 24000
```

because `token` can describe non-secret engineering concepts.

Prefer credential-specific compound patterns such as `ACCESS_TOKEN` / `REFRESH_TOKEN` rather than bare `TOKEN`.

## 6.5 Rejection reason

Add a stable P8 admission rejection reason, e.g.:

```ts
"secret_like_evidence"
```

It should appear in sanitized diagnostics/eval output without exposing the secret value.

## 6.6 Required tests

Table-driven tests:

```text
OPENAI_API_KEY                reject
DATABASE_PASSWORD             reject
PROD_ACCESS_TOKEN             reject
SERVICE_PRIVATE_KEY           reject
OAUTH_CLIENT_SECRET           reject
DESIGN_TOKEN_VERSION          allow
TOKEN_BUDGET_LIMIT            allow
CROSS_AGENT_TEST_20260817     allow
```

Assert rejected candidates:

```text
create no Memory
create no receipt
sanitized rejection contains no secret value
```

Add at least one lowercase/separator-normalization fixture.

---

# 7. FIX-05 — Quality report must reference the implementation commit

**Priority:** P2 / REQUIRED DOC FIX

## 7.1 Current problem

`docs/reports/quality/P8_IMPLICIT_REMEMBER_RESULT.md` currently describes the implementation tree as based on the P8 spec commit:

```text
1cac6a5658cc920413d83fa876ffb0aa1a7ebb15
```

but the P8 implementation is committed as:

```text
c8ba9625d3a4af0b00c3793cb9bf251fb85e1287
```

After this CR is fixed there will be an additional hardening commit.

## 7.2 Required behavior

Update the report so it records immutable evidence clearly, conceptually:

```text
P8 original implementation commit: c8ba9625...
P8 hardening commit: <new commit SHA>
P8 spec baseline: 1cac6a...
```

If the hardening commit SHA cannot be known until after commit creation, it is acceptable to:

1. update the report with the original implementation commit and mark hardening SHA pending;
2. commit the code;
3. perform a small follow-up documentation commit inserting the final hardening SHA.

Do not claim Codex real-provider PASS unless a real run actually passes.

Keep the existing Claude evidence and Codex BLOCKED evidence truthful.

---

# 8. Regression matrix

The following tests are required before closing CR-PHASE11.

| Area | Scenario | Required result |
|---|---|---|
| Opt-out | prefix opt-out truncated by old window behavior | zero implicit write |
| Opt-out | long assistant after opt-out | zero implicit write |
| Window | short durable user fact + >24k assistant | user evidence preserved; Indexed Memory created |
| Window | long user + long assistant | bounded total; user evidence still represented |
| Idempotency | one Stop replay | one Memory; no version bump |
| Idempotency | v1 Stop -> v2 Stop -> checkpoint | final v2; no content rewind |
| Idempotency | v1 -> v2 -> v3 -> checkpoint | final v3; no content rewind |
| Checkpoint | checkpoint-only candidate | receipt created; retry-safe |
| Core | checkpoint promotion after implicit materialization | legitimate tier admission still works |
| Secret guard | credential-like assignment | rejected; no Memory/receipt |
| Secret guard | DESIGN_TOKEN_VERSION | not rejected solely due to `token` |
| Lifecycle | implicit remember internal failure | assistant event persists; fail-open |
| P7/P8 | cross-Session opaque key closure | still PASS |
| Space | cwd drift/mismatched binding | no implicit write |

Existing P8 tests must remain green.

---

# 9. Evaluation requirements

Extend the deterministic P8 evaluation with fixtures for the new failure classes.

At minimum add metrics or hard-correctness assertions for:

```text
Explicit Opt-Out Violation Rate = 0.0
Long-Assistant User-Evidence Retention = PASS
Checkpoint Historical Replay Count = 0
Secret-Like Auto-Persistence Rate = 0.0
```

The existing metrics must remain at their accepted targets:

```text
Implicit Remember Precision             target 1.0 on frozen deterministic fixtures
Implicit Core Write Rate                0.0
Same-Evidence Duplicate Rate            0.0
Replay Duplicate Rate                   0.0
Assistant-Only Persistence Rate         0.0
Lifecycle Blocking Failure Rate         0.0
```

Do not improve one metric by weakening P7/P8 product invariants.

---

# 10. Expected implementation areas

Likely files include:

```text
src/application/memory-space.ts
src/application/implicit-remember-admission.ts
src/integration/implicit-remember.ts
src/integration/prompt-remember-directive.ts
src/application/*secret-like-policy*.ts          optional new pure helper
src/ports/store.ts                                only if convergence needs contract changes
src/adapters/sqlite/sqlite-store.ts               only if store support is needed

test/implicit-remember.test.ts
eval/p8-implicit-remember.ts
eval/fixtures/p8-implicit-remember.json

docs/reports/quality/P8_IMPLICIT_REMEMBER_RESULT.md
```

Do not force every listed file to change if a smaller correct solution exists.

---

# 11. Recommended implementation order

## CR11.1 — Control-plane correctness

Implement FIX-01 first.

Gate:

```text
full user opt-out is evaluated before bounded extraction
long/truncated input cannot bypass explicit disable
```

## CR11.2 — Evidence-preserving bounded window

Implement FIX-02.

Gate:

```text
long assistant cannot erase latest user evidence
bounds remain enforced
```

## CR11.3 — Receipt-aware checkpoint convergence

Implement FIX-03.

Gate:

```text
multiple implicit updates before checkpoint do not replay old content
checkpoint-only Core admission still works
```

## CR11.4 — Conservative secret guard

Implement FIX-04.

Gate:

```text
obvious credentials are not automatically persisted
non-secret token-related engineering facts remain eligible
```

## CR11.5 — Evaluation + report closure

Implement FIX-05 and extend eval.

Run full verification.

---

# 12. Verification commands

At minimum run the repository's current equivalents of:

```text
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run inspector:build
pnpm run check
pnpm run check:workspace
git diff --check
pnpm memory-space eval implicit-remember
```

If command names have changed, use the current package scripts and record the exact commands executed.

Real-provider smoke:

```text
Claude: rerun if practical after semantic changes affecting lifecycle/extraction
Codex: rerun only when account/provider execution is actually available
```

Do not convert an unavailable provider into a synthetic PASS.

---

# 13. Completion gate

CR-PHASE11 completion evidence:

```text
[x] full untruncated user evidence controls P8 opt-out
[x] bounded extraction cannot weaken explicit opt-out
[x] latest user evidence survives a long assistant response
[x] extraction remains bounded and persisted events remain immutable
[x] receipt-backed checkpoint no longer replays old materialized content
[x] multi-update checkpoint history has no backward content rewind
[x] legitimate checkpoint Core admission still works
[x] obvious credential-like assignments are rejected implicitly
[x] non-secret token-related engineering keys are not broadly blocked
[x] secret rejection diagnostics do not expose secret values
[x] P7 + P8 cross-Session closure remains green
[x] lifecycle fail-open remains green
[x] existing P8 deterministic metrics remain at target
[x] new hardening fixtures pass
[x] P8 quality report identifies real implementation/hardening commits
[x] lint/typecheck/test/build/check/workspace checks pass
```

Observed closure evidence on 2026-08-19:

```text
pnpm run lint                              PASS
pnpm run typecheck                         PASS
pnpm test                                  PASS (243 tests)
pnpm run inspector:build                   PASS
pnpm run check                             PASS
pnpm run check:workspace                   PASS
git diff --check                           PASS
pnpm memory-space eval implicit-remember   PASS
Claude 2.1.112 real P8 smoke               PASS
Codex real P8 smoke                        BLOCKED by account usage limit
```

Codex remains honestly BLOCKED rather than synthetically promoted to PASS. The
review already accepted that provider limitation as non-blocking when the
provider-neutral implementation, deterministic gates, and an available real
provider are green.

Final P8 state:

```text
COMPLETE / REVIEW PASS / FROZEN
```

with the remaining deferred work explicitly limited to future semantic/LLM extraction, embeddings, durable privacy watermark semantics, and any broader secret-management product design.

## Follow-up hardening

The closed review later received one targeted control-semantics follow-up:
opted-out user evidence could remain in the uncheckpointed range and be
materialized by a later implicit-remember turn. The follow-up preserves the
original findings and closure while adding this invariant:

```text
candidate source user event explicitly opted out
  -> reject every current or later P8 implicit admission
  -> reason = opted_out_evidence
  -> checkpoint behavior remains unchanged
```

The implementation resolves full persisted source events for the control
decision. Bounded extraction copies remain evidence for extraction and the
existing admission checks, but are not trusted for opt-out evaluation.
