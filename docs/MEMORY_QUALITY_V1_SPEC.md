# P6 — Memory Quality v1 Spec

**Status:** Stage A ACCEPTED; Stage B1 REVIEW PASS / FROZEN; Stage B2.1 IMPLEMENTED / AWAITING FINAL RE-REVIEW
**Phase:** P6  
**Primary goal:** Measure and improve whether durable Memory remains useful and correct over long horizons  
**Depends on:** P5 reviewed; P4 durable cross-session proof retained  
**Stage A accepted reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Related:** `V1_ROADMAP.md`, `P6_STAGE_B_RETRIEVAL_SPEC.md`, `quality/P6_BASELINE.md`, `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`

> P6 is benchmark-first and delta-driven: establish a trustworthy measurement before changing production behavior, then improve one measured failure class at a time with explicit before/after evidence.

---

## 1. Problem statement

P4 proves:

> Memory persists and is available across distinct Sessions/providers.

P6 asks the harder product question:

> Is the Memory that persists actually the right Memory, at the right tier, at the right time, without becoming stale, duplicated, contradictory, or excessively large?

P6 therefore has two responsibilities:

```text
Stage A
→ establish deterministic quality ground truth and accepted baseline

Stage B
→ make targeted production improvements against that accepted baseline
```

Stage A is complete and accepted after CR-PHASE9. Stage B proceeds only through separately scoped improvement stages.

---

# 2. Quality dimensions

Memory Quality v1 measures at least the following dimensions where current domain semantics support deterministic ground truth.

## 2.1 Extraction precision / recall

For checkpoint-derived candidates, compare extracted/retained memories to expected fixture labels.

```text
precision = correct extracted memories / extracted memories
recall    = correct extracted memories / expected memories
```

Do not count purely explicit `memory_remember` commands as extractor success unless the benchmark explicitly evaluates explicit-memory handling.

## 2.2 Retrieval Precision@K / Recall@K

For positive queries with known relevant Memory identities:

```text
Precision@K = relevant results in top K / K
Recall@K    = relevant results in top K / total relevant memories
```

Only K values meaningful for the filtered eligible corpus participate.

Zero-relevant queries are not ordinary Recall@K samples. They are evaluated separately by negative-query false-positive and abstention metrics.

Stage A uses K values:

```text
K = 1, 3, 5, 10
```

and preserves production search result ordering.

## 2.3 Core pollution rate

```text
Core pollution rate = irrelevant/stale/over-local active Core / active Core
```

Fixtures distinguish project-wide durable context from local/transient implementation detail.

## 2.4 Bootstrap critical-context coverage

For benchmark state, define critical expected default context such as:

```text
current goal
current project-wide decision
current blocker
latest next step
```

This is distinct from general explicit search recall.

## 2.5 Handoff completeness

Score whether the latest Handoff preserves deterministic continuation facts such as:

```text
current progress
active blockers
open questions
next steps
```

Deterministic field/content assertions remain primary over LLM-as-judge.

## 2.6 Stale-memory rate

Create scenarios where an old fact/task/decision is superseded or resolved and measure active memories that should no longer be treated as current.

## 2.7 Duplicate-memory rate

Create repeated paraphrased/equivalent evidence and measure avoidable logical duplicates according to current key/dedup semantics.

Semantic embedding dedup is not assumed by the Stage A baseline.

## 2.8 Contradiction / supersession correctness

Fixtures include state evolution such as:

```text
Session 2: database = SQLite
Session 8: database = PostgreSQL
```

Current working context must reflect intended latest/active state and exclude stale conflicting state where the frozen keyed/status semantics require it.

## 2.9 Bootstrap size / cost

Record deterministic metrics:

```text
Core item count
Handoff fact count
bootstrap character count
bootstrap byte count
```

Provider-specific token infrastructure is not required solely for this metric.

## 2.10 Long-horizon continuity

The accepted benchmark includes a 20 logical Session/step project evolution with:

- evolving decisions;
- completed/replaced tasks;
- repeated evidence;
- local details;
- blockers opened/resolved;
- multiple checkpoints;
- explicit and checkpoint-derived Memory.

---

# 3. Benchmark-first and staged-improvement rule

P6 is intentionally split into an accepted baseline plus independently reviewed improvement stages.

## Stage A — Deterministic baseline — ACCEPTED

Stage A built:

```text
fixtures
independent ground truth
metric computation
machine-readable report
human-readable report
failure examples
20-Session long-horizon scenario
provider-neutral integration proof
```

