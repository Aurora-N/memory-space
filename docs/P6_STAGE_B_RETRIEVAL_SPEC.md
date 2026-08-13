# P6 Stage B1 — Retrieval Precision & Abstention Spec

**Status:** B1.1 FALSE-ABSTENTION HARDENING IMPLEMENTED / AWAITING RE-REVIEW
**Phase:** P6 Stage B1  
**Stage A accepted reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Stage B1 implementation commits:** `4c71a665b2c7f7f8527e9d1e0be78591d8f600a5`, `d422083ea365236cdfac5d68c3b86926e7c38602`
**CR-PHASE10 hardening commit:** `ea3c50f3c652b431bec0a3f0332c9fbbbade90b1`
**B1.1 hardening commit:** `aecb9ba5e4fad410569fed60036d590604352b12`
**Depends on:** `MEMORY_QUALITY_V1_SPEC.md`, `quality/P6_BASELINE.md`, `code-review/CR-PHASE9.md`, `code-review/CR-PHASE10.md`, `P6_STAGE_B1_FALSE_ABSTENTION_HARDENING_SPEC.md`
**Primary goal:** Improve deterministic lexical retrieval precision, ranking, and abstention without changing Memory semantics or introducing semantic infrastructure.

> Stage B1 changes the product retrieval policy, but it does not change what a Memory is, who owns it, how Spaces/Sessions bind, or the six-tool MCP contract.

Implementation and local comparison evidence are recorded in
[`quality/P6_STAGE_B1_RESULT.md`](./quality/P6_STAGE_B1_RESULT.md). This status is
not a review PASS; B2/B3/B4 remain unstarted and unauthorized.

---

## 1. Why Stage B1 exists

The accepted Stage A baseline measured the current lexical search behavior rather than guessing where quality work should begin.

The strongest retrieval findings are:

```text
P@1                         0.727273
R@1                         0.681818
P@3                         0.303030
R@3                         0.818182
Negative-query FP rate      1.000000
Negative-query abstention   0.000000
```

The negative query `project database SQLite` has no relevant active Memory in the fixture, yet current lexical search returns seven active results. Other positive queries show wording mismatch and same-token distractor behavior.

The current production policy is intentionally simple:

```text
normalize query / Memory text
exact haystack substring     +10
matched query token          +1 each
score > 0                    → return
score DESC / updatedAt DESC / id ASC
```

That policy proves the MVP search surface but has no explicit relevance or abstention concept. Any token overlap is sufficient to return a Memory.

Stage B1 therefore focuses on:

```text
field-aware lexical evidence
relevance / abstention gate
ranking quality
before/after measurement
```

It does **not** attempt to solve all semantic wording mismatch in one change.

---

## 2. Scope and selected failure modes

Stage B1 owns exactly these measured problems:

### B1.1 Broad token false positives

Generic overlap such as `project` / `database` must not be sufficient by itself to treat a Memory as relevant when the discriminating query term conflicts or is absent.

### B1.2 Missing abstention behavior

Search must be able to return zero results when available lexical evidence is not strong enough.

The current policy:

```text
score > 0 → return
```

must be replaced by an explicit provider-neutral relevance decision.

### B1.3 Ranking precision

When several Memories match, stronger content/key/phrase evidence should rank above generic type/key/token overlap.

### B1.4 Lexical recall boundary

Stage B1 should preserve or improve existing lexical recall, but it is **not required** to solve queries with effectively no lexical overlap.

If wording-mismatch recall remains weak after B1 while precision/abstention improve, record that as evidence for a later semantic-recall decision rather than introducing embeddings in this stage.

---

## 3. Non-goals

Stage B1 must not implement:

```text
embeddings
vector database
hybrid vector/lexical retrieval
external model calls
LLM query rewriting
reranker service
semantic dedup
Memory rewriting
extractor heuristic changes
Core/Handoff policy changes
new Memory tier
new MCP tool
provider-specific search behavior
Cursor or another provider
```

Do not change Stage A ground truth to make candidate scores look better.

