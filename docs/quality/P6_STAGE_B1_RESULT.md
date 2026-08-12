# P6 Stage B1 — Retrieval Precision & Abstention Result

**Date:** 2026-08-12

**Branch:** `agent/memory-quality-v1`

**Accepted Stage A reference:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`

**Accepted snapshot commit:** `387db57db60ece079b1ad932b4c4786c8a26ac7f`

**Implementation commits:** `4c71a665b2c7f7f8527e9d1e0be78591d8f600a5`, `d422083ea365236cdfac5d68c3b86926e7c38602`

**Status:** IMPLEMENTED / AWAITING CODE AND QUALITY REVIEW

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
| canonical working-state type tie prior | 1 |

The two small priors cannot outweigh one content token. They resolve otherwise
equal lexical evidence in favor of canonical keyed/working-state Memory while the
existing deterministic `updatedAt`/`id` order remains the final tie breaker.

Broad structural nouns (`current`, `database`, `memory`, `project`, `storage`)
remain useful as a complete one-token query. In a mixed query that contains a
more discriminating term, they cannot independently establish relevance. This
is why `database` can retrieve current database Memory while `project database
SQLite` abstains when no eligible active Memory contains `SQLite` evidence.
When a multi-token query consists only of broad structural nouns, all tokens must
be covered unless an exact key/content phrase matches; `project.database` therefore
does not expose unrelated Memories that match only `project`.

A candidate is relevant when it has an exact key/content phrase, a content/key
token match, or—for a one-token query only—a type/data token match. Multi-token
type/data-only overlap is insufficient. A non-empty query with no qualifying
candidate returns an empty list.

## Accepted baseline versus candidate

| Metric | Stage A | B1 candidate | Delta | Queries |
| --- | ---: | ---: | ---: | ---: |
| P@1 | 0.727273 | 0.818182 | +0.090909 | 11 |
| R@1 | 0.681818 | 0.772727 | +0.090909 | 11 |
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

- `semantic-target-loses-to-overlap`: `retrieval.decision.rate-limit` moves from
  rank 2 to rank 1 over the same-token local storage fact.
- `long-old-sqlite-decision`: seven false-positive results become an empty result.

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
query identity and eligible corpus, per-K query counts, all required delta gates,
deep-rank diagnostics, and per-query top-1 non-regression.

Commands:

```bash
pnpm memory-space eval quality --compare-stage-a
pnpm memory-space eval quality --compare-stage-a --json
```

Recorded local validation on 2026-08-12:

```text
focused retrieval/eval/MCP/Handoff tests  PASS — 24/24
pnpm run check                            PASS — 114/114
pnpm run check:workspace                  PASS — 114/114
quality human CLI                         PASS
quality JSON CLI                          PASS
Stage A comparison human CLI              PASS — acceptance gate PASS
Stage A comparison JSON CLI               PASS — acceptance gate PASS
two quality JSON serializations           PASS — byte-equivalent, 24,644 bytes
two comparison JSON serializations        PASS — byte-equivalent, 16,053 bytes
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
