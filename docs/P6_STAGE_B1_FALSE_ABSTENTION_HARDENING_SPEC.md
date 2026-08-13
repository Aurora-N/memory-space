# P6 Stage B1.1 — False-Abstention Hardening Spec

**Status:** IMPLEMENTED / AWAITING B1 RE-REVIEW
**Parent phase:** P6 Stage B1 — Retrieval Precision & Abstention  
**Reviewed candidate:** `a48df760ebef948393d2fafa0d7e480e8077a417`  
**Implementation commit:** `aecb9ba5e4fad410569fed60036d590604352b12`
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Depends on:** `P6_STAGE_B_RETRIEVAL_SPEC.md`, `code-review/CR-PHASE10.md`, `quality/P6_STAGE_B1_RESULT.md`  
**B2 / B3 / B4:** NOT AUTHORIZED

> This is a narrow hardening addendum for the existing deterministic lexical B1 candidate. It does not reopen extraction, Memory semantics, storage, provider integration, MCP, Handoff/Core policy, or semantic retrieval.

---

## 1. Why this hardening exists

CR-PHASE10 successfully closed the original B1 review findings:

```text
raw query cardinality preserved                         PASS
English/domain broad-token stoplist removed             PASS
API and Han stale-value holdouts added                  PASS
canonicalType ranking prior removed                     PASS
Stage A fixture/query contract frozen in snapshot v2    PASS
accepted retrieval metrics do not regress               PASS
negative FP 1.0 -> 0.0                                  PASS
negative abstention 0.0 -> 1.0                          PASS
```

The hardened candidate now detects a possible stale/conflicting canonical slot for compact queries. A keyed Memory can emit a `canonicalSlotConflict` signal when it covers most query tokens but another supplied token is absent.

Current `MemorySpace.search()` then performs a corpus-level rule equivalent to:

```text
if no strong exact candidate exists
and any eligible Memory reports canonicalSlotConflict
then return []
```

That rule correctly abstains for examples such as:

```text
current project.database = PostgreSQL
query = project database SQLite

current project.api.endpoint = /v2/orders
query = project api v1
```

but it is too strong as a global veto.

A query may legitimately combine a canonical topic with another aspect that is answered by a different Memory:

```text
project api docs
project database migration
```

A keyed canonical Memory may look like a partial stale-slot conflict while another eligible Memory contains the missing aspect. In that case, returning `[]` is a false abstention.

Stage B1.1 must distinguish:

```text
unsupported stale/conflicting value
```

from:

```text
multi-aspect query with valid evidence elsewhere in the eligible corpus
```

without introducing semantic infrastructure.

---

## 2. Selected problem

B1.1 owns exactly two correctness/quality issues in the current lexical policy.

### B1.1-A — Candidate conflict must not become an unconditional query-wide veto

A `canonicalSlotConflict` signal is candidate-local evidence. It must not automatically discard every other valid Memory in the eligible corpus.

### B1.1-B — Type/data evidence must not help manufacture a canonical-slot conflict

The conflict detector currently reasons about matched query tokens. Conflict coverage must represent canonical topic/value evidence, not incidental metadata overlap.

For multi-token queries, `type` and `data` may remain diagnostic/scoring evidence according to the parent B1 policy, but they must not help satisfy the threshold that decides a keyed slot is nearly matched and therefore conflicting.

---

## 3. Non-goals

Do not implement or modify:

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

Do not change accepted Stage A ground-truth labels or regenerate accepted Stage A outputs.

---

## 4. Required semantic invariant

The implementation must make the following distinction explicit.

### Case A — stale/conflicting value with no supporting evidence

```text
canonical Memory:
  key     = project.api.endpoint
  content = Public API endpoint is /v2/orders.

query:
  project api v1

eligible corpus:
  no Memory provides valid key/content evidence for v1
```

Expected:

```text
abstain
```

The same invariant must continue to hold for:

```text
project database SQLite
数据库 SQLite
```

when the current active database is PostgreSQL and no eligible active Memory supports SQLite.

### Case B — multi-aspect query with support elsewhere

```text
canonical Memory:
  key     = project.api.endpoint
  content = Public API endpoint is /v2/orders.

other eligible Memory:
  content = API docs live in docs/openapi.md.

query:
  project api docs
```

Expected:

```text
do not globally abstain
return the docs Memory if it satisfies normal lexical relevance/ranking
```

Similarly:

```text
canonical Memory:
  key     = project.database
  content = Production database is PostgreSQL.

other eligible Memory:
  content = Migration helper lives in scripts/db/migrate.ts.

query:
  project database migration
```

Expected:

```text
do not globally abstain
migration Memory remains recallable
```

The product rule is therefore:

> A partial canonical-slot conflict may justify abstention only when the query term(s) missing from that slot lack valid lexical support elsewhere in the same eligible corpus.

---

## 5. Required implementation shape

