# P6 Stage B2 — Extraction Generalization & Transient Rejection Spec

**Status:** COMPLETE / REVIEW PASS / FROZEN
**Parent phase:** P6 Memory Quality  
**Prerequisite:** P6 Stage B1 Retrieval Precision & Abstention — REVIEW PASS / FROZEN
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**B1 final reviewed head:** `b4e01619bfbc63d03c2ca661dc8ad69558fa613f`  
**B2 implementation:** `12acd96ddada0b88d776ddaac77e6b05a6b16a4b`
**B2.1 durability/eval hardening:** `5ea1bffac6ee2774880a5bad181bfed0f75e8355`
**Final-review task-boundary hardening:** `4655124`
**Final reviewed head:** `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
**B3:** SPEC DRAFTED / NOT IMPLEMENTED / AWAITING REVIEW
**B4:** NOT AUTHORIZED

> Stage B2 improves deterministic checkpoint-derived Memory candidate extraction only. It must not reopen retrieval, Core/Handoff policy, semantic deduplication, provider integration, storage semantics, or MCP contracts.

---

## 1. Historical phase transition before B2 implementation

Before implementing B2, update project status so B1 is explicitly closed.

The expected phase state is:

```text
P6 Stage A
✅ ACCEPTED BASELINE

P6 Stage B1
✅ RETRIEVAL REVIEW PASS
✅ FROZEN

P6 Stage B2
→ AUTHORIZED
→ Extraction Generalization & Transient Rejection

P6 Stage B3
⛔ NOT AUTHORIZED

P6 Stage B4
⛔ NOT AUTHORIZED
```

B1 retrieval behavior becomes the regression baseline for B2.

Do not modify:

```text
lexical relevance policy
canonical conflict policy
retrieval weights
Stage A retrieval labels
Stage A snapshot
Stage B1 retrieval acceptance gates
```

merely to accommodate extraction work.

---

## 2. Problem statement

Accepted Stage A extraction baseline:

```text
TP = 4
FP = 1
FN = 2

Precision = 0.800000
Recall    = 0.666667
```

This indicates two distinct failure classes.

### Failure A — false negatives

Durable information expressed in a valid but currently unsupported wording is not extracted.

Conceptually:

```text
user says durable fact / decision / constraint / task
        ↓
current rule does not recognize syntax
        ↓
no Memory candidate
```

### Failure B — false positive

Transient conversational or execution-state language is mistaken for durable Memory.

Conceptually:

```text
temporary progress / immediate action / conversational chatter
        ↓
surface wording resembles task/progress
        ↓
Memory candidate incorrectly emitted
```

B2 must improve both behaviors without replacing deterministic extraction with an LLM.

---

## 3. Selected objective

Stage B2 owns exactly:

```text
checkpoint-derived candidate extraction
+
candidate rejection before persistence
```

The desired pipeline remains:

```text
checkpoint source material
        ↓
deterministic extractor
        ↓
candidate classification
        ↓
transient rejection
        ↓
Memory candidate
        ↓
existing application/domain policy
```

B2 does **not** own what happens after the candidate is emitted.

In particular:

```text
candidate extraction
≠
Core promotion policy

candidate extraction
≠
Handoff construction

candidate extraction
≠
deduplication

candidate extraction
≠
retrieval ranking
```

---

## 4. Production boundaries

Preferred production change surface:

```text
src/adapters/rule-based-extractor.ts
src/ports/extractor.ts                 only if internal result shape truly requires it

