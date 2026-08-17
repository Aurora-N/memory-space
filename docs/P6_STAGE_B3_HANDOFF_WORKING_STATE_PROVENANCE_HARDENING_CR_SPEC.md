# P6 Stage B3 CR — Handoff Working-State Provenance Hardening

**Status:** CHANGES REQUESTED / NARROW HARDENING REQUIRED  
**Parent phase:** P6 Stage B3 — Core / Handoff Pollution Policy  
**Target branch:** `agent/memory-quality-v1`  
**Reviewed B3 implementation head:** `6677a4dc0bc8b005f7337593b83f4a3551a6660f`  
**Parent spec:** `docs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`  
**P6 Stage A / B1 / B2:** REVIEW PASS / FROZEN  
**P6 Stage B3:** CODE REVIEW CHANGES REQUESTED / NOT FROZEN  
**P6 Stage B4:** NOT AUTHORIZED

> This change request is a narrow B3 hardening pass. It closes one uncovered
> Handoff provenance gap for persisted working-state Memory. It does not reopen
> Core admission, extraction, retrieval, storage, or any earlier frozen phase.

---

## 1. Background

B3 intentionally separates three decisions:

```text
durable Memory extraction
        ↓
Core admission / retained tier
        ↓
Handoff continuation projection
```

The implementation correctly applies bounded-local admission to new candidates,
records distinct promotion provenance, and fails closed for a legacy bounded-local
Core **task** when building a new Handoff. It also correctly preserves legacy
Core rows on store open: B3 does not perform a startup migration or retroactive
tier demotion.

The reviewed parent spec defines working-state Memory as:

```text
task
progress
blocker
question
```

For eligible tasks, blockers, and questions, bounded-local state may enter a new
Handoff only when the current semantic state has effective, trusted explicit
continuation intent:

```text
EXPLICIT_AGENT
EXPLICIT_USER
```

These provenance categories are not trusted continuation intent:

```text
AUTOMATIC
AMBIGUOUS_LEGACY
missing or unknown provenance
```

The current implementation enforces this boundary only for tasks. Blockers and
questions are still projected from `activeCore` by type alone.

---

## 2. Review finding

### 2.1 Current task path is provenance-aware

`src/application/handoff-policy.ts` currently routes tasks through:

```ts
isHandoffContinuationTask(memory, history)
```

That predicate requires:

```text
type = task
status = active
tier = core
AND (
  state is not bounded-local
  OR current state has effective EXPLICIT_AGENT / EXPLICIT_USER promotion
)
```

`activeTasks` and `nextSteps` therefore fail closed for a bounded-local legacy
Core task whose only promotion record is generic `operation = "promote"`.

### 2.2 Current blocker/question paths bypass provenance

The same projection currently derives blockers and questions as:

```text
active Core + type blocker  → blockers
active Core + type question → openQuestions
```

These paths do not evaluate:

```text
bounded-local scope
promotion provenance
effective explicit continuation intent
legacy ambiguity
```

In addition, `MemorySpace.#buildSnapshot()` loads history only for active Core
tasks. A blocker or question cannot receive the provenance-aware decision even
if `HandoffPolicy` were changed to request it.

This is an architecture-policy mismatch: the parent B3 contract is
working-state-specific, while the current runtime guard is task-specific.

---

## 3. Problem reproduction

### 3.1 Legacy bounded-local blocker

Seed a B2-compatible persisted Memory and immutable history:

```text
Memory
  family  = state
  type    = blocker
  key     = operation.blocker.current-run
  content = "This command is blocked during this run."
  tier    = core
  status  = active

History
  create
  promote    ← generic legacy operation
```

The generic promotion maps to:

```text
AMBIGUOUS_LEGACY
```

Required upgrade behavior:

```text
open existing store
  → preserve Memory tier/version/history
  → preserve the already-stored latest Handoff

first successful B3 checkpoint with no matching Memory evidence
  → keep the legacy Memory Core
  → build a new Handoff
  → exclude content from Handoff.blockers
```

Current behavior incorrectly includes the content in `Handoff.blockers`.

### 3.2 Legacy bounded-local question

Seed the equivalent question case:

```text
Memory
  family  = state
  type    = question
  key     = operation.question.current-run
  content = "Which region should this run use?"
  tier    = core
  status  = active

History
  create
  promote    ← generic legacy operation
```

Required result after the first new B3 checkpoint:

```text
Memory remains Core
new Handoff.openQuestions excludes the content
```

Current behavior incorrectly includes the content in `openQuestions`.

