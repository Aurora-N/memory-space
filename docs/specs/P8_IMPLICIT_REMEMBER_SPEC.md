# P8 — Implicit Turn-Time Remember Spec

**Status:** COMPLETE / REVIEW PASS / FROZEN
**Phase:** P8  
**Depends on:** Provider Integration v1, P6 Core/Handoff policy, P7 implicit prompt-time recall  
**Related:** `./P7_IMPLICIT_RECALL_SPEC.md`, `./PROVIDER_INTEGRATION_SPEC.md`, `./P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`, `./DOMAIN_MODEL.md`, `./PRODUCT_SPEC.md`

> P8 adds provider-neutral **implicit turn-time Memory ingestion**. A normal coding-agent conversation may persist durable user-provided project knowledge into Indexed Memory without requiring the model to explicitly call `memory_remember`.

---

# 1. Product invariant

After P8, Memory Space has symmetric automatic read/write paths around Indexed Memory:

```text
write side                              read side

explicit memory_remember               explicit memory_search/context
        |                                        |
implicit remember                      implicit recall (P7)
        |                                        |
        +------------ Indexed Memory ------------+
                           |
                       checkpoint
                           |
                    Core admission
                           |
                          Core
                           |
                       bootstrap
```

Frozen invariant:

```text
implicit remember
= opportunistic durable ingestion during a normal turn
= Indexed-only
= does not define a checkpoint boundary

checkpoint
= Memory Commit Point for the Session event range
= extraction + final candidate convergence + Core admission + Handoff
```

P8 MUST NOT redefine Assistant Stop as checkpoint.

P8 MUST NOT make every conversation message a Memory.

P8 MUST NOT require the provider model to simulate or emit a `memory_remember` MCP tool call.

---

# 2. Product problem

Before P8, durable Memory can be created through:

```text
explicit memory_remember
or
checkpoint extraction
```

This leaves an important gap:

```text
normal conversation
      ↓
user states durable project knowledge
      ↓
SessionEvent is persisted
      ↓
no PreCompact / SessionEnd yet
      ↓
no checkpoint yet
      ↓
no durable Memory available to another Session
```

P8 closes that gap through trusted lifecycle middleware:

```text
Assistant final turn / Stop
        ↓
persist assistant SessionEvent
        ↓
project implicitRemember policy
        ↓
provider-neutral bounded extraction
        ↓
strict implicit admission
        ↓
idempotent candidate commit
        ↓
Indexed Memory
```

If a later checkpoint processes the same source events, it MUST converge on the same Memory rather than create a duplicate.

---

# 3. Scope

P8 v1 includes:

- project-level `implicitRemember` configuration;
- an independent `ImplicitRememberService` in the integration layer;
- invocation after a reliable persisted `assistant_turn`;
- bounded extraction over persisted SessionEvents;
- conservative admission rules;
- Indexed-only implicit writes;
- candidate-level idempotency across implicit remember and later checkpoint extraction;
- prompt/turn-level explicit user opt-out;
- lifecycle fail-open behavior;
- doctor/status visibility;
- deterministic unit/integration/e2e evaluation;
- one deterministic stable-assignment extraction rule for opaque durable keys.

---

# 4. Non-goals

P8 v1 does **not** include:

- changing Assistant Stop into checkpoint;
- idle/periodic/timer-based Memory writes;
- empty checkpoint creation;
- implicit Handoff generation;
- automatic Core writes from implicit remember;
- generic LLM/semantic extraction of arbitrary prose;
- embeddings/vector retrieval;
- provider-specific Memory extraction logic;
- raw tool-result ingestion;
- trusting recalled P7 context as new Memory evidence;
- treating assistant speculation as durable project knowledge;
- cross-Space automatic deduplication;
- globally deduplicating all historically duplicated unkeyed Memories;
- changing explicit `memory_remember` semantics.

A future semantic extractor may plug into the existing `MemoryExtractor` port, but P8 v1 completion MUST NOT depend on a network/LLM call.

---

# 5. Lifecycle trigger

## 5.1 Frozen trigger

P8 v1 runs after a reliable assistant final turn has been normalized and persisted:

