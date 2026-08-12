# CR-PHASE9 — P6 Memory Quality v1 Stage A Baseline Review

**Reviewed branch:** `agent/memory-quality-v1`  
**Reviewed commit:** `0c0ad5a875bc3f92ac181b7f4e9c719159e4124b`  
**Base commit:** `e57095ce363afdbe4bb24ddf597f3933760a2ba6`  
**Status:** CHANGES REQUESTED  
**Phase result:** P6 Stage A architecture/fixture design accepted; retrieval baseline metrics require correction before baseline acceptance  
**Stage B:** NOT AUTHORIZED

---

## 1. Review conclusion

P6 Stage A is directionally strong and remains within the benchmark-first scope.
The implementation correctly keeps production extraction/retrieval/domain/storage/MCP behavior unchanged and concentrates changes in `eval/quality/*`, CLI wiring, tests, and documentation.

The following areas are accepted:

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
no Stage B production optimization                PASS
no embeddings/vector DB/new Memory tier           PASS
```

One review group blocks Stage A baseline acceptance:

```text
FIX-01 Retrieval metric validity                 REQUIRED
  FIX-01A zero-relevant query aggregation
  FIX-01B meaningful K eligibility
  FIX-01C production ranking preservation
```

Two documentation cleanups should be completed in the same hardening pass:

```text
DOC-02 P6 baseline implementation commit          REQUIRED FOR EVIDENCE ACCURACY
DOC-03 CR-PHASE8 stale historical wording         SHOULD FIX
```

Do not change the production retrieval/extraction algorithm while addressing this review.

---

# 2. FIX-01 — Retrieval metric validity

## Why this blocks baseline acceptance

Stage A exists to establish trustworthy measurements of the current implementation.
A poor product score is acceptable at this stage; a biased or semantically invalid metric is not.

The current runner computes `Precision@K` / `Recall@K` for every retrieval fixture and then macro-averages all generated values. That currently introduces three validity problems:

1. zero-relevant queries are folded into positive retrieval precision/recall;
2. K values larger than the eligible corpus are still scored;
3. evaluator-only tie ordering replaces production ranking order.

As a result, the currently recorded retrieval baseline must be treated as provisional and regenerated after this fix.

---

# 3. FIX-01A — Zero-relevant queries must not enter ordinary P@K / R@K aggregates

## Current problem

`long-horizon.json` intentionally contains a negative query:

```json
{
  "id": "long-old-sqlite-decision",
  "query": "project database SQLite",
  "relevantMemoryKeys": []
}
```

This is useful, but it is not a normal positive-relevance retrieval query.

The current metric implementation gives an empty relevant set:

```text
Recall@K = 1
Precision@K = hits / K = 0
```

and those values participate in the macro aggregate.

That causes both directions of distortion:

```text
negative query with no relevant documents
→ contributes a perfect Recall sample

perfect abstention
→ still contributes Precision 0
```

Neither value represents ordinary retrieval precision/recall.

## Required behavior

Split retrieval fixtures/results into two evaluation classes:

```text
positive relevance query
relevantMemoryKeys.length > 0
→ eligible for ordinary P@K / R@K