Stage A did not optimize product scores.

Accepted review:

```text
docs/code-review/CR-PHASE9.md
```

Accepted evidence:

```text
docs/quality/P6_BASELINE.md
commit 9490ebce94928132a2fb16aca247c8ae4888a7cf
```

## Stage B — Targeted improvements

Stage B does not mean "optimize every metric".

It is decomposed so one change class can be attributed to one measured outcome:

```text
B1 — Retrieval Precision & Abstention
     REVIEW PASS / FROZEN

B2 — Extraction Generalization & Transient Rejection
     B2.1 IMPLEMENTED / AWAITING FINAL RE-REVIEW

B3 — Core / Handoff Pollution Policy
     NOT AUTHORIZED

B4 — Semantic Dedup / Semantic Retrieval architecture decision
     OPTIONAL / NOT AUTHORIZED
```

The normative B1 execution spec is:

```text
docs/P6_STAGE_B_RETRIEVAL_SPEC.md
```

B1 completed code/quality review and is frozen. B2.1 is implemented and awaiting final re-review;
B3/B4 remain unauthorized.

---

# 4. Fixture and ground-truth policy

Quality fixtures live under `eval/quality/` and contain explicit expected labels rather than deriving answers from the system under test.

Stable logical keys identify expected Memory across random runtime IDs.

The accepted Stage A fixture labels are benchmark contracts for Stage B.

Do not modify existing:

```text
relevantMemoryKeys
expectedMemories
shouldBeCore
expectedInactive
expected Handoff facts
duplicate groups
critical bootstrap keys
```

merely to improve candidate scores.

Allowed changes are limited to:

1. adding new regression cases;
2. eliminating genuine nondeterministic score ties without changing relevance semantics;
3. correcting a demonstrably wrong benchmark label through an explicit review note before using the changed score.

---

# 5. Provider independence

Memory Quality primarily tests provider-neutral Memory/application behavior.

P4 remains the source of truth for provider/session transport independence.

P6 keeps only a smaller integration proof that provider-normalized evidence reaches the same quality state; do not multiply every quality fixture by Codex/Claude.

Stage B retrieval policy must remain provider-neutral. Do not add provider-specific search branches or aliases.

---

# 6. Reporting contract

The quality runner must produce deterministic machine-readable output and concise human output.

Stage A report includes:

```text
extraction precision / recall
positive-query P@K / R@K with per-K queryCount
negative-query FP / abstention
Core pollution
bootstrap coverage and size
Handoff completeness
stale-memory rate
duplicate-memory rate
contradiction checks
long-horizon Session count
hard correctness summary
failure examples
```

CLI:

```text
memory-space eval quality
memory-space eval quality --json
```

Stage B adds a before/after comparison against the accepted Stage A snapshot rather than overwriting Stage A history.

The B1 spec defines the required candidate comparison and result document.

---

# 7. Correctness invariant vs quality metric

Keep two classes of evaluation distinct.

```text
correctness invariant
→ hard PASS/FAIL

quality metric
→ baseline/candidate measurement + reviewed delta
```

Hard invariants include:

- no cross-Space leakage;
- provenance preserved;
- inactive/archived Memory excluded from bootstrap where contract requires;
- latest Handoff belongs to latest committed boundary;
- keyed current-state semantics remain correct;
- MCP remains exactly the frozen six tools.

Quality metrics include:

- retrieval P@K/R@K;
- negative-query false-positive/abstention;
- duplicate-memory rate;
- extraction precision/recall;
- Core pollution.

Stage B must never accept a quality gain that breaks a hard invariant.

---

# 8. Target and threshold policy

Stage A intentionally had no invented target thresholds.

Stage B uses reviewed **delta gates against an accepted synthetic baseline**, not universal product SLOs.

For B1, the accepted reference metrics and non-regression/improvement gates are frozen in `P6_STAGE_B_RETRIEVAL_SPEC.md`.

Do not present benchmark-specific thresholds as generic production guarantees.

Later B2/B3/B4 thresholds must be added through their own reviewed execution specs.

---

# 9. LLM-as-judge policy

LLM-as-judge remains optional and secondary in Memory Quality v1.

The required benchmark must remain runnable without network model calls.

If an LLM judge is later added:

- deterministic labels remain primary where possible;
- judge model/version/prompt are recorded;
- judge results never silently replace correctness checks;
- offline deterministic baseline remains available.

B1 does not authorize an LLM judge or LLM query rewriting.

---

