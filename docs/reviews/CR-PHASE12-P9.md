# CR-PHASE12 — P9 Grounded Semantic Extraction Self-Review

**Date:** 2026-08-21

**Baseline:** `cc8c86930cc4a729772534448f3d0ceabf24518d`

**Reviewed implementation:** `8f5f6001bbdc376cefb75d6428765ae239760f07`

**External compatibility follow-up:** `8350d6db78e1bb1d5c02bfd22b1d005bc9cb9a1a`

**Status:** REVIEW PASS / EXTERNAL AND CLAUDE HOST PASS / LOCAL BLOCKED / CODEX UNSUPPORTED

## Scope

The review covered the complete P9 diff against the backend-amendment baseline:

- semantic model and resolver ports;
- strict proposal parsing and full-source grounding;
- P8/P9 composition and checkpoint behavior;
- external, local, and host-agent adapters;
- configuration, setup, doctor, and status;
- deterministic evaluation and real smoke;
- P7/P8 regressions and the exact-six MCP contract.

## Invariants checked

- Model proposes; Memory Space proves; policy decides.
- No model writes Memory, SQLite, Core, Checkpoint, or Handoff directly.
- Semantic proposals remain unkeyed, create-only, and Indexed-recommended.
- Full persisted user SessionEvents are authoritative evidence.
- Assistant-only, unsupported, speculative, transient, sensitive, and opted-out
  evidence cannot create implicit Memory.
- Stop remains fail-open and distinct from checkpoint.
- Configured checkpoint semantic failure does not advance the boundary.
- Existing projects without semantic configuration remain off.
- Backend selection has no implicit fallback or retry.
- Raw API keys are not stored in project configuration.
- Local endpoints are loopback-only.
- MCP remains exactly six tools.

## Findings and fixes

### P1 — Host child timeout could wait indefinitely after SIGTERM

The process runner originally sent `SIGTERM` at timeout but resolved only after
the child emitted `close`. A non-cooperative CLI could therefore block the
lifecycle beyond the configured bound.

Fix: timeout now resolves immediately as a sanitized timeout result and schedules
a finite `SIGKILL` fallback. Regression coverage verifies timeout propagation.

### P1 — Grounding normalized evidence before substring validation

CRLF-to-LF conversion and trimming could accept a quote that was not a literal
substring of the persisted user event.

Fix: quote and candidate content grounding now use raw exact substring checks
against the full persisted SessionEvent. CRLF and surrounding-whitespace
counterexamples are rejected.

### P1 — External base URL could persist credentials outside `apiKeyEnv`

URL userinfo or query parameters could carry a token into project config even
though the model schema rejects raw `apiKey`.

Fix: semantic endpoint parsing rejects URL credentials, query parameters, and
fragments. Setup and parser regressions cover credential-bearing URLs.

### P1 — Interactive setup could select unsupported Codex host mode

The non-interactive CLI rejected explicit Codex host setup, but the shared
configuration function did not. An interactive choice could bypass the
capability truth.

Fix: the shared atomic setup entry rejects Codex host mode. The resolver also
returns `capability_unsupported`; no Codex adapter is composed.

### P2 — Unrelated provider test formatting churn

Formatting two legacy provider tests created a large non-functional diff.

Fix: both files were restored to baseline formatting and retain only the minimal
semantic-child recursion assertions.

## Final disposition

No open P0 or P1 implementation findings remain after the fixes and focused
retest. The provider-neutral semantic foundation and Claude host-agent backend
are review-passing.

The external reference backend subsequently passed a real production pipeline
smoke through a third-party OpenAI-compatible route after removing the optional
`temperature` request field that the route did not handle. JSON mode, strict
schema validation, grounding, and deterministic admission remain unchanged.

P9 is not marked FROZEN because no Ollama runtime/model is installed and Codex
host-agent isolation remains unsupported. Those gates are reported independently
rather than reclassified as implementation PASS.
