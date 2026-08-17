# P6 Stage B2 — Extraction Generalization & Transient Rejection Result

**Status:** COMPLETE / REVIEW PASS / FROZEN
**Source of Truth:** `docs/P6_STAGE_B2_EXTRACTION_SPEC.md`
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`
**Frozen B1 documentation commit:** `752abf7311bb3016e1184ab7435b195d0d6d22ac`
**B2 implementation:** `12acd96ddada0b88d776ddaac77e6b05a6b16a4b`
**B2.1 hardening implementation:** `5ea1bffac6ee2774880a5bad181bfed0f75e8355`
**Task-boundary hardening:** `4655124`
**Final reviewed head:** `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
**B3:** COMPLETE / REVIEW PASS / FROZEN
**B4:** DEFERRED TO V2

This document records the measured Stage A extraction failures, the reviewed B2
candidate evidence, and the final freeze decision. B2 does not modify the frozen
retrieval policy or any downstream Core/Handoff policy.

## Accepted before-state

| Metric | Stage A |
| --- | ---: |
| TP | 4 |
| FP | 1 |
| FN | 2 |
| Precision | 0.800000 |
| Recall | 0.666667 |

## Pre-implementation failure analysis

| Failure ID | Ground truth | Observed extraction | Root cause | Generalizable failure class | Selected B2 rule |
| --- | --- | --- | --- | --- | --- |
| FP-01 | `Task: Remove the temporary debug log after this command.` is current-interaction evidence and must not become durable Memory. | `state/task` with content `Remove the temporary debug log after this command.` | Explicit prefixes bypassed any durability/transience gate. | An otherwise task-shaped statement is scoped to the current command, turn, or response. | Reject candidate text with a grammatical deictic current-interaction scope, independent of its explicit prefix. |
| FN-01 | `We selected PostgreSQL for hosted deployments.` is a durable `knowledge/decision`. | No candidate. | English decisions were recognized only through an explicit `decision:` prefix. | A project/team subject makes an explicit completed selection or adoption. | Recognize subject + durable selection/adoption predicate as a natural decision, while preserving the full evidence sentence. |
| FN-02 | `All public APIs must remain backward compatible.` is a durable `knowledge/constraint`. | No candidate. | Constraints were recognized only through an explicit `constraint:` prefix. | A non-agent project subject carries a persistent modal obligation or prohibition. | Recognize subject + obligation/prohibition predicate as a natural constraint after transient narration has been rejected. |

The rules above are language shapes, not fixture-string patches. The transient
model also covers first-person/current-aspect execution narration, immediate
conversational next actions, ephemeral operation completions, and temporary
command/tool failures. A durable project task, progress statement, or blocker
requires a project-level or persistent-state grammatical shape.

`after this command/turn/response` is current-interaction scope and is rejected.
The frozen long-horizon fixture's explicit `after this run` task remains accepted:
a run can denote a project operation whose cleanup obligation survives the
current interaction. Its current Core/Handoff admission remains a B3 input.

## Candidate evidence

### Extraction policy

The extractor now evaluates message lines in this order:

```text
structured Memory event passthrough
→ explicit-prefix parsing
→ transient-evidence gate
→ existing canonical database/current-task rules
→ explicit candidate emission
→ deterministic natural durable-shape classification
```

Natural durable shapes are deliberately bounded:

- decision: a project/team subject plus completed selection for a stated role or
  purpose, adoption, standardization, or an explicit `decided to` predicate;
- constraint: a non-agent project subject plus obligation/prohibition modality;
- task: a project phase or release boundary plus a future completion obligation;
- progress: a non-agent project-state subject plus a completed/result state;
- blocker: a non-agent subject plus persistent blocked/阻塞 state.

The rule preserves the complete natural-language sentence as evidence. It does
not introduce new types, canonical keys, a synonym dictionary, query expansion,
or semantic deduplication. Existing explicit candidate fields and structured
Memory event defaults remain field-for-field compatible in regression tests.