---

## 4. Frozen architecture and contract boundaries

The following remain frozen:

```text
Space owns durable Memory
Session.spaceId remains authoritative once bound
provider identity remains Session provenance
one daemon owns one active durable SQLite store
MCP remains exactly six tools
agent search inputs still do not contain spaceId
Memory tier/status/actor remain policy controlled
Indexed remains progressive disclosure
P3 Claude real-MCP scoped waiver remains visible
```

Stage B1 must not change public Memory domain types merely to support scoring.

No provider adapter, lifecycle contract, checkpoint contract, or storage schema migration is expected.

---

## 5. Allowed production-code changes

Stage B1 may change the provider-neutral retrieval implementation only.

Preferred change surface:

```text
src/application/memory-space.ts            minimal search wiring
src/application/retrieval*.ts              optional new pure scoring/matching module
test/*                                     retrieval regressions
eval/quality/*                             candidate comparison/reporting
docs/*                                     evidence/status
```

A dedicated pure module is preferred if it keeps `MemorySpace.search()` readable and makes lexical policy directly unit-testable.

Conceptually:

```ts
interface LexicalRetrievalMatch {
  score: number;
  queryTokenCount: number;
  matchedQueryTokens: number;
  contentMatches: number;
  keyMatches: number;
  typeMatches: number;
  exactContentPhrase: boolean;
  exactKey: boolean;
  coverage: number;
}
```

This is not a frozen public type. The implementation may use a smaller internal representation.

Forbidden production change surfaces unless the reviewer explicitly reopens scope:

```text
src/adapters/rule-based-extractor.ts
src/ports/extractor.ts
src/domain/*
src/storage/*
src/adapters/providers/*
src/integration/*
src/mcp tool schemas
checkpoint/Handoff generation
```

---

## 6. Retrieval policy requirements

### 6.1 Keep lexical evaluation deterministic

The required offline eval must remain deterministic and network-free.

Normalization and tokenization must remain provider-neutral.

### 6.2 Field-aware evidence

Do not treat every token in this concatenation as equally meaningful:

```text
key + type + content + data
```

Stage B1 should distinguish at least the useful evidence classes available in the current Memory model, for example:

```text
exact key match
exact content phrase
content token match
key token match
type/data token match
```

Exact scoring weights are implementation details, but they must be centralized, testable, and explained in the completion report.

Generic structural key tokens must not dominate discriminating content evidence.

`canonicalKey` is a small ranking prior for canonical keyed slots, not lexical
evidence. It must remain weaker than one content-token match. Stage B1 does not
apply a query-independent Memory-type prior.

### 6.3 Explicit relevance / abstention gate

Search relevance must be a deliberate policy rather than an incidental `score > 0` filter.

Preferred structure:

```text
score lexical evidence
→ compute match shape / coverage
→ relevance gate
→ rank accepted candidates
→ return top N
```

The relevance decision should be represented by a named helper/policy rather than a magic inline threshold when practical.

Do not tune a single threshold solely because it removes the current `project database SQLite` fixture. The policy must have a semantic explanation and regression coverage beyond that one query.

The hardened B1 policy retains every normalized raw query token; there is no
English/domain stoplist. A true one-token query may use type/data evidence, while
a multi-token query requires content/key evidence. For a compact two- or
three-token query, an active keyed slot that covers at least two thirds of the
query but lacks another supplied term signals a possible stale/conflicting value.
Unless another eligible Memory has an exact key/content match, the search
abstains rather than falling back to weaker topic-only results. The same rule is
covered for database, API endpoint, and Han-token queries.

### 6.4 Preserve existing filters

The current `MemorySearchInput` filters remain authoritative:

```text
families
types
tiers
statuses
limit
```

Stage B1 changes relevance/ranking only after the eligible Memory set has been resolved under the existing Space/filter contract.

### 6.5 Preserve deterministic tie behavior

If candidate scores remain tied, production tie behavior must stay deterministic. Do not use quality fixture logical keys as production or evaluator ranking signals.

