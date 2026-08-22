# CR-PHASE13 — P9 Semantic Extraction Hardening

**Date:** 2026-08-22  
**Status:** CHANGES REQUIRED  
**Review baseline:** `d6ac119792dcd00ed87f742fafb653e79ecbb738`  
**P9 implementation:** `8f5f6001bbdc376cefb75d6428765ae239760f07`  
**External compatibility fix:** `8350d6db78e1bb1d5c02bfd22b1d005bc9cb9a1a`  
**P9 specs:** `dee763a1df265b3a93809bb2ce4edf129fa52fe1`, `cc8c86930cc4a729772534448f3d0ceabf24518d`  
**Previous self-review:** `docs/reviews/CR-PHASE12-P9.md`

> This review does not reject the P9 architecture. The provider-neutral semantic model port, exact persisted-user grounding, P8 admission reuse, Indexed-only implicit writes, explicit backend selection, local loopback boundary, and Claude host isolation are directionally correct. The remaining blockers are reliability/evaluation issues that can cause duplicate durable Memory or overstate semantic quality.

---

# 1. Required disposition before fixes

Until every P1 in this document is closed, P9 MUST NOT be described as:

```text
REVIEW PASS
FROZEN
```

Use an accurate status such as:

```text
IMPLEMENTATION COMPLETE / REVIEW CHANGES REQUIRED
```

Backend capability evidence is independent and MAY remain:

```text
Claude host-agent: PASS
External: PASS
Ollama: BLOCKED
Codex host-agent: UNSUPPORTED
```

A backend smoke PASS proves that a route can execute the production pipeline. It does not by itself prove P9-wide idempotency or semantic extraction quality.

---

# 2. Review summary

Open findings:

| ID | Severity | Area | Required |
|---|---|---|---|
| CR13-01 | P1 | Same-evidence idempotency under model nondeterminism | MUST FIX |
| CR13-02 | P1 | Semantic quality evaluation validity | MUST FIX |
| CR13-03 | P1 | Large-input computational bound | MUST FIX |
| CR13-04 | P2 | Full-source grounding authority contract | SHOULD FIX IN THIS CR |
| CR13-05 | P2 | Host-agent reviewed-capability truth | SHOULD FIX IN THIS CR |

No P0 architecture violation was found in the reviewed baseline.

---

# 3. CR13-01 — P1 — Same evidence can create duplicate semantic Memory

## 3.1 Problem

P9 v1 semantic candidates are intentionally unkeyed and `create`-only. This is correct for avoiding arbitrary model-generated stable keys, but it exposes P8 receipt identity to model-output nondeterminism.

Current grounding permits multiple exact-substring representations of the same user evidence.

Example persisted user event `E1`:

```text
现在 variant 一共有 a、b、c 三种。
```

Semantic call A may validly propose:

```text
content = "variant 一共有 a、b、c 三种"
sourceEventIds = [E1]
```

A later semantic call over the same evidence may validly propose:

```text
content = "现在 variant 一共有 a、b、c 三种"
sourceEventIds = [E1]
```

Both proposals satisfy the current exact-substring grounding rule.

However the existing P8 receipt fingerprint includes candidate content. Therefore:

```text
fingerprint(A) != fingerprint(B)
```

and the second proposal may create another durable unkeyed Memory rather than reusing/deduplicating the first.

This can happen in at least two paths:

```text
Stop #1 -> later Stop #2 over the same uncheckpointed user evidence

Stop -> SessionEnd / explicit checkpoint re-extraction
```

This is NOT the deferred P9.x semantic-identity problem of deciding whether a later factual update such as `a,b,c -> a,b,c,d` should update the same logical Memory. CR13-01 is narrower: **replaying the same source evidence must not duplicate durable Memory merely because the LLM selected a different exact substring.**

## 3.2 Invariant

Freeze the following P9 correctness invariant:

> Reprocessing the same persisted semantic source evidence must be idempotent against benign model-output variation that still grounds the same fact. Model-selected wording must not be the only durable replay identity.

Required metric:

```text
Same-Evidence Duplicate Rate = 0.0
```

The metric must now include nondeterministic/alternate-proposal replay, not only byte-identical fake-model output.

## 3.3 Required regression fixtures

Add deterministic tests where the fake semantic model intentionally changes its grounded proposal between calls.

Minimum case A — later Stop:

```text
Persisted E1:
现在 variant 一共有 a、b、c 三种。

Semantic call #1:
content = "variant 一共有 a、b、c 三种"
quote   = "现在 variant 一共有 a、b、c 三种。"

Semantic call #2 over the same E1:
content = "现在 variant 一共有 a、b、c 三种"
quote   = "现在 variant 一共有 a、b、c 三种。"
```

Expected:

```text
active semantic Memory rows for this fact = 1
no second durable Memory identity
no version inflation caused only by replay
Same-Evidence Duplicate Rate = 0
```

Minimum case B — checkpoint replay:

```text
Stop semantic call:
content A

SessionEnd/checkpoint semantic call:
content B

Both A and B are exact grounded substrings of the same persisted E1.
```

Expected:

```text
checkpoint completes
existing materialized semantic Memory is reused/deduplicated
no duplicate semantic row
checkpoint boundary semantics remain unchanged
```

Add at least one control case proving that two genuinely distinct facts from the same user event are not accidentally collapsed simply because they share one `sourceEventId`.

Example:

```text
项目数据库使用 PostgreSQL，缓存使用 Redis。
```

If the model proposes two independently grounded facts, the dedupe hardening must not force them into one Memory merely because both came from the same event.

## 3.4 Implementation constraints

Implementation strategy is owned by the coding agent, but all of the following are mandatory:

- DO NOT solve this by allowing arbitrary LLM-generated Memory keys.
- DO NOT introduce embedding/vector similarity in this CR.
- DO NOT silently drop every second semantic fact from the same user event.
- DO NOT weaken exact persisted-user grounding.
- DO NOT create an implicit checkpoint watermark that changes P8 checkpoint semantics without separate review.
- DO NOT remove receipt/idempotency semantics for deterministic extractors.
- Preserve P8 keyed-memory behavior and checkpoint convergence.

A P9-specific replay identity/evidence-convergence mechanism is acceptable if it is deterministic, scoped to semantic candidates, preserves multiple distinct facts from one event, and has regression evidence.

If the implementation cannot provide a general guarantee beyond a documented class of benign alternate-substring proposals, narrow the claim and metric accordingly. Do not claim universal semantic identity.

---

# 4. CR13-02 — P1 — Current precision/recall evaluation is oracle-fed

## 4.1 Problem

The current deterministic P9 eval is valuable for pipeline/admission correctness, but it is not a valid measurement of semantic-model extraction precision/recall.

The fake backend reads fixture labels such as:

```text
scenario.content
scenario.type
scenario.assertion
scenario.durability
```

and constructs the expected proposal from those labels.

Therefore the current reported values:

```text
Semantic Durable Precision = 1.0
Semantic Durable Recall = 1.0
Fixture Durable Recall = 1.0
Holdout Durable Recall = 1.0
```

primarily prove:

```text
oracle proposal
-> parser
-> grounding
-> P8 admission
-> durable Memory
```

They do NOT prove:

```text
raw natural language
-> real semantic model
-> correct proposal
```

The current "holdout" set is also not a semantic-model holdout if the fake model consumes the expected labels.

## 4.2 Required evaluation split

Split P9 evaluation conceptually into two independent layers.

### Layer A — deterministic pipeline/admission eval

Keep the current oracle/fake model style, but name the metrics according to what they actually prove.

Examples:

```text
Grounding Acceptance Correctness
Unsupported Claim Persistence Rate
Assistant-Only Persistence Rate
Transient Persistence Rate
Speculative Persistence Rate
Sensitive Persistence Rate
Opt-Out Violation Rate
Cross-Turn Opt-Out Violation Rate
Implicit Core Write Rate
Same-Evidence Duplicate Rate
Checkpoint Historical Replay Count
Deterministic Fallback Success Rate
Lifecycle Blocking Failure Rate
Cross-Session Recall Closure
```

This layer SHOULD remain deterministic and CI-friendly.

### Layer B — real semantic-model quality eval

Add an eval mode that gives the model ONLY the raw event conversation and P9 extraction instruction/schema.

The semantic model MUST NOT receive fixture answer fields such as:

```text
expected content
expected type
expected assertion
expected durability
expected persistence
```

Labels are used only after model output for scoring.

At least one already-real-PASS backend should be usable for this eval, for example:

```text
host-agent / Claude Code
or
external / OpenAI-compatible
```

Recommended dataset floor for the first reviewed gate:

```text
>= 20 durable positive cases
>= 20 negative / should-not-persist cases
```

Cover at minimum:

```text
fact
decision
constraint
convention
goal/task/progress/blocker/question where appropriate
Chinese and English
natural paraphrase variation
multi-clause user messages
speculation
temporary experiment
interaction-local narration
assistant-only claim + generic user acknowledgement
secret-like evidence
requests that do not encode project state
```

Keep a genuine holdout split whose raw wording is not used to build model proposals.

## 4.3 Quality metrics

The P9 spec thresholds:

```text
Semantic Durable Precision >= 0.95
Semantic Durable Recall >= 0.75
```

must apply to Layer B real-model extraction quality, not to oracle-fed Layer A.

If a real-model quality run cannot execute because of credentials/quota/runtime availability, report:

```text
REAL SEMANTIC QUALITY EVAL = BLOCKED
```

