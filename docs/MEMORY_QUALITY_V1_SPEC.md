# P6 — Memory Quality v1 Spec

**Status:** CR-PHASE9 fixes implemented; awaiting baseline re-review
**Phase:** P6  
**Primary goal:** Measure whether durable Memory remains useful and correct over long horizons  
**Depends on:** P5 reviewed; P4 durable cross-session proof retained  
**Related:** `V1_ROADMAP.md`, `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`, `P4_CROSS_SESSION_PROVIDER_EVAL.md`

> P6 begins by measuring the current system. Do not change retrieval/extraction architecture before establishing a reproducible baseline and identifying concrete failure modes.

---

## 1. Problem statement

P4 proves:

> Memory persists and is available across distinct Sessions/providers.

P6 asks the harder product question:

> Is the Memory that persists actually the right Memory, at the right tier, at the right time, without becoming stale, duplicated, contradictory, or excessively large?

The goal is a deterministic benchmark and quality report that can guide later targeted improvements.

---

# 2. Quality dimensions

The v1 benchmark should measure at least the following dimensions where the current domain semantics support deterministic ground truth.

## 2.1 Extraction precision / recall

For checkpoint-derived candidates, compare extracted/retained memories to expected fixture labels.

Conceptually:

```text
precision = correct extracted memories / extracted memories
recall    = correct extracted memories / expected memories
```

Avoid counting purely explicit `memory_remember` commands as extractor success unless the benchmark is explicitly evaluating explicit-memory handling.

## 2.2 Retrieval Precision@K / Recall@K

For each query with known relevant Memory IDs:

```text
Precision@K = relevant results in top K / K
Recall@K    = relevant results in top K / total relevant memories
```

Evaluate current lexical retrieval first. Do not add embeddings merely to improve the first benchmark score.

Suggested K values:

```text
K = 1, 3, 5, 10
```

Use only values meaningful for each fixture size.

## 2.3 Core pollution rate

Measure active Core items that should not be part of default working context.

Conceptually:

```text
Core pollution rate = irrelevant/stale/over-local active Core / active Core
```

Fixtures should distinguish project-wide durable context from local/transient implementation detail.

## 2.4 Bootstrap critical-context coverage

For each benchmark state, define critical expected default context and assert whether bootstrap includes it.

Examples:

```text
current goal
current project-wide decision
current blocker
latest next step
```

This is distinct from general search recall.

## 2.5 Handoff completeness

Given expected checkpoint state, score whether latest Handoff preserves the necessary continuation fields such as:

```text
current progress
active blockers
open questions
next steps
```

Prefer deterministic field/content assertions over LLM-as-judge in v1.

## 2.6 Stale-memory rate

Create scenarios where an old fact/task/decision is superseded or resolved.

Measure active memories that should no longer be treated as current.

The benchmark should exercise existing status/keyed-update/supersession semantics before proposing new ones.

## 2.7 Duplicate-memory rate

Create repeated paraphrased/equivalent evidence and measure whether the durable set contains avoidable logical duplicates according to current key/dedup semantics.

Do not require semantic embedding dedup in v1; score the current behavior honestly.

## 2.8 Contradiction / supersession correctness

Fixtures should include state evolution such as:

```text
Session 2: database = SQLite
Session 8: database = PostgreSQL
```

The benchmark should verify whether current working context reflects the intended latest/active state and whether stale conflicting state remains incorrectly exposed.

## 2.9 Bootstrap size / cost

Record stable deterministic size metrics:

```text
Core item count
Handoff size
bootstrap character count
bootstrap byte count
```

Exact provider-token counts are optional unless an existing tokenizer is already available. Do not introduce provider-specific tokenizer infrastructure solely for this metric.

## 2.10 Long-horizon continuity

Evaluate quality over a multi-session sequence rather than isolated two-session cases.

Minimum useful benchmark should include at least one scenario of approximately 20 logical Sessions/steps with:

- evolving decisions;
- completed/replaced tasks;
- repeated evidence;
- local details;
- blockers opened and resolved;
- multiple checkpoints;
- explicit and checkpoint-derived Memory.

---

# 3. Benchmark-first rule

P6 must be implemented in two stages.

## Stage A — Baseline

Build fixtures, ground truth, metric computation, and a machine-readable report using the current implementation unchanged where possible.

Required result:

```text
baseline metrics
failure examples
largest observed quality risks
```

Do not optimize scores before this result exists.

## Stage B — Targeted improvements

Only after baseline review, select the highest-value measured failure mode(s).

Examples:

```text
stale Core decisions
poor lexical recall for known wording variants
Handoff missing blockers
keyed update failing to suppress stale state
```

Any algorithm/domain change must be separately reviewed against frozen semantics.

Stage B is not automatically authorized by creating this spec; stop for review after baseline unless explicitly told to continue.

---

# 4. Fixture design

Prefer deterministic synthetic/project-like fixtures stored under a dedicated quality-eval area, for example:

```text
eval/quality/
├── fixtures/
│   ├── long-horizon-project.json
│   ├── superseded-decisions.json
│   ├── retrieval-ground-truth.json
│   └── handoff-ground-truth.json
├── metrics.ts
├── runner.ts
└── memory-quality.test.ts
```

Exact layout may follow repository conventions.

Fixtures should contain explicit ground truth rather than deriving the expected answer from the system under test.

A useful scenario item may include:

```ts
interface QualityStep {
  session: string;
  events: ...;
  explicitMemories?: ...;
  checkpoint?: boolean;
  expectedActive?: string[];
  expectedCore?: string[];
  expectedHandoff?: ...;
  queries?: Array<{
    text: string;
    relevantMemoryKeys: string[];
  }>;
}
```

This is conceptual, not a frozen schema.

---

# 5. Provider independence

Memory Quality should primarily test the Memory/application behavior, not duplicate provider hook tests.

Use provider-neutral Session/application flows where appropriate, with a smaller integration scenario confirming that P4 provider boundaries still feed the same quality state.

Do not multiply every quality fixture by Codex/Claude unless provider-specific evidence changes the quality property being measured.

P4 remains the source of truth for provider/session transport independence.

---

# 6. Reporting

The quality runner should produce a stable machine-readable result and a concise human summary.

Suggested shape:

```json
{
  "version": 1,
  "summary": {
    "extractionPrecision": 0.0,
    "extractionRecall": 0.0,
    "retrieval": {
      "precisionAt3": 0.0,
      "recallAt3": 0.0
    },
    "corePollutionRate": 0.0,
    "handoffCompleteness": 0.0,
    "staleMemoryRate": 0.0,
    "duplicateMemoryRate": 0.0
  },
  "scenarios": []
}
```

Exact fields may evolve during implementation, but results must be deterministic enough to compare across commits.

Recommended command after P5 productization:

```text
memory-space eval quality
```

or an equivalent documented `pnpm` command if the CLI eval surface is intentionally kept narrower.

---

# 7. Regression vs benchmark distinction

Do not turn every quality metric into a brittle hard failure immediately.

Separate:

```text
correctness invariant
→ must pass

quality metric
→ record baseline / compare intentionally
```

Examples of correctness invariants:

- no cross-Space leakage;
- provenance preserved;
- bootstrap never includes inactive/archived Memory when contract forbids it;
- latest Handoff belongs to the latest committed boundary.

Examples of metrics that may initially be below target:

- lexical Retrieval Recall@K;
- duplicate-memory rate;
- extraction recall.

Introduce thresholds only after a baseline is recorded and accepted.

---

# 8. Initial target policy

P6 baseline should record metrics without inventing arbitrary success thresholds.

After baseline review, add explicit target thresholds in a separate reviewed update, based on:

- observed current scores;
- intended product behavior;
- realistic fixture difficulty;
- acceptable bootstrap size/quality tradeoffs.

Do not write `PASS` merely because the benchmark executed.

---

# 9. LLM-as-judge policy

LLM-as-judge is optional and secondary in Memory Quality v1.

The required benchmark should remain runnable without network model calls.

If an LLM judge is later added:

- deterministic labels remain the primary source of truth where possible;
- judge model/version/prompt must be recorded;
- judge results must not silently replace deterministic correctness checks;
- offline baseline remains available.

---

# 10. Non-goals

Do not implement during P6 baseline:

- vector database migration;
- embeddings by default;
- reranker service;
- autonomous Memory rewriting;
- online reinforcement learning;
- full transcript ingestion;
- remote benchmark service;
- dashboard product UI;
- new provider integration;
- new Memory tiers solely to improve benchmark scores.

These may be considered only after measured evidence justifies them.

---

# 11. P6 baseline completion gate

Before requesting baseline review, report:

1. fixture/scenario inventory;
2. ground-truth format;
3. metrics implemented;
4. long-horizon scenario length;
5. baseline metric results;
6. representative failure examples;
7. correctness regressions that remain hard assertions;
8. runtime/reproducibility information;
9. `pnpm run check` result;
10. `pnpm run check:workspace` result;
11. whether any production algorithm/domain code changed;
12. recommended Stage B improvements ranked by measured impact.

Stop after baseline review unless explicitly instructed to implement quality improvements.

---

# 12. Stage A implementation evidence

The deterministic Stage A harness is implemented under `eval/quality/`. It
uses explicit JSON ground truth, stable logical Memory keys, isolated temporary
SQLite databases, and the unchanged production Memory implementation.

The fixture inventory covers:

```text
checkpoint-only extraction with positive and negative evidence
lexical retrieval with exact, reordered, wording-mismatch, and distractor queries
keyed decision supersession and inactive-state expectations
atomic Handoff continuation facts
one 20-Session long-horizon project history
one small Codex-to-Claude provider-neutral integration proof
```

The runner records extraction precision/recall, macro Precision@K and Recall@K
for eligible K values from 1/3/5/10, separate negative-query false-positive and
abstention rates, Core pollution, bootstrap critical coverage and size, Handoff
completeness, stale and duplicate rates, and contradiction/supersession
correctness. Positive-query K eligibility is based on the corpus exposed by the
same status/family/type/tier filters. Production search ordering is preserved;
fixture logical keys provide identity only. The machine-readable report remains
deterministic without exposing random runtime IDs.

Run the baseline with:

```bash
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Quality values are observations and have no acceptance thresholds in Stage A.
Frozen correctness invariants remain hard assertions and control the CLI exit
code. The recorded values, failure examples, reproducibility evidence, and
ranked Stage B candidates are in [`quality/P6_BASELINE.md`](./quality/P6_BASELINE.md).

No Memory extraction, retrieval, domain, storage, lifecycle, or MCP algorithm
was changed for the baseline. Stage B has not started.