---

## 7. Stage A fixture immutability

The accepted Stage A fixture labels form the benchmark contract for B1.

Do not change existing:

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

Allowed fixture changes are limited to:

1. adding new regression queries/cases;
2. removing genuine nondeterministic score ties without changing relevance semantics;
3. correcting a demonstrably incorrect benchmark label through a separate review note before relying on the changed score.

Any existing ground-truth label change must be called out separately and cannot be hidden inside a retrieval implementation commit.

---

## 8. Freeze the accepted Stage A baseline before product changes

Before changing production retrieval, persist an immutable machine-readable snapshot generated from the accepted Stage A reference:

```text
9490ebce94928132a2fb16aca247c8ae4888a7cf
```

Preferred path:

```text
eval/quality/baselines/p6-stage-a.json
```

The snapshot should contain enough stable data for before/after comparison, including:

```text
summary retrieval metrics
negative retrieval metrics
per-query classification
per-query query text and relevant logical keys
per-query family/type/tier/status filters
per-query eligibleCorpusSize
per-query returned logical keys
per-query P@K/R@K values
hard correctness summary
```

Do not include random runtime UUIDs or machine-specific temporary paths.

The snapshot is evidence, not an alternate source of truth for expected relevance. JSON fixture ground truth remains authoritative.

A test should validate the committed snapshot schema/version and should fail if comparison code silently reads an incompatible baseline format.

The CR-PHASE10 schema is version 2. It adds reviewable fixture-contract metadata
without replacing any accepted Stage A output from `9490ebc`. Comparison rejects
query-set, query-text, relevance-label, classification, filter, and eligible-corpus
mutation before comparing candidate metrics.

---

## 9. Candidate before/after comparison

Stage B1 must report accepted baseline versus candidate behavior.

At minimum compare:

```text
P@1 / R@1
P@3 / R@3
P@5 / R@5
P@10 / R@10
per-K queryCount
negative-query FP rate
negative-query abstention rate
```

Also compare per-query behavior:

```text
baseline returned logical keys
candidate returned logical keys
baseline top-1 relevant? / candidate top-1 relevant?
removed failures
new failures
unchanged failures
```

A human report should resemble:

```text
Metric                 Baseline    Candidate    Delta
P@1                    ...         ...          ...
R@1                    ...         ...          ...
P@3                    ...         ...          ...
R@3                    ...         ...          ...
Negative FP            ...         ...          ...
Negative abstention    ...         ...          ...
```

The machine-readable candidate report must remain deterministic.

Do not overwrite the Stage A baseline values with candidate values. Keep both.

---

## 10. Acceptance policy

Stage B1 uses delta-based acceptance grounded in the accepted Stage A measurement.

### 10.1 Hard correctness — all must remain PASS

```text
cross-Space isolation
provenance preservation
inactive/archived bootstrap exclusion
latest Handoff boundary
keyed current-state correctness
exact shared six MCP tools
P0–P5 regression suite
```

Any hard correctness regression blocks B1 regardless of retrieval score improvement.

### 10.2 Frozen baseline reference

Use the accepted Stage A baseline:

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

### 10.3 Required B1 improvement

The candidate must satisfy all of:

```text
Negative-query FP rate      < 1.000000
Negative-query abstention   > 0.000000
P@1                         >= 0.727273
P@3                         >= 0.303030
R@1                         >= 0.681818
R@3                         >= 0.818182
P@5                         >= 0.180000
R@5                         >= 0.800000
P@10                        >= 0.090000
R@10                        >= 0.800000
```

The candidate must add no accepted-fixture retrieval failure. A strict positive
precision increase is not required; this avoids incentivizing a query-independent
ranking prior merely to improve a benchmark aggregate.

### 10.4 Per-query non-regression

Any positive query that is top-1 correct in the accepted baseline should remain top-1 correct unless the reviewer explicitly accepts a documented tradeoff.

Do not accept an aggregate gain that silently breaks a previously reliable exact/partial retrieval case.