Do NOT replace that result with fake-model `1.0` metrics.

The deterministic pipeline eval may still PASS independently.

## 4.4 Result document correction

Update `docs/reports/quality/P9_SEMANTIC_EXTRACTION_RESULT.md` so it clearly separates:

```text
Pipeline / Admission Correctness
Real Semantic Model Quality
Backend Capability Smoke
```

Do not use one table in a way that implies oracle-fed metrics measure LLM quality.

If real quality thresholds have not been demonstrated, remove or relabel the current `Semantic Durable Precision/Recall = 1.0` claims.

---

# 5. CR13-03 — P1 — 12k output bound does not guarantee bounded preprocessing work

## 5.1 Problem

`buildSemanticModelEvents()` ultimately bounds semantic model input to approximately 12,000 UTF-16 characters, but the current suffix truncation implementation performs repeated array joins and shifts:

```ts
const points = [...value];
while (points.join("").length > maximum) points.shift();
return points.join("");
```

For a very large persisted message, this can approach quadratic work before the model request is even issued.

This matters particularly at checkpoint because checkpoint extraction may receive a much larger persisted event range than the normal P8 turn-time 24k view.

A bounded model payload is not sufficient if constructing that payload has unbounded/quadratic preprocessing cost.

## 5.2 Invariant

Freeze:

> Semantic model input construction must be computationally linear in inspected input size and must not repeatedly rebuild the remaining string while truncating.

The truncation path MUST be safe for UTF-16 surrogate boundaries.

## 5.3 Required fix

Replace repeated `join()/shift()` truncation with a direct bounded suffix operation or equivalent O(n) strategy.

A valid direction is:

```ts
function suffixWithoutBrokenSurrogate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let start = value.length - maximum;
  const unit = value.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start += 1;
  return value.slice(start);
}
```

Exact implementation is owned by the agent. Preserve the existing UTF-16 character-limit semantics unless the spec is deliberately amended.

Also inspect the rest of `buildSemanticModelEvents()` for avoidable repeated scans such as sequence lookup inside sort callbacks. Precompute lookup maps where appropriate so the entire bounded-view construction remains straightforwardly linear / `O(n log n)` at worst rather than accidentally quadratic in event count.

## 5.4 Required tests

Add tests for:

```text
very large single message
surrogate pair exactly at truncation boundary
ASCII input
Chinese input
latest-user priority preserved
final model input chars <= configured maximum
persisted event content remains unchanged
```

Add a practical stress regression with a large synthetic persisted event. The test should verify completion and exact bound/invariants; it need not assert fragile wall-clock milliseconds in CI.

---

# 6. CR13-04 — P2 — `sourceEvents` must be authoritative, not optional fallback

## 6.1 Problem

`ExtractionContext.sourceEvents` explicitly documents that full persisted events are required for grounding/control decisions, yet `SemanticMemoryExtractor` currently falls back to the possibly derived/bounded `events` argument when `sourceEvents` is absent.

That creates an unsafe future extension point:

```text
new caller passes derived events
forgets sourceEvents
-> derived data silently becomes grounding authority
```

Current main daemon P8/checkpoint paths appear to pass full persisted source events, so this is not a known production exploit in the reviewed baseline. It is nevertheless inconsistent with the port invariant.

## 6.2 Required hardening

When semantic extraction is enabled, absence of authoritative full `sourceEvents` should fail closed for the semantic branch.

Recommended semantics:

```text
implicit_remember:
  semantic branch unavailable/failed -> fail open lifecycle -> deterministic extractors still work

checkpoint:
  configured semantic extraction lacks authoritative source -> checkpoint-significant failure according to existing P9 semantics
```

Do not silently treat a bounded semantic input view as full evidence.

Add a regression proving that a caller cannot ground a candidate from a truncated/derived event view when authoritative source events are absent.

---

# 7. CR13-05 — P2 — Host-agent capability truth should include runtime verification

## 7.1 Problem

The repository has real evidence for Claude Code `2.1.112`, but the reviewed host factory currently treats any resolved Claude CLI as an available reviewed host backend before checking the installed runtime/version/capability surface.

A future or older CLI may change/remove flags such as:

```text
--json-schema
--tools ""
--strict-mcp-config
--setting-sources ""
--no-session-persistence
```

Actual extraction will generally fail safely if flags are unsupported, but setup/doctor/resolver truth should not overstate a runtime as reviewed merely because `provider = claude-code`.

## 7.2 Required hardening

At minimum, doctor/setup should distinguish:

```text
REVIEWED/PASS
UNVERIFIED
UNSUPPORTED
NOT INSTALLED
```

A lightweight capability probe may inspect CLI version/help/required flags and cache the result. Do not invoke a paid model call merely to render ordinary status unless the user explicitly requests a real smoke.

