# P9 Grounded Semantic Memory Extraction Result

**Date:** 2026-08-22

**P9 semantic extraction spec:** `dee763a1df265b3a93809bb2ce4edf129fa52fe1`

**P9 backend amendment:** `cc8c86930cc4a729772534448f3d0ceabf24518d`

**Hardening review:** `docs/reviews/CR-PHASE13-P9-HARDENING.md`

**Status:** IMPLEMENTATION COMPLETE / REVIEW CHANGES REQUIRED / REAL QUALITY EVAL BLOCKED

## Result separation

P9 evidence is reported in three independent layers. A PASS in one layer does not imply a PASS in
another.

| Layer | Current result | What it proves |
|---|---|---|
| Pipeline / Admission Correctness | PASS | Oracle proposal parsing, exact grounding, policy, replay convergence, persistence, and recall |
| Real Semantic Model Quality | BLOCKED | No reviewed real backend is available in this environment; no precision/recall result is claimed |
| Backend Capability Smoke | Historical external and Claude PASS | A previously tested route/runtime could execute the production pipeline |

## Pipeline / admission correctness

Command:

```text
node --experimental-strip-types src/cli/main.ts eval semantic-extraction --json
```

Observed on 2026-08-22:

| Metric | Result |
|---|---:|
| Pipeline Persistence Precision | 1.000000 |
| Pipeline Durable Acceptance Rate | 1.000000 |
| Fixture Pipeline Durable Acceptance Rate | 1.000000 |
| Holdout Pipeline Durable Acceptance Rate | 1.000000 |
| Grounding Acceptance Correctness | 1.000000 |
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

These are deliberately not named Semantic Durable Precision/Recall. The deterministic fake backend
uses fixture labels to construct oracle proposals, so this layer measures the pipeline after proposal
construction, not natural-language extraction quality.

The replay fixture now alternates two exact grounded substrings for the same persisted event across
Stop replay and checkpoint. Both converge on one durable Memory identity without version inflation.
Two independent clauses in one event remain independently persistable.

## Real semantic model quality

Command:

```text
node --experimental-strip-types src/cli/main.ts eval semantic-quality --json
```

The real-model dataset contains 20 durable positives and 20 negative/should-not-persist cases, split
equally between fixture and holdout wording. It covers Chinese and English facts, decisions,
constraints, conventions, goals/tasks/progress/blockers/questions, multi-clause language,
speculation, temporary narration, requests, assistant-only claims, opt-out, and secret-like evidence.

Only raw user/assistant events plus the P9 extraction instruction/schema are sent to the model.
Expected durability and answer anchors remain in the scorer and are never included in model input.

Observed on 2026-08-22:

```text
REAL SEMANTIC QUALITY EVAL = BLOCKED
reason = no configured real quality backend; Claude Code CLI is not installed
```

Therefore no real Semantic Durable Precision or Semantic Durable Recall value is reported. The frozen
thresholds remain:

```text
Semantic Durable Precision >= 0.95
Semantic Durable Recall >= 0.75
```

Configure `MEMORY_SPACE_P9_QUALITY_BACKEND=host-agent` for a reviewed Claude runtime, or `external`
with `MEMORY_SPACE_P9_QUALITY_BASE_URL`, `MEMORY_SPACE_P9_QUALITY_MODEL`, and optionally
`MEMORY_SPACE_P9_QUALITY_API_KEY`.

## Backend capability status

| Backend | Status | Evidence |
|---|---|---|
| external / openai-compatible | Historical PASS | Third-party route smoke recorded by the prior review; not rerun in this hardening environment |
| local / Ollama | BLOCKED | Runtime/model not installed |
| host-agent / Claude Code | NOT INSTALLED here; historical 2.1.112 PASS | Runtime version/help is now probed before availability is reported |
| host-agent / Codex | UNSUPPORTED | No reviewed all-tools/MCP/hooks isolation contract |

Doctor and semantic setup distinguish `REVIEWED`, `UNVERIFIED`, `UNSUPPORTED`, and `NOT_INSTALLED`.
The production resolver refuses unverified or missing Claude runtimes. The probe reads only CLI
version/help and never performs a paid model call. Runtime extraction retains the isolated cwd,
tools/MCP/settings/persistence controls, timeout, bounded output, and recursion marker.

## Hardening behavior

- semantic candidates receive a deterministic evidence-clause replay identity only after exact full
  persisted-user grounding;
- the existing P8 receipt fingerprint remains unchanged for deterministic extractors;
- replay identity does not use an LLM-generated key and does not perform semantic similarity;
- input suffix truncation is direct O(1) slicing after linear inspection and preserves UTF-16
  surrogate boundaries;
- event sequence lookup is precomputed before sorting;
- missing authoritative `sourceEvents` fails the semantic branch closed before any model request;
- implicit remember remains fail-open while a configured checkpoint still fails visibly.

## Scope limitation

Replay convergence covers benign alternate exact substrings that resolve to the same deterministic
source clause, family, type, and source-event set. It does not claim general semantic equivalence.
Different clauses from one event remain distinct. Updates such as `a,b,c -> a,b,c,d`, embeddings,
semantic merge policy, and canonical stable keys remain deferred.