### 10.5 No arbitrary global product threshold

The values above are **B1 regression/improvement gates against the accepted synthetic benchmark**, not a claim that these values represent universal production SLOs.

Do not publish them as generic product-quality guarantees.

---

## 11. Required new regression coverage

In addition to the existing Stage A queries, add focused production retrieval tests for at least:

```text
exact content phrase
exact key
short one-token query
partial key query
mixed key + discriminating content query
generic key-token overlap with conflicting/absent content term
same-token distractor
negative obsolete-state query
status-filtered retrieval
empty result / abstention
limit after relevance filtering
stable deterministic tie behavior
```

Tests should exercise the provider-neutral search implementation directly. Do not duplicate all cases through Codex and Claude.

Add pure scorer/relevance tests if a pure retrieval policy module is introduced.

---

## 12. Semantic recall decision gate

Do not introduce embeddings during B1 merely because wording-mismatch queries remain unresolved.

After the lexical precision/abstention candidate is measured, classify remaining retrieval failures into:

```text
lexical ranking/relevance bug
lexical capability boundary (little/no token overlap)
fixture ambiguity
```

If the major remaining failures are capability-boundary cases, stop and write a short architecture decision comparing at least:

```text
lightweight deterministic query expansion
hybrid embedding + lexical retrieval
no change / explicit recall wording remains acceptable
```

Only then may a semantic retrieval experiment be authorized.

---

## 13. Stage B2/B3/B4 remain out of scope

After B1 review, later work may be considered separately:

```text
B2 — Extraction Generalization & Transient Rejection
B3 — Core / Handoff Pollution Policy
B4 — Semantic Dedup / Semantic Retrieval architecture decision
```

B1 completion does not authorize any of these.

This separation is intentional: changing corpus creation and search ranking in the same stage would make quality deltas difficult to attribute.

---

## 14. Verification

Before requesting B1 review, run:

```bash
pnpm run check
pnpm run check:workspace
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Also run the before/after comparison command or script introduced by the implementation.

Verify two consecutive candidate JSON runs are deterministic.

If GitHub CI is not observable, state:

```text
GitHub CI not independently confirmed
```

Do not fabricate remote CI evidence.

---

## 15. Documentation and evidence

On implementation completion, update at least:

```text
docs/P6_STAGE_B_RETRIEVAL_SPEC.md
docs/MEMORY_QUALITY_V1_SPEC.md
docs/V1_ROADMAP.md
docs/quality/P6_BASELINE.md        // baseline remains historical; append B1 reference only if useful
README.md
eval/README.md
```

Prefer a new result document for the candidate rather than rewriting Stage A history, for example:

```text
docs/quality/P6_STAGE_B1_RESULT.md
```

Record:

```text
implementation commit
accepted Stage A baseline reference
retrieval policy change
baseline metrics
candidate metrics
deltas
per-query improvements/regressions
remaining capability-boundary failures
all hard correctness checks
local verification
remote CI status if actually observed
```

---

## 16. Completion report and stop gate

After implementing B1, stop before B2 or semantic retrieval work.

Report:

1. files changed;
2. retrieval policy architecture;
3. scoring evidence fields/weights;
4. relevance/abstention policy;
5. accepted Stage A snapshot path and validation;
6. baseline P@K/R@K;
7. candidate P@K/R@K;
8. negative-query baseline/candidate;
9. per-query improved cases;
10. per-query regressions;
11. new/removed failure examples;
12. whether wording-mismatch failures remain;
13. correctness-invariant result;
14. production files changed;
15. focused retrieval tests;
16. full `pnpm run check` result;
17. `pnpm run check:workspace` result;
18. deterministic two-run result;
19. GitHub CI status if observed;
20. recommendation: stop at lexical B1 or request semantic-recall architecture review.

For the CR-PHASE10 re-review pass, end with:

```text
P6 Stage B1 CR-PHASE10 fixes implemented.
B2/B3/B4 NOT started.
Awaiting B1 re-review.
```

Do not mark B1 review PASS yourself.