If the implementation chooses an explicit reviewed version/range, document why. Do not pretend untested versions have completed the same real isolation gate.

Runtime extraction must remain fail-safe even after a setup/doctor capability PASS.

Codex remains `UNSUPPORTED` until a separately reviewed isolation contract exists.

---

# 8. Non-goals / scope guard

CR-PHASE13 MUST NOT expand into:

```text
semantic canonical stable keys
semantic update/merge policy for changed facts
embedding/vector search
semantic recall/reranking
second LLM verifier
cross-Space semantic merge
background semantic extraction
new MCP tools
LLM-controlled Core promotion
LLM direct memory writes
full DLP
```

In particular, do not use CR13-01 as a reason to implement the deferred full P9.x Semantic Identity phase. Fix replay idempotency for the same persisted evidence without claiming to solve all semantic equivalence/update problems.

---

# 9. Required implementation order

Recommended order:

```text
1. Reproduce CR13-01 with failing tests
2. Fix same-evidence semantic replay idempotency
3. Add alternate-proposal Stop and checkpoint regressions
4. Refactor eval into deterministic pipeline vs real semantic quality layers
5. Fix bounded-input preprocessing
6. Harden missing sourceEvents behavior
7. Harden host-agent capability reporting
8. Run full regression suite
9. Run real semantic quality eval on at least one available PASS backend
10. Update P9 result/review documents
11. Perform a fresh self-review of the final diff
```

Do not modify frozen P7/P8/P9 product semantics merely to make tests pass.

---

# 10. Required validation

Run all repository-standard gates, including the applicable equivalents of:

```text
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run inspector:build
pnpm run check
pnpm run check:workspace
git diff --check
```

Also run:

```text
P7 eval
P8 eval
P9 deterministic pipeline/admission eval
P9 alternate-proposal idempotency regression
P9 real semantic model quality eval
P9 real backend smoke where credentials/runtime are available
```

Do not substitute fake-model PASS for a blocked real-model quality run.

Record exact command/result evidence in the updated quality report.

---

# 11. Mandatory post-fix self-review

After tests pass, stop implementing and review the entire CR13 diff as if you were a separate senior reviewer.

At minimum re-check:

### Idempotency

- Can one persisted event create duplicate semantic Memory when the model expands/shrinks an exact substring?
- Does Stop -> later Stop remain one durable identity?
- Does Stop -> checkpoint remain convergent?
- Are two distinct facts in one user event still independently persistable?

### Evaluation validity

- Does the real-model eval receive only raw conversation + extraction contract?
- Is any expected label accidentally passed into the model request?
- Are deterministic pipeline metrics clearly separated from model-quality metrics?
- Are holdout examples truly holdout with respect to proposal construction?

### Bounded work

- Is there any repeated `join`, `shift`, whole-string rebuild, or repeated full event search inside a truncation loop?
- Is surrogate handling correct?
- Does checkpoint input construction remain bounded in practical work?

### Grounding authority

- Can `events` fallback ever become authority when full persisted `sourceEvents` are missing?
- Are opt-out and privacy decisions still based on full persisted source events?

### Host isolation/capability

- Is an unverified Claude CLI reported accurately?
- Does actual semantic child execution still use empty cwd, tools off, MCP off, settings off, persistence off, bounded output, timeout, and recursion marker?
- Is Codex still unsupported rather than silently downgraded into an unsafe adapter?

If any P0/P1 remains, fix it and repeat the relevant review/tests.

---

# 12. Documentation disposition

After fixes, update this document with:

```text
Fix commits
Tests added
Real quality eval backend/version
Measured real semantic precision/recall
Remaining limitations
Final disposition
```

Update `docs/reports/quality/P9_SEMANTIC_EXTRACTION_RESULT.md` to remove stale claims and record the new evidence.

Do not rewrite historical evidence in `CR-PHASE12-P9.md`; CR-PHASE13 supersedes its final review disposition for the reviewed baseline.

P9 may return to:

```text
REVIEW PASS
```

only when all CR13 P1 findings are closed with regression evidence.

P9 may be marked:

```text
FROZEN
```

only if the repository's existing freeze criteria are also satisfied; closing this CR alone does not automatically imply freeze.

---

# 13. Coding-agent handoff

Use this CR as the source of truth for the hardening task.

Start by reproducing the three P1 findings before editing production behavior. Then implement the smallest architecture-consistent fixes, run the full validation matrix, run at least one real semantic quality evaluation if a reviewed backend is available, and perform a fresh independent self-review before updating the result status.

Do not ask for clarification for ordinary implementation choices that are already constrained by this CR and the frozen P9/P8 specs. If a necessary fix would change a product invariant or require implementing deferred Semantic Identity, stop and surface that as a design blocker instead of silently expanding scope.
