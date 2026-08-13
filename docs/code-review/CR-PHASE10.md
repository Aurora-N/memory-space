# CR-PHASE10 — P6 Memory Quality v1 Stage B1 Retrieval Review

**Reviewed branch:** `agent/memory-quality-v1`  
**Reviewed commit:** `fc6d107a6e431eeaefedfc4e310ac0d883a60f92`  
**Stage B1 spec baseline:** `a78d758fc7435c06c62e8b2f6f02cfbab342d032`  
**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`  
**Status:** CHANGES REQUESTED  
**Phase result:** Stage B1 architecture, comparison harness, and change boundary are accepted; retrieval relevance policy and benchmark-contract enforcement require hardening before B1 can freeze.  
**B2 / B3 / B4:** NOT AUTHORIZED

---

## 1. Review conclusion

Stage B1 is directionally correct and remains within the authorized production boundary.

The following work is accepted:

```text
Stage A snapshot committed before product changes        PASS
provider-neutral retrieval-only production scope         PASS
MemorySpace.search keeps Space/filter semantics          PASS
field-aware scorer extracted into a pure module          PASS
explicit relevance / abstention concept introduced       PASS
production score/updateAt/id ordering retained           PASS
accepted-baseline before/after comparison harness        PASS
per-query top-1 regression reporting                     PASS
quality comparison CLI                                   PASS
hard correctness checks retained                         PASS
no extractor/domain/storage/provider/MCP change          PASS
no embedding/vector/reranker/query-expansion work        PASS
B2/B3/B4 not started                                     PASS
semantic-recall ADR remains deferred                     PASS
```

However, the current candidate is not ready to freeze because the relevance policy still contains benchmark-specific behavior and the machine-readable comparison does not fully freeze the accepted Stage A query contract.

Required review groups:

```text
FIX-01 Retrieval relevance policy generalization         REQUIRED
  FIX-01A raw-query vs discriminating-token semantics
  FIX-01B stale-value abstention beyond database fixture
  FIX-01C multilingual / Han equivalent behavior

FIX-02 Query-independent canonicalType ranking prior      REQUIRED REVIEW / PREFER REMOVE

FIX-03 Accepted Stage A fixture contract enforcement      REQUIRED BEFORE FREEZE
```

Do not continue tuning aggregate scores while fixing this CR.

The goal of this pass is a policy that is easier to explain and generalize, even if the provisional B1 `P@1` / `R@1` improvement becomes smaller.

---

# 2. FIX-01 — Retrieval relevance policy must generalize beyond the named SQLite fixture

## 2.1 Current implementation

The candidate currently defines a hand-written structural vocabulary:

```ts
const BROAD_QUERY_TOKENS = new Set([
  "current",
  "database",
  "memory",
  "project",
  "storage"
]);
```

and derives:

```text
rawQueryTokens
→ remove broad tokens when another token exists
→ queryTokens
→ field matches / coverage / relevance
```

This makes the accepted negative fixture:

```text
project database SQLite
```

abstain against the current PostgreSQL Memory because `project` and `database` are removed and `SQLite` does not match.

That is useful evidence, but the policy does not yet represent the same failure class consistently.

---

# 3. FIX-01A — Raw query cardinality must not collapse into a synthetic one-token query

## Current problem

The implementation permits type/data-only evidence when:

```ts
queryTokens.length === 1
```

where `queryTokens` is the **post-filtered** discriminating token list.

This conflicts with the documented policy that type/data-only evidence is sufficient only for a genuine one-token user query.

For example:

```text
query: database decision
rawQueryTokens: [database, decision]
post-filter queryTokens: [decision]
```

The query is genuinely multi-token, but the implementation can treat it as one-token after removing `database`. Any Memory whose type is `decision` can then establish relevance even if it has no database evidence.

## Required behavior

Keep these concepts separate:

```text
raw query tokens
→ describe what the user actually supplied