```text
provider Stop / assistant final hook
        ↓
ProviderAssistantTurnEvent
        ↓
LifecycleHandler
        ↓
append SessionEvent.message(role=assistant)
        ↓
ImplicitRememberService.rememberTurn(...)
```

The persisted SessionEvent is authoritative evidence. Implicit remember MUST run only after that event write succeeds.

## 5.2 No new provider-native lifecycle contract

P8 relies on the existing Provider Integration `assistant_turn` capability. It does not introduce polling or provider wrappers to emulate missing lifecycle events.

If a provider cannot deliver a reliable assistant final turn:

```text
implicit remember for that provider = unsupported/off
checkpoint behavior remains unchanged
explicit memory_remember remains available
```

## 5.3 Lifecycle result

The normalized lifecycle result may expose sanitized diagnostics:

```ts
interface ImplicitRememberResult {
  configuredMode?: ImplicitRememberMode;
  effectiveMode: ImplicitRememberMode;
  bypassed: boolean;
  inspectedEventIds: string[];
  committed: Array<{
    memoryId: string;
    key?: string;
    type: string;
    disposition: "created" | "updated" | "deduplicated";
  }>;
  rejected: Array<{
    type?: string;
    reason: ImplicitRememberRejectionReason;
  }>;
}
```

Provider-facing output MUST NOT contain raw internal errors, database paths, or hidden Memory content not already present in the current Session evidence.

---

# 6. Project-level configuration

P8 extends the project binding file independently from P7 recall configuration:

```json
{
  "version": 1,
  "spaceId": "space_...",
  "implicitRecall": {
    "mode": "exact"
  },
  "implicitRemember": {
    "mode": "conservative"
  }
}
```

## 6.1 Mode

P8 v1 supports:

```ts
type ImplicitRememberMode = "off" | "conservative";
```

Semantics:

```text
off
  -> no implicit Memory extraction/commit

conservative
  -> deterministic extractor only
  -> strict admission
  -> Indexed-only writes
```

## 6.2 Backward-compatible default

Missing `implicitRemember` or missing `implicitRemember.mode` resolves to:

```text
effective mode = off
source = default
```

Reason: automatic durable writes are a stronger side effect than prompt-time recall. Existing project configs MUST NOT silently begin writing Memory after upgrade.

After P8 ships, new `memory-space init` output SHOULD write the desired behavior explicitly:

```json
"implicitRemember": { "mode": "conservative" }
```

This gives new projects the automatic-memory experience while preserving existing-project compatibility.

## 6.3 Invalid configuration

Invalid configuration fails closed for writing while lifecycle remains fail-open:

```text
implicitRemember = []
implicitRemember.mode = "semantic"
implicitRemember.mode = 123
```

Expected:

```text
Space binding remains usable if version + spaceId are valid
effective implicit remember mode = off
no implicit Memory write
doctor/status = ERROR with remediation
assistant/provider flow continues
```

Do not silently coerce invalid input to `conservative`.

## 6.4 Session authority

An existing Provider Session's persisted `session.spaceId` remains authoritative.

At implicit-remember time:

```text
resolve current project binding from cwd

if binding.spaceId == session.spaceId
  -> use that binding's current implicitRemember configuration

if binding missing / invalid / points to another Space
  -> keep Session unchanged
  -> implicit remember = off for this turn
  -> record best-effort diagnostic
  -> continue provider flow
```

This mirrors the P7 principle that cwd drift cannot migrate an existing Session.

---

# 7. Prompt/turn-level opt-out

Project configuration is the default. The current user may narrow it for one turn.

P8 v1 requires a deterministic narrow directive:

```ts
type PromptRememberDirective = "allow" | "disable_for_turn";
```

Required precedence:

```text
explicit user disable for this turn
  > project implicitRemember.mode
```

Examples that SHOULD disable implicit remember:

```text
不要记住这次内容
不要把这次对话保存到记忆
这次不要写入 Memory Space
Do not remember this turn
Do not save this conversation to memory
```

Examples that MUST NOT disable merely because they mention Memory:

```text
你记得之前的方案吗？
把这段代码改成 memory-safe 的
memory-space 的 remember 是怎么实现的？
```

P7 recall opt-out and P8 remember opt-out are independent:

```text
不要使用之前的记忆回答
  -> disables P7 recall for this prompt
  -> does not automatically disable P8 write

不要记住这次内容
  -> disables P8 implicit remember for this turn
  -> does not automatically disable P7 recall
```

A combined explicit instruction may disable both.

The user message SessionEvent MUST still be persisted when P8 is bypassed.

---

# 8. Extraction event window

## 8.1 Source of truth

Implicit remember reads only persisted SessionEvents from the current Session.

It MUST NOT extract directly from:

- provider hook-native unvalidated fields;
- P7 `additionalContext`;
- bootstrap rendered context;
- MCP tool descriptions;
- provider hidden reasoning/internal traces.

## 8.2 Window

For one assistant-turn trigger, P8 v1 may inspect the uncheckpointed event range through the newly persisted assistant event:

```text
(Session.lastCheckpointEventId, currentAssistantEventId]
```

The implementation MUST apply bounded work, for example:

```ts
maxEventsPerImplicitRemember = 32
maxInputCharsPerImplicitRemember = 24_000
```

If the uncheckpointed range is larger, inspect the newest bounded suffix. Earlier turns are expected to have been processed by earlier Stop triggers and remain eligible for later checkpoint extraction.

Bounds are implementation constants in P8 v1, not project configuration.

## 8.3 No implicit watermark

P8 v1 MUST NOT reuse or advance `Session.lastCheckpointEventId`.

A separate durable `lastImplicitRememberEventId` is not required for P8 v1. Candidate commit receipts provide replay idempotency.

---

# 9. Extraction contract

P8 reuses the provider-neutral `MemoryExtractor` contract.

The extractor remains responsible for:

```text
SessionEvents
  -> MemoryCandidate[]
```

It is not responsible for deciding whether implicit remember may write Core.

## 9.1 Context evolution

The existing extraction context is checkpoint-named. P8 SHOULD generalize it without making extractors provider-specific.

Recommended direction:

```ts
type ExtractionTrigger = "checkpoint" | "implicit_remember";

interface ExtractionContext {
  session: Session;
  trigger: ExtractionTrigger;
  operationId: string;
  checkpointId?: string;
  projectBinding?: SessionProjectBinding;
}
```

Existing deterministic extractors SHOULD require no behavioral fork solely because the trigger changed.

## 9.2 Stable opaque assignment rule

P8 v1 MUST add deterministic support for an opaque stable assignment so the P7 exact-key scenario can be produced automatically.

Eligible shape:

```text
<distinctive-stable-key> = <non-empty-value>
```

Key candidate rules SHOULD reuse the P7 exact-key distinctiveness contract:

```text
maximal run: [A-Za-z0-9._:/-]+
length: 3..128
first char: [A-Za-z0-9]
AND at least one:
  contains _ . : / -
  contains a digit
  all-uppercase identifier length >= 3
```

Example:

```text
CROSS_AGENT_TEST_20260817 = lavender-731
```

Expected candidate:

```ts
{
  family: "knowledge",
  type: "fact",
  key: "CROSS_AGENT_TEST_20260817",
  content: "CROSS_AGENT_TEST_20260817 = lavender-731",
  confidence: >= 0.95,
  importance: 0.5,
  recommendedTier: "indexed",
  operation: "update",
  sourceEventIds: [sourceUserEventId]
}
```

The rule MUST NOT treat ordinary prose equality/comparison text as a key assignment.

## 9.3 Semantic extraction boundary

P8 v1 does not claim arbitrary prose such as:

```text
上传模块使用 variant 区分新版样式，variant 的类型包括 a、b、c。
```

will always become Memory unless the deterministic extractor has an explicit supported rule for it.

A future semantic/LLM-backed extractor may support broader natural-language facts without redesigning P8 lifecycle, admission, or commit contracts.

---

# 10. Implicit admission policy

Extraction and admission are separate decisions:

```text
MemoryExtractor
     ↓
MemoryCandidate
     ↓
ImplicitRememberAdmissionPolicy
     ↓
accepted / rejected
```

## 10.1 Hard tier rule

Every candidate accepted by implicit remember is committed as:

```text
tier = indexed
```

`recommendedTier = core` MUST be ignored for implicit commit.

