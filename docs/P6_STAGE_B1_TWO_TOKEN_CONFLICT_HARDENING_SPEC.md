# P6 Stage B1.2 — Two-Token Conflict Hardening Spec

**Status:** REVIEW PASS / FROZEN WITH STAGE B1
**Parent phase:** P6 Stage B1 — Retrieval Precision & Abstention  
**Previous hardening:** P6 Stage B1.1 — False-Abstention Hardening  
**Reviewed candidate:** `5dcb14890caa74c610fae877ac3af6dd6c43a72c`  
**B1.1 implementation:** `aecb9ba5e4fad410569fed60036d590604352b12`  
**B1.2 implementation:** `e50d46846900c0d4281af0480fd0e90a596ac6b9`
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Depends on:** `P6_STAGE_B_RETRIEVAL_SPEC.md`, `P6_STAGE_B1_FALSE_ABSTENTION_HARDENING_SPEC.md`, `code-review/CR-PHASE10.md`, `quality/P6_STAGE_B1_RESULT.md`  
**B2:** AUTHORIZED AFTER B1 FREEZE
**B3 / B4:** NOT AUTHORIZED

> This is the final narrow lexical-policy hardening requested before Stage B1 can be considered for freeze. It fixes the two-token stale/conflicting-value gap without reopening the B1 architecture or introducing semantic retrieval.

---

## 1. Why this hardening exists

Stage B1.1 correctly replaced the previous unconditional conflict veto with a corpus-supported policy:

```text
candidate-local canonical conflict
        ↓
missing query term(s)
        ↓
other eligible Memories provide key/content support?
        ├─ yes → preserve normal retrieval
        └─ no  → query may abstain
```

It also correctly separated:

```text
key/content evidence
from
type/data metadata evidence
```

and proved H1–H7, including multi-aspect queries such as:

```text
project api docs
project database migration
```

However, the current conflict threshold is:

```ts
keyContentMatchedTokens.size * 3 >= rawQueryTokens.length * 2
```

with full key/content coverage explicitly excluded from conflict.

For a two-token query this creates an unreachable conflict state:

```text
1 / 2 matched → 50% < 2/3 → no conflict
2 / 2 matched → full coverage → no conflict
```

Therefore a natural stale-value query such as:

```text
database SQLite
api v1
```

cannot currently produce `canonicalSlotConflict`, even when the only active canonical Memory says PostgreSQL or `/v2/orders`.

The product behavior becomes inconsistent:

```text
project database SQLite   → abstain

database SQLite           → may return current PostgreSQL Memory
```

and:

```text
project api v1            → abstain

api v1                    → may return current /v2 Memory
```

B1.2 must close this shape gap while preserving all B1.1 protections against false abstention.

---

## 2. Selected problem

B1.2 owns exactly one behavior class:

> A compact two-token query contains one canonical subject/topic token and one unsupported conflicting/discriminating token.

Examples:

```text
database SQLite
api v1
数据库 SQLite
```

The current canonical slot should not be returned merely because the subject/topic token overlaps.

At the same time, B1.2 must preserve legitimate two-token multi-aspect and metadata-qualified queries such as:

```text
database migration
api docs
database decision
```

This means the fix must not be implemented as a blind `1/2 == conflict` rule.

---

## 3. Non-goals

Do not implement or change:

```text
embeddings
vector database
hybrid retrieval
query expansion
synonym dictionary
LLM query rewriting
reranker
semantic dedup
extractor heuristics
Core/Handoff policy
Memory domain types
storage schema
provider adapters
provider lifecycle
MCP schemas or tool count
Space binding
checkpoint semantics
```

Do not begin P6 B2, B3, or B4.

Do not modify accepted Stage A ground-truth labels, accepted Stage A outputs, or the Stage A snapshot v2 contract merely to make this hardening pass.

---

## 4. Required semantic model

Do not lower the current percentage threshold mechanically.

Instead make the conflict shape explicit around three independent concepts.

### 4.1 Canonical coverage

Canonical coverage comes only from:

```text
key
content
```

For conflict detection, type/data must never increase the number of canonical matched tokens.

### 4.2 Metadata-qualified terms

A raw query term may be absent from key/content but still be explicitly explained by the candidate's metadata:

```text
type
data
```

