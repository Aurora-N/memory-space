# P9 Grounded Semantic Memory Extraction Result

**Date:** 2026-08-21

**P9 semantic extraction spec:** `dee763a1df265b3a93809bb2ce4edf129fa52fe1`

**P9 backend amendment:** `cc8c86930cc4a729772534448f3d0ceabf24518d`

**Implementation commit:** `8f5f6001bbdc376cefb75d6428765ae239760f07`

**Self-review:** `docs/reviews/CR-PHASE12-P9.md`

**Status:** IMPLEMENTATION COMPLETE / REVIEW PASS / CLAUDE HOST PASS / EXTERNAL BLOCKED / LOCAL BLOCKED / CODEX UNSUPPORTED

## Implemented architecture

P9 adds a provider-neutral `SemanticExtractionModel` capability behind
`MemoryExtractor`:

```text
persisted SessionEvents
  -> one bounded semantic model request
  -> strict versioned proposal parsing
  -> full persisted user-event quote grounding
  -> deterministic durability/safety validation
  -> existing P8 admission
  -> receipt-aware Indexed commit
  -> later P7 lexical recall
```

The model cannot select Memory identity, key, operation, tier, promotion,
checkpoint, or Handoff. Accepted P9 v1 candidates are unkeyed, create-only, and
Indexed-recommended. P8 still forces every implicit commit to Indexed.

Existing projects without `semanticExtraction` remain off. Enabling P8
conservative implicit remember does not enable P9 or cause a model request.

## Backend status

| Backend | Status | Evidence |
|---|---|---|
| external / openai-compatible | BLOCKED | Production adapter and tests pass; available OpenAI credential returned HTTP 401 |
| local / Ollama | BLOCKED | Production loopback adapter and tests pass; Ollama runtime/model not installed |
| host-agent / Claude Code | PASS | Claude Code 2.1.112 real isolated production smoke passed |
| host-agent / Codex | UNSUPPORTED | Codex 0.147.0 cannot prove all-tools/MCP/hooks isolation |

The Claude backend requires no additional model API key but may consume the
user's existing Claude Code account quota. No automatic fallback occurs among
backend classes or providers.

## Mandatory scenario

Session A used ordinary natural language:

```text
上传组件是通过 variant 来判断是否使用新版样式的，
现在 variant 一共有 a、b、c 三种。
```

The real Claude host semantic child proposed exact user substrings. The normal
P9/P8 path grounded and admitted two Indexed facts without any
`memory_remember`, `memory_search`, or `memory_context` call.

Session B asked:

```text
上传模块的 variant 有什么类型？
```

P7 lexical recall injected Indexed Memory containing `a、b、c`. No semantic
child Session was persisted; only the two expected coding Sessions existed.

## Deterministic evaluation

`pnpm memory-space eval semantic-extraction` covers durable Chinese and English
facts, decisions, constraints, conventions, durable state, holdout phrasing,
transient narration, test results, speculation, hypotheses, temporary
experiments, assistant-only claims, generic acknowledgements, credentials,
invalid quotes, unknown event IDs, current-turn opt-out, cross-turn opt-out,
deterministic fallback, replay, checkpoint convergence, and P7 cross-session
recall.

Targets:

| Metric | Required |
|---|---:|
| Semantic Durable Precision | >= 0.95 |
| Semantic Durable Recall | >= 0.75 |
| Unsupported Claim Persistence Rate | 0.0 |
| Assistant-Only Persistence Rate | 0.0 |
| Transient Persistence Rate | 0.0 |
| Speculative Persistence Rate | 0.0 |
| Sensitive Persistence Rate | 0.0 |
| Opt-Out Violation Rate | 0.0 |
| Cross-Turn Opt-Out Violation Rate | 0.0 |
| Implicit Core Write Rate | 0.0 |
| Same-Evidence Duplicate Rate | 0.0 |
| Checkpoint Historical Replay Count | 0 |
| Deterministic Fallback Success Rate | 1.0 |
| Lifecycle Blocking Failure Rate | 0.0 |
| Cross-Session Recall Success Rate | 1.0 |

Measured deterministic results:

| Metric | Result |
|---|---:|
| Semantic Durable Precision | 1.000000 |
| Semantic Durable Recall | 1.000000 |
| Fixture Durable Recall | 1.000000 |
| Holdout Durable Recall | 1.000000 |
| Unsupported Claim Persistence Rate | 0.000000 |
| Assistant-Only Persistence Rate | 0.000000 |
| Transient Persistence Rate | 0.000000 |
| Speculative Persistence Rate | 0.000000 |
| Sensitive Persistence Rate | 0.000000 |
| Opt-Out Violation Rate | 0.000000 |
| Cross-Turn Opt-Out Violation Rate | 0.000000 |
| Implicit Core Write Rate | 0.000000 |
| Same-Evidence Duplicate Rate | 0.000000 |
| Checkpoint Historical Replay Count | 0 |
| Deterministic Fallback Success Rate | 1.000000 |
| Lifecycle Blocking Failure Rate | 0.000000 |
| Cross-Session Recall Success Rate | 1.000000 |
| Hard correctness | PASS |

## Safety and lifecycle

- model input is bounded to 12,000 UTF-16 characters;
- output is limited to eight proposals, three quotes per proposal, 500 quote
  characters, and 1,000 content characters;
- grounding uses raw exact substrings of full persisted user events;
- fake event IDs, assistant evidence, paraphrased content, and unsupported
  quotes fail closed;
- current and historical opted-out evidence remains ineligible for implicit
  remember through existing P8 full-source admission;
- secret-shaped values are rejected without including them in diagnostics;
- external requests have one attempt, bounded timeout, and 1 MiB response cap;
- local configuration is loopback-only and never pulls a model automatically;
- Claude host execution uses an empty cwd, strict empty MCP configuration,
  disabled tools/settings/slash commands, no session persistence, bounded
  process output, and a recursion marker;
- semantic failure at Stop is fail-open and deterministic extraction remains
  available;
- configured checkpoint semantic failure remains checkpoint-significant and
  does not advance the boundary.

## Setup

`memory-space semantic setup [project]` supports interactive selection and
deterministic non-interactive modes for host-agent, local, external, and off.
It atomically updates only `semanticExtraction`, preserves Space/P7/P8 and
unrelated configuration, rejects symlink/non-file targets, supports dry-run,
and stores only an environment variable name for external credentials.

## Known limitations and deferred work

- P9 v1 has no semantic canonical identity or semantic merge/update policy.
- Unkeyed semantic facts may remain separate when wording changes.
- No embedding, vector database, semantic retrieval, reranking, or verifier.
- No automatic historical reprocessing or background extraction.
- No durable never-persist watermark; checkpoint privacy semantics remain the
  existing P8 v1 contract.
- Sensitive-evidence detection is intentionally narrow and is not full DLP.
- External and local real-runtime gates remain blocked by environment
  availability, not reported as PASS.