negative relevance query
relevantMemoryKeys.length === 0
→ excluded from ordinary P@K / R@K aggregate
→ evaluated by a dedicated negative-query metric
```

The exact negative-query report shape may follow repository conventions, but it must be deterministic and machine-readable.

A minimal acceptable shape is conceptually:

```ts
interface NegativeRetrievalAggregate {
  queryCount: number;
  falsePositiveQueries: number;
  abstainedQueries: number;
  falsePositiveRate: number;
  abstentionRate: number;
}
```

For each negative query, retain enough diagnostic detail to show whether active results were returned, for example:

```text
query id
returned logical keys
returned count
abstained: true/false
```

Do not call the negative-query score `Recall@K`.

## Required tests

Add focused tests proving:

```text
zero-relevant query is absent from positive P@K/R@K aggregation
perfect negative-query abstention is not scored as Precision@K = 0
negative query returning active results increments false-positive behavior
empty negative-query set has explicit stable denominator behavior
```

Do not invent an arbitrary PASS threshold for the negative-query metric during Stage A.

---

# 4. FIX-01B — Only compute K values meaningful for the eligible corpus

## Current problem

The normative P6 spec says:

```text
Use only values meaningful for each fixture size.
```

The runner currently generates all fixture K values for every query:

```text
K = 1, 3, 5, 10
```

However some queries apply status filters, for example:

```json
{
  "id": "long-resolved-blocker",
  "statuses": ["resolved"]
}
```

The eligible corpus for that query can be smaller than 5 or 10.

Scoring:

```text
1 relevant result found from a 4-item eligible corpus
as Precision@10 = 1/10
```

is not meaningful and artificially depresses the baseline.

## Required behavior

For every query, determine the eligible corpus size under the same retrieval filters before selecting metric K values.

Only calculate/report a K when:

```text
K <= eligibleCorpusSize
```

Preferred behavior:

```text
requested K is not meaningful
→ omit that K for that query
→ do not include it in the corresponding macro aggregate
```

Do not silently relabel `effectiveK = min(K, corpusSize)` as `P@K` unless the report explicitly distinguishes requested and effective K. Omitting ineligible K values is preferred for Stage A simplicity.

The eligible corpus count must respect query filters such as status/family/type/tier when present. Use the existing application/search boundary; do not reach into raw SQLite/store internals solely for this measurement.

Update `queryCount` in each aggregate so it accurately states how many positive queries actually contributed to that K.

## Required tests

Add tests proving:

```text
corpus size 10 → K 1/3/5/10 eligible
corpus size 4  → K 1/3 eligible; K 5/10 omitted
status-filtered corpus uses filtered corpus size
aggregate queryCount differs by K when eligibility differs
ineligible K cannot depress aggregate precision/recall
```

Update documentation that currently claims every evaluated corpus contains at least ten retrievable items; that statement is not true for status-filtered queries.

---

# 5. FIX-01C — Do not replace production ranking with fixture-only logical-key ordering

## Current problem

Production `MemorySpace.search()` sorts by its own contract:

```text
score DESC
updatedAt DESC
id ASC
```

The quality evaluator currently receives the production results and then re-sorts them using:

```text
score DESC
logicalKey ASC
```

This makes the benchmark evaluate a hybrid ranking that users do not actually receive.

A fixture logical key is evaluation metadata and must not become a ranking signal.

This can change P@1/P@3 when a relevant item and distractor have equal lexical score near a K boundary.

## Required behavior

Preserve production search result ordering:

```ts
const returnedKeys = returned.map(...)
```

Do not reorder production results using logical fixture identity.

If production tie-breaking makes a particular fixture non-deterministic because random runtime IDs decide an equal-score boundary, fix the fixture/query so the relevant baseline comparison does not depend on an unresolved score tie.

Preferred Stage A rule:

```text
benchmark production ordering as returned
+
construct deterministic fixtures around important K boundaries
```

Do not modify production retrieval ranking to make the benchmark deterministic.

Do not introduce a complex tie-aware ranking metric unless a simple fixture correction cannot remove the ambiguity.

## Required tests

Add a focused regression that would fail if evaluator-only logical-key sorting is reintroduced.

At minimum prove:

```text
runner preserves the order returned by MemorySpace.search
logical fixture key cannot reorder equal-score production results
report remains deterministic across two consecutive complete eval runs
```

---

# 6. Regenerate the retrieval baseline after FIX-01

The following currently recorded values are provisional because they were produced by the invalid aggregate described above:

```text
Retrieval P@1 / R@1
Retrieval P@3 / R@3
Retrieval P@5 / R@5
Retrieval P@10 / R@10
```

After implementing FIX-01A/B/C, rerun the complete deterministic quality evaluation and update:

```text
docs/quality/P6_BASELINE.md
docs/MEMORY_QUALITY_V1_SPEC.md     if implementation evidence is embedded there
docs/V1_ROADMAP.md                 only for phase status/evidence accuracy
eval/README.md                     if report semantics are documented there
README.md                           only if displayed baseline values changed
```

The regenerated baseline must include:

```text
positive-query P@K / R@K
per-K contributing queryCount
negative-query false-positive/abstention measurement
representative retrieval failures
```

Do not change fixtures merely to improve product scores. Fixture edits are allowed only when required to remove metric ambiguity such as non-deterministic equal-score ties; document any such edit and why it improves validity rather than difficulty.

---

# 7. Preserve all already accepted Stage A evidence

The hardening pass must not weaken or remove:

```text
checkpoint-derived extraction fixture
independent JSON ground truth
20 logical Sessions
SQLite-isolated deterministic runner
Core pollution measurement
bootstrap critical coverage
Handoff completeness
stale-memory measurement
duplicate-memory measurement
contradiction/supersession checks
Codex → Claude provider-neutral proof
provenance hard check
cross-Space isolation hard check
inactive bootstrap exclusion
exact shared six MCP tools
quality metric != CLI correctness exit status
```

The quality runner must remain daemon-independent and must not write benchmark state into the user's real project Space/database.

---

# 8. Production-code boundary remains frozen during this fix

This review is about the evaluator, not product optimization.

Do not modify production behavior under:

```text
src/application/* extraction/retrieval algorithm
src/domain/*
src/storage/*
src/integration/*
src/adapters/providers/*
src/mcp/*
```

unless a compilation-only type import adjustment is unavoidable and semantically inert.

Specifically forbidden during this CR pass:

```text
retrieval scoring rewrite
embeddings
vector search
reranking service
query expansion
semantic dedup
extractor heuristic tuning
checkpoint extraction redesign
new Memory tier
new MCP tool
new provider integration
```

A low corrected baseline score is an acceptable Stage A result.

Do not improve the score before the corrected baseline is reviewed.

---

# 9. DOC-02 — Correct P6 baseline implementation evidence

`docs/quality/P6_BASELINE.md` currently says the implementation commit was not created and describes a working tree.

The reviewed implementation commit now exists:

```text
0c0ad5a875bc3f92ac181b7f4e9c719159e4124b
```

After the CR fix commit is created, update the baseline evidence to identify the actual implementation/hardening commit(s) used to produce the final recorded metrics.

Do not leave stale "working tree" wording after commits exist.

---

# 10. DOC-03 — Clean stale CR-PHASE8 historical wording

`docs/code-review/CR-PHASE8.md` correctly has a PASS header after re-review, but its early conclusion section still reads as though two P5 findings remain blocking.

Preserve the historical review record, but rewrite the stale present-tense wording into historical form, for example:

```text
Initial review identified FIX-01 and FIX-02 as blockers.
Both were closed by the re-review commit.
```

Do not rewrite or erase the detailed historical findings themselves.

This is documentation hygiene and not an excuse for unrelated P5 changes.

---

# 11. Tests and verification required before re-review

Run focused quality tests plus the complete repository checks.

At minimum verify:

```text
metric formula unit tests                         PASS
zero-relevant positive-aggregate exclusion       PASS
negative-query metric                             PASS
meaningful-K filtering                            PASS
filtered-corpus K eligibility                     PASS
production-order preservation                     PASS
two consecutive quality reports deterministic     PASS
20-Session quality runner                         PASS
quality CLI human output                          PASS
quality CLI JSON output                           PASS
P0–P5 regressions                                 PASS
```

Then actually run:

```bash
pnpm run check
pnpm run check:workspace
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Run the quality JSON output twice and verify deterministic equality after the ranking fix.

If GitHub CI is not observable, continue to state:

```text
GitHub CI not independently confirmed
```

Do not fabricate a remote CI PASS.

---

# 12. Re-review completion report

After fixing this CR, stop and report:

1. files changed;
2. FIX-01A implementation;
3. positive vs negative query classification;
4. negative-query metric definition and corrected result;
5. FIX-01B K-eligibility implementation;
6. how eligible corpus size is determined;
7. per-K aggregate `queryCount`;
8. FIX-01C production-order preservation;
9. any fixture changes made only to eliminate score-tie ambiguity;
10. corrected P@1/R@1;
11. corrected P@3/R@3;
12. corrected P@5/R@5;
13. corrected P@10/R@10;
14. whether Stage B ranking recommendations changed after corrected metrics;
15. DOC-02 evidence update;
16. DOC-03 cleanup;
17. focused test results;
18. `pnpm run check` result;
19. `pnpm run check:workspace` result;
20. human/JSON quality CLI results;
21. deterministic two-run result;
22. production algorithm/domain files changed? expected answer: no;
23. remaining baseline limitations.

End with:

```text
P6 Stage A CR-PHASE9 fixes implemented.
Stage B NOT started.
Awaiting baseline re-review.
```

Do not mark CR-PHASE9 PASS yourself.

---

# 13. Acceptance gate

CR-PHASE9 can be closed when the reviewer confirms:

```text
zero-relevant queries no longer bias positive P/R        PASS
negative-query behavior measured separately              PASS
only meaningful K values enter metrics                   PASS
filtered corpus size is respected                        PASS
evaluator preserves production ranking                   PASS
full report remains deterministic                        PASS
baseline numbers regenerated truthfully                  PASS
production retrieval/extraction unchanged                PASS
P3 scoped Claude MCP waiver unchanged                    PASS
Stage B not started                                      PASS
```

Until then:

```text
P6 Stage A baseline review      CHANGES REQUESTED
P6 Stage B                      DO NOT START
```