### Transient rejection model

Transient rejection is structural rather than a keyword stoplist:

- first-person/current-aspect execution narration (`I am currently reading`,
  `我现在先检查`);
- immediate conversational intent (`Next, I will analyze`, `接下来我会运行`);
- first-person/recent operation completion (`I just ran`, `我刚读取完`);
- operation-scoped failures (`The tool call just failed`, `刚才命令…失败`);
- deictic current-interaction scope (`this/current command/turn/response` and
  Chinese equivalents).

The transient gate is applied to explicit-prefix content as well as natural
sentences, which closes FP-01 without weakening normal `Task:` compatibility.
Words such as `command`, `failure`, `task`, or `progress` are not independently
rejected; durable holdouts containing them continue to extract.

### Required holdouts

| Holdout | Result | Evidence |
| --- | --- | --- |
| E1 existing explicit prefixes | PASS | 25 English/Chinese prefix forms plus full candidate-field compatibility |
| E2 durable natural decision | PASS | hosted PostgreSQL, Redis adoption, S3 adoption, and Chinese adoption variants |
| E3 durable natural constraint | PASS | English obligation/prohibition and Chinese persistent requirement |
| E4 durable project task | PASS | project phase and pre-release obligations; current migration action rejected |
| E5 execution narration | PASS | explicit task-shaped Chinese/English current execution rejected |
| E6 conversational next action | PASS | explicit task-shaped next reply/test narration rejected |
| E7 durable project progress | PASS | Chinese migration and English rollout completion extracted |
| E8 ephemeral completion | PASS | explicit progress-shaped recent file/command completion rejected |
| E9 blocker vs operation failure | PASS | credential blockers extracted; recent path-error failures rejected |
| E10 structured Memory event | PASS | candidate/default fields and provenance preserved |

An additional negative holdout proves `We selected lines 10 through 20.` is not
mistaken for a durable technical selection. An additional compatibility holdout
keeps the frozen long-horizon `after this run` explicit task unchanged.

## Before / after

| Metric | Stage A | B2 candidate | Delta |
| --- | ---: | ---: | ---: |
| TP | 4 | 6 | +2 |
| FP | 1 | 0 | -1 |
| FN | 2 | 0 | -2 |
| Precision | 0.800000 | 1.000000 | +0.200000 |
| Recall | 0.666667 | 1.000000 | +0.333333 |

Per-case result:

- removed FP: current-command debug-log cleanup;
- fixed FN: hosted PostgreSQL natural decision;
- fixed FN: public-API backward-compatibility natural constraint;
- new accepted-fixture FP/FN: none;
- unchanged extraction failures: none.

The original extraction fixture inputs and labels were not modified.

## Whole-quality regression evidence

| Dimension | Frozen B1 / before B2 | B2 candidate | Result |
| --- | ---: | ---: | --- |
| P@1 / R@1 | 0.727273 / 0.681818 | 0.727273 / 0.681818 | unchanged |
| P@3 / R@3 | 0.303030 / 0.818182 | 0.303030 / 0.818182 | unchanged |
| P@5 / R@5 | 0.180000 / 0.800000 | 0.180000 / 0.800000 | unchanged |
| P@10 / R@10 | 0.090000 / 0.800000 | 0.090000 / 0.800000 | unchanged |
| Negative FP / abstention | 0.000000 / 1.000000 | 0.000000 / 1.000000 | unchanged |
| Core pollution | 0.111111 (1/9) | 0.111111 (1/9) | unchanged |
| Bootstrap critical coverage | 1.000000 (7/7) | 1.000000 (7/7) | unchanged |
| Handoff completeness | 1.000000 (9/9) | 1.000000 (9/9) | unchanged |
| Stale-memory rate | 0.000000 (0/13) | 0.000000 (0/13) | unchanged |
| Duplicate-memory rate | 0.500000 (2/4) | 0.500000 (2/4) | unchanged |
| Contradiction checks | 1.000000 (10/10) | 1.000000 (10/10) | unchanged |
| Hard correctness | PASS | PASS | unchanged |

