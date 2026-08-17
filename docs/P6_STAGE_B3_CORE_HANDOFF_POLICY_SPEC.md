# P6 Stage B3 — Core / Handoff Pollution Policy Spec

**Status:** COMPLETE / REVIEW PASS / FROZEN
**Phase:** P6 Stage B3
**Reviewed B2 head:** `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
**Prerequisites:** Stage A, Stage B1, and Stage B2 COMPLETE / REVIEW PASS / FROZEN
**B4:** DEFERRED TO V2
**Related:** `MEMORY_QUALITY_V1_SPEC.md`, `P6_STAGE_B2_EXTRACTION_SPEC.md`, `quality/P6_STAGE_B2_RESULT.md`, `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`

> Spec review passed at `b3ce4219cde8c07eae7a4af2eb9c67c2de096231`
> and authorized the scoped implementation recorded by
> `quality/P6_STAGE_B3_RESULT.md`. The normative boundaries below remain the
> reviewed and frozen implementation contract. B4 semantic retrieval/dedup is
> deferred to v2 by ADR 0004.

---

## 1. Problem statement

Stage B2 answers whether a message contains durable Memory. B3 asks a separate
question:

> Given a valid durable Memory, should it occupy default Core context, appear in
> the latest cross-Session Handoff, or remain available only through Indexed
> recall?

The frozen B2 evaluator measures one concrete admission failure:

```text
Task: Remove the temporary debug log after this run.

extraction classification   durable state/task (accepted)
current automatic tier      Core
current Handoff facts       activeTasks + nextSteps
ground-truth tier            Indexed
```

The extraction is not the bug. The cleanup obligation can be worth remembering,
while still being too local and short-lived for persistent default context.
Durability, Core value, and Handoff value are distinct policy decisions.

## 2. Frozen B3 before-state

B3 must capture its machine-readable before-state from the frozen B2 reviewed
head `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`. It must not regenerate Stage A,
B1, or B2 accepted evidence through a B3 candidate implementation.

Current measured input:

| Dimension | Frozen B2 value |
| --- | ---: |
| Core pollution | 0.111111 (1/9) |
| Polluted Core key | `task.temporary-debug-cleanup` |
| Bootstrap critical coverage | 1.000000 (7/7) |
| Bootstrap unexpected default keys | 1 |
| Handoff required-fact coverage | 1.000000 (9/9) |
| Handoff missing facts | 0 |
| Handoff unexpected facts | 2 |
| Extraction TP / FP / FN | 6 / 0 / 0 |
| Extraction precision / recall | 1.000000 / 1.000000 |
| Hard correctness | PASS |

The two unexpected Handoff facts are:

```text
activeTasks:Remove the temporary debug log after this run.
nextSteps:Remove the temporary debug log after this run.
```

The current B1 retrieval, negative retrieval, stale, duplicate, and contradiction
values are frozen non-regression inputs in section 14.

## 3. Scope

B3 owns only deterministic, provider-neutral default-context policy:

```text
candidate → automatic tier admission
active Memory → Core eligibility
Core Memory → Handoff inclusion
status/tier transition → next bootstrap and Handoff
explicit promotion/demotion interaction with automatic policy
```

B3 may implement, after review:

- a small pure Core admission policy;
- a small pure Handoff inclusion policy;
- the existing type, key, status, recommendation, and promotion-reason gates,
  minus one bounded-local automatic-admission override;
- reason-aware prospective admission for extractor evidence that matches an
  existing Memory, including the equivalent/deduplicate path;
- durable automatic/explicit-agent/explicit-user promotion provenance through
  the existing history operation channel;
- audit-only reporting for persisted importance and confidence metadata;
- deterministic fresh-store and seeded-upgrade tests plus a B3-specific frozen
  comparison;
- minimal `MemorySpace` wiring required to apply those policies.

## 4. Non-goals and frozen boundaries

B3 must not modify:

```text
frozen B1 lexical retrieval or MemorySpace.search ordering
frozen B2 extraction grammar or transient rejection
Stage A/B1/B2 fixtures, snapshots, labels, or acceptance contracts
Memory domain types or storage schema
Space binding or Session identity
provider adapters or lifecycle normalization
checkpoint trigger/boundary/idempotency semantics
the exact six MCP tools or their schemas
P3 Claude real-MCP scoped waiver
```

B3 does not authorize embeddings, a vector database, semantic deduplication,
query expansion, reranking, an LLM durability judge, a learned classifier,
weighted ML scoring, complex decay, or background timed demotion. B4 remains
unauthorized.

B3 v1 also does not authorize a startup migration, background sweep, or
retroactive tier reconciliation of Memory already persisted as Core by a prior
release. That migration is a non-goal, but upgrade behavior is not allowed to be
untested: sections 7.5, 10, 11, 12, and 15 define a separate seeded-upgrade
regression contract.

No B3 implementation may solve admission pollution by changing what the frozen
B2 extractor emits.

## 5. Current production policy

This section describes the reviewed code at `e0ff2ac`; it is the before-state,
not the B3 proposal. The implementation source is
[`../src/application/memory-space.ts`](../src/application/memory-space.ts); the
current transition/Handoff regressions are in
[`../test/bootstrap.test.ts`](../test/bootstrap.test.ts) and
[`../test/hardening.test.ts`](../test/hardening.test.ts).

### 5.1 Candidate to persisted tier

Checkpoint processing currently performs:

```text
MemoryExtractor.extract(events)
        ↓
