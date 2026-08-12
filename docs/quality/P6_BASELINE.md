# P6 Memory Quality v1 — Stage A Baseline

**Date:** 2026-08-12
**Branch:** `agent/memory-quality-v1`
**Base commit:** `e57095ce363afdbe4bb24ddf597f3933760a2ba6`
**Implementation commit:** not created; evidence describes the current review working tree
**Status:** Stage A implemented and awaiting baseline review
**Stage B:** Not started

This document records the deterministic baseline produced by the current
Memory implementation. It is measurement evidence, not a claim that every
quality score passes a target. No target thresholds have been adopted.

## Scope and fixture inventory

The harness lives under `eval/quality/` and uses independent JSON ground truth:

| Fixture | Coverage |
| --- | --- |
| `extraction.json` | Checkpoint-derived candidates only: six expected durable facts and two negative/transient evidence cases |
| `retrieval.json` | Twelve-memory corpus with exact, partial, reordered, wording-mismatch, multi-relevant, and keyword-distractor queries |
| `supersession.json` | SQLite to PostgreSQL and API v1 to v2 evolution, including expected inactive Memory |
| `handoff.json` | Nine required atomic continuation facts across goal, progress, tasks, decisions, blockers, questions, and next steps |
| `long-horizon.json` | Exactly 20 logical Sessions with evolving decisions, completed work, repeated evidence, local detail, blockers, checkpoints, and explicit plus extracted Memory |

A smaller provider-neutral proof normalizes Codex lifecycle evidence, commits a
checkpoint, starts a distinct Claude Session in the same Space, and verifies
bootstrap/search continuity. It also hard-checks provenance, cross-Space
isolation, inactive bootstrap exclusion, and the unchanged exact six MCP tools.

Ground truth refers to stable logical keys. A run-local identity map translates
the production store's random Memory IDs to those keys, including keyed
in-place evolution. Reports contain no random UUIDs.

## Metric policy

The implemented formulas are:

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

Retrieval values are macro averages across 12 queries. K is meaningful because
each evaluated corpus contains at least ten retrievable items. Equal lexical
scores are ordered by fixture logical key in the evaluator only; production
ranking is unchanged.

Empty expected sets have precision/recall/completeness value 1. Empty
pollution/stale/duplicate denominators have rate 0. This makes edge behavior
explicit and stable instead of producing `NaN`.

Quality metrics do not control the CLI exit status. Only frozen correctness
invariants do.

## Recorded baseline

| Dimension | Result |
| --- | ---: |
| Extraction | TP 4, FP 1, FN 2 |
| Extraction precision | 0.800000 |
| Extraction recall | 0.666667 |
| Retrieval P@1 / R@1 | 0.666667 / 0.708333 |
| Retrieval P@3 / R@3 | 0.277778 / 0.833333 |
| Retrieval P@5 / R@5 | 0.166667 / 0.833333 |
| Retrieval P@10 / R@10 | 0.083333 / 0.833333 |
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

Handoff completeness is 1.0 because all nine required facts are present. The
report separately identifies two unexpected facts: the temporary debug cleanup
appears in both `activeTasks` and `nextSteps`.

The stale rate and supersession score are also honest current results: keyed
updates and explicit status transitions keep the obsolete SQLite/API v1 state
out of active/default context in this fixture. They are not synthetic PASS
labels or thresholds.

## Hard correctness evidence

All 15 hard checks pass:

- latest Handoff belongs to the final committed S20 boundary;
- inactive/resolved Core Memory is excluded from bootstrap;
- both keyed decision slots expose the current state and exclude stale state;
- Codex evidence reaches a distinct Claude Session in the same Space;
- original Session provenance is preserved;
- cross-Space search remains isolated;
- archived Core Memory remains absent from bootstrap;
- MCP remains exactly the six shared tools.

These checks control `memory-space eval quality` exit status. The lower quality
scores above remain observations.

## Representative observed failures

1. Checkpoint extraction promotes a temporary debug-cleanup task, producing one
   extraction false positive and the single polluted Core item.
2. Natural wording for the hosted PostgreSQL decision and API compatibility
   constraint is not recognized, producing two extraction false negatives.
3. Lexical wording variants can completely miss the migration-path Memory and
   rank database keyword distractors instead.
4. Three unkeyed paraphrases of the same database rationale remain durable,
   producing two avoidable duplicates. Keyed database evolution itself remains
   one runtime Memory and is not counted as a duplicate.
5. A query phrased around obsolete SQLite state can retrieve currently active
   but semantically different items that share lexical tokens.

## Reproducibility and isolation

The runner creates isolated temporary SQLite files for extraction, retrieval,
long-horizon, and provider-proof scenarios and removes them after each run. It
does not contact the daemon and never opens the daemon's configured database.
It performs no network model calls.

Two consecutive runner executions produced deep-equal reports, and the report
contains no runtime UUID. The CLI exposes the same runner:

```bash
pnpm memory-space eval quality
pnpm memory-space eval quality --json
```

Recorded validation on 2026-08-12:

```text
pre-change pnpm run check             PASS — 98/98
pre-change pnpm run check:workspace   PASS — 98/98
final pnpm run check                  PASS — 104/104
final pnpm run check:workspace        PASS — 104/104
quality human CLI                     PASS
quality JSON CLI                      PASS
two consecutive deterministic runs   PASS / byte-equivalent JSON
Codex P2 runner self-test             PASS
Claude P3 runner self-test            PASS
```

GitHub CI was not independently confirmed in this local pass.

## Production boundary audit

Stage A adds fixtures, evaluator code, tests, report formatting, and the thin
`eval quality` CLI route. It does not modify production extraction, retrieval,
Memory/domain, persistence, lifecycle, provider adapter, or MCP behavior. It
does not add a seventh tool, provider-specific alias, embeddings, a vector
store, a new tier, or direct CLI access to daemon SQLite.

The P3 real Claude model-driven MCP compatibility blocker remains under the
existing scoped progression waiver. This baseline does not report it as PASS.

## Ranked Stage B candidates

These are recommendations for later review, not implemented work:

1. **Lexical wording mismatch and current-intent ranking — high measured impact,
   medium implementation risk.** Two query families miss relevant content or
   prefer same-keyword distractors, directly affecting explicit recall.
2. **Extraction generalization with transient-evidence rejection — high impact,
   medium risk.** The baseline records two false negatives and one false
   positive, with the false positive also reaching default context.
3. **Core/Handoff transient pollution control — high impact, low-to-medium
   risk.** One of nine Core items is over-local, and two unexpected Handoff
   facts repeat it.
4. **Semantic dedup for unkeyed paraphrases — visible impact, high semantic and
   migration risk.** The measured rate is 2/4, but keyed dedup is already
   correct; any broader merge rule needs separate domain review.

Stage B has not started. Selecting targets, thresholds, or algorithm changes
requires explicit baseline review and authorization.