The evaluator still executes exactly 20 logical Sessions, provider-neutral
Codex→Claude proof, provenance/isolation checks, inactive bootstrap exclusion,
and the exact six MCP tools.

## Verification

```text
Focused extractor + quality tests       PASS (23/23)
pnpm run check                          PASS (132/132; both smoke self-tests PASS)
pnpm run check:workspace                PASS (132/132; both smoke self-tests PASS)
pnpm memory-space eval quality          PASS (human report; hard correctness PASS)
pnpm memory-space eval quality --json   PASS (two explicit runs)
JSON report equality                    PASS (deep-equal)
Codex P2 smoke runner self-test         PASS
Claude P3 smoke runner self-test        PASS
```

The B1 comparison CLI remains B1-specific and was not presented as B2 evidence.
Real provider smoke sessions were not re-executed because B2 changes only the
provider-neutral extractor; the existing Codex/Claude runner self-tests were
executed directly and through both full gates. GitHub CI was not independently
observed.

## Boundary audit and remaining inputs

Production code changed only in `src/adapters/rule-based-extractor.ts`. The
extractor port, retrieval policy/weights/conflict handling, MemorySpace search,
domain, storage, providers/lifecycle, MCP, checkpoint/Handoff generation, Core
promotion, and Space binding were not changed. No Stage A fixture label or B1
snapshot changed.

Remaining measured limitations are intentionally unchanged:

- the long-horizon explicit `after this run` task still enters Core and produces
  two unexpected Handoff facts; its downstream tier/admission policy is B3 input;
- lexical wording mismatch remains a retrieval capability boundary;
- unkeyed semantic paraphrases remain duplicated and are B4 input;
- the deterministic grammar remains conservative for implicit durable facts not
  carrying one of the reviewed semantic shapes.

## B2.1 durability-boundary and extraction-eval hardening

### Final subject/scope model

Natural extraction now requires two independent kinds of evidence:

```text
predicate grammar identifies the candidate Memory kind
subject/scope grammar establishes that the statement is durable
```

The subject classifier uses small grammatical classes rather than a generic
keyword stoplist. Interaction-local subjects (`I`, `you`, current
command/tool/test/turn/response and Chinese equivalents) do not establish
durability. Project/team/service/system/database, public API, durable
credential/configuration/component, and release/rollout/migration/deployment
subjects can establish it when paired with the corresponding durable predicate.

Constraint extraction therefore requires a persistent non-agent subject, while
current/second-person obligations are narration. Progress extraction rejects
passive command/tool/test completion but retains project rollout/migration
completion. Operation failure is transient only when recent or current-operation
scope is expressed; a persistent build failure with durable missing prerequisites
remains a blocker. Explicit durable prefixes remain authoritative after the
shared transient-evidence gate, and structured Memory events retain their exact
compatibility behavior.

### B2.1 holdouts

All existing E1–E10 holdouts remain PASS. The added durability cases are:

| Holdout | Expected boundary | Result |
| --- | --- | --- |
| D1 `You must run the test now.` | second-person constraint rejected | PASS |
| D2 `Right now I must run the test.` | shifted first-person constraint rejected | PASS |
| D3 public APIs must remain compatible | durable API constraint retained | PASS |
| D4 command completed | passive operation completion rejected | PASS |
| D5 test completed | passive operation completion rejected | PASS |
| D6 production rollout completed | durable progress retained | PASS |
| D7 tool call just failed | recent operation failure rejected | PASS |
| D8 build failed because signing credentials are missing | persistent blocker retained | PASS |
| D9 `命令已经完成。` | passive operation completion rejected | PASS |
| D10 `数据库迁移已经完成。` | durable project progress retained | PASS |
| D11 `现在我必须运行测试。` | immediate narration rejected | PASS |
| D12 `所有访问令牌必须在一小时内过期。` | durable constraint retained | PASS |

