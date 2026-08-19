# P8 Implicit Turn-Time Remember Result

**Date:** 2026-08-19

**P8 spec baseline:** `1cac6a5658cc920413d83fa876ffb0aa1a7ebb15`

**P8 original implementation:** `c8ba9625d3a4af0b00c3793cb9bf251fb85e1287`

**P8 hardening commit:** `600e585224db93ae38c7a62c836e23c7953300ed`

**P8 cross-turn opt-out hardening:** pending

**Status:** COMPLETE / REVIEW PASS / FROZEN / CLAUDE REAL-PROVIDER PASS / CODEX BLOCKED

## Outcome

P8 adds provider-neutral conservative turn-time ingestion after a reliable
assistant event has been persisted. Accepted candidates require current user
evidence, confidence of at least 0.85, non-transient evidence, an allowed
create/update operation, and no existing Core target. Every implicit commit is
forced to Indexed.

CR-PHASE11 hardening evaluates per-turn opt-out from the full persisted user
event before constructing bounded extraction input. The bounded window reserves
the latest user evidence ahead of the assistant response, checkpoint convergence
does not replay receipt-materialized historical content, and conservative
implicit admission rejects narrow credential-shaped assignment keys.

The final targeted hardening resolves every extracted candidate's source event
identity back to the full persisted SessionEvent before evaluating opt-out.
Evidence from an opted-out user turn remains permanently ineligible for P8
implicit materialization, even when a later turn's bounded extraction window
includes it. This does not create a durable privacy watermark and does not
change checkpoint extraction.

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
| Explicit Opt-Out Violation Rate | 0.000000 |
| Long-Assistant User-Evidence Retention | PASS |
| Checkpoint Historical Replay Count | 0 |
| Secret-Like Auto-Persistence Rate | 0.000000 |
| Cross-Turn Opt-Out Violation Rate | 0.000000 |
| Hard correctness | PASS |

The fixture covers all fifteen required categories: opaque assignment, durable
decision, transient narration, assistant-only repetition, P7 recalled-content
repetition, opt-out, invalid config, replayed Stop, Stop plus SessionEnd,
existing Core collision, Space mismatch/cwd drift, long-assistant user-evidence
retention, multi-update checkpoint convergence, and secret-like assignment
rejection, plus cross-turn opt-out carry-over.

## Real-provider evidence

### Claude Code

The original P8 implementation was observed with:

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

The cross-turn opt-out hardening working tree was revalidated with Claude Code
`2.1.112` on 2026-08-19. The same Session A to Session B scenario passed:
source Stop, automatic Indexed persistence, target recall context, and final
answer `lavender-731` were all observed, with no explicit Memory tool call.

### Codex

Codex CLI `0.147.0` was authenticated during the original P8 validation, but the
real model run was blocked before turn execution by the account usage limit. It
remains recorded as **BLOCKED**, not PASS or product failure, until a real model
execution succeeds. No Codex P8 lifecycle evidence is synthesized.

## Invariants

- Assistant Stop remains distinct from checkpoint.
- Implicit remember creates no Checkpoint or Handoff and advances no checkpoint
  boundary.
- Existing Core Memory is not modified, demoted, superseded, or overwritten.
- Assistant-only and recalled-content-only repetition cannot create Memory.
- Full persisted source evidence carrying an explicit opt-out cannot be
  materialized by a later implicit-remember attempt.
- Receipt and Memory mutation share one SQLite transaction.
- A successful receipt represents content materialization. A later checkpoint
  collapses candidates to the final Memory identity, skips historical content
  replay, and still runs normal P6 admission, Handoff generation, and boundary
  advancement.
- MCP remains exactly six tools.

## Remaining work

P8 v1 uses deterministic extraction only. Broader semantic extraction,
embeddings, remote/LLM extractors, and a durable privacy watermark for
per-turn opt-out remain future work. The secret-like guard is intentionally
narrow and key-shaped; it is not a complete DLP or secret-management system.
Checkpoint may still process an opted-out SessionEvent under the existing P8 v1
contract; durable never-persist semantics remain future work.
