# P7 Implicit Prompt-Time Recall Result

**Date:** 2026-08-18

**Spec commit:** `4a32ebb387a4d56627bb61554fcfb8332ffa4071`

**Implementation commit:** `5bedf63a7bcc5e3731c8b5ef2cba618b21be8219`

**Hardening commit:** `e75afca415e9f6b6f47f4e3d0ec7ebe18cffa490`

**Final eval/review commit:** `bd73caf41d23cd88acc5c22b514ab3c01a532000`

**Status:** COMPLETE / REVIEW PASS / FROZEN

## Outcome

P7 adds provider-neutral, deterministic prompt-time recall for active Indexed
Memory. `UserPromptSubmit` is persisted first, then a trusted project binding
selects `off`, `exact`, or `lexical` disclosure. Core Memory remains bootstrap
only, and the shared MCP surface remains exactly six tools.

New bindings explicitly default to:

```json
{
  "implicitRecall": { "mode": "exact" }
}
```

Existing bindings without this field remain valid and also resolve to `exact`.
Malformed policy, missing/mismatched project binding, or recall failure disables
recall for that prompt and does not block the provider.

## Deterministic evaluation

`pnpm memory-space eval implicit-recall` passed with:

| Metric | Result |
|---|---:|
| Bare-identifier hit rate | 1.000000 |
| Exact-key hit rate | 1.000000 |
| Implicit Recall Precision@1 | 1.000000 |
| Negative abstention rate | 1.000000 |
| Core re-injection rate | 0.000000 |
| Metadata leakage rate | 0.000000 |
| Opt-out compliance rate | 1.000000 |
| Budget compliance rate | 1.000000 |
| Codex/Claude 4×4 matrix | 4 / 4 |
| Hard correctness | PASS |

Two complete JSON runs were byte-equivalent. The fixture contract rejects
mutations to scenario set, prompt, classification, source/target provider,
expected keys/order, and abstention expectation.

The evaluator injects a recording `LifecycleHandler` seam into the real Codex
and Claude lifecycle integrations. Reported `effectiveMode` and `bypassed`
values are read from the resulting `LifecycleResult.user_prompt.recall`; they
are not reconstructed from fixture classification or rendered context. A
scenario passes only when those observed decisions match the frozen expected
decision. Regression tests prove that either an effective-mode mismatch or a
bypass mismatch fails acceptance.

## Provider evidence

- P7.0A native `UserPromptSubmit.additionalContext`: PASS for Codex 0.147.0 and Claude Code 2.1.112.
- P7.0B production bridge: PASS for both providers.
- Bare-key final answers: Codex `lavender-731`; Claude Code `CROSS_AGENT_TEST_20260817 = lavender-731`.
- Explicit Memory MCP calls in P7.0B: none.
- Natural lexical final answers: both providers returned `a`, `b`, `c`.
- Stale conflict: both observed React `19.0.0`, reported the conflict with recalled React 18, and treated the current file as authoritative.
- Opt-out: both avoided recalled values and made no Memory MCP call.
- Complete real-agent matrix: 8 / 8 stages passed.

See [`P7_PROVIDER_CAPABILITY_SPIKE.md`](./P7_PROVIDER_CAPABILITY_SPIKE.md).

## Security and product boundaries

- Recall searches only the Session's Space and only active Indexed Memory.
- The nearest project binding must still match the Session's frozen Space.
- Exact candidates are distinctive and bounded before lookup.
- Lexical mode reuses the frozen P6 production order; fixture keys never rank results.
- Rendered disclosure contains escaped Memory content only, not id, key, type,
  score, source Session, or provenance metadata.
- Recalled content is explicitly marked untrusted project data; current repository,
  runtime, and explicit user evidence take precedence.
- Output is capped at 2,400 UTF-16 code units without splitting Unicode code points
  or escaped entities.
- Prompt opt-out prevents implicit retrieval and emits only a small trusted control.
- No retrieval/extraction/domain/storage/MCP policy was changed.

## Code-review hardening

The initial review requested four closeout changes. Hardening commit `e75afca`
now:

- extracts a complete allowed-character run before enforcing the 3–128 exact-key
  boundary, preventing overlong-prefix and invalid-leading-character disclosure;
- wires recall-only diagnostics into the production daemon with a sanitized
  default log and an injectable diagnostic callback;
- runs the deterministic provider matrix through the real Codex/Claude lifecycle
  integrations instead of manually invoking provider renderers;
- runs bounded exact candidate lookups and the lexical full-prompt lookup
  concurrently while preserving exact-first deterministic merge order.

Regression tests cover both exact token boundary attacks, diagnostic fail-open
behavior and non-disclosure of prompt/path data, integration-level provider
output, and concurrent Memory query execution.

Final eval/review commit `bd73caf` closes the remaining evidence-validity issue:
the provider matrix now records the actual lifecycle recall decision and rejects
decision mismatches before metric aggregation.

## Closeout

All required local deterministic, workspace, regression, native-provider, and
real-bridge gates passed. P7 is therefore complete, review pass, and frozen.
GitHub CI was not independently confirmed; the evidence below is from the local
macOS environment.

## Post-freeze correctness patch — P7.1 Exact-Key Lookup

**Patch commit:** `ebdd20585abd67ceeb25bd693512952441c99fe1`

The original exact path searched lexically with `limit: 20` and then checked
normalized key equality inside that truncated result. Twenty-one higher-scoring
content distractors could therefore hide a Memory whose key matched exactly.

P7.1 adds an application-level normalized exact-key lookup. It uses the existing
raw active-key lookup as a fast path, then performs a correctness fallback over
the requested Space's active Indexed Memories with symmetric
`normalizeLexicalText` equality. `ImplicitRecallService` no longer uses lexical
ranking, ordering, or a result limit for exact candidates. Concurrent candidate
lookups still merge in prompt occurrence order; lexical mode still runs the
unchanged frozen P6 full-prompt search and merges exact results first.

Regression coverage proves that 21 higher-ranked distractors cannot hide the
exact key, case normalization remains symmetric, and Core, archived, resolved,
and other-Space Memories remain ineligible. The patch also verifies exact mode
does not run the lexical full-prompt search. P6 scoring, ordering, abstention,
storage schema, provider contracts, and the six-tool MCP surface are unchanged.

P7.1 verification:

```text
pnpm run check                                      PASS (196/196)
pnpm run check:workspace                            PASS (root + Inspector)
pnpm memory-space eval implicit-recall              PASS
pnpm memory-space eval implicit-recall --json       PASS
pnpm memory-space eval quality --json               PASS (P6 metrics unchanged)
pnpm run smoke:p7                                   NOT RUN (provider path unchanged)
```

## Verification

```text
pnpm run check                                      PASS (193/193)
pnpm run check:workspace                            PASS (root + Inspector)
pnpm memory-space eval implicit-recall              PASS
pnpm memory-space eval implicit-recall --json × 2   PASS (parsed JSON byte-equivalent)
pnpm memory-space eval quality --json               PASS (P6 metrics unchanged)
pnpm run smoke:p7:capability                        PASS (Codex + Claude Code)
pnpm run smoke:p7                                   PASS (8/8 real-agent stages)
```

The P6 regression remained at P@1/R@1 `0.727273/0.681818`, P@3/R@3
`0.303030/0.818182`, P@5/R@5 `0.180000/0.800000`, and P@10/R@10
`0.090000/0.800000`, with zero negative false positives, one abstention, and
hard correctness PASS.