Additional regressions cover natural blocker subject boundaries, explicit
durable prefixes, keyed database decisions, and the existing current-task rule.

### Accepted Stage A extraction contract and B2 comparison

The immutable extraction before-state is:

```text
eval/quality/baselines/p6-stage-a-extraction.json
accepted commit 9490ebce94928132a2fb16aca247c8ae4888a7cf
```

`eval/quality/extraction-baseline.ts` validates its version, provenance,
historical metrics, and historical result identities.
`eval/quality/extraction-comparison.ts` validates the ordered fixture contract
before candidate metrics and implements the dedicated B2 comparison gate.

Mutation tests fail before metric comparison for event text/order/set, expected
Memory set/order/logical key/family/type/key/content/Core label, negative
evidence set/order/text/reason, and accepted metric mutations. The B1 retrieval
snapshot v2 and comparison remain unchanged.

The dedicated CLI reports itself as `P6 Stage B2 — Extraction comparison`:

```text
pnpm memory-space eval quality --compare-stage-a-extraction
pnpm memory-space eval quality --compare-stage-a-extraction --json
```

| Metric | Accepted Stage A | B2.1 candidate | Delta |
| --- | ---: | ---: | ---: |
| TP | 4 | 6 | +2 |
| FP | 1 | 0 | -1 |
| FN | 2 | 0 | -2 |
| Precision | 0.800000 | 1.000000 | +0.200000 |
| Recall | 0.666667 | 1.000000 | +0.333333 |

Fixed false negatives are `extraction.constraint.api-compatibility` and
`extraction.decision.hosted-postgresql`. The transient current-command cleanup
false positive is removed. New and unchanged false positives/negatives are all
zero. Contract validation, hard correctness, precision non-regression, strict
recall improvement, false-negative reduction, and no-new-regression checks all
PASS.

### Whole-quality and verification evidence

| Dimension | B2.1 result |
| --- | ---: |
| P@1 / R@1 | 0.727273 / 0.681818 |
| P@3 / R@3 | 0.303030 / 0.818182 |
| P@5 / R@5 | 0.180000 / 0.800000 |
| P@10 / R@10 | 0.090000 / 0.800000 |
| Negative FP / abstention | 0.000000 / 1.000000 |
| Core pollution | 0.111111 (1/9) |
| Bootstrap critical coverage | 1.000000 (7/7) |
| Handoff completeness | 1.000000 (9/9) |
| Stale-memory rate | 0.000000 (0/13) |
| Duplicate-memory rate | 0.500000 (2/4) |
| Contradiction checks | 1.000000 (10/10) |
| Hard correctness | PASS |

```text
Focused extractor + quality tests       PASS (33/33)
pnpm run check                          PASS (143/143)
pnpm run check:workspace                PASS (143/143)
quality human report                    PASS; hard correctness PASS
quality JSON                            PASS; two explicit runs byte-identical
B2 extraction comparison human         PASS; all six gates PASS
B2 extraction comparison JSON          PASS; two explicit runs byte-identical
Codex P2 smoke runner self-test         PASS
Claude P3 smoke runner self-test        PASS
GitHub CI                               not independently confirmed
```

Production changes remain confined to the deterministic extractor. Frozen B1
lexical retrieval/search ordering, extractor port, domain, storage, provider
adapters/lifecycle, MCP, checkpoint/Handoff generation, Core promotion, Space
binding, and accepted fixture labels were not changed. At that implementation
handoff, B3/B4 remained unstarted; the known Core/Handoff pollution and semantic
duplicate limitations were recorded as inputs for separately authorized stages.

## Final-review task-boundary hardening

The final review found one remaining overly broad Chinese natural-task branch:
any text before `前/之前必须完成…` was acting as durable scope. The task model now
requires both a recognized future-obligation predicate and independently
classified durable boundary/scope evidence.