relevance/discriminating tokens
→ may be used by a relevance policy
```

A rule documented as "one-token query" must use raw-query cardinality, not the cardinality left after stop/structural-token processing.

Do not silently change documentation to redefine a multi-token query as one-token merely because one token was filtered.

## Required regression

Add a production retrieval regression proving a multi-token query such as:

```text
database decision
```

cannot expose unrelated Memories solely because their `type` is `decision`.

Also retain explicit tests showing true one-token type/data queries behave according to the intended policy.

---

# 4. FIX-01B — Obsolete-value abstention must not depend on `database` being in a hard-coded list

## Current problem

The accepted long-horizon fixture contains two keyed state evolutions:

```text
project.database
SQLite → PostgreSQL

project.api.endpoint
/v1/orders → /v2/orders
```

The current policy handles the first named negative case:

```text
project database SQLite
→ current PostgreSQL Memory abstains
```

but the same reasoning does not naturally extend to:

```text
project api v1
```

because `api` is not one of the current broad tokens. The active `/v2` Memory can still receive relevance from `api` key/content evidence while the discriminating obsolete value `v1` is absent.

This is the same product failure class:

> a query asks for an obsolete/conflicting value, while only the current canonical value exists.

A B1 policy should not solve one keyed slot only because its domain noun was named in a stop/broad-token set.

## Required behavior

Refactor the lexical relevance policy so that stale/conflicting-value abstention has a general explanation independent of the exact word `database`.

The implementation choice is not prescribed, but it must satisfy all of the following:

```text
- exact key remains strongly relevant;
- short direct value queries such as `PostgreSQL` remain useful;
- partial key queries such as `database` may remain useful if explicitly intended;
- a mixed query containing structural/key evidence plus an unmatched discriminating value must not become relevant merely from the structural/key portion;
- the rule must work for more than one domain slot;
- the rule must remain deterministic and provider-neutral.
```

Do **not** fix this by only expanding the hard-coded list with:

```text
api
auth
endpoint
...
```

or by adding tokens solely because the new tests name them.

If a small structural vocabulary is retained, document the invariant it represents and prove the behavior with independent holdout cases rather than treating the vocabulary itself as the policy.

## Required regressions

At minimum add an unseen/holdout case for:

```text
current key: project.api.endpoint
current content: Public API endpoint is /v2/orders.
query: project api v1
expected: current /v2 Memory must not be accepted solely on `project`/`api` evidence
```

Keep the existing exact-key/current-value positive cases.

Do not add this holdout by changing accepted Stage A relevance labels. It belongs in production retrieval regression coverage or a separately added B1 holdout set.

---

# 5. FIX-01C — The policy must behave coherently for the existing Han-token path

## Current problem

The production tokenizer explicitly supports Han text through bigrams, and the repository already contains Chinese extraction/evolution evidence such as:

```text
数据库确定使用 SQLite
数据库确定使用 PostgreSQL
```

The current broad-token vocabulary is English-only. Therefore an equivalent stale-value query such as:

```text
数据库 SQLite
```

can still match the current PostgreSQL Memory through the `数据库` lexical evidence even though the obsolete value `SQLite` is absent.

The exact expected tokenization details are implementation-specific, but the user-visible relevance semantics should not depend on whether the structural noun is written in English or Chinese when both paths are already supported by the lexical layer.

## Required behavior

Do not introduce a special-case Chinese translation table solely for this one test.

Instead ensure the generalized FIX-01 relevance rule applies to Han tokenization as well as ASCII tokenization.

## Required regression

Add a deterministic test equivalent to:

```text
current DB = PostgreSQL
query = 数据库 SQLite
expected = do not accept current PostgreSQL Memory solely on database-topic overlap
```

Also retain a positive current-value/direct query so the fix does not simply suppress Chinese database recall.

---

# 6. FIX-02 — Reconsider the query-independent `canonicalType` ranking prior

## Current behavior

The candidate adds small ranking priors such as:

```text
canonicalKey  +2
canonicalType +1
```

where `canonicalType` rewards working-state types such as:

```text
decision
goal
task
blocker
...
```

independently of the query.

The current positive top-1 improvement is materially influenced by this rule for the accepted fixture:

```text
query: storage bucket throttling

