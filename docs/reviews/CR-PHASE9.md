# CR-PHASE9 — P6 Memory Quality v1 Stage A Baseline Review

**Reviewed branch:** `agent/memory-quality-v1`  
**Initial reviewed commit:** `0c0ad5a875bc3f92ac181b7f4e9c719159e4124b`  
**Metric hardening:** `1fab987197fb46618769c601b898d80d6ef6fd87`  
**Tie-fixture hardening:** `39bfc6266ad412c3188c0f8c173e5c84a0f37b9f`  
**Accepted evidence commit:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Base commit:** `e57095ce363afdbe4bb24ddf597f3933760a2ba6`  
**Status:** PASS  
**Phase result:** P6 Stage A deterministic baseline ACCEPTED  
**Next:** P6 Stage B1 Retrieval Precision & Abstention may proceed under `P6_STAGE_B_RETRIEVAL_SPEC.md`

---

## 1. Review conclusion

P6 Stage A is accepted as a trustworthy deterministic baseline for the current Memory implementation.

The benchmark keeps independent JSON ground truth, stable logical Memory identity, a 20-Session long-horizon scenario, provider-neutral continuity proof, hard correctness assertions, and quality metrics that remain observations rather than arbitrary PASS thresholds.

No production extraction, retrieval, domain, storage, lifecycle, provider, or MCP algorithm was changed to improve the Stage A scores.

Accepted areas:

```text
independent fixture ground truth                 PASS
stable logical fixture identity                  PASS
checkpoint-derived extraction baseline           PASS
20-Session long-horizon scenario                 PASS
Core pollution measurement                       PASS
bootstrap critical-context coverage              PASS
Handoff completeness measurement                 PASS
stale-memory measurement                         PASS
duplicate-memory measurement                     PASS
contradiction/supersession scenario               PASS
provider-neutral continuity proof                 PASS
hard correctness vs quality metric separation    PASS
daemon-independent quality eval                   PASS
production search ordering preserved             PASS
positive vs negative retrieval split             PASS
meaningful per-query K eligibility                PASS
full report determinism                           PASS
no Stage B optimization during baseline           PASS
```

---

## 2. Initial review findings

The initial review requested one retrieval-metric hardening group before the baseline could be trusted:

```text
FIX-01A zero-relevant query aggregation
FIX-01B meaningful K eligibility
FIX-01C production ranking preservation
```

It also requested two evidence/documentation cleanups:

```text
DOC-02 record real P6 implementation/hardening commits
DOC-03 clean stale CR-PHASE8 present-tense blocker wording
```

These findings are retained as review history; all are closed by the accepted evidence commit.

---

## 3. FIX-01A — CLOSED

Zero-relevant queries no longer participate in ordinary positive-query Precision@K / Recall@K aggregation.

They are classified separately and reported with deterministic negative-retrieval metrics:

```text
queryCount
falsePositiveQueries
abstainedQueries
falsePositiveRate
abstentionRate
```

`retrievalAtK()` now rejects an empty relevant set, preventing accidental reintroduction of the old Recall@K=1 behavior for negative queries.

Accepted result:

```text
Negative-query count        1
False-positive rate         1.000000
Abstention rate             0.000000
```

The poor score is an honest product observation, not a benchmark failure.

---

## 4. FIX-01B — CLOSED

Each query now determines its eligible corpus using the same status/family/type/tier filters as the real query.

A K contributes only when:

```text
K <= eligibleCorpusSize
```

The accepted aggregate therefore records different contributing query counts:

```text
K=1   11 positive queries
K=3   11 positive queries
K=5   10 positive queries
K=10  10 positive queries
```

The resolved-only query has four eligible Memories and correctly contributes only at K=1 and K=3.

---

## 5. FIX-01C — CLOSED

The evaluator now preserves the exact order returned by production `MemorySpace.search()` and only maps runtime IDs to fixture logical keys.

Fixture logical identity is never used as a ranking or tie-breaking signal.

A focused regression intentionally uses equal-score returned results whose logical-key lexical order conflicts with production order, proving the evaluator does not reorder them.

One query-only fixture adjustment removed an otherwise random production score tie while preserving its relevance labels and intended difficulty. Production ranking was not changed for Stage A.

---

## 6. Accepted Stage A baseline

The accepted retrieval baseline is:

```text
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
```

Other accepted Stage A observations remain:

```text
Extraction precision        0.800000
Extraction recall           0.666667
Core pollution              1 / 9 = 0.111111
Bootstrap critical coverage 7 / 7 = 1.000000
Handoff completeness        9 / 9 = 1.000000
Stale-memory rate           0 / 13 = 0.000000
Duplicate-memory rate       2 / 4 = 0.500000
Long-horizon Sessions       20
```

See `docs/reports/quality/P6_BASELINE.md` for the full recorded evidence and failure examples.

---

## 7. Correctness and regression evidence

The accepted Stage A run preserves the frozen correctness properties, including:

```text
latest committed Handoff boundary               PASS
inactive/resolved Core excluded from bootstrap   PASS
current keyed state visible                      PASS
stale keyed state excluded                       PASS
Codex → Claude continuity                        PASS
provenance preservation                          PASS
cross-Space isolation                            PASS
archived Core exclusion                          PASS
exact shared six MCP tools                       PASS
```

Repository evidence records:

```text
focused quality tests        PASS — 8/8
pnpm run check               PASS — 107/107
pnpm run check:workspace     PASS — 107/107
quality CLI human output     PASS
quality CLI JSON output      PASS
two-run deterministic JSON  PASS
```

GitHub CI was not independently confirmed for this review and is not represented as green.

---

## 8. Stage B authorization boundary

Stage A review PASS authorizes only the next separately specified improvement stage:

```text
P6 Stage B1 — Retrieval Precision & Abstention
```

Normative execution spec:

```text
docs/specs/P6_STAGE_B_RETRIEVAL_SPEC.md
```

Stage B1 must use the accepted Stage A reference `9490ebce94928132a2fb16aca247c8ae4888a7cf` as its immutable before-state and must preserve the accepted fixture ground truth.

Stage B1 does **not** authorize:

```text
B2 extraction optimization
B3 Core/Handoff policy changes
semantic dedup
embeddings/vector search
new Memory tiers
new MCP tools
new provider integration
```

Those require later review decisions.

---

## 9. Final verdict

```text
P6 Stage A architecture / scope             PASS
P6 Stage A metric validity                  PASS
P6 Stage A deterministic baseline           PASS
P6 Stage A code / quality review            PASS

CR-PHASE9                                   CLOSED
P6 Stage B1                                 READY / AUTHORIZED BY SPEC
```