Exact code structure is not frozen, but the policy must remain deterministic, provider-neutral, and explainable.

Preferred conceptual pipeline:

```text
resolve Space + filters
        ↓
score every eligible Memory
        ↓
collect candidate-local lexical evidence
        ↓
identify possible canonical-slot conflicts
        ↓
check whether missing conflict terms have supporting key/content evidence
elsewhere in the eligible corpus
        ↓
query-level abstention decision
        ↓
rank accepted candidates
        ↓
limit
```

Do not encode the fix as another domain-specific word list.

Do not add one-off cases such as:

```text
if query contains docs ...
if query contains migration ...
```

The invariant must operate over lexical evidence and query shape.

---

## 6. Conflict evidence must use key/content support only

The conflict detector should reason from fields that describe the queried subject/value:

```text
key
content
```

For the purpose of deciding whether a canonical slot covers enough of the query to signal a stale/conflicting value, do not count matches that exist only in:

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
  database decision history
```

`database` may be key evidence. `decision` is only type metadata. `history` is absent.

This must not become a 2/3 canonical-slot conflict merely because the type contributes one token.

A useful internal representation may separate:

```ts
interface LexicalRetrievalMatch {
  // existing score/relevance fields

  keyContentMatchedTokens: string[];
  metadataMatchedTokens: string[];
  missingKeyContentQueryTokens: string[];
  canonicalSlotConflict: boolean;
}
```

This exact type is not required. The important point is semantic separation.

---

## 7. Query-level conflict resolution

A candidate-level conflict must be resolved against the corpus before turning into global abstention.

Recommended reasoning:

```text
for each conflicting keyed candidate:
  determine the raw query token(s) not supported by that candidate's key/content

  ask whether another eligible candidate provides meaningful key/content evidence
  for the missing token(s)

  if supported elsewhere:
      this conflict must NOT globally veto the query

  if unsupported everywhere:
      this conflict may contribute to abstention
```

The implementation may choose a different internal algorithm if it satisfies the same externally observable invariant.

Do not use fixture logical keys or provider-specific metadata in this decision.

### Strong exact evidence

Existing strong exact behavior remains valid:

```text
exact key
exact content phrase
```

A strong exact relevant result must not be erased by an unrelated conflicting canonical slot.

If multiple conflicts exist, the query-level policy must still avoid an unrelated slot vetoing independently supported results.

---

## 8. Holdout regressions — REQUIRED

Add production retrieval regressions outside the accepted Stage A fixture contract.

At minimum cover all of the following.

### H1 — existing stale database negative

```text
current:
  project.database = PostgreSQL

query:
  project database SQLite

no active SQLite support elsewhere

expected:
  []
```

### H2 — existing stale API negative

```text
current:
  project.api.endpoint = /v2/orders

query:
  project api v1

no active v1 support elsewhere

expected:
  []
```

### H3 — existing Han stale negative

```text
current:
  数据库使用 PostgreSQL

query:
  数据库 SQLite

expected:
  []
```

### H4 — API multi-aspect positive

```text
current canonical:
  project.api.endpoint = /v2/orders

other Memory:
  API docs live in docs/openapi.md.

query:
  project api docs

expected:
  docs Memory remains returned/relevant
  query must not globally abstain
```

### H5 — database multi-aspect positive

```text
current canonical:
  project.database = PostgreSQL

other Memory:
  Migration helper lives in scripts/db/migrate.ts.

query:
  project database migration

expected:
  migration Memory remains returned/relevant
  query must not globally abstain
```

### H6 — metadata cannot manufacture conflict

```text
Memory:
  key  = project.database
  type = decision
  content does not contain history

query:
  database decision history

expected:
  type=decision does not help the canonical slot reach the conflict coverage threshold
```

### H7 — exact support survives unrelated conflicts

Construct an eligible corpus where:

```text
one canonical slot emits a conflict
another Memory has an exact key or exact content phrase for the query
```

Expected:

```text
exact result survives
```

The current strong-exact behavior should already move in this direction; add an explicit regression so it cannot be weakened later.

---

## 9. Preserve accepted Stage A / CR-PHASE10 behavior

The following must remain true after B1.1:

```text
raw one-token vs multi-token semantics remain correct
BROAD_QUERY_TOKENS remains absent
canonicalType remains absent
canonicalKey remains only a small documented ranking prior
Stage A snapshot remains v2 or a strictly compatible reviewed extension
query text / relevant keys / filters / classification mutation detection remains active
production result ordering remains score DESC / updatedAt DESC / id ASC
```

Do not edit accepted Stage A `relevantMemoryKeys` or other frozen fixture labels.

The new H4–H7 cases are B1.1 holdouts, not retroactive Stage A relabeling.

---

## 10. Metric acceptance gate

Stage B1.1 is a correctness/generalization hardening pass. It is not required to improve aggregate positive retrieval metrics.

The accepted Stage A comparison must still satisfy:

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

The expected healthy outcome may remain:

```text
all positive Stage A metrics unchanged
negative FP 1.0 -> 0.0
negative abstention 0.0 -> 1.0
```

Do not introduce a ranking prior or loosen/tighten a threshold just to create a prettier aggregate delta.

---

## 11. Comparison/eval requirements

Existing Stage A comparison remains authoritative for accepted benchmark regression.

In addition, B1.1 must have direct holdout assertions for false-abstention behavior because H4–H7 are intentionally not retrofitted into the Stage A snapshot.

The completion evidence must report separately:

```text
Accepted Stage A comparison
B1.1 holdout regressions
```

Do not blend newly added holdouts into Stage A aggregate metrics and then claim the historical baseline changed.

If desired, a separate B1 holdout report may be added, but this is optional.

---

## 12. Allowed change surface

Primary allowed files:

```text
src/application/lexical-retrieval.ts
src/application/memory-space.ts