#validateCandidate
  recommendedTier becomes validated memory.tier
  importance defaults to 0.5
  confidence defaults to 1.0
        ↓
#candidateTier
        ↓
#commitMemory
```

`MemorySpace.#candidateTier(...)` chooses Core only when all three conditions are
true:

```text
candidate.recommendedTier === "core"
candidate.promoteReason is non-empty
#coreEligible(candidate) is true
```

Otherwise it chooses Indexed. `importance` and `confidence` are validated and
persisted but do not currently participate in automatic tier admission.

`#coreEligible(...)` currently accepts these types:

```text
goal roadmap progress task blocker decision constraint convention
question rule instruction
```

It also accepts a `fact` with a non-empty stable key. An unkeyed fact is not
automatically or agent-promotably Core under this predicate.

New non-active Memory is forced to Indexed. Updating equivalent keyed Memory can
promote an existing Indexed item when the extractor candidate requests Core.
Updating changed keyed Memory preserves the existing tier unless the extractor
requests and passes Core admission. Core capacity defaults to 64 active items and
is enforced on creation and promotion.

Conversely, an Indexed extractor decision does not currently demote an existing
Core Memory. Equivalent content returns through the deduplicate path without
re-applying an Indexed admission decision. These before-state behaviors are the
prospective update gap addressed in sections 7.7 and 7.8.

### 5.2 Explicit remember, promote, demote, and status

`remember()` rejects a caller-supplied tier and persists new explicit Memory as
Indexed. The HTTP and MCP promotion adapters fix the actor to `agent`; agent
promotion requires an active Memory, a reason, `#coreEligible`, and remaining
capacity. Trusted in-process `actor: "user"` promotion may override the type
eligibility check but still requires active status and capacity.

`demote()` changes Core to Indexed. Setting status to resolved, superseded, or
archived also forces Indexed. These transitions invalidate bootstrap cache.

The current `#changeTier(...)` path records every Indexed-to-Core tier change as
the same generic history operation, `promote`. It does not durably distinguish
an extractor-driven automatic promotion from `memory_promote` or a trusted
in-process user promotion. Therefore existing generic `promote` history is
ambiguous and cannot prove explicit continuation intent under B3.

### 5.3 Current bootstrap

`bootstrap()` renders every active Core Memory, deterministically ordered by
type, key, and id, into fixed sections. It then renders the latest Handoff
Snapshot. Indexed Memory remains available through explicit search/context and
is not default bootstrap content.

### 5.4 Current Handoff snapshot

`MemorySpace.#buildSnapshot(...)` reads all active Core Memory and projects:

| Snapshot field | Current source |
| --- | --- |
| `goal` | last active Core `goal` |
| `activeTasks` | all active Core `task` content |
| `decisions` | all active Core `decision` content |
| `blockers` | all active Core `blocker` content |
| `openQuestions` | all active Core `question` content |
| `nextSteps` | `data.nextStep(s)` from any active Core plus all active Core tasks |
| `completed` | every resolved task whose history shows it was ever Core |

Active Core `progress`, constraints, conventions, rules, instructions, roadmap,
and keyed facts are present in bootstrap but are not directly projected into a
named Handoff field. A resolved former-Core task is absent from active Core and
active tasks, but `#wasEverCore(...)` keeps it in `completed`. A resolved task
that was always Indexed does not enter Handoff.

The actual flow is:

```text
MemoryCandidate
      ↓ recommendedTier + promoteReason
#candidateTier + #coreEligible + Core capacity
      ↓
active Core or Indexed Memory
      ↓
#buildSnapshot(active Core + resolved task history)
      ↓
latest Handoff Snapshot
      ↓
bootstrap(Core sections + latest Handoff)
```

## 6. B3 v1 policy principles

The candidate policy must remain small, deterministic, offline, explainable,
provider-neutral, and case-testable.

1. Durable does not imply Core.
2. Core is scarce default context; Indexed is successful durable retention, not
   rejection.
3. Handoff is a continuation view, not a synonym for every Core item.
4. Type and status establish the base rule; bounded-local scope may make a
   durable working-state item Indexed.
5. Importance and confidence remain validated, persisted audit metadata. B3 v1
   does not use them to admit, reject, rank, demote, or reconcile Memory.
6. Explicit promotion is the escape hatch for a reviewed Memory that automatic
   policy conservatively leaves Indexed.
7. Provider payload must never select tier, actor, or Handoff fields directly.
8. A new or unknown signal cannot promote an otherwise ineligible item. For a
   working-state candidate already accepted as durable by frozen B2, absence of
   explicit bounded-local evidence preserves the reviewed type rule; B3 does not
   reinterpret that absence as an extraction failure.
9. Upgrade must be observable and no-clobber: opening an existing store cannot
   silently rewrite legacy Core rows, their history, or their last stored
   Handoff Snapshot.
10. Trusted explicit continuation intent must have durable, unambiguous
    provenance. Legacy or unknown promotion provenance fails closed.