Implicit remember MUST NOT invoke `decideCoreAdmission()` to select the initial tier.

## 10.2 Existing Core protection

If an implicit candidate would target an existing active Core Memory by stable key or explicit target identity:

```text
implicit commit MUST NOT mutate, demote, overwrite, or supersede Core
```

Disposition:

```text
reject / no-op with reason = existing_core_memory
```

A later checkpoint or explicit domain operation may reconcile that evidence through the existing Core policy.

## 10.3 Evidence rule

P8 v1 accepts only candidates supported by at least one persisted **user** message event in the inspected range.

Therefore:

```text
assistant-only candidate
  -> rejected

candidate sourced from recalled P7 content repeated by assistant
  -> rejected

user-provided durable fact / decision / constraint
  -> eligible subject to the remaining rules
```

This is the primary P8 v1 defense against Memory self-reinforcement and assistant hallucination persistence.

## 10.4 Confidence

Default conservative threshold:

```text
confidence >= 0.85
```

Candidates below threshold are not implicitly written. They remain eligible to be reconsidered by later checkpoint extraction.

## 10.5 Transient evidence

Evidence rejected by the existing transient extraction policy remains rejected.

Examples:

```text
我现在正在检查这个文件
刚才的命令失败了
这次测试完成了
```

Interaction-local narration MUST NOT become durable Memory merely because a Stop occurred.

## 10.6 Allowed operations

P8 implicit remember MAY execute:

```text
create
update
```

P8 v1 MUST NOT autonomously execute:

```text
supersede
```

for implicit writes unless the candidate targets an Indexed Memory by stable key and the existing domain semantics can prove a deterministic replacement. The conservative default is to reject ambiguous supersede requests and leave reconciliation to checkpoint.

`ignore` remains a no-op.

---

# 11. Candidate-level idempotency

P8 introduces a durable candidate commit receipt so the same source evidence can be processed at Stop and again at checkpoint without duplicate Memory creation.

## 11.1 Problem

Without a shared receipt:

```text
Stop
  -> extract unkeyed candidate A
  -> create Memory M1

SessionEnd
  -> checkpoint scans same source event
  -> extract candidate A again
  -> create Memory M2   // forbidden duplicate
```

Stable-key Memories already converge through key update semantics, but P8 MUST also protect unkeyed candidates from same-evidence duplication.

## 11.2 Fingerprint

Define one canonical versioned fingerprint over candidate identity and source evidence:

```text
sha256(
  "p8:v1" + NUL +
  sessionId + NUL +
  family + NUL +
  type + NUL +
  normalize(key ?? "") + NUL +
  normalize(content) + NUL +
  sort(unique(sourceEventIds)).join(",")
)
```

The fingerprint intentionally excludes:

```text
recommendedTier
confidence
importance
promoteReason
```

because those may differ between implicit admission and checkpoint admission while describing the same Memory evidence.

## 11.3 Receipt

Recommended durable shape:

```ts
interface MemoryCandidateCommitReceipt {
  id: string;
  sessionId: string;
  fingerprint: string;
  memoryId: string;
  firstCommitSource: "implicit" | "checkpoint";
  sourceEventIds: string[];
  createdAt: string;
}
```

Required uniqueness:

```text
UNIQUE(session_id, fingerprint)
```

Only successful create/update/deduplicate commits create a receipt. Rejected implicit candidates MUST NOT block a later checkpoint from reconsidering the same evidence.

## 11.4 Checkpoint reuse

When checkpoint encounters a candidate whose receipt already exists:

```text
load receipt.memoryId
  -> reuse existing Memory identity
  -> apply checkpoint candidate semantics / Core admission to that Memory
  -> do not create a second Memory
```

The checkpoint remains authoritative for:

```text
Core admission
Handoff generation
lastCheckpointEventId advancement
checkpoint candidate audit records
```

## 11.5 Replay

Repeated delivery of the same assistant Stop must converge:

```text
same SessionEvents
same candidate fingerprint
same receipt
same Memory identity
```

No duplicate Memory row and no duplicate semantic update may be produced.

---

# 12. Shared candidate commit path