Example:

```text
Memory:
  key  = project.database
  type = decision

query:
  database decision
```

`database` is canonical key/content evidence.

`decision` is metadata qualification of the same Memory.

This must **not** become a stale-value conflict.

Metadata therefore may neutralize/explain a missing term for conflict classification, but it must not increase canonical coverage.

The distinction is:

```text
metadata may prevent a false conflict
metadata may not manufacture a conflict
```

### 4.3 Unresolved query terms

Define the concept of an unresolved query term as a raw query token that is supported by neither:

```text
candidate key/content
nor
candidate type/data metadata
```

The exact internal field name is not frozen. Examples include:

```text
unresolvedQueryTokens
unexplainedQueryTokens
conflictTerms
```

The important semantic rule is frozen.

---

## 5. Required compact conflict shape

For the existing B1 compact-query path, a keyed candidate may signal a canonical-slot conflict only when all of the following hold:

```text
1. candidate has a key;
2. query has 2 or 3 normalized raw tokens;
3. query is not an exact key match;
4. query is not an exact content phrase;
5. candidate has real key/content evidence;
6. exactly one raw query term remains unresolved after considering
   candidate key/content and candidate metadata;
7. key/content evidence covers every other raw query term.
```

Equivalent cardinality form:

```text
raw token count = N, where N ∈ {2, 3}

canonical key/content matched tokens = N - 1
unresolved terms                    = 1
```

Metadata-qualified terms do not count toward `N - 1`; they are only removed from the unresolved set when they genuinely match candidate type/data.

### Expected examples

#### Two-token stale value

```text
query: database SQLite

candidate:
  key     = project.database
  content = Production database is PostgreSQL.

canonical matches: database
metadata matches:  none
unresolved:        SQLite

→ candidate conflict
```

#### Two-token metadata qualifier

```text
query: database decision

candidate:
  key  = project.database
  type = decision

canonical matches: database
metadata matches:  decision
unresolved:        none

→ NOT a candidate conflict
```

#### Three-token stale value

```text
query: project database SQLite

canonical matches: project, database
unresolved:        SQLite

→ candidate conflict
```

#### Three-token insufficient canonical evidence

```text
query: database migration rollback

candidate:
  key = project.database

canonical matches: database
unresolved:        migration, rollback

→ NOT a canonical-slot conflict
```

The last case is too ambiguous for B1 lexical stale-value inference and must fall back to ordinary relevance/ranking rather than global abstention.

---

## 6. Reuse B1.1 corpus-support resolution

B1.2 must not create a second abstention architecture.

After a candidate is classified as conflicting, continue using the B1.1 query-level resolution:

```text
conflicting candidate
        ↓
unresolved term
        ↓
does another eligible Memory provide key/content lexical support?
        ├─ yes → conflict is corpus-supported; do not globally abstain
        └─ no  → conflict remains unsupported; query may abstain
```

Support scope must remain the same eligible corpus after the existing:

```text
Space
status
family
type
tier
```

filters.

Corpus support must continue to use other Memory **key/content** evidence only.

Do not use:

```text
type/data-only support
fixture logical keys
provider metadata
special-case domain vocabularies
```

as cross-Memory support.

---

## 7. Strong exact protection remains frozen

Existing strong exact behavior remains authoritative:

```text
exact key
exact content phrase
```

If an eligible result has strong exact support, an unrelated canonical conflict must not erase it.

B1.2 must not weaken H7 or alter production tie ordering.

---

## 8. Required regression holdouts

Add new production retrieval regressions outside the accepted Stage A fixture contract.

Keep all existing CR-PHASE10 and B1.1 holdouts.

At minimum add the following B1.2 cases.

### T1 — two-token database stale value

```text
current canonical:
  key     = project.database
  content = Production database is PostgreSQL.

query:
  database SQLite

eligible corpus:
  no active Memory with key/content SQLite support

expected:
  []
```

### T2 — two-token API stale value

```text
current canonical:
  key     = project.api.endpoint
  content = Public API endpoint is /v2/orders.

query:
  api v1

eligible corpus:
  no active Memory with key/content v1 support

expected:
  []
```

### T3 — two-token database multi-aspect positive