11. Passive legacy state is preserved, but every new post-B3 extractor
    transition is governed prospectively by the B3 admission decision.

## 7. Proposed deterministic Core admission policy

This proposal passed B3 spec review and is the authorized B3 implementation policy.

### 7.1 Admission result

A future pure policy should return an auditable decision such as:

```ts
type CoreAdmissionDecision =
  | { tier: "core"; reason: "eligible" }
  | {
      tier: "indexed";
      reason:
        | "bounded-local"
        | "not-recommended"
        | "missing-promotion-reason"
        | "type-ineligible";
    };
```

This is an internal design shape, not a frozen public domain type or TypeScript
API. The semantic reason categories are normative. They let persistence wiring
distinguish a measured negative override from a candidate that merely lacks
positive automatic-admission evidence.

Reason selection is deterministic. For a working-state candidate, explicit
bounded-local scope produces `bounded-local` even if recommendation or promotion
reason is also absent. Otherwise the checks proceed as
`not-recommended` → `missing-promotion-reason` → `type-ineligible` → `eligible`.
The reason describes Core admission only; it does not re-evaluate B2 durability.

### 7.2 Stable-context types

When active, recommended Core, accompanied by a promotion reason, and accepted
by the existing `#coreEligible(...)` predicate, these remain automatic Core
candidates:

```text
goal
roadmap
decision
constraint
convention
rule
instruction
keyed stable fact
```

Unkeyed facts remain automatically Indexed because that is the existing
eligibility rule. Episodes remain ineligible. B3 v1 adds no new positive
admission signal and no importance/confidence threshold for these types.

### 7.3 Working-state types

`task`, `progress`, `blocker`, and `question` require a separate working-state
admission rule:

- a deterministic bounded-local scope result forces automatic Indexed;
- otherwise the existing type/recommendation/reason gates remain available;
- keyed current slots such as `project.progress.current` are strong evidence for
  current default context, not proof that all progress should be Core;
- explicit trusted promotion may override automatic Indexed for an eligible,
  active working-state Memory.

For B3 v1, bounded-local scope is a negative admission override, not a second
extractor. It may inspect candidate-local normalized type/key/content and trusted
operation history, but it must never emit, rewrite, ignore, or reclassify a
Memory. The classifier must use a small structural category such as an explicit
single run/command/tool/test/turn scope, not a growing domain-word stoplist.

The frozen example therefore becomes:

```text
Remove the temporary debug log after this run.
→ durable task persists
→ bounded-local admission
→ Indexed
→ absent from default Core and Handoff
→ explicitly searchable
```

An active high-level migration or rollout task without bounded-local scope keeps
the current automatic Core behavior so critical bootstrap coverage does not
regress.

The complete B3 v1 automatic decision is intentionally minimal:

```text
working-state type has bounded-local scope   → Indexed / bounded-local
recommendedTier is not Core                  → Indexed
promoteReason is empty                       → Indexed
existing #coreEligible(...) is false         → Indexed
otherwise                                    → Core
```

Status remains enforced by the existing commit/status transition rules, and
Core capacity remains enforced separately. Key presence matters only where the
existing eligibility predicate already uses it, currently for `fact`. No
absence of bounded-local evidence, score, or metadata field can independently
promote a candidate.

### 7.4 Importance and confidence are audit-only

B3 v1 must continue validating and persisting `importance` and `confidence`, so
operators and later evaluations can inspect them. It must not introduce
`importance >= 0.8`, `confidence >= 0.8`, or any other automatic admission
threshold. The frozen B3 failure supplies no measured evidence for those new
variables, and adding them would make the cleanup fix inseparable from an
unmeasured policy change.

Any future use of importance/confidence as policy input requires a separately
reviewed B3.x proposal, an independent measured failure, holdouts, and a new
before-state. It must not be introduced while implementing this spec merely to
improve an aggregate metric.

### 7.5 Pre-existing Core upgrade semantics

B3 v1 evaluates automatic admission for every new extractor candidate processed
after B3 is active, including a candidate that creates, updates, or deduplicates
against an existing semantic Memory. It does not rescan or automatically demote
a Memory merely because that Memory was already Core when the B3 runtime opened
its store. Reopening, `bootstrap()`, search, and ordinary reads must be
side-effect-free with respect to that Memory's tier, version, and history.

The Core tier and the Handoff Snapshot have different upgrade semantics:

| Upgrade point | Required B3 v1 behavior |
| --- | --- |
| open a B2-created store | preserve all Memory rows, tiers, versions, history, and the identity and field values of the stored latest Handoff; perform no replacement or update |
| bootstrap before a new checkpoint | legacy active Core is still rendered; the last pre-B3 Handoff is still the latest stored Snapshot |
| first successful B3 checkpoint with no matching new Memory evidence | do not rewrite the legacy tier merely because the runtime was upgraded; build a new Snapshot with the B3 Handoff inclusion policy |
| post-B3 extractor evidence that matches an existing Memory | apply the prospective transition matrix in section 7.7, including on the equivalent/deduplicate path |
| explicit demotion or non-active status transition | use the existing trusted transition; subsequent bootstrap/snapshots no longer disclose the item as active Core |

