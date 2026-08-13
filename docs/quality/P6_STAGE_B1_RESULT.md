# P6 Stage B1 — Retrieval Precision & Abstention Result

**Date:** 2026-08-13

**Branch:** `agent/memory-quality-v1`

**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`

**Accepted snapshot commit:** `387db57db60ece079b1ad932b4c4786c8a26ac7f`

**Implementation commits:** `4c71a665b2c7f7f8527e9d1e0be78591d8f600a5`, `d422083ea365236cdfac5d68c3b86926e7c38602`

**CR-PHASE10 hardening commit:** `ea3c50f3c652b431bec0a3f0332c9fbbbade90b1`

**Status:** CR-PHASE10 FIXES IMPLEMENTED / AWAITING RE-REVIEW

This document records the deterministic B1 candidate. It is implementation
evidence, not reviewer approval and not a universal product-quality SLO.
B2/B3/B4 have not started.

## Change boundary

Production changes are limited to provider-neutral lexical retrieval:

```text
MemorySpace.search eligible Space/filter corpus
→ deterministic field-aware evidence
→ explicit relevance gate
→ score accepted candidates
→ score DESC / updatedAt DESC / id ASC
→ limit
```

No extraction, domain model, storage, lifecycle, provider adapter, Handoff/Core,
or MCP contract code changed. MCP remains exactly six shared tools.

## Retrieval policy

Normalization is deterministic NFKC, whitespace folding, and locale-independent
lowercasing. Tokenization supports ASCII alphanumerics and existing Han bigrams.

Centralized evidence weights:

| Evidence | Weight |
| --- | ---: |
| exact key | 120 |
| exact content phrase | 100 |
| content token | 12 each |
| key token | 8 each |
| data token | 4 each |
| type token | 2 each |
| matched-token coverage | up to 10 |
| canonical key tie prior | 2 |

`canonicalType` was removed during CR-PHASE10 hardening. Stage B1 no longer gives
`decision`, `task`, or other working-state types a query-independent preference.
The semantic target therefore returns to its accepted Stage A rank instead of
being promoted merely because it is a `decision`.

`canonicalKey` remains a +2 ranking prior, explicitly separate from lexical
evidence. An independent holdout proves that one content-token match (+12) ranks
above a candidate receiving only key-token evidence and this prior.

`BROAD_QUERY_TOKENS` was removed. Raw query tokens are never collapsed by a
domain-specific stoplist. The policy is:

1. exact key/content phrase remains strong;
2. content/key token overlap establishes ordinary lexical relevance;
3. type/data-only overlap is allowed only when the actual raw query has one token;
4. for a compact two- or three-token query, a keyed slot covering at least two
   thirds of the raw tokens while missing another term signals a possible
   stale/conflicting value;
5. unless another eligible Memory has an exact key/content match, that signal
   makes the whole query abstain instead of returning weaker topic-only results.

This query-shape/canonical-slot invariant has independent database, API endpoint,
and Chinese/Han holdouts. No token such as `api`, `auth`, `endpoint`, or a Chinese
translation was added to a vocabulary.

CR-PHASE10 holdout results:

| Holdout | Result |
| --- | --- |
| `database decision` | current database Memory is retained; unrelated `decision` type-only Memory is excluded |
| current API `/v2/orders`, query `project api v1` | empty result / abstain |
| current DB PostgreSQL, query `数据库 SQLite` | empty result / abstain |
| current DB PostgreSQL, query `数据库 PostgreSQL` | current Chinese Memory ranks first |
| `project.api.endpoint` | exact current key ranks first |
| `v2 orders` | direct current API value ranks first |

## Accepted baseline versus candidate

| Metric | Stage A | B1 candidate | Delta | Queries |
| --- | ---: | ---: | ---: | ---: |
| P@1 | 0.727273 | 0.727273 | 0 | 11 |
| R@1 | 0.681818 | 0.681818 | 0 | 11 |
| P@3 | 0.303030 | 0.303030 | 0 | 11 |
| R@3 | 0.818182 | 0.818182 | 0 | 11 |
| P@5 | 0.180000 | 0.180000 | 0 | 10 |
| R@5 | 0.800000 | 0.800000 | 0 | 10 |
| P@10 | 0.090000 | 0.090000 | 0 | 10 |
| R@10 | 0.800000 | 0.800000 | 0 | 10 |
| Negative-query FP rate | 1.000000 | 0.000000 | -1.000000 | 1 |
| Negative-query abstention | 0.000000 | 1.000000 | +1.000000 | 1 |

The per-K participant counts and every query's eligible corpus size are unchanged.
All positive queries that were top-1 correct in Stage A remain top-1 correct.

## Per-query changes

Improved:

- `long-old-sqlite-decision`: seven false-positive results become an empty result.

The provisional `semantic-target-loses-to-overlap` rank-1 improvement was removed
with `canonicalType`. Its relevant Memory remains at rank 2, matching Stage A and
preserving Recall@3 without claiming lexical evidence for `throttling → rate
limiting`.

No positive query regressed at top 1 or at its reported P@K/R@K values. Some
returned tails changed because candidates with only broad/non-qualifying evidence
are now filtered; these changes do not alter ground-truth hits.

Retrieval failure classification:

| Failure | Candidate classification |
| --- | --- |
| `wording-mismatch` | lexical capability boundary: target and query have effectively no useful shared token |
| `long-migration-wording-mismatch` | lexical capability boundary: related wording has no overlapping lexical evidence |

Removed failure example:

```text
saas-commerce-api-20-session-evolution:long-old-sqlite-decision:
negative-query-false-positive
```

New retrieval failure examples: none. The two wording-mismatch Recall@3 failures
remain unchanged. Extraction, Core pollution, and duplicate failures also remain
unchanged because B2/B3/B4 were not started.

## Correctness and determinism

All 15 accepted hard-correctness checks remain PASS, including Space isolation,
provenance, inactive bootstrap exclusion, latest Handoff boundary, keyed current
state, and the exact shared six-tool MCP surface.

The committed comparison validates the Stage A snapshot schema/version, candidate
query identity/text/relevant keys/filters/classification and eligible corpus,
per-K query counts, all required delta gates, no-new-failure policy, deep-rank
diagnostics, and per-query top-1 non-regression. Snapshot schema v2 only adds this
contract metadata; all accepted returned results and metrics still originate from
`9490ebc`.

Mutation tests independently reject changed query text, relevant keys,
classification, filters, query set, and eligible corpus. Aggregate per-K query
counts remain checked separately by the acceptance report.

Commands:

```bash
pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
```

Recorded local validation on 2026-08-13:

```text
focused retrieval/eval/MCP/Handoff tests  PASS — 26/26
pnpm run check                            PASS — 116/116
pnpm run check:workspace                  PASS — 116/116
quality human CLI                         PASS
quality JSON CLI                          PASS
Stage A comparison human CLI              PASS — acceptance gate PASS
Stage A comparison JSON CLI               PASS — acceptance gate PASS
two quality JSON CLI runs                  PASS — byte-equivalent, 25,260 bytes
two comparison JSON CLI runs               PASS — byte-equivalent, 18,216 bytes
Codex P2 runner self-test                  PASS
Claude P3 runner self-test                 PASS
```

GitHub CI not independently confirmed.

## Semantic recall stop gate

The remaining retrieval failures are wording variants with little or no lexical
overlap. B1 stops here instead of adding semantic infrastructure. The separately
reviewable alternatives are compared in
[`../adr/0004-semantic-recall-options-after-b1.md`](../adr/0004-semantic-recall-options-after-b1.md).

Recommendation: keep the deterministic lexical B1 candidate and request a
semantic-recall architecture review only if the remaining capability boundary is
not acceptable. Do not begin B2/B3/B4 from this result.
