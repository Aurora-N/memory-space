# P6 Stage B3 — Core / Handoff Pollution Policy Result

**Date:** 2026-08-17
**Status:** IMPLEMENTED / AWAITING CODE REVIEW — NOT PASS / NOT FROZEN
**Source of Truth:** `docs/P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`
**Reviewed spec head:** `b3ce4219cde8c07eae7a4af2eb9c67c2de096231`
**Frozen B2 source:** `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
**Stage A/B1/B2:** COMPLETE / REVIEW PASS / FROZEN
**Stage B4:** NOT STARTED / NOT AUTHORIZED

This document records the B3 implementation candidate and deterministic local
evidence. It does not declare B3 review PASS or freeze the policy.

## Frozen before-state

The immutable B2 Core/Handoff baseline is
`eval/quality/baselines/p6-stage-b2-core-handoff.json`. Its loader validates the
literal B2 source commit plus SHA-256 digests for the normalized 20-Session
fixture contract, expected Handoff facts, accepted metrics, and seeded upgrade
state. Existing Stage A, B1, and B2 baseline artifacts were not modified.

| Dimension | Frozen B2 |
| --- | ---: |
| Active Core items | 9 |
| Core pollution | 0.111111 (1/9) |
| Polluted logical key | `task.temporary-debug-cleanup` |
| Bootstrap critical coverage | 1.000000 (7/7) |
| Bootstrap unexpected default keys | 1 |
| Handoff required coverage | 1.000000 (9/9) |
| Handoff unexpected facts | 2 |
| Extraction TP / FP / FN | 6 / 0 / 0 |
| Hard correctness | PASS |

The two unexpected Handoff facts were the cleanup task in `activeTasks` and
`nextSteps`.

## Candidate policy

### Core admission

`src/application/core-admission-policy.ts` is a pure, provider-neutral policy.
It returns exactly these auditable outcomes, in order:

```text
working-state + bounded execution scope → Indexed / bounded-local
recommendedTier != Core                 → Indexed / not-recommended
missing promoteReason                   → Indexed / missing-promotion-reason
existing type/key eligibility fails     → Indexed / type-ineligible
otherwise                               → Core / eligible
```

The bounded-local classifier applies only to task, progress, blocker, and
question Memory. It recognizes an explicit single run, command, tool call,
test, turn, or response scope in English or Chinese. It is a negative Core
admission override, not a durability extractor, domain stoplist, semantic
classifier, or new B2 grammar. Importance and confidence remain validated audit
metadata and do not affect admission.

### Promotion provenance and prospective transitions

New Indexed-to-Core transitions use distinct existing history-operation values:

| Semantic provenance | Operation identity | Trusted continuation intent |
| --- | --- | --- |
| AUTOMATIC | `promote:automatic` | no |
| EXPLICIT_AGENT | `promote:explicit-agent` | yes |
| EXPLICIT_USER | `promote:explicit-user` | yes |
| AMBIGUOUS_LEGACY | generic `promote`, missing, or unknown promotion identity | no |

No Memory field, domain type, database column, or storage migration was added.
Reason text, source event ids, and caller data are not used to infer provenance.
An already-Core idempotent promotion still creates no new history and therefore
cannot manufacture an explicit override.

Every new extractor match re-runs admission on both changed-content and
equivalent/deduplicate paths. A bounded-local decision demotes an existing Core
state unless equivalent evidence has effective EXPLICIT_AGENT or EXPLICIT_USER
intent. `not-recommended`, `missing-promotion-reason`, and non-conflicting
`type-ineligible` decisions preserve an existing Core tier. Schema conflicts
still reject and roll back. Explicit intent survives equivalent evidence and is
invalidated by changed content, explicit demotion, non-active status, or
supersession.

### Handoff inclusion

`src/application/handoff-policy.ts` is a pure projection policy. `activeTasks`
and `nextSteps` use the same continuation-eligible active Core task predicate.
Only that task may contribute its content and non-empty string values from
`data.nextStep` or `data.nextSteps`.

Decision, constraint, fact, progress, goal, blocker, question, convention, rule,
instruction, and roadmap data cannot inject `nextSteps`. Indexed, inactive, and
bounded-local tasks without effective trusted explicit intent cannot contribute
either task field. Existing goal, decision, blocker, question, and resolved
former-Core task projections otherwise remain unchanged.

## Fresh-store before / after

| Dimension | Frozen B2 | B3 candidate | Result |
| --- | ---: | ---: | --- |
| Active Core items | 9 | 8 | expected cleanup removal |
| Core pollution | 0.111111 (1/9) | 0.000000 (0/8) | strict improvement |
| Polluted keys | 1 | 0 | removed `task.temporary-debug-cleanup` |
| Bootstrap critical coverage | 1.000000 (7/7) | 1.000000 (7/7) | unchanged |
| Bootstrap unexpected keys | 1 | 0 | strict improvement |
| Handoff required coverage | 1.000000 (9/9) | 1.000000 (9/9) | unchanged |
| Handoff unexpected facts | 2 | 0 | strict improvement |
| Bootstrap Core/Handoff facts | 9 / 11 | 8 / 9 | expected bounded-local removal |
| Bootstrap chars / bytes | 1654 / 1674 | 1444 / 1464 | smaller default context |

No new polluted key, missing required Handoff fact, or accepted-fixture
extraction/retrieval failure was introduced.

## C1–C22

| Case | Result | Candidate evidence |
| --- | --- | --- |
| C1 | PASS | durable primary goal is Core and supplies Handoff goal |
| C2 | PASS | architecture decision is Core and supplies decisions |
| C3 | PASS | constraint is Core without fabricated task/decision output |
| C4 | PASS | unkeyed low-value fact remains Indexed |
| C5 | PASS | accepted cleanup task persists Indexed and stays out of Handoff |
| C6 | PASS | cross-Session task supplies active task and task next steps |
| C7 | PASS | resolved former-Core task is completed only |
| C8 | PASS | persistent project blocker is Core and in Handoff |
| C9 | PASS | bounded operation blocker is Indexed and excluded |
| C10 | PASS | current/unkeyed project progress keeps existing gates; bounded progress is Indexed; progress data cannot inject next steps |
| C11 | PASS | eligible active agent promotion records trusted provenance; existing ownership/capacity tests remain PASS |
| C12 | PASS | resolution/demotion removes active bootstrap/Handoff disclosure |
| C13 | PASS | task-only content/data whitelist rejects all non-task types plus Indexed tasks |
| C14 | PASS | seeded B2 open/bootstrap is no-clobber; first B3 checkpoint changes only the new Handoff projection |
| C15 | PASS | automatic bounded-local task has no trusted override and stays Indexed |
| C16 | PASS | EXPLICIT_AGENT can intentionally override bounded-local admission |
| C17 | PASS | generic legacy `promote` remains ambiguous and fails closed |
| C18 | PASS | trusted in-process user promotion records EXPLICIT_USER |
| C19 | PASS | changed project-wide Core task to bounded local becomes Indexed |
| C20 | PASS | equivalent bounded-local evidence re-runs policy and demotes automatic/legacy Core |
| C21 | PASS | non-bounded Indexed reasons preserve Core; schema conflict still rejects |
| C22 | PASS | agent/user intent survives equivalent evidence and is invalidated at all reviewed boundaries |

English/Chinese bounded-scope paraphrases are tested independently of the
accepted cleanup sentence.

## Seeded B2 → B3 upgrade behavior

The upgrade lane creates a literal B2-style bounded-local task with Core tier,
version 2, `create` plus generic `promote` history, and a stored Handoff that
contains the task.

- opening the store and bootstrapping preserve tier, version, history, and the
  identity and fields of the stored latest Handoff;
- the legacy Core task remains visible in Core bootstrap before a trusted
  transition;
- a first successful B3 checkpoint with no matching Memory evidence does not
  demote or rewrite the task, but its new Handoff excludes the bounded-local
  task because legacy provenance is ambiguous;
- the old Handoff remains immutable historical evidence;
- later trusted demotion removes active Core and Handoff disclosure.

The fresh-store improvement therefore does not claim retroactive cleanup of
legacy Core rows.

## Frozen whole-quality non-regression

| Dimension | Frozen input | B3 candidate |
| --- | ---: | ---: |
| Extraction TP / FP / FN | 6 / 0 / 0 | 6 / 0 / 0 |
| Extraction precision / recall | 1.000000 / 1.000000 | 1.000000 / 1.000000 |
| P@1 / R@1 | 0.727273 / 0.681818 | 0.727273 / 0.681818 |
| P@3 / R@3 | 0.303030 / 0.818182 | 0.303030 / 0.818182 |
| P@5 / R@5 | 0.180000 / 0.800000 | 0.180000 / 0.800000 |
| P@10 / R@10 | 0.090000 / 0.800000 | 0.090000 / 0.800000 |
| Negative FP / abstention | 0.000000 / 1.000000 | 0.000000 / 1.000000 |
| Stale-memory rate | 0.000000 (0/13) | 0.000000 (0/13) |
| Duplicate-memory rate | 0.500000 (2/4) | 0.500000 (2/4) |
| Contradiction checks | 1.000000 (10/10) | 1.000000 (10/10) |
| Hard correctness | PASS | PASS |

The canonical evaluator still runs exactly 20 logical Sessions, the
provider-neutral Codex→Claude proof, provenance and Space isolation checks,
inactive bootstrap exclusion, and the exact shared six MCP tools.

## Comparison and contract evidence

The dedicated commands are:

```text
pnpm memory-space eval quality --compare-stage-b2-core-handoff
pnpm memory-space eval quality --compare-stage-b2-core-handoff --json
```

The human title is `P6 Stage B3 — Core/Handoff comparison`. Contract validation
runs before candidate metrics. Mutation tests reject event text/order/set,
Memory identity/family/type/key/content/Core label, scenario/critical/Handoff
sets, explicit promotion default/toggle/removal, status-change
addition/removal/order/content, candidate operation, transition
addition/removal/order, source-mode changes, promotion provenance, accepted
metrics, correctness status, and seeded-upgrade tier/version/history/Handoff
changes.

## Verification

```text
Focused B3 policy/contract tests        PASS (8/8)
pnpm run check                          PASS (153/153; both smoke self-tests PASS)
pnpm run check:workspace                PASS (153/153; both smoke self-tests PASS)
quality human report                    PASS; hard correctness PASS
quality JSON                            PASS; two explicit runs byte-identical
B3 comparison human                     PASS; all acceptance gates PASS
B3 comparison JSON                      PASS; two explicit runs byte-identical
Codex P2 smoke runner self-test         PASS
Claude P3 smoke runner self-test        PASS
GitHub CI                               not independently confirmed
```

## Production boundary audit

Production changes are limited to the two provider-neutral application policy
modules, minimal `MemorySpace` admission/history/update/Handoff wiring, and the
daemon-independent CLI comparison surface. Evaluation, tests, and documentation
add the frozen B2 contract and candidate evidence.

The frozen B1 lexical scorer, `MemorySpace.search` ranking/order, frozen B2
extractor, extractor port, domain model, storage interface/schema, provider
adapters/lifecycle, checkpoint trigger/boundary/idempotency behavior, Space
binding, Session identity, MCP schemas, and exact six-tool surface were not
changed. No embedding, vector database, query expansion, reranker, semantic
deduplication, new tier, new provider, or B4 work was added.

## Known limitations

- bounded-local admission recognizes only explicit reviewed execution-scope
  structures; implicit local scope may still require explicit demotion;
- B3 intentionally performs no startup sweep or retroactive tier reconciliation;
- pre-B3 generic promotion provenance remains ambiguous by design;
- importance/confidence remain audit-only and do not optimize Core admission;
- resolved former-Core task completion semantics remain unchanged;
- lexical wording mismatch and unkeyed semantic duplicates remain the frozen
  B1/B4 capability inputs;
- real provider smoke sessions were not rerun because the policy is
  provider-neutral; both existing smoke runner self-tests are required and pass;
- GitHub CI was not independently observed.

P6 Stage B3 Core/Handoff policy implemented.

P6 Stage A/B1/B2 remain frozen.
P6 Stage B4 NOT started / NOT authorized.

Awaiting B3 code review.