Consequently, a cleanup task that was already Core under B2 remains Core and can
remain visible in Core bootstrap until a normal demotion or status transition.
After the first B3 checkpoint, however, a newly built Handoff must exclude that
bounded-local legacy task because Handoff inclusion is independently evaluated.
The old pre-B3 Snapshot is immutable historical evidence; it is not rewritten.

Fresh-store B3 quality evaluation must still prove that the same cleanup task is
admitted as Indexed. A separate seeded-upgrade evaluation must prove the behavior
above. The fresh-store improvement must never be reported as retroactively
cleaning a user's existing Core state.

### 7.6 Promotion provenance invariant

B3 must not infer trusted explicit promotion intent from the legacy generic
`MemoryHistoryRecord.operation === "promote"`. That operation is ambiguous: it
may have been written by extractor automatic promotion, explicit agent
promotion, trusted user promotion, or an earlier implementation path. A legacy
generic `promote`, a missing record, and an unknown promotion identity all fail
closed and must not:

- override bounded-local automatic admission;
- make a bounded-local Core Memory eligible for Handoff continuation;
- prove that an agent or user intentionally requested persistent continuation.

After B3, every successful new Indexed-to-Core promotion must durably identify
one of these semantic provenance categories:

| Semantic provenance | Source | Trusted explicit continuation intent? |
| --- | --- | --- |
| `AUTOMATIC` | extractor admission promotes an existing Indexed Memory | no |
| `EXPLICIT_AGENT` | `memory_promote` / trusted adapter path after agent eligibility, reason, ownership, status, and capacity checks | yes |
| `EXPLICIT_USER` | trusted in-process user promotion after status and capacity checks | yes |
| `AMBIGUOUS_LEGACY` | legacy generic `promote`, missing provenance, or unknown identity | no; fail closed |

The semantic category is frozen; the concrete operation strings are an
implementation choice. B3 must persist distinct operation identities through
the existing extensible `MemoryHistoryRecord.operation` channel. It must not add
a Memory field, database column, or domain schema field, and it must not infer
provenance later from free-form reason text, source event ids, or caller data.
A direct extractor-created Core Memory is automatic admission, never explicit
override evidence, regardless of the history operation used for creation. B3 v1
establishes an override only through a successful Indexed-to-Core explicit
transition. An idempotent promotion request for a Memory already in Core does not
create override evidence.

Promotion provenance is used only to determine whether a durable working-state
Memory has trusted continuation intent. It must not call the extractor again,
change family/type/content, or reclassify durability.

A trusted explicit promotion intent is effective only for the semantic Memory
state on which it was recorded. It survives later extractor evidence that is
equivalent under the existing deterministic deduplicate relation. It is
invalidated by explicit demotion, a non-active status transition, supersession,
or a changed-content update representing a new semantic state. Historical
records remain immutable; “invalidated” means they no longer authorize a current
override.

### 7.7 Prospective admission for existing Memory

Passive legacy preservation ends when new extractor evidence attempts to create,
update, or deduplicate the same active semantic Memory. That is a new admission
event governed by current B3 policy, not a retroactive migration. The decision
must be evaluated before both the changed-content update path and the
equivalent-content deduplicate path.

The following tier transition matrix is normative:

| Existing tier | New admission reason | Additional state | Required tier result |
| --- | --- | --- | --- |
| Indexed | `eligible` | active candidate | Core; any Indexed-to-Core transition has `AUTOMATIC` provenance |
| Indexed | any Indexed reason | — | remain Indexed |
| Core | `eligible` | — | remain Core |
| Core | `bounded-local` | changed content/new semantic state | Indexed; any older explicit intent is invalid for the new state |
| Core | `bounded-local` | equivalent content and effective B3 `EXPLICIT_AGENT` or `EXPLICIT_USER` intent | remain Core; preserve the trusted override |
| Core | `bounded-local` | equivalent content without effective trusted intent, including `AUTOMATIC` or `AMBIGUOUS_LEGACY` history | Indexed |
| Core | `not-recommended` | — | preserve Core; absence of a new recommendation is not demotion evidence |
| Core | `missing-promotion-reason` | — | preserve Core; absence of a new reason is not demotion evidence |
| Core | `type-ineligible` | no existing schema conflict | preserve Core; ineligibility alone is not an implicit demotion command |
| Core | `type-ineligible` | existing key/family/type invariant would be violated | reject and roll back using the existing schema-conflict behavior |

“Same semantic Memory” uses the existing trusted target/key resolution and
deduplicate relation; B3 must not introduce semantic matching. An extractor
candidate whose operation is `create` may still resolve to an existing keyed or
equivalent Memory and is then governed by this matrix. `ignore` performs no
transition. `supersede`, explicit demotion, and non-active status remain
authoritative domain transitions rather than admission reasons.

Equivalent content is not permission to skip policy. In particular:

```text
existing automatic/legacy Core
+ new equivalent bounded-local extractor evidence
→ evaluate bounded-local
→ no effective trusted explicit intent
→ Indexed
```

Conversely:

```text
bounded-local durable task
→ automatic Indexed
→ trusted explicit promotion to Core
→ new equivalent bounded-local extractor evidence
→ explicit intent remains effective
→ preserve Core and Handoff continuation
```