P8 SHOULD refactor candidate commit coordination so explicit remember, implicit remember, and checkpoint do not reimplement Memory mutation logic independently.

Recommended conceptual source type:

```ts
type MemoryCommitSource = "explicit" | "implicit" | "checkpoint";
```

The shared commit path owns:

- provenance validation;
- stable-key lookup/update;
- equivalent-content deduplication;
- Memory history;
- memory_sources;
- candidate receipt lookup/write for extractor-driven paths;
- cache invalidation.

Source-specific policy remains outside or explicitly parameterized:

```text
explicit
  -> existing memory_remember behavior

implicit
  -> Indexed-only
  -> Core target protected
  -> conservative operation policy

checkpoint
  -> existing decideCoreAdmission behavior
  -> may promote/demote according to frozen Core policy
```

Do not expose raw provider payloads to the commit path.

---

# 13. Interaction with checkpoint

P8 MUST preserve every existing checkpoint invariant.

After implicit remember:

```text
Session.lastCheckpointEventId = unchanged
latestHandoffSnapshotId = unchanged
no Checkpoint row created
no HandoffSnapshot created
```

Later:

```text
PreCompact / SessionEnd / explicit checkpoint
  -> still reads the full uncheckpointed event range
  -> still runs extraction
  -> still records checkpoint candidates
  -> reuses prior implicit Memory identity when fingerprint matches
  -> still applies Core admission
  -> still builds Handoff
  -> advances lastCheckpointEventId only on successful checkpoint
```

Implicit remember is not a partial checkpoint and MUST NOT mark source events as checkpoint-committed.

---

# 14. Failure semantics

P8 lifecycle behavior is fail-open.

Order:

```text
persist assistant SessionEvent
        ↓
try implicit remember
        ↓
if failure:
  emit best-effort sanitized diagnostic
  return normal provider lifecycle result
  do not roll back the persisted assistant event
```

Recommended diagnostic code:

```text
IMPLICIT_REMEMBER_UNAVAILABLE
```

Important consequence:

> A failed implicit remember does not destroy source evidence. A later checkpoint can still extract from the persisted SessionEvents.

Database transaction failures during one candidate commit MUST not leave a receipt pointing to a nonexistent/incomplete Memory.

Receipt + Memory mutation must be transactionally consistent.

---

# 15. Store/schema changes

P8 requires durable candidate commit receipts.

Recommended SQLite migration:

```sql
CREATE TABLE memory_candidate_commit_receipts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  fingerprint TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  first_commit_source TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, fingerprint)
);
```

Required store-port operations may include:

```ts
findMemoryCandidateCommitReceipt(
  sessionId: string,
  fingerprint: string
): Promise<MemoryCandidateCommitReceipt | undefined>;

insertMemoryCandidateCommitReceipt(
  receipt: MemoryCandidateCommitReceipt
): Promise<void>;
```

Do not store provider-native hook payloads in this table.

---

# 16. Doctor / status / init

P8 extends project diagnostics.

Human output should expose effective behavior, for example:

```text
Implicit Recall      OK      lexical
Implicit Remember    OK      conservative
```

or:

```text
Implicit Remember    OFF     default; existing project config has not opted in
```

or:

```text
Implicit Remember    ERROR   invalid mode; effective mode is off
```

Machine-readable output should include at least:

```ts
{
  configuredMode?: "off" | "conservative";
  effectiveMode: "off" | "conservative";
  source: "explicit" | "default" | "invalid";
  error?: string;
}
```

`memory-space init` for a newly initialized project SHOULD write:

```json
"implicitRemember": { "mode": "conservative" }
```

Existing config files MUST remain valid without manual migration.

---

# 17. Canonical acceptance scenarios

## 17.1 Automatic opaque-key remember — mandatory

Project config:

```json
{
  "implicitRemember": { "mode": "conservative" },
  "implicitRecall": { "mode": "exact" }
}
```

User prompt in Session A:

```text
CROSS_AGENT_TEST_20260817 = lavender-731
```

After reliable assistant Stop:

```text
user SessionEvent persisted
assistant SessionEvent persisted
implicit remember runs automatically
one active Indexed Memory exists:
  key = CROSS_AGENT_TEST_20260817
  content contains lavender-731
no explicit memory_remember tool call required
no Checkpoint created
no Handoff created
Session.lastCheckpointEventId unchanged
```

