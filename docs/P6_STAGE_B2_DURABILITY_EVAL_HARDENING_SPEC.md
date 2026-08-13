# P6 Stage B2.1 — Durability Boundary & Extraction Eval Hardening Spec

**Status:** COMPLETE / REVIEW PASS / FROZEN
**Parent phase:** P6 Stage B2 — Extraction Generalization & Transient Rejection  
**Current reviewed branch:** `agent/memory-quality-v1`  
**Reviewed head:** `97d61c2a1287f9185247a4404f5a93f39f1d9dc1`  
**B2 implementation under review:** `12acd96ddada0b88d776ddaac77e6b05a6b16a4b`  
**B2.1 hardening implementation:** `5ea1bffac6ee2774880a5bad181bfed0f75e8355`
**Final-review task-boundary hardening:** `4655124`
**Final reviewed head:** `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**P6 Stage B1:** REVIEW PASS / FROZEN  
**P6 Stage B3:** SPEC DRAFTED / NOT IMPLEMENTED / AWAITING REVIEW
**P6 Stage B4:** NOT AUTHORIZED

> B2.1 is a narrow review hardening pass. It does not reopen B1 and does not authorize B3/B4. It closes the remaining durability-boundary and evaluator-contract blockers found during B2 code review.

---

## 1. Review verdict that motivates B2.1

The first B2 candidate produced a real improvement on the accepted extraction fixture:

```text
Stage A
TP = 4
FP = 1
FN = 2
Precision = 0.800000
Recall    = 0.666667