### 7.8 Transition precedence

B3 v1 resolves competing transitions in this order:

```text
authoritative status transition or supersession
        ↓
explicit demotion
        ↓
effective B3 EXPLICIT_AGENT / EXPLICIT_USER intent for equivalent state
        ↓
automatic B3 admission for new extractor evidence
        ↓
passive legacy Core preservation when there is no new matching evidence
```

This precedence prevents an ordinary equivalent checkpoint observation from
undoing a trusted explicit action. It does not let explicit promotion bypass
status, Space ownership, type eligibility applicable to that actor, Core
capacity, or supersession. A changed semantic state invalidates the older
promotion intent before its new admission decision is applied.

## 8. Type-specific semantics

### 8.1 Goals, decisions, and constraints

- a primary active goal belongs in Core and supplies the Handoff goal;
- active architecture/project decisions belong in Core and Handoff decisions;
- active project constraints/conventions belong in Core bootstrap;
- constraints are not copied into an unrelated Handoff field merely because
  they are Core.

### 8.2 Tasks

- a short-lived bounded cleanup task is Indexed and absent from Handoff;
- an important cross-Session project task is Core and appears in both
  `activeTasks` and `nextSteps`;
- setting the task non-active forces Indexed and removes it from active task/next
  step fields at the next checkpoint;
- B3 v1 preserves the existing `wasEverCore` completed-task behavior unless the
  frozen comparison demonstrates completed-history pollution;
- an always-Indexed resolved task remains explicit-recall history only.

### 8.3 Progress

Progress is not equivalent to completed work. B3 v1 should keep a canonical,
active project-wide current-progress slot eligible for Core bootstrap.
Bounded-local progress is automatically Indexed. An unkeyed, non-bounded
progress candidate continues to follow the existing recommendation, reason, and
type eligibility gates; B3 v1 does not add key presence as a new progress gate.
Progress does not enter Handoff `completed`; only resolved former-Core tasks do.
Progress `data.nextStep(s)` cannot feed Handoff under the whitelist in section
9.1.

### 8.4 Blockers

A persistent project/release blocker is Core and appears in Handoff while active.
A bounded local operation blocker is Indexed and absent from Handoff even though
it remains searchable. Resolution forces Indexed and removes the blocker from
the next snapshot. Automatic blocker admission must not be based on the word
`blocker` alone when explicit bounded-local scope is present.

### 8.5 Explicit promotion

Automatic admission protects the default context. `memory_promote` remains the
intentional override for an agent that can identify a cross-Session need and
provide a reason. It must continue to enforce Session Space ownership, active
status, deterministic type eligibility, Core capacity, and trusted actor
selection. Promotion does not bypass status or Space isolation.

For eligible tasks/blockers/questions, a successful B3 promotion with durable
`EXPLICIT_AGENT` or `EXPLICIT_USER` provenance is sufficient continuation intent
for Handoff inclusion while active. A generic legacy `promote` record is not.
Demotion reverses default Core/Handoff disclosure at the next snapshot without
deleting Indexed recall and invalidates earlier explicit intent.

## 9. Handoff is an independent policy

B3 must make Handoff inclusion explicit instead of treating it as an accidental
side effect of a broad Core type list.

Proposed v1 projection:

| Memory state | Bootstrap Core | Handoff |
| --- | --- | --- |
| active primary goal | yes | `goal` |
| active Core decision | yes | `decisions` |
| active Core constraint/convention | yes | no unrelated projection |
| active cross-Session task | yes | `activeTasks` + `nextSteps` |
| active bounded-local task | no, Indexed | no |
| resolved former-Core task | no, Indexed | `completed`, preserving current v1 history rule |
| resolved always-Indexed task | no | no |
| active persistent blocker | yes | `blockers` |
| active bounded-local blocker | no, Indexed | no |
| active canonical progress | yes | no direct completed projection |
| active project-wide question | yes | `openQuestions` |

This keeps Core and Handoff related but not identical. Handoff policy consumes
trusted persisted state and policy results; it never consumes provider-selected
Handoff fields.

### 9.1 `nextSteps` type and source whitelist

The current projection accepts `data.nextStep` or `data.nextSteps` from any
active Core Memory. B3 v1 replaces that broad behavior with this exhaustive
whitelist:

```text
contributing Memory type       task only
required state                 active + Core + eligible for Handoff continuation
accepted persisted source      checkpoint-extracted task candidate, or
                               explicitly remembered task followed by a trusted
                               successful promotion
accepted value source          that same task's content, data.nextStep, or
                               data.nextSteps
accepted value shape           non-empty string, or array elements that are
                               non-empty strings
```

The whitelist is evaluated from trusted persisted Memory and its normal
transition/provenance history. Raw lifecycle/provider payload, an uncommitted
extractor candidate, or caller-selected Handoff fields are never projection
inputs. `data.nextStep(s)` is output data only: it cannot help a Memory become
Core or Handoff-eligible.