test/*extract*
eval/quality/*
docs/*
```

Avoid changing `Extractor` public contracts unless necessary.

Forbidden without separate review:

```text
src/application/memory-space.ts retrieval behavior
src/application/lexical-retrieval.ts
src/domain/*
src/storage/*
src/mcp/*
src/adapters/providers/*
src/integration/*
checkpoint/Handoff generation
promotion/demotion policy
Space binding
```

No storage migration is expected.

---

## 5. Deterministic extraction remains mandatory

The mandatory evaluator must remain:

```text
offline
network-free
deterministic
reproducible
```

Do not add:

```text
LLM extraction
OpenAI/Claude calls
embedding classifier
remote NLP API
reranker
agent judge
```

to the required extraction path.

An LLM extractor may be investigated in a later independently reviewed experiment, but is outside B2.

---

## 6. Start from measured failures, not new heuristics

Before production code changes, inspect the accepted Stage A extraction report and explicitly classify all:

```text
FP = 1
FN = 2
```

Produce a small table in the completion report:

```text
Failure ID
Ground truth
Observed output
Failure class
Root cause
Selected B2 rule
```

Do not start with generic rules like:

```text
contains "should" → task
contains "use" → decision
contains "need" → blocker
```

without connecting them to a measured failure class.

The implementation must solve a generalizable language shape, not merely match the exact fixture sentence.

---

## 7. Preserve explicit extraction behavior

Existing explicit patterns remain important compatibility behavior.

Examples currently supported include conceptually:

```text
goal:
目标:

roadmap:
路线图:
计划:

progress:
进度:
已完成:

task:
todo:
任务:
下一步:

decision:
决定:

constraint:
约束:

convention:
约定:

blocker:
阻塞:

question:
待确认:
问题:

fact:
事实:
```

Also preserve accepted structured-memory-event behavior.

B2 should generalize beyond these explicit prefixes, not break them.

Add regression tests for the existing explicit forms before broadening detection.

---

## 8. Generalization policy

B2 may add deterministic natural-language patterns for durable facts.

Prefer **specific semantic shapes** over broad keyword matching.

For example, the extractor may recognize patterns conceptually equivalent to:

```text
X 使用 Y
X 采用 Y
X 确定使用 Y
X 改为 Y

must ...
must not ...
只能 ...
禁止 ...

当前目标是 ...
接下来需要完成 ...
决定采用 ...
```

Only introduce concrete forms justified by measured failures and regression cases.

A good rule should answer:

> Why does this sentence represent durable project state instead of merely containing a keyword?

---

## 9. Durability evidence

A candidate should have evidence that it belongs to one of the existing durable Memory concepts, such as:

```text
decision
constraint
goal
task
blocker
convention
fact
progress
question
```

Do not create a new type solely because a fixture is difficult.

Prefer existing type semantics.

Durability signals may include:

```text
explicit decision/constraint language
stable project configuration
current canonical state
cross-session task commitment
persistent blocker
agreed convention
durable factual project knowledge
```

---

## 10. Transient rejection

B2 must add an explicit concept of transient evidence rather than merely increasing extraction recall.

Examples of transient language that generally should **not** automatically become durable Memory include:

```text
我先看看
我现在检查一下
正在跑测试
刚刚执行了命令
等一下我修改
接下来我会输出结果
这轮先这样处理
我正在读取文件
```

The exact words above are examples, not a mandatory stoplist.

Do **not** implement:

```ts
const TRANSIENT_WORDS = [...]
```

and reject everything containing one of them.

Instead reason from sentence shape.

Useful transient classes include:

### Execution narration

```text
正在检查...
我现在运行...
我先读取...
```

These describe current agent execution, not durable project state.

### Immediate conversational intent

```text
我接下来回答...
我先分析...
稍后输出...
```

These describe the current turn.

### Ephemeral operation result

```text
刚运行完测试
刚打开文件
正在构建
```

unless the statement clearly expresses durable project progress that should survive sessions.

---

## 11. Important distinction: task vs transient action

This is likely the most important B2 semantic boundary.

These are different:

```text
项目下一阶段需要完成数据库迁移
```

versus:

```text
我现在先看看数据库文件
```

The first can represent a durable task.

The second represents immediate conversational execution.

Likewise:

```text
发布前必须完成 migration
```

can be durable.

But:

```text
我接下来运行 migration test
```

is normally transient execution narration.

Tests must explicitly cover this distinction.

---

## 12. Important distinction: progress vs narration

Do not equate past-tense wording with durable progress.

Example:

```text
数据库迁移已经完成
```

may be meaningful persistent project progress.

But:

```text
我刚读取完 README
```

is not durable project progress.

Progress extraction should require meaningful project-state semantics rather than merely a completed verb.

---

## 13. Keyed canonical extraction

Existing deterministic keyed update behavior must remain stable.

For project state with a known canonical slot, prefer stable keys where existing semantics already justify them.

For example, the current project database rule already conceptually maintains:

```text
project.database
```

Do not introduce many new keys merely to increase extraction metrics.

A new canonical key requires a stable product meaning, not just a test-specific string.

B2 must preserve:

```text
keyed update
→ current active value

previous value
→ handled through existing supersession semantics
```

Do not implement a second supersession system in the extractor.

---

## 14. Candidate normalization

Where multiple surface forms describe the same semantic extraction shape, normalization is allowed.

Example:

```text
数据库使用 PostgreSQL
数据库采用 PostgreSQL
数据库确定使用 PostgreSQL
```

may normalize to the same existing canonical concept if that concept is already part of production semantics.

However:

```text
normalization
≠
semantic dedup
```

Do not attempt to merge arbitrary paraphrased unkeyed Memories in B2.

That belongs to B4.

---

## 15. Required holdout categories

Do not evaluate B2 only on the original six extraction expectations.

Add unseen-style production extractor regression tests.

At minimum cover these categories.

### E1 — existing explicit prefixes

Representative explicit forms continue to extract.

Expected:

```text
PASS
```

### E2 — natural durable decision paraphrase

A durable decision without the exact `decision:` / `决定:` prefix.

Expected:

```text
correct decision candidate
```

### E3 — natural durable constraint

A persistent requirement without the exact `constraint:` prefix.

Expected:

```text
constraint candidate
```

### E4 — durable task

A project-level future obligation.

Expected:

```text
task candidate
```

### E5 — execution narration

Example shape:

```text
我现在先检查数据库文件
```

Expected:

```text
no Memory candidate
```

### E6 — conversational next action

Example shape:

```text
接下来我会运行测试并回复结果
```

Expected:

```text
no durable task candidate
```

### E7 — durable project progress

Example shape:

```text
数据库迁移已经完成
```

Expected:

```text
progress candidate
```

### E8 — ephemeral completion narration

Example shape:

```text
我刚读取完配置文件
```

Expected:

```text
no durable progress candidate
```

### E9 — blocker vs temporary operation failure

Durable:

```text
生产发布被缺失凭证阻塞
```

Expected blocker.

Transient:

```text
刚才命令因为路径写错执行失败
```

Expected no persistent blocker unless otherwise clearly durable.

### E10 — structured Memory event compatibility

Current structured extraction behavior remains unchanged.

---

## 16. Original fixture immutability

Accepted Stage A extraction ground truth remains frozen.

Do not change:

```text
expectedMemories
expected extraction type
expected content
existing scenario inputs
```

merely to improve candidate metrics.

Existing FP/FN must remain historical evidence.

If an accepted label is genuinely incorrect, stop and request evaluator-spec review before changing it.

---

## 17. Before / after reporting

Persist Stage A extraction baseline explicitly in the B2 report:

```text
TP = 4
FP = 1
FN = 2

Precision = 0.800000
Recall    = 0.666667
```

Candidate report must include:

```text
Metric       Stage A       B2      Delta

TP
FP
FN
Precision
Recall
```

Also include per-case changes:

```text
removed false positives
fixed false negatives
new false positives
new false negatives
unchanged failures
```

Aggregate metrics alone are insufficient.

---

## 18. B2 acceptance gate

This phase should not use an arbitrary universal quality SLO.

Use Stage A → candidate delta.

Minimum acceptance:

```text
Precision >= 0.800000
Recall    >  0.666667
```

And:

```text
FN < 2
```

At least one accepted Stage A false negative must be fixed.

Preferably:

```text
FP <= 1
```

A stronger healthy target would be:

```text
TP >= 5
FP <= 1
FN <= 1
```

but do not distort extractor semantics merely to reach perfect fixture scores.

Additionally:

```text
new accepted-fixture extraction regression = 0
existing explicit extraction regression     = 0
structured Memory event regression          = 0
E1–E10 holdouts                              PASS
```

If recall improves by introducing obviously broad false positives, B2 is not PASS.

---

## 19. Whole-system regression gate

B2 extraction changes can affect downstream persisted Memories, so the **entire quality suite** must still be evaluated.

The following Stage A/B1 behavior must not regress:

```text
retrieval P@K/R@K
Negative FP / abstention
Core pollution
bootstrap critical coverage
Handoff completeness
stale-memory rate
duplicate-memory rate
contradiction/supersession correctness
hard correctness checks
```

Important:

B2 is **not required to improve Core pollution or Handoff pollution**.

Those are B3 concerns.

But B2 must not make them worse.

If extraction improvement causes:

```text
more transient candidate extraction
        ↓
Core/Handoff pollution increases
```

the implementation must be reconsidered rather than declaring that B3 will fix it later.

---

## 20. B3 boundary

Do not modify Core/Handoff selection policy in B2.

If, after B2:

```text
extractor outputs correct durable candidate
```

but downstream:

```text
candidate enters Core incorrectly
```

or:

```text
transient/correctly-classified candidate leaks into Handoff
```

record it as:

```text
B3 input
```

and stop.

B3 will own:

```text
Core admission quality
Handoff transient pollution
durability/tier policy
```

---

## 21. B4 boundary

Do not solve:

```text
duplicate paraphrased unkeyed Memories
```

inside B2.

Even if B2 introduces more natural-language variants, semantic duplicate detection remains B4.

Allowed:

```text
stable keyed normalization
```

Not allowed:

```text
embedding similarity
fuzzy semantic merging
LLM duplicate judge
```

---

## 22. Required implementation report

After implementation create/update:

```text
docs/quality/P6_STAGE_B2_RESULT.md
```

Report:

```text
Stage A TP/FP/FN
B2 TP/FP/FN

Precision before/after
Recall before/after

exact fixed FN cases
exact removed FP cases
new FP/FN cases

new extraction rules
transient rejection model
task vs execution boundary
progress vs narration boundary

E1–E10 results

retrieval regression metrics
Core pollution regression
Handoff completeness regression
duplicate/stale regression
hard correctness results

focused tests
pnpm run check
pnpm run check:workspace
quality human
quality JSON
two-run JSON determinism

Codex P2 smoke
Claude P3 smoke

production boundary audit

B3 NOT started
B4 NOT started
```

Do not claim GitHub CI is green unless actually observed.

---

## 23. Required verification

Run:

```bash
pnpm run check
pnpm run check:workspace

pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Run JSON twice and verify deterministic equality.

If the existing comparison CLI remains B1-specific, do **not** misuse it as B2 evidence.

Instead either:

```text
extend quality comparison generically
```

or:

```text
add a B2-specific extraction comparison
```

with separate reviewable code.

Do not change B1 accepted retrieval history.

---

## 24. Stop conditions

Stop B2 and request review when all are true:

```text
accepted extraction recall strictly improves
precision does not regress

at least one Stage A FN removed
no new accepted extraction regression

E1–E10 PASS

retrieval B1 behavior unchanged
hard correctness PASS

Core/Handoff pollution not worsened

B3/B4 not started
```

Do **not** continue endlessly adding extraction grammar after these gates pass.

Remaining unsupported natural-language variants should be recorded as capability boundaries.

---

## 25. Historical implementation handoff statement

Before reviewer approval, the implementation Agent was required to end its report
with:

```text
P6 Stage B2 extraction generalization and transient rejection implemented.

P6 Stage B1 remains frozen.
P6 Stage B3/B4 NOT started.

Awaiting B2 code review.
```

At that historical implementation point, the Agent was not permitted to
self-mark B2 as `PASS`, `ACCEPTED`, or `FROZEN`. Final review subsequently passed
at `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`; B2 is now frozen. Further
Core/Handoff admission work is specified separately in
`P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md` and is not yet authorized for
implementation.
