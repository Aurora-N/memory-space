# P8 Implicit Turn-Time Remember Result

**Date:** 2026-08-19

**Implementation tree:** working tree based on `1cac6a5658cc920413d83fa876ffb0aa1a7ebb15`

**Status:** IMPLEMENTED / DETERMINISTIC PASS / CLAUDE REAL-PROVIDER PASS / CODEX BLOCKED

## Outcome

P8 adds provider-neutral conservative turn-time ingestion after a reliable
assistant event has been persisted. Accepted candidates require current user
evidence, confidence of at least 0.85, non-transient evidence, an allowed
create/update operation, and no existing Core target. Every implicit commit is
forced to Indexed.

Existing bindings without `implicitRemember` remain auto-write-off. New
`memory-space init` bindings explicitly use:

```json
{
  "implicitRemember": { "mode": "conservative" }
}
```

## Deterministic evaluation

`pnpm memory-space eval implicit-remember` passed twice with byte-equivalent
reports:

| Metric | Result |
|---|---:|
| Implicit Remember Precision | 1.000000 |
| Implicit Core Write Rate | 0.000000 |
| Same-Evidence Duplicate Rate | 0.000000 |
| Replay Duplicate Rate | 0.000000 |
| Assistant-Only Persistence Rate | 0.000000 |
| Lifecycle Blocking Failure Rate | 0.000000 |
| Hard correctness | PASS |

The fixture covers all eleven required categories: opaque assignment, durable
decision, transient narration, assistant-only repetition, P7 recalled-content
repetition, opt-out, invalid config, replayed Stop, Stop plus SessionEnd,
existing Core collision, and Space mismatch/cwd drift.

## Real-provider evidence

### Claude Code

Command:

```text
node scripts/p8-real-smoke.mjs --provider claude
```

Observed with Claude Code `2.1.112`:

- reliable native `Stop.last_assistant_message`: PASS;
- Session A normal prompt automatically created one active Indexed Memory:
  `CROSS_AGENT_TEST_20260817 = lavender-731`;
- Session B bare key received P7 prompt-time recall context;
- final answer: `lavender-731`;
- explicit `memory_remember`, `memory_search`, or `memory_context` calls: none;
- duplicate Memory rows after Session B: zero.

### Codex

Codex CLI `0.147.0` was authenticated, but the real model run was blocked before
turn execution by the account usage limit. The CLI reported that usage becomes
available again on **August 20, 2026 at 11:47 AM**. The provider is therefore
recorded as **BLOCKED**, not PASS or product failure. The failed smoke produced
no P8 lifecycle evidence.

## Invariants

- Assistant Stop remains distinct from checkpoint.
- Implicit remember creates no Checkpoint or Handoff and advances no checkpoint
  boundary.
- Existing Core Memory is not modified, demoted, superseded, or overwritten.
- Assistant-only and recalled-content-only repetition cannot create Memory.
- Receipt and Memory mutation share one SQLite transaction.
- A later checkpoint reuses the receipt Memory identity while still running
  normal P6 admission, Handoff generation, and boundary advancement.
- MCP remains exactly six tools.

## Remaining work

P8 v1 uses deterministic extraction only. Broader semantic extraction,
embeddings, remote/LLM extractors, and a durable privacy watermark for
per-turn opt-out remain future work. Rerun the Codex smoke after the stated
usage-limit reset and append the observed result without changing the
deterministic acceptance status.