For this policy, “eligible for Handoff continuation” means the persisted active
Core task either has no bounded-local scope under the same B3 classifier, or has
currently effective B3 `EXPLICIT_AGENT` or `EXPLICIT_USER` provenance after
ordinary validation. Handoff does not need to reconstruct non-persisted
recommendation or promotion-reason inputs. Generic legacy `promote`, `AUTOMATIC`,
missing, and unknown provenance fail closed as bounded-local overrides. This
makes a project-wide auto-admitted task and an intentionally promoted task
eligible, while preventing a bounded-local legacy Core row from qualifying
merely because an older release assigned its tier.

An active Core `decision`, `constraint`, `fact`, `progress`, `goal`, `blocker`,
`question`, `convention`, `rule`, `instruction`, or `roadmap` must not contribute
`data.nextStep(s)`, even if its data object contains those property names. An
Indexed, inactive, or bounded-local task also contributes neither its content nor
its data. Task content and accepted task data are deduplicated in their existing
deterministic order.

This source rule does not add a provider-specific path or schema. Structured
Memory events remain compatible only after they have passed the frozen B2
extractor validation and the ordinary task admission path.

## 10. Required holdouts

These cases must be implemented only after this spec is approved.

| ID | Scenario | Required result |
| --- | --- | --- |
| C1 | durable primary goal | Core; bootstrap; Handoff goal |
| C2 | durable architecture decision | Core; bootstrap; Handoff decision |
| C3 | durable project constraint | Core bootstrap; no fabricated decision/task field |
| C4 | low-value durable fact | Indexed; explicit recall only |
| C5 | short-lived cleanup task | Indexed; absent from active Handoff and next steps |
| C6 | important cross-Session task | Core; active task + next step in Handoff |
| C7 | resolved task | Indexed; absent from active tasks/next steps; former-Core completion behavior preserved |
| C8 | persistent project blocker | Core; active Handoff blocker |
| C9 | bounded local blocker | Indexed; absent from Handoff |
| C10 | progress state | keyed current project progress Core; bounded-local progress Indexed; unkeyed non-bounded progress follows existing gates; never completed task or `nextSteps` source |
| C11 | explicit `memory_promote` | eligible active Indexed Memory can override automatic admission; ownership/capacity retained |
| C12 | demotion/resolution | next bootstrap/snapshot removes active disclosure; resolved former-Core task is completed only |
| C13 | Handoff next-step provenance | accepted active Core task content/data may contribute; Core decision/constraint/fact data with identical `nextStep(s)` cannot inject Handoff; inactive/Indexed tasks cannot contribute |
| C14 | B2-to-B3 seeded upgrade | opening/bootstrapping performs no tier/version/history/Snapshot rewrite; first B3 checkpoint with no matching new Memory evidence applies new Handoff projection without retroactive tier demotion; trusted demotion/status transition then removes active disclosure |
| C15 | automatic bounded-local task | cleanup task is durable but automatic admission is Indexed; no trusted explicit provenance; absent from Core and Handoff |
| C16 | explicitly agent-promoted bounded-local task | same task starts Indexed, then trusted `memory_promote` records `EXPLICIT_AGENT`; becomes Core and may contribute active task/next step at the next checkpoint |
| C17 | legacy ambiguous promotion | seeded B2 bounded-local Core has only generic `promote`; opening does not mutate tier, but the first B3 Handoff excludes it and the legacy record never counts as explicit override |
| C18 | trusted user promotion | eligible active Indexed task promoted in-process records `EXPLICIT_USER`; becomes Core and is eligible for Handoff continuation |
| C19 | changed-content existing-Core update | same active key changes from project-wide Core task to bounded-local task; new `bounded-local` decision applies prospectively and demotes to Indexed |
| C20 | equivalent existing-Core deduplicate | equivalent bounded-local extractor evidence re-runs admission; automatic/legacy Core demotes, so deduplicate cannot bypass B3 |
| C21 | non-bounded Indexed reasons on existing Core | `not-recommended` and `missing-promotion-reason` preserve Core; `type-ineligible` preserves or raises the existing schema conflict, never silently rewrites the type |
| C22 | explicit override precedence | equivalent bounded-local evidence preserves Core after effective `EXPLICIT_AGENT`/`EXPLICIT_USER`; changed semantic state, demotion, non-active status, or supersession invalidates that intent |

Independent paraphrases and Chinese/English variants must prove that a future
bounded-scope rule is structural rather than an exact fixture sentence patch.
Tests must also prove that the accepted B2 cleanup text remains extracted and
persisted as Indexed; B3 must not turn it into an extraction false negative.

## 11. Machine-readable B3 before-state

Before any B3 production change, add a dedicated immutable artifact such as:

```text
eval/quality/baselines/p6-stage-b2-core-handoff.json
```

Its source commit must be the frozen B2 reviewed head `e0ff2ac...`. At minimum it
must freeze:

