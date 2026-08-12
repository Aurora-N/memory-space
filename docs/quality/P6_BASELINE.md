# P6 Memory Quality v1 — Stage A Baseline

**Date:** 2026-08-12
**Branch:** `agent/memory-quality-v1`
**Base commit:** `e57095ce363afdbe4bb24ddf597f3933760a2ba6`
**Initial implementation commit:** `0c0ad5a875bc3f92ac181b7f4e9c719159e4124b`
**CR-PHASE9 metric hardening commit:** `1fab987197fb46618769c601b898d80d6ef6fd87`
**CR-PHASE9 tie-fixture commit:** `39bfc6266ad412c3188c0f8c173e5c84a0f37b9f`
**Accepted evidence commit:** `9490ebce94928132a2fb16aca247c8ae4888a7cf`
**Status:** ACCEPTED — CR-PHASE9 REVIEW PASS
**Next authorized stage:** P6 Stage B1 Retrieval Precision & Abstention

This document is the immutable historical Stage A before-state for later quality comparisons. It records the current production Memory implementation before Stage B product retrieval changes.

The values below are measurement evidence, not universal product SLOs.

## Scope and fixture inventory

The harness lives under `eval/quality/` and uses independent JSON ground truth:

| Fixture | Coverage |
| --- | --- |
| `extraction.json` | Checkpoint-derived candidates only: six expected durable facts and two negative/transient evidence cases |
| `retrieval.json` | Twelve-memory corpus with exact, partial, reordered, wording-mismatch, multi-relevant, and keyword-distractor queries |
| `supersession.json` | SQLite to PostgreSQL and API v1 to v2 evolution, including expected inactive Memory |
| `handoff.json` | Nine required atomic continuation facts across goal, progress, tasks, decisions, blockers, questions, and next steps |
| `long-horizon.json` | Exactly 20 logical Sessions with evolving decisions, completed work, repeated evidence, local detail, blockers, checkpoints, and explicit plus extracted Memory |

A smaller provider-neutral proof normalizes Codex lifecycle evidence, commits a checkpoint, starts a distinct Claude Session in the same Space, and verifies bootstrap/search continuity. It also hard-checks provenance, cross-Space isolation, inactive bootstrap exclusion, and the unchanged exact six MCP tools.

Ground truth refers to stable logical keys. A run-local identity map translates production random Memory IDs to those keys, including keyed in-place evolution. Reports contain no random UUIDs.

## Metric policy

```text
Extraction precision = TP / (TP + FP)
Extraction recall    = TP / (TP + FN)
Precision@K          = relevant unique results in top K / K
Recall@K             = relevant unique results in top K / relevant ground truth
Core pollution       = polluted active Core / active Core
Handoff completeness = required atomic facts found / required atomic facts
Stale rate           = stale active Memory / active Memory
Duplicate rate       = avoidable active duplicates / active duplicate-group members
```

Queries with at least one relevant logical key contribute to macro P@K/R@K. Zero-relevant queries are excluded and measured separately by false-positive and abstention rates.

For each query, K contributes only when:

```text
K <= eligibleCorpusSize
```

The eligible corpus is counted through `MemorySpace.search()` with an empty query and the same status/family/type/tier filters. Aggregate `queryCount` therefore varies by K.

The evaluator preserves the exact order returned by production `MemorySpace.search()`. Logical fixture keys translate identity only and never act as ranking or tie-breaking signals.

One query-only fixture correction was required after removing evaluator reordering: the multi-relevant rate-limit query uses existing relevant/distractor terms whose production scores are distinct. This removed random equal-score ordering without changing relevance labels or the intended failure class.

Empty relevant sets are invalid ordinary P@K/R@K inputs. An empty negative-query set has false-positive rate 0 and abstention rate 1. Empty expected completeness sets retain value 1; empty pollution/stale/duplicate denominators retain rate 0.

Quality metrics do not control the CLI exit status. Frozen correctness invariants do.

## Accepted baseline

| Dimension | Result |
| --- | ---: |
| Extraction | TP 4, FP 1, FN 2 |
| Extraction precision | 0.800000 |
| Extraction recall | 0.666667 |
| Retrieval P@1 / R@1 | 0.727273 / 0.681818 — 11 positive queries |
| Retrieval P@3 / R@3 | 0.303030 / 0.818182 — 11 positive queries |
| Retrieval P@5 / R@5 | 0.180000 / 0.800000 — 10 positive queries |
| Retrieval P@10 / R@10 | 0.090000 / 0.800000 — 10 positive queries |
| Negative-query false-positive rate | 1 / 1 = 1.000000 |
| Negative-query abstention rate | 0 / 1 = 0.000000 |
| Core pollution | 1 / 9 = 0.111111 |
| Bootstrap critical coverage | 7 / 7 = 1.000000 |
| Handoff completeness | 9 / 9 = 1.000000 |
| Stale-memory rate | 0 / 13 = 0.000000 |
| Duplicate-memory rate | 2 / 4 = 0.500000 |
| Contradiction/supersession checks | 10 / 10 = 1.000000 |
| Long-horizon Sessions | 20 |
| Bootstrap Core items | 9 |
| Latest Handoff facts | 11 |
| Bootstrap size | 1,654 characters / 1,674 UTF-8 bytes |