# 10. Architecture-change policy

Any Stage B production change must remain inside the currently authorized improvement boundary.

B1 may change provider-neutral retrieval scoring/relevance policy as defined in its execution spec.

B1 does not authorize changes to:

```text
Memory domain semantics
Space/Session binding
storage schema
checkpoint/Handoff generation
extractor heuristics
MCP schemas/tool count
provider lifecycle semantics
```

If an implementation appears to require one of those changes, stop and request an architecture review rather than silently broadening Stage B.

---

# 11. Stage A accepted evidence

The deterministic Stage A harness is implemented under `eval/quality/` using explicit JSON ground truth, stable logical Memory keys, isolated temporary SQLite databases, and the unchanged production Memory implementation.

Accepted metrics:

```text
Extraction precision        0.800000
Extraction recall           0.666667

P@1                         0.727273
R@1                         0.681818
P@3                         0.303030
R@3                         0.818182
P@5                         0.180000
R@5                         0.800000
P@10                        0.090000
R@10                        0.800000

Negative FP rate            1.000000
Negative abstention         0.000000

Core pollution              0.111111
Bootstrap coverage          1.000000
Handoff completeness        1.000000
Stale-memory rate           0.000000
Duplicate-memory rate       0.500000
Long-horizon Sessions       20
```

The corrected metric implementation:

- excludes zero-relevant queries from ordinary P@K/R@K;
- measures negative queries separately;
- uses only K values meaningful for each filtered corpus;
- preserves production search result ordering;
- keeps fixture logical keys as identity only;
- produces deterministic repeated reports.

Full evidence: [`quality/P6_BASELINE.md`](./quality/P6_BASELINE.md).

Review: [`code-review/CR-PHASE9.md`](./code-review/CR-PHASE9.md).

---

# 12. Stage B1 authorization

The accepted baseline ranks retrieval precision/abstention as the highest-value first improvement:

```text
1. lexical wording mismatch / broad false positives / current-intent ranking
2. extraction generalization / transient rejection
3. Core/Handoff transient pollution
4. semantic dedup / semantic retrieval architecture
```

Item 1 completed review and is frozen. Item 2 is implemented and awaiting final
re-review under `P6_STAGE_B2_EXTRACTION_SPEC.md` and
`P6_STAGE_B2_DURABILITY_EVAL_HARDENING_SPEC.md`; items 3–4 remain unauthorized.

Stage B1 must:

```text
freeze a machine-readable Stage A before snapshot
change provider-neutral lexical relevance/ranking only
preserve Stage A fixture labels
produce deterministic before/after metrics
improve reviewed retrieval signals without recall/correctness regression
stop for review
```

See [`P6_STAGE_B_RETRIEVAL_SPEC.md`](./P6_STAGE_B_RETRIEVAL_SPEC.md) for the normative execution and acceptance gates.

---

# 13. Later Stage B decisions

After B1 review, B2 extraction quality was authorized. Later review may authorize:

```text
B3 Core/Handoff pollution policy
semantic-recall architecture experiment
semantic dedup architecture work
```

Do not infer authorization from roadmap ordering alone.

If B1 shows that remaining retrieval failures have little/no lexical overlap, treat that as evidence of a lexical capability boundary. Stop and compare semantic options before adding embeddings/vector infrastructure.

---

# 14. Cross-stage non-goals

Unless separately reviewed, P6 does not authorize:

- vector database migration;
- embeddings by default;
- external reranker service;
- autonomous Memory rewriting;
- online reinforcement learning;
- full transcript ingestion;
- remote benchmark service;
- dashboard product UI;
- new provider integration;
- new Memory tiers solely to improve benchmark scores.

---

# 15. Review cadence

Every improvement stage follows:

```text
accepted before-state
→ scoped execution spec
→ Coding Agent implementation
→ deterministic before/after eval
→ regression suite
→ code/quality review
→ status update
→ explicit next authorization
```

Stage B1 frozen evidence is in
[`quality/P6_STAGE_B1_RESULT.md`](./quality/P6_STAGE_B1_RESULT.md). B2 is governed
by [`P6_STAGE_B2_EXTRACTION_SPEC.md`](./P6_STAGE_B2_EXTRACTION_SPEC.md), with
B2.1 hardening governed by
[`P6_STAGE_B2_DURABILITY_EVAL_HARDENING_SPEC.md`](./P6_STAGE_B2_DURABILITY_EVAL_HARDENING_SPEC.md);
B3/B4 remain blocked.