B2 candidate
TP = 6
FP = 0
FN = 0
Precision = 1.000000
Recall    = 1.000000
```

The accepted extraction fixture was not modified, and frozen B1 retrieval / downstream quality metrics did not regress.

The candidate nevertheless remains `CHANGES REQUESTED` because three review findings remain:

```text
FIX-01  Natural durable-vs-transient grammar is still too broad.
FIX-02  Operation-failure rejection is broader than its documented transient semantics.
FIX-03  B2 has no machine-enforced Stage A extraction before/after contract.
```

B2.1 owns only these findings.

---

## 2. Non-goals and frozen boundaries

Do not modify or reopen:

```text
P6 Stage B1 lexical retrieval
MemorySpace.search relevance/ranking/abstention
retrieval weights
canonical-slot conflict policy
Stage A retrieval snapshot/query contract
Core admission policy
Handoff construction policy
semantic deduplication
embeddings / vector DB
query expansion / reranking
Memory domain model
storage schema or storage semantics
provider adapters / provider lifecycle
MCP schemas or exact six-tool surface
Space binding
checkpoint semantics
```

Do not begin:

```text
P6 Stage B3
P6 Stage B4
```

Production changes should remain primarily inside:

```text
src/adapters/rule-based-extractor.ts
```

Eval/test changes may touch:

```text
test/rule-based-extractor.test.ts
eval/quality/*
eval/README.md
docs/quality/P6_STAGE_B2_RESULT.md
docs/P6_STAGE_B2_EXTRACTION_SPEC.md   status/evidence only if needed
```

No production change outside the extractor should be necessary for this hardening.

---

# 3. FIX-01 — Harden the durability subject boundary

## 3.1 Problem

The current B2 implementation describes natural durable shapes as project-level or persistent-state grammatical shapes, but several regular expressions actually use a weaker condition:

```text
not sentence-initial I/we
```

This is insufficient.

For example, the current constraint rule can treat statements such as:

```text
You must run the test now.
Right now I must run the test.
```

as durable `knowledge/constraint` candidates.

Likewise the current progress rule can treat:

```text
The command has been completed.
The test has been completed.
命令已经完成。
测试已经完成。
```

as durable project progress.

These are exactly the kinds of current-interaction / operation-state statements that B2 exists to reject.

The fix must generalize the semantic boundary rather than add exact-string exclusions.

---

## 3.2 Required model

For a natural-language candidate without an explicit durable prefix, extraction must require both:

```text
A. a durable predicate shape
AND
B. durable subject/scope evidence
```

Do not treat:

```text
predicate shape alone
```

as sufficient evidence.

A useful conceptual model is:

```text
natural candidate
    ↓
known durable predicate?
    ↓ yes
subject / scope looks project-persistent?
    ├─ yes → candidate may be emitted
    └─ no  → reject / do not infer durability
```

The implementation does not need a full NLP parser. A small deterministic subject/scope classifier is acceptable.

---

## 3.3 Project-persistent subject evidence

Natural extraction may accept clear durable subjects such as conceptually:

```text
project / the project
team / the team
service
API / public APIs
production rollout
release
migration
database
deployment
build pipeline
client credentials
access tokens
project configuration
system / service component

项目
团队
生产发布
数据库迁移
公共 API
访问令牌
服务
系统
发布流程
构建流程
```

This is not a mandate to create one giant domain vocabulary.

Prefer reusable grammatical/domain-role classes where practical, for example:

```text
project/team subject
technical artifact or system subject
release/deployment/process subject
plural policy-governed resource subject
```

The rule should remain explainable and conservative.

If the implementation cannot confidently distinguish a natural sentence from current interaction narration, the default should be **do not emit a durable candidate**.

---

## 3.4 Interaction-local subjects that must not establish durability

Natural extraction must not infer durability solely from statements whose subject/scope is interaction-local, including shapes such as:

```text
I / we / you
this command
the command
this tool call
the tool call
this test / the test
this response / this turn
the current run when clearly referring to the current agent action

我 / 我们 / 你
这次命令 / 当前命令
本次工具调用
这次测试
当前回复 / 这一轮对话
```

Note that an explicit prefix still does not automatically override transient evidence. Existing B2 behavior that applies the transient gate to explicit-prefix content remains correct.

---

# 4. Constraint hardening

## 4.1 Required positive behavior

These durable constraints should remain supported:

```text
All public APIs must remain backward compatible.
Client credentials must not be written to logs.
All access tokens must expire within one hour.
所有访问令牌必须在一小时内过期。
```

Expected:

```text
knowledge / constraint
```

## 4.2 Required negative behavior

Add independent holdouts for at least:

```text
You must run the test now.
Right now I must run the test.
I must reply with the result now.
你必须现在运行测试。
现在我必须运行测试。
```

Expected:

```text
no natural durable constraint candidate
```

Do not solve these by adding `you`, `right now`, or individual Chinese strings to a flat stopword list.

The selected rule must be explainable in terms of subject/scope durability.

---

# 5. Progress hardening

## 5.1 Required positive behavior

Keep durable project-state progress such as:

```text
The production rollout has been completed.
The database migration has been completed.
数据库迁移已经完成。
生产发布已经完成。
```

Expected:

```text
state / progress
```

## 5.2 Required negative behavior

Add holdouts for operation-local completions:

```text
The command has been completed.
The test has been completed.
The tool call has been completed.
命令已经完成。
测试已经完成。
工具调用已经完成。
```

Expected:

```text
no durable progress candidate
```

The current B2 E8 cases based on first-person narration must remain PASS:

```text
I just ran the local command.
我刚读取完配置文件。
```

The goal is to prove that passive voice does not bypass transient rejection.

---

# 6. Blocker hardening

A similar subject/scope rule should apply to natural blockers.

Keep durable blocker examples:

```text
Production rollout is blocked by missing credentials.
The release is blocked on production signing credentials.
生产发布被缺失凭证阻塞。
```

Do not infer a durable blocker merely because an operation failed in the current interaction.

Examples that should remain transient/non-durable unless explicitly established as a project-state blocker:

```text
The current command is blocked on a bad path.
This tool call is blocked by malformed input.
当前命令被错误路径阻塞。
```

Do not broaden B2 into downstream blocker resolution or B3 admission policy.

---

# 7. FIX-02 — Narrow operation-failure transient rejection

## 7.1 Problem

The current English operation-failure rejection pattern effectively treats:

```text
command/tool/test/build + failed/errored
```

as transient even when no recent/current interaction scope exists.

This is broader than the documented B2 semantics.

For example:

```text
Blocker: The tool call just failed due to a mistyped path.
```

is correctly transient.

But:

```text
Blocker: Build failed because production signing credentials are missing.
```

can describe a persistent release blocker and must not be silently discarded merely because the subject is `build` and the predicate is `failed`.

---

## 7.2 Required semantic rule

Operation failure is transient only when there is evidence that it is scoped to the current/recent interaction or one-off operation.

Conceptually:

```text
operation failure
+
current/recent interaction scope
→ transient
```

Do not implement:

```text
any command/test/build failure
→ transient
```

Useful current/recent evidence may include grammatical shapes such as:

```text
just failed
just errored
this command failed
this tool call failed
the current command failed
刚才命令失败
刚刚工具调用报错
这次测试失败
```

A durable project/release blocker must survive the transient gate when it lacks current-interaction scope and has persistent project-state evidence.

---

## 7.3 Required contrast holdout

Add at least this explicit pair:

### Transient

```text
Blocker: The tool call just failed due to a mistyped path.
```

Expected:

```text
[]
```

### Durable

```text
Blocker: Build failed because production signing credentials are missing.
```

Expected:

```text
state / blocker
```

Also add a Chinese contrast if practical:

```text
阻塞：刚才命令因为路径写错执行失败。
→ []

阻塞：生产构建因缺少签名凭证而失败。
→ blocker
```

The exact durable Chinese wording may be adjusted for grammatical clarity, but it must test the same semantic distinction.

---

# 8. Explicit-prefix policy remains authoritative but not unconditional

Preserve existing B2 behavior:

```text
explicit prefix parsing
→ evaluate content for transient evidence
→ only then emit explicit candidate
```

This is required to keep the accepted Stage A FP fixed:

```text
Task: Remove the temporary debug log after this command.
→ no durable Memory
```

At the same time, the transient gate must not overreach and erase legitimate explicit durable statements.

Required examples:

```text
Constraint: Public APIs must remain backward compatible.
→ constraint

Progress: Production rollout has been completed.
→ progress

Blocker: Build failed because production signing credentials are missing.
→ blocker
```

---

# 9. Existing special-case rules must remain compatible

Do not regress the existing deterministic rules that predate B2, including:

```text
数据库使用 PostgreSQL
→ keyed project.database decision

先完成 ...
→ current task behavior
```

Do not rewrite these into a new generic semantic framework unless necessary to close a demonstrated review issue.

The purpose of B2.1 is hardening, not extractor redesign.

---

# 10. Required new durability holdouts

Keep all existing E1–E10 tests and add at minimum the following B2.1 cases.

## D1 — second-person constraint is not durable project policy

```text
You must run the test now.
```

Expected:

```text
[]
```

## D2 — shifted first-person constraint does not bypass the guard

```text
Right now I must run the test.
```

Expected:

```text
[]
```

## D3 — durable API constraint remains extracted

```text
All public APIs must remain backward compatible.
```

Expected:

```text
knowledge / constraint
```

## D4 — passive operation completion is not durable progress

```text
The command has been completed.
```

Expected:

```text
[]
```

## D5 — passive test completion is not durable progress

```text
The test has been completed.
```

Expected:

```text
[]
```

## D6 — durable deployment completion remains progress

```text
The production rollout has been completed.
```

Expected:

```text
state / progress
```

## D7 — recent operation failure remains transient

```text
Blocker: The tool call just failed due to a mistyped path.
```

Expected:

```text
[]
```

## D8 — persistent build failure remains blocker

```text
Blocker: Build failed because production signing credentials are missing.
```

Expected:

```text
state / blocker
```

## D9 — Chinese passive operation completion rejected

```text
命令已经完成。
```

Expected:

```text
[]
```

## D10 — Chinese durable project progress retained

```text
数据库迁移已经完成。
```

Expected:

```text
state / progress
```

## D11 — Chinese immediate constraint/narration rejected

```text
现在我必须运行测试。
```

Expected:

```text
[]
```

## D12 — durable Chinese constraint retained

```text
所有访问令牌必须在一小时内过期。
```

Expected:

```text
knowledge / constraint
```

These are holdouts outside the accepted Stage A extraction fixture contract. Do not modify Stage A labels to add them.

---

# 11. FIX-03 — Machine-freeze the Stage A extraction contract

## 11.1 Problem

The current B2 tests assert the candidate result:

```text
TP = 6
FP = 0
FN = 0
```

but do not machine-enforce that the candidate was evaluated against the exact accepted Stage A extraction contract.

The existing `p6-stage-a.json` snapshot freezes retrieval/correctness evidence, but does not freeze the extraction fixture contract strongly enough for a B2 before/after comparison.

B2 must therefore add a dedicated extraction baseline/comparison contract.

---

## 11.2 Accepted source of truth

The accepted extraction before-state must continue to originate from:

```text
accepted commit:
9490ebce94928132a2fb16aca247c8ae4888a7cf

Stage A extraction result:
TP = 4
FP = 1
FN = 2
Precision = 0.800000
Recall = 0.6666666666666666
```

Do not regenerate the accepted Stage A output using the current B2 extractor.

The accepted baseline is historical evidence, not a candidate recomputation.

---

## 11.3 Required frozen extraction contract

Freeze at least:

```text
fixture version/id
ordered or normalized event texts
expected Memories:
  logicalKey
  family
  type
  key
  content
  shouldBeCore
negative evidence:
  text
  reason
accepted extraction metrics:
  TP
  FP
  FN
  precision
  recall
```

If rationale fields are considered normative, freeze them too. Otherwise explicitly document that they are descriptive only.

A suggested structured shape is:

```ts
{
  acceptedCommit: "9490...",
  extraction: {
    fixtureVersion: 1,
    fixtureId: "checkpoint-derived-extraction-baseline",
    events: [...],
    expectedMemories: [...],
    negativeEvidence: [...],
    metrics: {
      tp: 4,
      fp: 1,
      fn: 2,
      precision: 0.8,
      recall: 2 / 3
    }
  }
}
```

The exact file layout is not frozen.

Acceptable options include:

```text
extend eval/quality/baselines/p6-stage-a.json
```

or:

```text
add a dedicated extraction baseline artifact
```

Choose the option that keeps historical Stage A provenance easiest to review.

---

# 12. Required B2 extraction comparison

Add a machine-readable comparison path that performs contract validation before metric acceptance.

It must reject at least:

```text
changed event text
changed event set/order if order is semantically relevant
changed expected Memory logical key
changed family/type/key/content
changed shouldBeCore
changed negativeEvidence text
changed negativeEvidence membership
changed accepted baseline metrics
```

Then compare candidate extraction results and report at minimum:

```text
Stage A TP / FP / FN
B2 TP / FP / FN
Precision before / after
Recall before / after

fixed false negatives
removed false positives
new false negatives
new false positives
unchanged failures
```

Do not infer case identity only from aggregate metrics.

---

# 13. Comparison acceptance gates

The B2 comparison must machine-enforce:

```text
Stage A extraction contract unchanged

Precision >= 0.800000
Recall > 0.666667
FN < 2
at least one accepted Stage A FN fixed
new accepted-fixture extraction regression = 0
```

Given the current candidate, a healthy result remains:

```text
TP = 6
FP = 0
FN = 0
Precision = 1.0
Recall = 1.0
```

Do not weaken the acceptance gate to preserve a candidate regression.

Do not change the accepted Stage A extraction ground truth merely because a new grammar rule disagrees with it.

---

# 14. Required mutation tests

Add tests that intentionally mutate the frozen extraction contract and verify that comparison rejects them.

At minimum:

```text
M1 event text mutation
M2 expected content mutation
M3 expected type/family mutation
M4 expected key mutation
M5 shouldBeCore mutation
M6 negative-evidence text mutation
M7 expected Memory set mutation
M8 negative-evidence set mutation
```

If ordering is declared normative, include an order mutation test.

The error should identify the class of contract mutation rather than failing later on an unrelated aggregate metric.

---

# 15. CLI / report surface

The existing B1 comparison remains B1-specific.

Do not label a B1 comparison as B2 evidence.

Add either:

```text
a B2-specific extraction comparison command
```

or a generic comparison API with an explicit B2 extraction mode.

Possible CLI naming examples:

```bash
pnpm memory-space eval quality --compare-stage-a-extraction
pnpm memory-space eval quality --compare-stage-a-extraction --json
```

The exact flag is not frozen.

The human report must visibly identify itself as B2 extraction comparison, not B1 retrieval comparison.

The JSON result must be deterministic and suitable for review/CI.

---

# 16. Whole-quality regression remains mandatory

After B2.1, the whole quality suite must still preserve the frozen B1/downstream values unless a separately reviewed reason exists.

Expected non-regression checks include:

```text
P@1 / R@1
P@3 / R@3
P@5 / R@5
P@10 / R@10
negative retrieval FP / abstention
Core pollution
bootstrap critical coverage
Handoff completeness
stale-memory rate
duplicate-memory rate
contradiction / supersession correctness
hard correctness checks
```

B2.1 is not allowed to change Core/Handoff policy merely to compensate for extractor false positives.

If a candidate is incorrectly classified as durable, fix the extractor.

If a correctly durable candidate is later admitted to the wrong tier/Handoff, record that as B3 input.

---

# 17. Existing E1–E10 remain frozen regressions

All current B2 required holdouts must remain PASS:

```text
E1 existing explicit prefixes
E2 natural durable decision
E3 natural durable constraint
E4 durable project task
E5 execution narration rejection
E6 conversational next action rejection
E7 durable project progress
E8 ephemeral completion rejection
E9 blocker vs temporary operation failure
E10 structured Memory event compatibility
```

Do not fix D1–D12 by breaking E1–E10.

In particular preserve:

```text
We selected PostgreSQL for hosted deployments.
→ decision

All public APIs must remain backward compatible.
→ constraint

项目下一阶段需要完成数据库迁移。
→ task

数据库迁移已经完成。
→ progress

Production rollout is blocked by missing credentials.
→ blocker
```

---

# 18. Structured Memory events remain trusted structured input

Do not apply natural-language durability grammar to structured `memory` events unless an existing contract explicitly requires it.

B2.1 is about automatic extraction from message text.

Structured candidate passthrough/default compatibility remains E10 and must not regress.

Do not change source provenance/default operation/tier behavior for structured candidates in this hardening.

---

# 19. Implementation quality guidance

Avoid replacing the current regex set with an even larger flat pile of unrelated exceptions.

Prefer small named helpers whose intent is visible, for example conceptually:

```ts
isCurrentInteractionScope(...)
isOperationLocalSubject(...)
hasDurableProjectSubject(...)
isRecentOperationFailure(...)
```

Exact names are not frozen.

The final code should make this distinction obvious:

```text
predicate grammar identifies what kind of statement it could be;
subject/scope grammar decides whether it is durable enough to persist.
```

Do not add:

```text
LLM calls
remote classifier
embedding classifier
synonym dictionary
large domain stopword list
fixture exact-string branching
```

---

# 20. Required completion evidence

Update:

```text
docs/quality/P6_STAGE_B2_RESULT.md
```

with a B2.1 section containing:

```text
final durability subject/scope model
constraint boundary
progress boundary
blocker/failure boundary
D1–D12 results
E1–E10 regression results

Stage A extraction contract artifact/path
comparison implementation/path
mutation protection tests

Stage A → candidate TP/FP/FN
Precision/Recall
fixed FP/FN
new FP/FN

whole-quality regression metrics
hard correctness
focused test count
pnpm run check
pnpm run check:workspace
quality human/json
B2 extraction comparison human/json
two-run JSON determinism
Codex P2 smoke self-test
Claude P3 smoke self-test
production boundary audit
GitHub CI only if actually observed
```

Do not rewrite historical B1 evidence except for clearly marked present-tense status reconciliation if necessary.

---

# 21. Required verification

Run the existing full gates:

```bash
pnpm run check
pnpm run check:workspace

pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Run the new B2 extraction comparison in human and JSON modes.

Run both quality JSON and extraction-comparison JSON at least twice and verify deterministic equality.

Run focused tests covering:

```text
E1–E10
D1–D12
extraction baseline contract mutation tests
```

Run established Codex P2 / Claude P3 smoke self-tests if they remain part of the branch validation routine.

Do not claim GitHub CI is green unless an actual GitHub status/check/workflow run is observed for the final commit.

---

# 22. B2.1 acceptance gate

B2.1 is ready for reviewer re-review only when all of the following are true:

```text
Stage A extraction fixture contract machine-frozen       PASS
contract mutation tests                                  PASS
B2 extraction comparison                                 PASS

Precision >= Stage A                                     PASS
Recall > Stage A                                         PASS
new accepted-fixture extraction regression = 0           PASS

E1–E10                                                    PASS
D1–D12                                                    PASS

second-person/current-interaction constraint rejection   PASS
passive operation-completion rejection                   PASS
durable project progress retained                        PASS
recent operation failure rejected                        PASS
persistent build/release blocker retained                PASS

frozen B1 retrieval                                      unchanged
whole-quality downstream metrics                         non-regressed
hard correctness                                         PASS

B3/B4                                                     NOT STARTED
```

---

# 23. Stop condition

Once the gates above pass, stop hardening deterministic extraction and request review.

Do not continue adding grammar merely to support every possible natural-language paraphrase.

Any remaining unsupported but legitimate implicit durable statements should be documented as deterministic-extractor capability boundaries.

Further changes to Core/Handoff admission belong to B3.

Semantic extraction/dedup architecture changes require separate review and are not authorized by B2.1.

---

# 24. Historical implementation handoff statement

Before final reviewer approval, the implementation report ended with:

```text
P6 Stage B2.1 durability-boundary and extraction-eval hardening implemented.

P6 Stage B1 remains frozen.
P6 Stage B3/B4 NOT started.

Awaiting B2 final re-review.
```

At that historical implementation point, the Agent did not self-mark B2 as PASS,
ACCEPTED, or FROZEN. Final review subsequently passed at
`e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`; B2 is now frozen. B3 has only a
draft spec and remains unauthorized for implementation. B4 remains unauthorized.