### 3.3 Why existing tests do not catch it

The current suite covers two adjacent cases but not this intersection:

```text
fresh bounded-local blocker → Indexed / no Handoff       covered by C9
legacy bounded-local task   → Core retained / no Handoff covered by C17

legacy bounded-local blocker                            not covered
legacy bounded-local question                           not covered
```

The seeded upgrade evaluation is task-only, so the generic legacy promotion
fail-closed assertion does not exercise `blockers` or `openQuestions`.

---

## 4. Goal

Make Handoff continuation eligibility consistent for every directly projected
working-state type that requires provenance:

```text
task
blocker
question
```

The required invariant is:

```text
active + Core + directly projected working-state
AND (
  not bounded-local
  OR effective EXPLICIT_AGENT / EXPLICIT_USER intent
)
→ eligible for its Handoff field
```

For a bounded-local item:

```text
generic legacy promote / AUTOMATIC / missing / unknown
→ fail closed for new Handoff projection

effective EXPLICIT_AGENT / EXPLICIT_USER
→ eligible for new Handoff projection
```

This change governs Handoff projection only. It must not retroactively demote a
legacy Core row.

---

## 5. Constraints and non-goals

Do not reopen or change:

```text
frozen B1 lexical retrieval or MemorySpace.search ordering
frozen B2 extraction grammar, transient rejection, or accepted fixtures
CoreAdmissionPolicy decisions or bounded-local classifier semantics
promotion operation names or provenance mapping
hasEffectiveExplicitPromotion invalidation semantics
prospective existing-Core transition matrix
explicit promotion actor/ownership/status/capacity/type checks
bootstrap Core rendering
completed former-Core task behavior
checkpoint trigger, boundary, identity, or idempotency
Memory domain types
MemoryHistoryRecord shape
database schema or storage semantics
provider lifecycle/adapters
MCP tools or schemas
Space binding
Stage A/B1/B2 baseline artifacts
the frozen B3 before-state artifact
```

Do not add:

```text
startup migration
background reconciliation or tier sweep
retroactive tier rewrite
new Memory fields or database columns
new promotion provenance categories
reason-text/source-event inference of promotion intent
provider-selected Handoff fields
LLM or probabilistic classification
embeddings, vector DB, reranking, or other B4 work
```

P6 Stage B4 remains not authorized.

---

## 6. Allowed modification scope

Production changes should be limited to:

```text
src/application/handoff-policy.ts
src/application/memory-space.ts
```

Test/evaluation changes may touch:

```text
eval/quality/core-handoff-policy.test.ts
eval/quality/core-handoff-policy-eval.ts
focused Handoff/bootstrap tests under test/
docs/quality/P6_STAGE_B3_RESULT.md only after all acceptance gates pass
docs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md status/evidence only after review
```

Do not modify `src/application/core-admission-policy.ts` unless a focused test
proves a defect in the already reviewed helper contract. No such defect is part
of this CR.

The immutable artifacts below must remain byte-identical:

```text
eval/quality/baselines/p6-stage-a.json
eval/quality/baselines/p6-stage-a-extraction.json
eval/quality/baselines/p6-stage-b2-core-handoff.json
```

Add independent seeded holdouts for blocker/question instead of rewriting the
accepted B2 before-state to make the candidate pass.

---

## 7. Implementation requirements

### 7.1 Introduce one shared working-state continuation decision

Refactor the task-only concept into one pure predicate for directly projected
working state, conceptually:

```ts
isHandoffContinuationWorkingState(memory, history)
```

The name and exact TypeScript surface are not frozen. The semantic contract is.
It must return true only when all of these are true:

```text
memory.type is task, blocker, or question
memory.status === "active"
memory.tier === "core"
and either:
  isBoundedLocalWorkingState(memory) === false
or:
  hasEffectiveExplicitPromotion(memory, history) === true
```

`progress` remains part of the broader Core working-state policy but has no
direct named Handoff field in B3. Do not invent a progress projection or map it
to `completed`, `activeTasks`, `decisions`, or `nextSteps`.

The existing task helper may delegate to the shared predicate if retaining it
keeps call sites and tests clear. There must not be separate task, blocker, and
question implementations that can drift semantically.

### 7.2 Route every relevant projection field through the shared decision

Apply the same decision to:

```text
eligible task     → activeTasks
eligible task     → nextSteps, including allowed task content/data sources
eligible blocker  → blockers
eligible question → openQuestions
```