```text
version and baseline id
source commit
ordered 20-Session scenario/step ids and evidence
expected logical Memory identities and shouldBeCore labels
criticalBootstrapKeys
expected Handoff facts
normalized ordered operation/source-mode plan for every step
expected checkpoint candidate operation (`create`, `update`, `supersede`, or
`ignore`) where extraction evidence defines a candidate
explicit-memory promote flag for every explicit Memory, including omitted flags
normalized to `false`
expected semantic promotion provenance (`AUTOMATIC`, `EXPLICIT_AGENT`,
`EXPLICIT_USER`, or `AMBIGUOUS_LEGACY`) for every promotion transition
ordered statusChanges with logical key, target status, and reason
active Core logical keys
polluted Core logical keys
bootstrap covered/missing/unexpected keys
observed Handoff facts
missing and unexpected Handoff facts
Core/Handoff/bootstrap counts and ratios
B1 retrieval and negative-query summary
B2 extraction TP/FP/FN and precision/recall
stale/duplicate/contradiction summary
hard-correctness check ids/statuses
seeded-upgrade Memory tier/version/history and latest-Handoff expectations
```

Array ordering is normative. Runtime UUIDs, temporary paths, wall-clock values,
and random database state must not enter the artifact.

The contract treats candidate operation, evaluator transition, and source mode
as separate fields rather than collapsing them into equivalent setup. It must
distinguish at least:

```text
source mode:          checkpoint message event | checkpoint structured Memory
                      event | explicit remember
candidate operation:  create | update | supersede | ignore
transition operation: checkpoint | remember | automatic promotion |
                      explicit agent promotion | explicit user promotion |
                      demote | status change
```

A step containing more than one operation freezes their execution order. A
missing `explicitMemories[].promote` value is normalized to `false` before the
contract is captured, so changing omitted/false to true is a mutation rather
than an evaluator default. `statusChanges` freezes its presence, order, logical
key, status, and reason. The source mode freezes whether equivalent Memory
ground truth arrived through a message event, a structured Memory event, or
explicit remember. The candidate operation freezes the extractor transition
intent independently of the evaluator transition that eventually persists,
promotes, or changes status. Those paths are not interchangeable benchmark
setup.

The frozen B2 upgrade seed must preserve the literal generic `promote` history
operation and normalize its semantic provenance only to `AMBIGUOUS_LEGACY`; the
baseline must not guess its origin. Candidate-side B3 transitions must record
their expected semantic provenance independently of concrete operation-string
names.

The baseline loader must reject wrong version/id/source commit and any mutation
of frozen metrics or per-case identities. Fixture-contract validation must occur
before candidate metric comparison and reject changed event text/order/set,
logical keys, type/family/key/content/status/Core labels, critical bootstrap set,
Handoff expected set, scenario set, explicit promote flag, `statusChanges`,
candidate operation, semantic promotion provenance, transition-operation order,
or source mode.

Mutation tests must independently prove rejection when they:

- toggle, add, remove, or rely on a changed default for an explicit promote
  flag;
- add, remove, reorder, or edit a status change;
- switch checkpoint-extracted input to explicit remember or the reverse;
- switch message-event and structured-Memory-event source modes;
- mutate `create`/`update`/`supersede`/`ignore` candidate operation;
- mutate automatic/explicit-agent/explicit-user/ambiguous-legacy provenance or
  reinterpret a legacy generic `promote` as trusted explicit intent;
- add, remove, or reorder a transition operation in a mixed-operation step;
- mutate the seeded-upgrade tier, version, history operation, or latest Handoff.

The artifact must carry two distinct lanes: a fresh-store B3 comparison and a
seeded B2-to-B3 upgrade-state contract. The upgrade seed is produced from the
frozen B2 reviewed behavior, not synthesized by the B3 policy under test.

Stage A retrieval and extraction snapshots remain byte-identical. B3 adds a new
baseline; it does not extend or rewrite accepted prior-phase artifacts.

## 12. B3-specific comparison

The B3 comparison has a distinct API/CLI identity:

```text
pnpm memory-space eval quality --compare-stage-b2-core-handoff
pnpm memory-space eval quality --compare-stage-b2-core-handoff --json
```

The human title must identify `P6 Stage B3 — Core/Handoff comparison`. It must not
reuse the B1 retrieval or B2 extraction comparison as B3 evidence.

The comparison must report:

```text
before/candidate Core item count and pollution rate
removed/new/unchanged polluted logical keys
before/candidate Handoff required coverage
removed/new/unchanged unexpected Handoff facts
new/unchanged missing required Handoff facts
bootstrap critical coverage and missing keys
extraction and retrieval non-regression values
hard-correctness result
C1–C22 results
seeded-upgrade preservation and post-checkpoint Handoff results
promotion-provenance and prospective existing-Core transition results
```

Contract mutation failures occur before candidate deltas are considered. The
human and JSON reports must label fresh-store improvement separately from legacy
upgrade state; they must not imply that B3 retroactively demoted old Core.

## 13. B3 acceptance philosophy

B3 does not define `Core pollution = 0` as a universal product SLO. Acceptance is
relative to the frozen reviewed before-state plus case-level correctness.

Minimum candidate gate:

```text
Core pollution rate strictly improves
polluted Core logical-key count strictly decreases
Handoff unexpected facts strictly decrease
no new polluted Core logical key
no new missing required Handoff fact
bootstrap critical coverage does not regress
Handoff required-fact coverage does not regress
all C1–C22 holdouts pass
seeded upgrade performs no read/startup mutation and follows section 7.5
legacy generic `promote` and unknown provenance fail closed
new automatic/explicit-agent/explicit-user promotions are durably distinguishable
post-B3 changed and equivalent existing-Memory transitions follow section 7.7
effective trusted explicit intent survives equivalent automatic evidence
only whitelisted active Core task sources contribute `nextSteps`
Core decision/constraint/fact data cannot inject `nextSteps`
B1 retrieval does not regress
B2 extraction does not regress
stale/duplicate/contradiction values do not regress
hard correctness PASS
exact six MCP tools preserved
provider-neutral behavior preserved
```