Then Session B submits:

```text
CROSS_AGENT_TEST_20260817
```

P7 exact recall must be able to disclose the automatically created Indexed Memory.

This is the required P7 + P8 end-to-end closure scenario.

## 17.2 Natural deterministic decision

User:

```text
项目已经决定使用 pnpm 作为包管理器。
```

If the current deterministic extractor emits a decision candidate:

```text
implicit remember accepts it only with user evidence
resulting Memory tier = indexed
```

Even if the candidate recommends Core, implicit remember MUST NOT create Core directly.

A later checkpoint may promote according to the frozen Core admission policy.

## 17.3 Replayed Stop

Deliver the same logical assistant-turn trigger twice.

Expected:

```text
one candidate fingerprint
one receipt
one Memory identity
no duplicate create/update side effect
provider lifecycle continues normally
```

## 17.4 Later checkpoint over same evidence

After scenario 17.1 or 17.2, invoke SessionEnd.

Expected:

```text
checkpoint processes the same source SessionEvents
matching receipt is found
same Memory identity reused
no duplicate Memory row
checkpoint candidate audit still recorded
Handoff still generated
lastCheckpointEventId advances only here
```

## 17.5 User write opt-out

User:

```text
不要记住这次内容。
CROSS_AGENT_TEST_20260817 = secret-value
```

Expected:

```text
SessionEvents persist normally
PromptRememberDirective = disable_for_turn
no implicit candidate commit
no receipt
no Indexed Memory created by P8
provider flow continues
```

A later explicit checkpoint may still process the persisted evidence unless the product separately adds a durable "never persist this event" privacy semantic. P8 v1 opt-out governs implicit remember only.

## 17.6 Assistant repetition of recalled Memory

Given P7 recalled historical content is injected and the assistant repeats it in the final answer without the user restating the fact:

```text
assistant-only extracted candidate
  -> rejected by P8 user-evidence rule
```

No new Memory and no receipt are created solely from the assistant repetition.

## 17.7 Existing Core key collision

Given active Core Memory with key `project.primary_goal`, an implicit candidate targets the same key.

Expected:

```text
implicit remember does not mutate Core
rejection reason = existing_core_memory
checkpoint remains responsible for later reconciliation
```

## 17.8 Mode off

Config:

```json
"implicitRemember": { "mode": "off" }
```

Expected:

```text
SessionEvents persist
implicit remember returns effectiveMode=off
no extraction/commit side effect
```

## 17.9 Missing config on existing project

Existing v1/P7 config has no `implicitRemember` field.

Expected:

```text
effective mode = off
source = default
no automatic durable writes
config remains valid
```

## 17.10 Invalid config

Invalid `implicitRemember.mode`.

Expected:

```text
Space binding usable
effective mode = off
no Memory disclosure/write side effect from P8
doctor/status error
provider lifecycle continues
```

---

# 18. Evaluation metrics

P8 must add a small deterministic evaluation suite.

Required metrics:

```text
Implicit Remember Precision
= accepted candidates judged durable / all implicitly accepted candidates
Target for frozen deterministic fixtures: 1.0

Implicit Core Write Rate
= Memories newly written to Core directly by implicit remember / implicit commits
Target: 0.0

Same-Evidence Duplicate Rate
= duplicate Memory rows caused by Stop + later checkpoint over the same source events
Target: 0.0

Replay Duplicate Rate
= duplicate side effects after repeated identical Stop delivery
Target: 0.0

Assistant-Only Persistence Rate
= assistant-only candidates accepted by P8 v1
Target: 0.0

Lifecycle Blocking Failure Rate
= implicit remember failures that block provider assistant completion
Target: 0.0
```

Required fixture categories:

- opaque stable assignment;
- natural durable decision;
- transient execution narration;
- assistant-only repetition;
- P7 recalled-content repetition;
- opt-out phrase;
- invalid config;
- replayed Stop;
- Stop then SessionEnd checkpoint;
- existing Core key collision;
- Space binding mismatch/cwd drift.

---

# 19. Implementation boundaries

Expected primary implementation areas:

```text
src/binding/project-config.ts
  -> ImplicitRememberMode / configuration resolver

src/binding/space-resolver.ts
  -> expose resolved implicitRemember configuration

src/integration/implicit-remember.ts
  -> NEW service + bounded orchestration

src/integration/prompt-remember-directive.ts
  -> NEW deterministic per-turn opt-out policy

src/integration/lifecycle-handler.ts
  -> call implicit remember after persisted assistant_turn

src/ports/extractor.ts
  -> generalize ExtractionContext away from checkpoint-only naming

src/adapters/rule-based-extractor.ts
  -> stable opaque assignment rule
  -> preserve existing durable/transient rules

src/application/memory-space.ts
  -> shared extractor-candidate commit path
  -> implicit Indexed-only commit semantics
  -> receipt-aware checkpoint reuse

src/ports/store.ts
  -> candidate receipt contract

src/adapters/sqlite/migrations.ts
src/adapters/sqlite/sqlite-store.ts
  -> durable receipt storage

doctor/status/init implementation
  -> expose/configure P8 mode

test/*
  -> unit/integration/e2e coverage
```

Do not move provider-specific logic into `MemorySpace`.

---

# 20. Recommended implementation order

Implement P8 as vertical slices rather than one large refactor.

## P8.1 — Configuration + diagnostics

```text
ImplicitRememberMode
resolver
SpaceBinding exposure
init
doctor/status
tests
```

Gate:

```text
missing => off
explicit conservative => conservative
invalid => off + diagnostic
```

## P8.2 — Service skeleton + lifecycle

```text
ImplicitRememberService
prompt write opt-out
assistant_turn hook integration
bounded event selection
fail-open diagnostic
```

Gate:

```text
no Memory mutation yet needed to prove lifecycle ordering
assistant event persists before implicit remember
failure cannot block provider flow
```

## P8.3 — Deterministic extraction + admission

```text
reuse MemoryExtractor
stable opaque assignment rule
user-evidence rule
confidence threshold
Indexed-only policy
Core collision rejection
```

Gate:

```text
CROSS_AGENT_TEST_20260817 = lavender-731
creates active Indexed Memory automatically
```

## P8.4 — Candidate receipt + checkpoint convergence

```text
migration
store port
fingerprint helper
shared candidate commit path
implicit commit receipt
checkpoint receipt reuse
```

Gate:

```text
Stop replay => one Memory
Stop + SessionEnd => one Memory
checkpoint/Handoff semantics unchanged
```

## P8.5 — Real provider smoke + cross-session closure

For each provider that already supports reliable assistant-turn capture:

```text
Session A normal prompt
  -> no explicit memory_remember
  -> automatic Indexed Memory

Session B prompt with bare key
  -> P7 implicit recall
  -> correct value reaches final answer
```

Record provider/version/config and PASS/BLOCKED evidence in a quality report.

---

# 21. Completion gate

P8 is complete only when all of the following are true:

```text
[ ] implicit remember is project-configurable
[ ] existing configs remain auto-write-off by default
[ ] new init config exposes conservative mode explicitly
[ ] reliable assistant_turn triggers P8 only after SessionEvent persistence
[ ] P8 lifecycle failures are fail-open
[ ] user can disable implicit remember for one turn
[ ] deterministic opaque assignment auto-creates Indexed Memory
[ ] implicit remember cannot directly create/promote/mutate Core
[ ] assistant-only candidates are rejected
[ ] recalled-memory repetition cannot self-reinforce through assistant output
[ ] replayed Stop is idempotent
[ ] Stop + later checkpoint does not duplicate Memory
[ ] checkpoint boundary/Handoff behavior is unchanged
[ ] P7 can implicitly recall an Indexed Memory created by P8
[ ] doctor/status exposes effective P8 configuration
[ ] unit + integration + real-provider smoke coverage passes
```

Frozen product statement after P8:

> P7 makes relevant Indexed Memory automatically recallable at prompt time. P8 makes conservative durable user-provided project knowledge automatically storable at turn time. Together they establish the first provider-neutral `conversation -> durable Indexed Memory -> cross-session implicit recall` loop without depending on model-initiated Memory MCP calls.
