# P6 Stage B2 — Extraction Generalization & Transient Rejection Result

**Status:** IMPLEMENTED / AWAITING CODE REVIEW — NOT PASS / NOT FROZEN
**Source of Truth:** `docs/P6_STAGE_B2_EXTRACTION_SPEC.md`
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`
**Frozen B1 documentation commit:** `752abf7311bb3016e1184ab7435b195d0d6d22ac`
**B2 implementation:** `12acd96ddada0b88d776ddaac77e6b05a6b16a4b`
**B3 / B4:** NOT STARTED / NOT AUTHORIZED

This document records the measured Stage A extraction failures and the completed
B2 candidate evidence. It is implementation evidence, not reviewer approval. B2
does not modify the frozen retrieval policy or any downstream Core/Handoff policy.

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

P6 Stage B2 is not marked PASS or frozen. B3/B4 have not started.