```text
current canonical:
  key     = project.database
  content = Production database is PostgreSQL.

other Memory:
  content = Migration helper lives in scripts/db/migrate.ts.

query:
  database migration

expected:
  migration Memory remains returned
  query does not globally abstain
```

### T4 — two-token API multi-aspect positive

```text
current canonical:
  key     = project.api.endpoint
  content = Public API endpoint is /v2/orders.

other Memory:
  content = API docs live in docs/openapi.md.

query:
  api docs

expected:
  docs Memory remains returned
  query does not globally abstain
```

### T5 — two-token metadata qualifier does not become stale conflict

```text
Memory:
  key  = project.database
  type = decision

query:
  database decision

expected:
  current database Memory remains eligible/retrievable
  unrelated type=decision Memory remains excluded unless it has normal lexical relevance
  no query-wide abstention occurs solely because `decision` is absent from key/content
```

### T6 — metadata cannot create two-token conflict coverage

Construct a keyed candidate where:

```text
one query term matches key/content
one query term matches only type/data
```

Expected:

```text
metadata term may explain the candidate qualifier
but must not be counted as canonical key/content coverage
```

Assert the internal diagnostic shape if exposed by `scoreLexicalMemory`.

### T7 — two-token corpus support prevents stale abstention

```text
current canonical:
  project.database = PostgreSQL

other active Memory:
  content contains SQLite as a genuinely relevant current/historical detail
  under the same requested filters

query:
  database SQLite
```

Expected:

```text
query must not globally abstain merely because the canonical current slot conflicts;
normal relevance/ranking determines returned supported Memory.
```

The exact content should be chosen so the support is unambiguous lexical evidence rather than a fixture-specific trick.

---

## 9. Preserve all previously accepted behavior

After B1.2, all of the following must still hold:

```text
H1 project database SQLite                       PASS
H2 project api v1                               PASS
H3 数据库 SQLite                                  PASS
H4 project api docs                             PASS
H5 project database migration                   PASS
H6 metadata cannot manufacture 3-token conflict PASS
H7 strong exact survives unrelated conflict     PASS

BROAD_QUERY_TOKENS absent                       PASS
canonicalType absent                            PASS
canonicalKey remains small documented prior     PASS
raw one-token vs multi-token semantics          PASS
Stage A snapshot v2 unchanged                   PASS
fixture mutation protection unchanged           PASS
production order score/updatedAt/id unchanged   PASS
```

Do not fix T1/T2 by breaking T3/T4/T5.

---

## 10. Production implementation guidance

Preferred change surface remains narrow:

```text
src/application/lexical-retrieval.ts
src/application/memory-space.ts          only if query-level wiring needs minimal change
test/retrieval-policy.test.ts
docs/P6_STAGE_B1_TWO_TOKEN_CONFLICT_HARDENING_SPEC.md
docs/quality/P6_STAGE_B1_RESULT.md       evidence update only
```

If practical, prefer making the candidate-local match object expose the distinction explicitly, for example:

```ts
interface LexicalRetrievalMatch {
  keyContentMatchedTokens: string[];
  metadataMatchedTokens: string[];
  unresolvedQueryTokens: string[];
  canonicalSlotConflict: boolean;
}
```

This exact API is not required and remains internal.

Avoid adding another percentage constant if the semantic rule can be represented directly as:

```text
compact query
+ keyed candidate
+ exactly one unresolved term
+ every other term has canonical key/content evidence
```

The implementation should be understandable from the code without reverse-engineering a magic fraction.

---

## 11. Eval-only deterministic ID policy

B1.1 introduced deterministic eval-only runtime Memory IDs so production's final `id ASC` tie-break remains reproducible without evaluator-only logical-key sorting.

B1.2 does not reopen that design unless a new metric-relevant tie is discovered.

Requirements remain:

```text
production comparator unchanged
no evaluator post-sort by fixture logical key
accepted Stage A snapshot unchanged
metric-relevant K boundaries must not rely on arbitrary fixture insertion order
```

If T1–T7 or existing accepted queries expose an equal-score relevant/distractor tie at a reported K boundary, fix the fixture/query ambiguity or request review; do not manipulate synthetic ID assignment to choose the desired result.

---

## 12. Metric acceptance gate

B1.2 is another correctness/generalization pass. Aggregate positive metrics do not need to improve.