test/retrieval-policy.test.ts

eval/quality/comparison.ts           only if comparison wiring genuinely needs hardening
eval/quality/memory-quality.test.ts  only for non-Stage-A-contract regression support

docs/P6_STAGE_B1_FALSE_ABSTENTION_HARDENING_SPEC.md
docs/P6_STAGE_B_RETRIEVAL_SPEC.md    status/reference update only
docs/quality/P6_STAGE_B1_RESULT.md   final evidence update
docs/code-review/*                   reviewer-owned status unless explicitly requested
README.md / roadmap                  only after review status actually changes
```

Avoid modifying the Stage A snapshot unless a schema-only compatibility issue is discovered. No accepted historical output needs to be regenerated for this hardening.

---

## 13. Production boundary audit

At completion, verify that this hardening did **not** modify:

```text
RuleBasedExtractor
extractor port
domain types / Memory semantics
storage implementation/schema
checkpoint policy
Handoff generation
provider adapters
provider lifecycle integration
MCP tool schemas
exact-six MCP tool surface
Space binding semantics
P3 Claude scoped waiver
```

B2/B3/B4 must remain unstarted.

---

## 14. Required verification

Run at minimum:

```bash
pnpm run check
pnpm run check:workspace

pnpm memory-space eval quality
pnpm memory-space eval quality --json

pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
```

Also run focused retrieval tests containing H1–H7.

Run both JSON commands twice and confirm deterministic equality / byte-equivalent serialization according to the existing project convention.

Do not claim GitHub CI PASS unless an actual remote check/workflow is visible.

### Recorded implementation evidence — 2026-08-13

The candidate-local conflict signal now exposes key/content matches and missing
raw query terms separately from type/data metadata matches. `MemorySpace.search()`
checks every missing conflict term against key/content evidence from other
eligible Memories. Supported multi-aspect queries continue to normal production
ranking; unsupported stale-value queries abstain. Strong exact evidence remains
protected.

All H1–H7 holdouts pass. Accepted Stage A positive metrics remain unchanged,
negative FP remains `0.000000`, negative abstention remains `1.000000`, new
accepted retrieval failures remain zero, and top-1 regressions remain zero.
Both full checks pass `118/118`; quality and comparison JSON each remain
byte-equivalent across two CLI processes. This is implementation evidence, not
reviewer PASS or freeze authority.

---

## 15. Completion report

After implementation, stop and report:

```text
1. files changed
2. final canonical-slot conflict model
3. candidate-local vs query-level responsibilities
4. what fields contribute to conflict coverage
5. how missing conflict terms are checked against the eligible corpus
6. H1 stale database result
7. H2 stale API result
8. H3 Han stale database result
9. H4 API docs multi-aspect result
10. H5 database migration multi-aspect result
11. H6 metadata/type-only conflict result
12. H7 exact-support-survives-conflict result
13. canonicalType status (must remain removed)
14. canonicalKey status
15. accepted Stage A P@1/R@1
16. accepted Stage A P@3/R@3
17. accepted Stage A P@5/R@5
18. accepted Stage A P@10/R@10
19. negative FP / abstention
20. new/removed/unchanged accepted-fixture failures
21. Stage-A top-1 regressions
22. focused test result
23. pnpm run check result
24. pnpm run check:workspace result
25. human/JSON quality eval
26. human/JSON Stage A comparison
27. deterministic two-run result
28. production boundary audit
29. B2/B3/B4 status
30. GitHub CI only if independently observed
```

End with:

```text
P6 Stage B1.1 false-abstention hardening implemented.
B2/B3/B4 NOT started.
Awaiting B1 re-review.
```

Do not self-mark B1 PASS or FROZEN.

---

## 16. Review stop gate

After B1.1 implementation:

```text
STOP
→ code review
→ quality review
```

Do not proceed automatically to:

```text
B2 extraction
B3 Core/Handoff
B4 semantic retrieval
```

Only after B1 receives reviewer PASS may the next P6 sub-stage be selected.