The implementation separates English project obligations, Chinese project-phase
obligations, and Chinese boundary obligations. Boundary obligations reuse
`hasDurableProjectSubject` through `hasDurableProjectScope`, plus a small anchored
positive boundary-shape classifier for project/release/上线/deployment/migration/
milestone lifecycle boundaries. It has no response/output blacklist: unknown or
interaction-local boundaries fail closed. A rejected task-shaped boundary is not
allowed to fall through and become a natural constraint.

| Holdout | Result |
| --- | --- |
| T1 `回复前必须完成测试。` → `[]` | PASS |
| T2 `输出结果前必须完成测试。` → `[]` | PASS |
| T3 `发布前必须完成 migration 回滚演练。` → `state/task` | PASS |
| T4 `部署前必须完成数据库迁移。` → `state/task` | PASS |
| Paraphrase `上线之前必须完成回滚验证。` → `state/task` | PASS |
| Project milestone paraphrase → `state/task` | PASS |
| Mixed migration-test-output boundary → `[]` | PASS |

E1–E10 and D1–D12 remain PASS. Keyed `project.database`, explicit current-task,
and structured Memory event compatibility remain unchanged. The accepted Stage A
extraction artifact is byte-unchanged.

Final validation at `4655124`:

```text
Focused extractor tests                 PASS (19/19)
pnpm run check                          PASS (144/144)
pnpm run check:workspace                PASS (144/144)
quality human/JSON                      PASS; hard correctness PASS
B2 extraction comparison human/JSON    PASS; all six gates PASS
quality JSON two-run equality           PASS (byte-equivalent)
comparison JSON two-run equality        PASS (byte-equivalent)
Codex P2 smoke runner self-test         PASS
Claude P3 smoke runner self-test        PASS
GitHub CI                               not independently confirmed
```

Extraction remains 6 TP / 0 FP / 0 FN, precision/recall remain 1.000000, and
new FP/FN remain zero. Frozen B1/downstream metrics remain exactly those recorded
above. The production semantic diff for this follow-up is limited to
`src/adapters/rule-based-extractor.ts`; B1 retrieval and B3/B4 surfaces are
unchanged.

## B2 freeze record

Final review at `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
returned `P6 Stage B2 CODE REVIEW = PASS` and `P6 Stage B2 = READY TO
FREEZE`. The current phase status is therefore COMPLETE / REVIEW PASS / FROZEN.

| Evidence | Frozen result |
| --- | --- |
| Accepted Stage A extraction | 4 TP / 1 FP / 2 FN |
| Accepted Stage A precision / recall | 0.800000 / 0.666667 |
| Frozen B2 extraction | 6 TP / 0 FP / 0 FN |
| Frozen B2 precision / recall | 1.000000 / 1.000000 |
| New FP / FN | 0 / 0 |
| B2 extraction comparison | PASS; all six gates |
| Stage A extraction contract | FROZEN |
| E1–E10 | PASS |
| D1–D12 | PASS |
| Final task-boundary holdouts | PASS |
| Whole-quality regression | PASS / no regression |
| GitHub CI | not independently confirmed |

The earlier `awaiting review` and `NOT PASS / NOT FROZEN` statements in this
document describe historical implementation handoff points before reviewer
approval; they are not the current phase status.

After B2 freeze, each of the following requires a new architecture/phase review:

- adding natural-language extraction grammar;
- expanding the durable-subject vocabulary;
- adding a transient stoplist;
- modifying the Stage A extraction fixture;
- modifying the B2 extraction acceptance contract.

The current conservative deterministic extraction boundary is an accepted v1
capability boundary. Do not continue adding regular expressions merely to raise
natural-language recall. B3 Core/Handoff admission subsequently passed review
and is frozen. ADR 0004 defers B4 semantic retrieval/dedup to v2.