The accepted Stage A comparison must continue to satisfy:

```text
hard correctness checks                     PASS
query/fixture contract                      unchanged
eligible corpus sizes                       unchanged
per-K query counts                          unchanged

Negative FP                                 < 1.000000
Negative abstention                         > 0.000000

P@1                                         >= 0.727273
R@1                                         >= 0.681818
P@3                                         >= 0.303030
R@3                                         >= 0.818182
P@5                                         >= 0.180000
R@5                                         >= 0.800000
P@10                                        >= 0.090000
R@10                                        >= 0.800000

Stage-A top-1-correct positive regressions  0
new accepted-fixture retrieval failures     0
```

The healthy expected result may remain exactly:

```text
all positive Stage A P@K/R@K unchanged
Negative FP         1.0 → 0.0
Negative abstention 0.0 → 1.0
```

The value of B1.2 is the new short-query generalization evidence, not a prettier aggregate score.

---

## 13. Required verification

Run the following after implementation:

```bash
pnpm run check
pnpm run check:workspace

pnpm memory-space eval quality
pnpm memory-space eval quality --json

pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
```

Run both JSON commands twice and verify deterministic equality / byte equivalence.

Run focused retrieval tests containing:

```text
all existing CR-PHASE10 holdouts
H1–H7
T1–T7
```

Also run the existing Codex P2 and Claude P3 smoke self-tests if they are part of the established branch validation routine.

Do not claim GitHub CI is green unless an actual GitHub status/check/workflow run is observed for the final commit.

### Recorded implementation evidence — 2026-08-13

The percentage threshold was removed. A keyed candidate now signals conflict
only when a two- or three-token raw query has exactly `N - 1` key/content
canonical matches and exactly one term unresolved by both key/content and
type/data metadata. Metadata may explain a qualifier, but does not increase
canonical coverage. The existing B1.1 eligible-corpus support and strong-exact
protections remain unchanged.

T1–T7 and H1–H7 pass. Accepted Stage A metrics remain unchanged, negative FP is
`0.000000`, negative abstention is `1.000000`, new accepted retrieval failures
and top-1 regressions remain zero. Both full checks pass `120/120`; quality and
comparison JSON are each byte-equivalent across two CLI processes. This remains
implementation evidence awaiting reviewer decision, not B1 PASS or freeze.

---

## 14. Completion report

After implementation, stop and report:

1. final compact-query conflict rule;
2. whether the old `2/3` threshold was removed or retained and why;
3. canonical key/content evidence definition;
4. metadata qualifier semantics;
5. unresolved-term definition;
6. query-level corpus-support behavior;
7. T1 result — `database SQLite`;
8. T2 result — `api v1`;
9. T3 result — `database migration`;
10. T4 result — `api docs`;
11. T5 result — `database decision`;
12. T6 metadata-coverage diagnostic result;
13. T7 supported `database SQLite` result;
14. H1–H7 regression status;
15. final P@1/R@1;
16. final P@3/R@3;
17. final P@5/R@5;
18. final P@10/R@10;
19. Negative FP / abstention;
20. removed/new/unchanged accepted retrieval failures;
21. Stage-A top-1 regressions;
22. focused tests;
23. `pnpm run check`;
24. `pnpm run check:workspace`;
25. human/JSON quality eval;
26. human/JSON Stage A comparison;
27. two-run determinism;
28. production boundary audit;
29. Stage A snapshot mutation audit;
30. B2/B3/B4 status;
31. GitHub CI evidence only if independently observed.

End with exactly:

```text
P6 Stage B1.2 two-token conflict hardening implemented.
B2/B3/B4 NOT started.
Awaiting B1 final re-review.
```

Do not self-promote Stage B1 to PASS/FROZEN.

---

## 15. Exit condition

B1.2 is complete only when all of the following are true:

```text
T1–T7 PASS
H1–H7 still PASS
accepted Stage A comparison PASS
no new accepted retrieval failure
no top-1 regression
hard correctness PASS
production boundary preserved
Stage A snapshot unchanged
B2/B3/B4 not started
```

After that, stop for reviewer decision.

Do not continue lexical-policy hardening speculatively once these requirements are met. Any further work should be justified by a new measured failure class or proceed to the next explicitly authorized phase.
