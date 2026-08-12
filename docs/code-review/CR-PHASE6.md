# CR-PHASE6 — Claude Code P3 Integration Review

**Target branch:** `agent/provider-integration-v1`  
**Base commit:** `f30acc74029d6cc85a6c99e1dca23f47ddc10132`  
**Implementation digest:** `ebef6c21b95d9b59ec0483f1c7357851e185433cc0bf4e26cbb69272137f60ad`  
**Status:** Code and automated validation accepted; real hook lifecycle accepted; real model-driven MCP execution blocked externally. P3 is **ACCEPTED WITH A SCOPED PROGRESSION WAIVER**, not fully Frozen. P4 may proceed under the constraints below.  
**Normative guardrails:** [`../PROVIDER_INTEGRATION_GUARDRAILS.md`](../PROVIDER_INTEGRATION_GUARDRAILS.md)  
**P4 execution spec:** [`../P4_CROSS_SESSION_PROVIDER_EVAL.md`](../P4_CROSS_SESSION_PROVIDER_EVAL.md)

## 1. Review conclusion

The P3 code satisfies the Provider Integration contract without changing the
frozen Memory domain or MCP command plane.

Accepted implementation:

- `ClaudeAdapter` normalizes Claude Code native payloads into the existing five common lifecycle events;
- `SessionStart` injects an opaque internal Session handle plus deterministic Core/latest-Handoff context through native `additionalContext`;
- the daemon exposes `/providers/claude-code/lifecycle` and shares the same `MemorySpace`, `LifecycleHandler`, checkpoint coordinator, and SQLite owner with REST, Codex, and MCP;
- Claude connects to the existing HTTP MCP endpoint with exactly the same six tools; no Claude-specific tools or raw CRUD escape hatch were added;
- user prompt and reliable `Stop.last_assistant_message` content are preserved exactly as Conversation-lite evidence;
- `transcript_path` is stored only as an opaque provider-neutral `TranscriptRef`;
- lifecycle remains fail-open while MCP remains fail-visible;
- provider payload fields cannot choose Space, tier, status, actor, promotion, checkpoint boundary, or idempotency identity.

No open code-level P0/P1/P2 regression was found.

The remaining real MCP execution blocker is external to Memory Space and must not be worked around by changing the shared command-plane contract.

---

## 2. Official lifecycle contract reviewed

The implementation was checked against current official documentation:

- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [MCP configuration](https://code.claude.com/docs/en/mcp)
- [CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Session/resume behavior](https://code.claude.com/docs/en/sessions)
- [Claude Code changelog](https://code.claude.com/docs/en/changelog)

The reviewed mapping is:

```text
SessionStart       → session_start + bootstrap injection
UserPromptSubmit   → user_prompt with original prompt
Stop               → assistant_turn only when last_assistant_message is non-empty
PreCompact         → pre_compact checkpoint policy
SessionEnd         → session_end checkpoint policy
other Claude hooks → ignored by Conversation-lite ingestion
```

Current documented `SessionStart.source` values are:

```text
startup
resume
clear
compact
```

Claude CLI session forking is a distinct CLI/session feature and is not a documented `SessionStart.source = "fork"` payload. If the current adapter/tests/examples still accept or advertise `fork`, remove that extra value before P4 review readiness. This cleanup is provider-local and must not change the common `ProviderLifecycleEvent` contract.

Current SessionEnd reasons and both manual/automatic PreCompact triggers remain provider-local validation concerns. `prompt_id`, effort, permissions, task data, and background work metadata are non-authoritative and intentionally dropped.

---

## 3. Findings fixed during review

### FIX-01 — Reliable Stop requires Claude Code 2.1.47+

The installed 2.1.112 client did not emit `last_assistant_message`. The official changelog records that field as added in 2.1.47. The smoke preflight now rejects older clients and supports a temporary exact official package version without replacing the user's global CLI.

### FIX-02 — Structured output hid assistant-final text

Using `--json-schema` made the final response a `StructuredOutput` tool call, so there was no assistant text for Stop to report. The runner now requires a plain JSON final assistant message and parses it itself. A real 2.1.227 run then proved that `last_assistant_message` was delivered and persisted exactly.

### FIX-03 — Fail explicitly on gateway MCP name rewriting

The active compatibility gateway collapses double underscores in Claude MCP tool names. The runner previously surfaced only model booleans. It now detects the concrete `No such tool available: mcp_memory_space_...` signature and reports the required remediation without proposing alias tools.

### FIX-04 — SessionEnd dirty/no-op boundaries

The Claude lifecycle eval verifies both a dirty SessionEnd checkpoint and a repeated clean SessionEnd no-op, in addition to dirty/clean PreCompact.

### FIX-05 — Additional ingress and fail-open adversarial coverage

Regressions cover Claude lifecycle wrong media type, hostile Origin, privilege-shaped payloads, malformed native payload redaction, throwing diagnostics, unsafe daemon hook output, unavailable transport, and one shared daemon owner.

### FIX-06 — Real automatic PreCompact sends nullable instructions

Claude Code 2.1.227 emitted `custom_instructions: null` for a real automatic compact. The adapter now accepts the observed `string | null` shape and retains rejection of all other types. A regression test covers the nullable payload. The hook-only runner also accumulates multiple completed conversation groups before forcing compact, avoiding the client's `too_few_groups` refusal.

---

## 4. Security and boundary review

The following invariants remain intact:

```text
provider evidence ──X──> Space/tier/status/actor/checkpoint authority
provider evidence ─────> normalized Conversation-lite lifecycle evidence

Claude lifecycle ──────> fail-open safe warning
Claude MCP command ────> fail-visible domain envelope

Claude + Codex + REST + MCP ──> one loopback daemon / one MemorySpace owner
```

Bootstrap content labels Memory as untrusted project data. Provider-visible warnings redact database paths, native IDs, Space IDs, and transport details. All privileged daemon routes retain loopback Host/Origin and JSON media-type protection. Session identity resolves before mutable cwd binding on re-entry, and trusted explicit conflicts remain visible without migration.

---

## 5. Verification matrix

Automated verification passed for the implemented P3 surface:

- native mapping and malformed payload handling;
- full prompt/final-response content fidelity;
- null/empty assistant final ignore behavior;
- adapter capability parity with Codex;
- duplicate/resume/compact start identity reuse;
- changed-cwd Space freezing and explicit trusted conflict;
- opaque TranscriptRef provenance;
- dirty/clean PreCompact and SessionEnd checkpoints;
- durable SQLite reopen/resume;
- exact six MCP tools and privileged-field rejection;
- daemon endpoint routing, local ingress, media type, and shared owner;
- lifecycle service failure and diagnostic-sink fail-open behavior;
- all existing MVP/P0/P1/P2 regressions.

Recorded commands at review time:

```text
pnpm run check           PASS — 75/75 tests
pnpm run check:workspace PASS — 75/75 tests
```

P4 implementation must rerun the current quality gates; these historical counts are not a substitute for new execution evidence.

---

## 6. Real-provider acceptance evidence

The full real run proved native hook loading, bootstrap injection, MCP connection/exact-six discovery, UserPromptSubmit, reliable Stop capture, and SessionEnd. Real MCP execution was blocked by the active gateway's tool-name rewrite.

A separate real `--hooks-only` run passed the provider lifecycle path:

```text
startup/bootstrap
→ prompt/final capture
→ SessionEnd
→ resume
→ PreCompact
→ SessionStart(source=compact)
→ cross-session Handoff
→ daemon-unavailable fail-open
```

MCP-dependent checks were explicitly skipped.

Evidence: [`../validation/CLAUDE_P3_SMOKE.md`](../validation/CLAUDE_P3_SMOKE.md)

This is not a Memory Space code defect and cannot be safely worked around inside this phase without violating the exact-six shared MCP contract.

---

## 7. Progression waiver

The project may proceed to P4 even though the real Claude model-driven MCP call is still blocked, because P4's deterministic product proof can exercise the same shared MCP command plane directly through `MemoryMcpGateway` or the daemon MCP protocol while still using real Codex/Claude provider lifecycle adapters for Session creation, Conversation-lite evidence, bootstrap, and checkpoint behavior.

This is a **progression waiver**, not a verification waiver that converts a blocked check into PASS.

The following remain forbidden:

```text
Claude-specific alias MCP tools
renaming the shared six tools
provider-pair-specific handoff logic
fake documentation claiming real Claude MCP PASS
```

The open external acceptance item must remain visible until a first-party Anthropic authentication path or name-preserving gateway can execute the existing shared MCP tools unchanged.

---

## 8. Verdict

```text
P3 implementation:          COMPLETE
P3 automated validation:    PASS
P3 code review:              PASS
P3 real hook lifecycle:     PASS (hook-only scope)
P3 real MCP execution:      BLOCKED (external gateway)
P3 status:                  ACCEPTED WITH WAIVER / NOT FULLY FROZEN
P4 progression:             ALLOWED
```

P4 must follow [`../P4_CROSS_SESSION_PROVIDER_EVAL.md`](../P4_CROSS_SESSION_PROVIDER_EVAL.md).

If the external Claude MCP blocker is later removed, rerun the full P3 smoke and update the validation/status record. No Claude-only command-plane workaround is authorized by this review.