relevant:   Rate limit enforcement uses a Redis token bucket.  (decision)
distractor: Asset uploads use a storage bucket.                (fact)
```

After structural-token filtering, the lexical evidence can be tied or nearly tied. The `decision` type then wins because of `canonicalType`, producing the reported top-1 improvement.

However, the fixture itself describes this as a semantic-target case: the scorer does not derive `throttling → rate limiting`; it prefers a Memory type.

## Why this needs review

Stage B1 is authorized as deterministic lexical relevance/ranking work, while semantic-recall choices are intentionally deferred.

A query-independent type prior can be legitimate product policy, but it is not lexical evidence. Without broader evidence it risks encoding:

```text
decision > fact
```

as a universal ranking preference merely because that happens to select the benchmark's intended semantic target.

## Preferred fix

Prefer removing `canonicalType` from Stage B1 unless there is independent product evidence that working-state types should globally outrank factual Memories under equal lexical evidence.

It is acceptable if removing this prior causes the provisional aggregate improvement:

```text
P@1 0.727273 → 0.818182
R@1 0.681818 → 0.772727
```

to shrink or disappear.

A smaller but more trustworthy B1 result is preferable to a benchmark-driven ranking prior.

Stage B1 can still be valuable if it proves:

```text
negative-query false-positive behavior improves
negative-query abstention improves
accepted positive lexical recall does not regress
previously top-1-correct positive queries do not regress
```

## Alternative if the prior is retained

If `canonicalType` is retained, it must be explicitly promoted from an incidental tie bonus to a reviewed ranking-policy concept.

At minimum:

1. document it separately from lexical evidence in the B1 spec/result;
2. explain the product semantic reason for the ordering;
3. add independent holdout cases where a factual Memory should beat a decision when its lexical evidence is stronger or equally appropriate;
4. prove the prior does not broadly suppress Indexed factual recall;
5. keep the weight incapable of overriding meaningful query evidence.

Do not retain the prior solely to preserve the current `P@1` improvement.

## `canonicalKey`

`canonicalKey` has a stronger semantic argument because keyed Memory represents a canonical state slot, but it is still a ranking prior rather than lexical evidence.

If retained, document it as such and test that one lexical content token can outweigh the prior.

---

# 7. Acceptance policy may be corrected to avoid incentivizing benchmark chasing

The current B1 comparison includes a strict-improvement check that can be satisfied by the `canonicalType`-driven top-1 change.

During this CR, it is authorized to revise the B1 acceptance policy if necessary so that removing an unjustified ranking prior does not make a more principled candidate fail solely because `P@1` returns to baseline.

A minimum acceptable B1 gate after this review should still require:

```text
all frozen hard correctness checks PASS
query/eligible-corpus contract stable
negative-query false-positive rate strictly improves from Stage A
negative-query abstention strictly improves from Stage A
P@1 >= accepted Stage A P@1
R@1 >= accepted Stage A R@1
P@3 >= accepted Stage A P@3
R@3 >= accepted Stage A R@3
P@5/R@5/P@10/R@10 do not regress
all Stage-A top-1-correct positive queries remain top-1 correct
no new accepted-fixture retrieval failure
```

Do not invent a new arbitrary numeric target.

If there is a genuine positive-ranking improvement after the generalized policy, report it, but it is not required to manufacture one through a query-independent type preference.

Update `docs/P6_STAGE_B_RETRIEVAL_SPEC.md` if the acceptance rule changes.

---

# 8. FIX-03 — Freeze the accepted Stage A query contract, not only its output metrics

## Current problem

The committed Stage A snapshot currently freezes per-query fields such as:

```text
scenarioId
id
classification
eligibleCorpusSize
returned
atK
```

but does not freeze the complete evaluation contract that generated those values:

```text
query text
relevantMemoryKeys / expected logical keys
families
types
tiers
statuses
```

The candidate comparison verifies identity/classification/corpus size, but a future change could theoretically keep the same query ID while changing query text or relevance labels and still produce a superficially valid comparison.

No such cheating was observed in this implementation. This finding is about hardening the benchmark contract before Stage B1 is frozen.

## Required behavior

Extend the accepted Stage A snapshot so each retrieval query freezes enough source contract to detect benchmark mutation.

Preferred structure:

```ts
{
  scenarioId,
  id,
  classification,
  query,
  relevantMemoryKeys,
  filters: {
    families?,
    types?,
    tiers?,
    statuses?
  },
  eligibleCorpusSize,
  returned,
  atK
}
```

Equivalent normalized fields are acceptable.

The comparison must hard-fail before metric comparison if candidate fixture contract differs from the accepted Stage A snapshot.

At minimum verify:

```text
query text unchanged
relevant logical keys unchanged
classification unchanged
filters unchanged
eligible corpus unchanged
query identity set unchanged
per-K participant counts unchanged
```

A stable normalized fixture-contract hash may be added in addition to structured fields, but do not replace reviewable structured evidence with an opaque hash only.

## Snapshot provenance

Do not regenerate Stage A expected outputs using the B1 implementation.

The accepted Stage A output values remain those from:

```text
9490ebce94928132a2fb16aca247c8ae4888a7cf
```

If the snapshot file needs a schema extension for query/ground-truth/filter fields, populate those contract fields from the accepted fixture definitions without replacing the accepted Stage A returned results/metrics with B1 output.

Document the snapshot-schema migration clearly.

---

# 9. Stage A ground truth remains immutable

Do not modify existing accepted Stage A labels merely to make the new scorer pass.

Forbidden score-driven changes include:

```text
existing relevantMemoryKeys
existing positive/negative classification
existing expected Core labels
existing expected inactive labels
existing Handoff labels
existing duplicate groups
existing criticalBootstrapKeys
```

Adding **new B1 holdout/regression cases** is encouraged and does not alter Stage A history.

If an existing accepted fixture is discovered to be genuinely invalid, stop and request an eval-spec review instead of silently editing it in this CR.

---

# 10. Preserve accepted production and architecture boundaries

Do not reopen unrelated layers while addressing CR-PHASE10.

Allowed primary change surface:

```text
src/application/lexical-retrieval.ts
src/application/memory-space.ts          only if minimal wiring changes are needed
test/retrieval-policy.test.ts
eval/quality/baseline.ts
eval/quality/comparison.ts
eval/quality/baselines/p6-stage-a.json   schema-extension only, not regenerated candidate output
eval/quality/*.test.ts
docs/P6_STAGE_B_RETRIEVAL_SPEC.md
docs/quality/P6_STAGE_B1_RESULT.md
docs/code-review/CR-PHASE10.md           implementation-status note only if desired
other status docs only when evidence changes
```

Do not modify:

```text
RuleBasedExtractor / extractor port
domain model
storage schema / persistence semantics
checkpoint or Handoff generation
provider lifecycle adapters
MCP tool schemas / exact-six contract
Space binding semantics
P3 Claude scoped waiver
```

Forbidden during this CR:

```text
embeddings
vector database
hybrid retrieval
query expansion / synonym dictionary
LLM query rewriting
reranker service
semantic dedup
B2 extraction work
B3 Core/Handoff policy work
B4 semantic retrieval implementation
new provider integration
```

`docs/adr/0004-semantic-recall-options-after-b1.md` may remain a deferred decision record; do not turn it into implementation authorization.

---

# 11. Required focused tests

Add or retain focused coverage for at least:

```text
exact key query remains strong                           PASS
one-token direct value query remains useful              PASS
partial-key query intended behavior documented/tested    PASS
mixed structural + current value query                   PASS
mixed structural + obsolete value query abstains         PASS
API v1→v2 obsolete-value holdout                         PASS
multi-token type-only false positive rejected            PASS
true one-token type/data policy behaves as intended      PASS
Han/Chinese stale-value holdout                          PASS
Han/Chinese current-value positive recall                PASS
no fixture logical key participates in production rank   PASS
score ties keep updatedAt DESC / id ASC                   PASS
existing Space/status/family/type/tier filters            PASS
limit applied after relevance/ranking                    PASS
```

If `canonicalType` is retained, also test both directions of its intended policy with holdouts not derived from `storage bucket throttling`.

---

# 12. Required comparison/eval tests

Add coverage proving the accepted-baseline contract cannot be changed silently.

At minimum:

```text
snapshot schema validates query text                     PASS
snapshot schema validates relevant logical keys          PASS
snapshot schema validates retrieval filters              PASS
candidate query text mutation causes comparison failure  PASS
candidate relevance-label mutation causes failure        PASS
candidate filter mutation causes comparison failure      PASS
query set mutation causes failure                         PASS
eligible corpus mutation causes failure                  PASS
per-K participant counts remain stable                   PASS
hard correctness remains PASS                            PASS
comparison remains deterministic                         PASS
```

Do not weaken existing comparison checks to make the candidate pass.

---

# 13. Verification required before re-review

Run focused tests and the complete repository gate.

At minimum execute:

```bash
pnpm run check
pnpm run check:workspace
pnpm memory-space eval quality
pnpm memory-space eval quality --json
pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
```

Run both JSON forms twice and confirm deterministic equality.

Report the actual candidate values after hardening:

```text
P@1 / R@1
P@3 / R@3
P@5 / R@5
P@10 / R@10
negative-query false-positive rate
negative-query abstention rate
```

If removing `canonicalType` lowers the provisional B1 aggregate improvement, record that truthfully.

Do not restore the prior merely to recover the previous score.

If GitHub CI is not observable, continue to state:

```text
GitHub CI not independently confirmed
```

Do not claim remote CI PASS without evidence.

---

# 14. Re-review completion report

After implementing CR-PHASE10, stop and report:

1. files changed;
2. final relevance-policy explanation;
3. whether `BROAD_QUERY_TOKENS` remains and, if so, its generalized invariant;
4. raw-query vs discriminating-token semantics;
5. `database decision` regression result;
6. API v1→v2 obsolete-value result;
7. Chinese/Han stale-value result;
8. Chinese/Han positive current-value result;
9. `canonicalType` removed or retained;
10. if retained, independent justification and holdout evidence;
11. `canonicalKey` policy and evidence;
12. Stage A snapshot schema changes;
13. how query text / relevant keys / filters are frozen;
14. mutation-detection tests;
15. updated B1 acceptance policy, if changed;
16. final P@1/R@1;
17. final P@3/R@3;
18. final P@5/R@5;
19. final P@10/R@10;
20. final negative FP / abstention;
21. removed/new/unchanged retrieval failures;
22. top-1 regressions, expected none;
23. focused test results;
24. `pnpm run check` result;
25. `pnpm run check:workspace` result;
26. quality human/JSON CLI results;
27. Stage A comparison human/JSON CLI results;
28. two-run determinism result;
29. production files outside authorized retrieval boundary changed? expected no;
30. B2/B3/B4 status, expected not started;
31. GitHub CI status only if actually observed;
32. remaining lexical capability boundaries.

End with:

```text
P6 Stage B1 CR-PHASE10 fixes implemented.
B2/B3/B4 NOT started.
Awaiting B1 re-review.
```

Do not mark CR-PHASE10 PASS yourself.

---

# 15. Acceptance gate

CR-PHASE10 can be closed when the reviewer confirms:

```text
raw multi-token queries do not collapse into one-token type/data relevance     PASS
obsolete-value abstention generalizes beyond the database fixture              PASS
Han/ASCII stale-value behavior is coherent                                     PASS
no benchmark-specific vocabulary patch is the sole explanation                 PASS
canonicalType prior is removed or independently justified                      PASS
accepted Stage A query text/ground truth/filters are machine-frozen             PASS
candidate comparison rejects fixture-contract mutation                          PASS
negative FP improves over accepted Stage A                                     PASS
negative abstention improves over accepted Stage A                             PASS
accepted positive P@1/R@1/P@3/R@3 do not regress                              PASS
deep-rank diagnostics do not regress                                            PASS
previously top-1-correct positive queries remain top-1 correct                  PASS
all frozen hard correctness checks remain PASS                                  PASS
production change remains provider-neutral retrieval only                       PASS
exact six MCP tools unchanged                                                   PASS
P3 Claude scoped waiver unchanged                                               PASS
B2/B3/B4 remain unstarted                                                       PASS
```

Until then:

```text
P6 Stage B1 code review        CHANGES REQUESTED
P6 Stage B2/B3/B4             DO NOT START
```