The expected first candidate delta is removal of the measured cleanup pollution,
not a benchmark-wide claim that all future pollution is solved.

## 14. Frozen non-regression values

Unless a separately reviewed fixture-validity issue is found, the B3 candidate
must preserve at least:

| Dimension | Frozen value |
| --- | ---: |
| Extraction TP / FP / FN | 6 / 0 / 0 |
| Extraction precision / recall | 1.000000 / 1.000000 |
| P@1 / R@1 | 0.727273 / 0.681818 |
| P@3 / R@3 | 0.303030 / 0.818182 |
| P@5 / R@5 | 0.180000 / 0.800000 |
| P@10 / R@10 | 0.090000 / 0.800000 |
| Negative FP / abstention | 0.000000 / 1.000000 |
| Bootstrap critical coverage | 1.000000 (7/7) |
| Handoff required coverage | 1.000000 (9/9) |
| Stale-memory rate | 0.000000 |
| Duplicate-memory rate | 0.500000 |
| Contradiction checks | 1.000000 |
| Hard correctness | PASS |

Metric aggregates do not replace case gates. A candidate that improves a ratio
by dropping a required goal, decision, task, or blocker fails.

## 15. Required tests after authorization

An implementation plan must include:

1. pure unit tests for Core admission and Handoff inclusion decisions;
2. C1–C22 integration holdouts, including non-task `data.nextStep(s)` injection
   rejection;
3. promotion provenance unit/integration tests for all four semantic categories,
   legacy fail-closed behavior, and invalidation boundaries;
4. prospective changed-content and equivalent/deduplicate transition-matrix
   tests, with and without effective trusted explicit intent;
5. fresh-store and seeded B2-to-B3 upgrade-state regressions;
6. existing promotion/demotion/status/wasEverCore regressions;
7. checkpoint and bootstrap cache-invalidation regressions;
8. dedicated baseline schema and independent mutation tests for promote flags,
   promotion provenance, status changes, operation order/source mode, and
   upgrade seed state;
9. per-case comparison and deterministic two-run tests;
10. full quality human/JSON and B3 comparison human/JSON;
11. `pnpm run check` and `pnpm run check:workspace`;
12. Codex P2 and Claude P3 smoke runner self-tests;
13. a production-boundary audit proving B1/B2/domain/storage/provider/MCP files
    remain unchanged.

Real provider smoke reruns are not required solely for provider-neutral admission
policy unless implementation review identifies provider-visible behavior outside
bootstrap/Handoff content.

## 16. Authorized implementation sequence

The reviewer authorized this sequence at the reviewed spec head. The candidate
must still stop for code review before B3 can be declared PASS or FROZEN.

```text
1. freeze B2 Core/Handoff before-state and fixture contract
2. add failing C1–C22, upgrade-state, provenance, transition-matrix, and mutation tests
3. implement a pure Core/Handoff policy module
4. add minimal MemorySpace admission, provenance-history, update, and snapshot wiring
5. run B3-specific comparison and full quality suite
6. document per-case deltas and limitations
7. stop for code review
```

If the accepted candidate cannot distinguish bounded-local from project-wide
working state without changing the frozen extractor contract, stop and request a
separate architecture review. Do not smuggle a new extraction grammar into B3.

## 17. Freeze boundaries inherited from B2

After B2 freeze, the following require a new architecture/phase review:

- adding natural-language extraction grammar;
- expanding the durable-subject vocabulary;
- adding a transient stoplist;
- modifying the Stage A extraction fixture;
- modifying the B2 extraction acceptance contract.

The conservative deterministic extraction boundary is an accepted v1 capability
boundary. B3 may decide disclosure for already-extracted Memory; it must not tune
extraction for additional natural-language recall.

## 18. Spec-review exit condition

Spec review passed after the reviewer determined:

- whether the proposed automatic Core gates are sufficiently small;
- whether bounded-local scope belongs in B3 admission without reopening B2;
- whether explicit promotion should override automatic admission as specified;
- whether audit-only importance/confidence is the correct minimal B3 v1 scope;
- whether legacy Core no-reconciliation semantics are explicit and adequately
  protected by the seeded-upgrade contract;
- whether generic legacy `promote` fails closed and new automatic/agent/user
  provenance is durably distinguishable without schema changes;
- whether prospective existing-Core update and deduplicate semantics use the
  admission reason without treating every Indexed result as a demotion;
- whether effective trusted explicit intent has correct precedence and
  invalidation boundaries;
- whether the task-only `nextStep(s)` type/source whitelist prevents indirect
  Handoff injection;
- whether the dedicated before/after contract prevents transition and fixture
  drift;
- whether C1–C22 and the delta gate protect critical context.

Final phase state:

```text
P6 Stage B3 = COMPLETE / REVIEW PASS / FROZEN
P6 Stage B4 = DEFERRED TO V2
```