The resolved-only query has an eligible corpus of four Memories, so it contributes at K=1 and K=3 but is omitted at K=5 and K=10.

The negative SQLite query has an eligible active corpus of 13 and returns seven logical keys:

```text
decision.database.postgresql
decision.api.v2
progress.migration-complete
knowledge.database.paraphrase.3
decision.rate-limit.redis
decision.auth.jwt
goal.commerce-api
```

It is one false-positive query and is not represented as an artificial Recall@K=1 / Precision@K=0 sample.

Handoff completeness is 1.0 because all nine required facts are present. The report separately identifies two unexpected facts: the temporary debug cleanup appears in both `activeTasks` and `nextSteps`.

The stale rate and supersession score are also honest current results: keyed updates and explicit status transitions keep obsolete SQLite/API v1 state out of active/default context in this fixture.

## Hard correctness evidence

All accepted hard checks pass, including:

- latest Handoff belongs to the final committed S20 boundary;
- inactive/resolved Core Memory is excluded from bootstrap;
- keyed decision slots expose current state and exclude stale state;
- Codex evidence reaches a distinct Claude Session in the same Space;
- original Session provenance is preserved;
- cross-Space search remains isolated;
- archived Core Memory remains absent from bootstrap;
- MCP remains exactly the six shared tools.

These checks control `memory-space eval quality` exit status. Lower quality scores remain observations.

## Representative observed failures

1. Checkpoint extraction promotes a temporary debug-cleanup task, producing one extraction false positive and the single polluted Core item.
2. Natural wording for the hosted PostgreSQL decision and API compatibility constraint is not recognized, producing two extraction false negatives.
3. Lexical wording variants can completely miss the migration-path Memory and rank database keyword distractors instead.
4. Three unkeyed paraphrases of the same database rationale remain durable, producing two avoidable duplicates. Keyed database evolution itself remains one runtime Memory and is not counted as a duplicate.
5. The zero-relevant query phrased around obsolete SQLite state returns seven currently active but semantically different items. Its dedicated negative metric records false-positive rate 1.0 and abstention rate 0.0.

## Reproducibility and isolation

The runner creates isolated temporary SQLite files for extraction, retrieval, long-horizon, and provider-proof scenarios and removes them after each run. It does not contact the daemon and never opens the daemon's configured database. It performs no network model calls.

Two consecutive runner executions produced deep-equal reports after production ordering was restored, and the report contains no runtime UUID.

CLI:

```bash
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Recorded validation on 2026-08-12:

```text
pre-change pnpm run check             PASS — 98/98
pre-change pnpm run check:workspace   PASS — 98/98
CR-PHASE9 focused quality tests       PASS — 8/8
final pnpm run check                  PASS — 107/107
final pnpm run check:workspace        PASS — 107/107
quality human CLI                     PASS
quality JSON CLI                      PASS
two consecutive deterministic runs   PASS / byte-equivalent JSON
Codex P2 runner self-test             PASS
Claude P3 runner self-test            PASS
```

GitHub CI was not independently confirmed in this local pass.

## Production boundary audit

Stage A added fixtures, evaluator code, tests, report formatting, and the thin `eval quality` CLI route. It did not modify production extraction, retrieval, Memory/domain, persistence, lifecycle, provider adapter, or MCP behavior.

It did not add a seventh tool, provider-specific alias, embeddings, vector store, new tier, or direct CLI access to daemon SQLite.

The P3 real Claude model-driven MCP compatibility blocker remains under the existing scoped progression waiver. This baseline does not report it as PASS.

## Accepted Stage B ranking

The measured risks rank as:

1. **Lexical wording mismatch, negative-query false positives, and current-intent ranking — high measured impact, medium implementation risk.** Two positive query families miss relevant content, while the negative query returns seven active results instead of abstaining.
2. **Extraction generalization with transient-evidence rejection — high impact, medium risk.** Two false negatives and one false positive are recorded; the false positive also reaches default context.
3. **Core/Handoff transient pollution control — high impact, low-to-medium risk.** One of nine Core items is over-local, and two unexpected Handoff facts repeat it.
4. **Semantic dedup for unkeyed paraphrases — visible impact, high semantic and migration risk.** The measured rate is 2/4, while keyed dedup is already correct.

This ranking authorizes only Stage B1 now. See:

```text
docs/P6_STAGE_B_RETRIEVAL_SPEC.md
```

Stage B1 must preserve this document as the accepted before-state. Candidate metrics belong in a separate B1 result/comparison document rather than replacing these values.

## Review acceptance

CR-PHASE9 accepted this baseline after verifying:

```text
zero-relevant queries do not bias positive P/R
negative-query behavior is measured separately
only meaningful K values enter each aggregate
filtered corpus size is respected
production ranking is preserved
reports remain deterministic
baseline numbers are regenerated truthfully
production retrieval/extraction remain unchanged
P3 scoped Claude MCP waiver remains unchanged
```

Review evidence: [`../code-review/CR-PHASE9.md`](../code-review/CR-PHASE9.md).