Preserve the existing task-only `nextStep` / `nextSteps` source whitelist.
Blockers and questions must never contribute next-step data.

Keep goal, decisions, completed tasks, deduplication, and deterministic output
ordering unchanged.

### 7.3 Supply histories for all provenance-aware projection types

Update `MemorySpace.#buildSnapshot()` so `buildHandoffProjection(...)` receives
history for every active Core type whose Handoff eligibility can depend on
promotion provenance:

```text
task
blocker
question
```

Loading history for all active Core Memory is acceptable only if behavior stays
deterministic and no unrelated type starts consuming it. The smallest expected
change is to extend the existing history-load filter to the three relevant
types.

Store open, bootstrap, and history reads must remain side-effect-free. Do not
write synthetic provenance or normalize legacy `promote` records.

### 7.4 Preserve fail-closed provenance semantics

The implementation must continue using the existing trusted history operation
channel:

```text
promote:explicit-agent → EXPLICIT_AGENT → trusted
promote:explicit-user  → EXPLICIT_USER  → trusted
promote:automatic      → AUTOMATIC      → not trusted override
promote                → AMBIGUOUS_LEGACY → not trusted override
unknown/missing        → AMBIGUOUS_LEGACY → not trusted override
```

Do not infer explicit intent from:

```text
tier = core
reason text
importance/confidence
source event ids
caller/provider payload
legacy generic promote
```

Existing invalidation rules remain authoritative: changed semantic state,
explicit demotion, non-active status, supersession, or later non-trusted
promotion history must prevent stale explicit intent from authorizing the
current state as already defined by the parent spec and implementation.

### 7.5 Preserve upgrade no-clobber semantics

For every seeded legacy case:

```text
opening the store does not change tier/version/history
bootstrap does not change tier/version/history
the stored pre-B3 Handoff is not rewritten
the first successful new checkpoint creates a new Snapshot
the new Snapshot applies current provenance-aware Handoff policy
```

Exclusion from a new Handoff is not a tier demotion and must not mutate the
Memory row.

---

## 8. Required new tests

Add the following four independent seeded holdouts. They may be named H1–H4 or
use an equivalent clear naming scheme.

| ID | Seeded state | Required result after new B3 checkpoint |
| --- | --- | --- |
| H1 | bounded-local active Core blocker; generic legacy `promote` | remains Core; row/version/history unchanged; excluded from `blockers` |
| H2 | bounded-local active Core blocker; effective `promote:explicit-agent` | remains Core; included in `blockers` |
| H3 | bounded-local active Core question; generic legacy `promote` | remains Core; row/version/history unchanged; excluded from `openQuestions` |
| H4 | bounded-local active Core question; effective `promote:explicit-user` | remains Core; included in `openQuestions` |

### 8.1 Test construction requirements

Each legacy holdout must seed persisted Memory and history directly. It must not
depend on the B3 extractor automatically creating an invalid Core state.

Each case must assert the named Handoff field itself, not only a helper return
value. Pure-policy unit tests are also required, but they do not replace the
MemorySpace/checkpoint integration assertion.

For H1 and H3, assert all of:

```text
generic operation is interpreted as AMBIGUOUS_LEGACY
Memory remains Core
Memory version is unchanged
history is byte/deep equal to the seed after open/bootstrap
stored pre-B3 Handoff is unchanged before the checkpoint
new Handoff omits the bounded-local content
```

For H2 and H4, assert all of:

```text
explicit operation has the expected trusted provenance
effective explicit intent is true for the current state
new Handoff includes the content exactly once
unrelated Handoff fields remain unchanged
```

Use at least one English and one Chinese/paraphrased bounded-local case across
the new holdouts if the current classifier supports them. Do not add exact-string
production exceptions to satisfy the fixtures.

### 8.2 Shared-predicate and negative regression assertions

Add focused tests proving:

```text
non-bounded active Core blocker remains included
non-bounded active Core question remains included
Indexed or inactive blocker/question remains excluded
AUTOMATIC provenance does not override bounded-local scope
missing/unknown provenance does not override bounded-local scope
blocker/question data.nextStep(s) still cannot enter nextSteps
progress still has no direct Handoff projection
```

Retain and rerun the existing task cases so the generalization does not regress:

```text
legacy bounded-local Core task → excluded
explicitly promoted bounded-local Core task → included
task-only nextSteps whitelist → unchanged
resolved former-Core task completed behavior → unchanged
```

### 8.3 Existing suite and comparison gates

All existing B3 evidence must remain green:

```text
C1–C22
promotion provenance checks
prospective transition matrix checks
seeded task upgrade checks
baseline mutation checks
B3 Core/Handoff before-after comparison
B1 retrieval non-regression
B2 extraction non-regression
whole-quality hard correctness
```

The fix is expected to close unmeasured legacy projection leakage. Do not update
accepted metrics or expected results merely to absorb a regression.

---

## 9. Required implementation sequence

Follow this order:

```text
1. add failing pure-policy blocker/question holdouts
2. add failing seeded MemorySpace/checkpoint holdouts H1–H4
3. generalize the Handoff continuation predicate
4. route blockers/openQuestions through that predicate
5. supply blocker/question histories from #buildSnapshot
6. run focused tests
7. run B3 comparison and whole-quality regression
8. audit the production diff against this CR
9. update result/status evidence only after all gates pass
10. stop for code re-review
```

Do not change the baseline, broaden Core policy, or modify extraction to make a
test pass.

---

## 10. Validation commands

Run at least the repository's focused B3 policy/Handoff tests and the standard
quality gates:

```bash
pnpm exec vitest run eval/quality/core-handoff-policy.test.ts
pnpm run check
pnpm run check:workspace
pnpm memory-space eval quality
pnpm memory-space eval quality --json
pnpm memory-space eval quality --compare-stage-b2-core-handoff
pnpm memory-space eval quality --compare-stage-b2-core-handoff --json
```

If the exact comparison flag differs in the current CLI, use the existing B3
Core/Handoff comparison command shown by `pnpm memory-space eval quality --help`;
do not add a new CLI surface as part of this CR.

Run each machine-readable quality/comparison command twice and verify
byte-equivalent output. Also run any existing provider smoke self-tests required
by the parent B3 result contract.

Do not report GitHub CI as passing unless an actual status/check/workflow has
been observed for the final commit.

---

## 11. Acceptance criteria

This CR is complete only when all of the following are true:

1. H1–H4 pass at both pure-policy and persisted checkpoint/Handoff levels.
2. Generic legacy, automatic, missing, and unknown promotion provenance fail
   closed for bounded-local task/blocker/question Handoff continuation.
3. Effective `EXPLICIT_AGENT` and `EXPLICIT_USER` provenance allows eligible
   bounded-local task/blocker/question continuation while the same semantic
   state remains active Core.
4. Legacy rows remain Core and their tier/version/history are not rewritten by
   open, bootstrap, or a checkpoint with no matching Memory evidence.
5. The stored pre-B3 Handoff remains immutable; only the newly created Handoff
   applies the hardened projection.
6. `activeTasks`, `blockers`, and `openQuestions` all use one shared semantic
   continuation decision.
7. `nextSteps` remains task-only and cannot be injected by blocker, question,
   progress, decision, fact, goal, constraint, convention, rule, instruction,
   or roadmap data.
8. Progress receives no new Handoff field or fabricated projection.
9. Existing C1–C22, promotion provenance, prospective transition, seeded task
   upgrade, mutation, and comparison gates all pass unchanged.
10. Frozen Stage A/B1/B2 behavior and whole-quality metrics do not regress.
11. The three immutable baseline files listed in section 6 are byte-identical.
12. Production semantic changes are limited to Handoff eligibility/projection
    wiring in the two authorized application files.
13. No storage/domain schema, extractor, retrieval, provider, MCP, Space, or
    checkpoint semantic change is present.
14. P6 Stage B4 has not started.
15. The implementation stops for code re-review and does not self-declare B3
    REVIEW PASS or FROZEN.

---

## 12. Required completion report

The implementing agent must report:

```text
1. final shared working-state continuation predicate
2. history-loading change in MemorySpace.#buildSnapshot
3. H1–H4 results
4. legacy/automatic/missing/unknown fail-closed results
5. EXPLICIT_AGENT / EXPLICIT_USER positive results
6. task nextSteps whitelist result
7. progress non-projection result
8. C1–C22 result
9. seeded upgrade and no-clobber result
10. B3 comparison result
11. B1 retrieval and B2 extraction non-regression result
12. whole-quality metrics and hard-correctness result
13. deterministic JSON result
14. focused/full test counts
15. immutable baseline audit
16. production boundary audit
17. GitHub CI status, only if independently observed
18. final commit hash
```

End the report with:

```text
P6 Stage B3 Handoff working-state provenance hardening implemented.

P6 Stage A/B1/B2 remain frozen.
P6 Stage B4 NOT started.

Awaiting B3 final code re-review.
```

