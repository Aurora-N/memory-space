# CR-PHASE5 — Codex P2 Final Hardening

**Target branch:** `agent/provider-integration-v1`  
**Scope:** Final Codex P2 correctness/security/acceptance hardening before P3 Claude Code integration  
**Reviewed head:** `ca126bc910f83c8d20714965385d70ccb84938aa`  
**Status:** Action required before P3  
**Normative guardrails:** [`../PROVIDER_INTEGRATION_GUARDRAILS.md`](../PROVIDER_INTEGRATION_GUARDRAILS.md)

---

## 1. Review conclusion

The P2 implementation is substantially correct and should not be redesigned broadly.

The following areas are already accepted and must be preserved:

- Codex native hook adapter exists under `src/adapters/providers/codex/`;
- supported v1 mapping is `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, and `SessionEnd`;
- `PreToolUse` / `PostToolUse` are not ingested into SessionEvent by default;
- user prompt and reliable assistant-final content are stored as Conversation-lite full content;
- `transcript_path` is stored only as an opaque `TranscriptRef`;
- bootstrap returns the opaque internal Memory Space Session handle plus deterministic Core/Handoff context;
- Codex lifecycle hook bridge is fail-open;
- MCP remains fail-visible and uses the shared daemon owner;
- provider privilege-shaped fields do not become trusted Memory commands;
- automated Codex lifecycle/eval coverage exists.

Do **not** start P3 until the blocking items below are fixed and the P2 acceptance status is truthful.

Current official Codex Hook behavior was re-checked during this review against:

- `https://developers.openai.com/codex/hooks`
- `https://developers.openai.com/codex/mcp`

The official hook contract currently states that `SessionStart.source` may be `startup`, `resume`, `clear`, or `compact`, and that after compaction Codex runs matching `SessionStart(source="compact")` hooks before the next model request; automatic compaction can occur in the middle of a turn. The fix below must preserve that real lifecycle behavior.

---

# 2. FIX-01 — SessionStart re-entry must resolve provider identity before cwd binding

**Priority:** P2 blocker before P3  
**Category:** Session identity / Space freezing / compaction correctness  
**Guardrails:** G1, G7, G12

## Problem

Current Codex normalization validates `SessionStart.source`, but normalizes every start into the same provider-neutral event and drops the native source.

Current common `LifecycleHandler.#start()` then resolves project binding from current `cwd` before resolving/reusing the provider Session.

That produces an invalid lifecycle for a legitimate Codex session:

```text
SessionStart(startup)
cwd = /repo
→ Space A
→ Memory Session S

agent later changes cwd
cwd = /repo/apps/web
→ nested binding would resolve Space B

PreCompact
→ checkpoint S

Codex compacts

SessionStart(source=compact)
cwd = /repo/apps/web
→ current implementation resolves Space B again
→ same provider-native session is already Space A
→ conflict warning
→ post-compaction bootstrap is lost
```

This violates the frozen design principle that Space is resolved once when the provider Session is first bound and `Session.spaceId` is authoritative afterward.

The current Codex eval also treats a repeated start under changed cwd as a binding conflict. That expectation must be corrected for lifecycle re-entry of an already-known provider-native identity.

## Required invariant

For `session_start` with stable `provider + externalSessionId`:

```text
1. Look for an already-bound provider Session first.

2a. Existing Session found:
    → reuse it
    → Session.spaceId is authoritative
    → bootstrap existing Session Space
    → current cwd MUST NOT rebind it

2b. No existing Session:
    → resolve trusted explicit Space override / project cwd binding
    → atomically create/bind provider Session
    → freeze Session.spaceId
```

This must work for:

- duplicate SessionStart delivery;
- resume/re-entry;
- `source=compact` after PreCompact;
- changed working directory inside a monorepo.

A trusted runtime/operator `explicitSpaceId` remains authoritative configuration. If it is intentionally supplied and conflicts with an existing provider Session binding, return an explicit binding conflict; do not migrate the Session.

Mutable provider `cwd` is not authoritative after first binding.

## Preferred implementation direction

Do not add Codex conditionals to `MemorySpace`.

Fix the common provider lifecycle orchestration so provider identity is resolved before project binding on repeated SessionStart.

A small API such as one of these is acceptable:

```ts
sessionResolver.findOptional(provider, externalSessionId)
```

or equivalent application operation returning `Session | undefined`.

Conceptually:

```ts
async #start(event, context) {
  if (event.externalSessionId) {
    const existing = await findExistingProviderSession(
      event.provider,
      event.externalSessionId
    );

    if (existing) {
      validateTrustedExplicitBindingIfPresent(existing, context);
      return bootstrapExisting(existing);
    }
  }

  const binding = await spaceResolver.resolve({
    cwd: event.cwd ?? context.cwd,
    explicitSpaceId: context.explicitSpaceId
  });

  const session = await sessionResolver.resolve(...);
  return bootstrap(session);
}
```

The exact API may differ. Preserve atomic get-or-create for first creation.

### About `SessionStart.source`

Do not add a provider-specific `codexSource` field to the common contract.

If native start reason is useful for diagnostics/observability, keep it adapter-local or introduce an optional provider-neutral lifecycle metadata concept only if justified. The correctness fix should not require Codex-specific branching in the common Memory layer.

## Required regressions

### Regression A — compact after cwd change

```text
root binding = Space A
nested binding = Space B

SessionStart(startup, root)
→ Session S / Space A

UserPromptSubmit / Stop
→ Session S

change provider cwd to nested

PreCompact(auto|manual)
→ completed when dirty

SessionStart(compact, nested)
→ status ok
→ same Session S
→ Space A
→ bootstrap/additionalContext returned
→ latest Handoff/Core context available
```

### Regression B — resume/repeated start does not rebind by cwd

```text
Session S already bound to Space A
SessionStart(resume, cwd resolving Space B)
→ same S
→ Space A
→ no silent migration
```

### Regression C — explicit trusted conflict remains visible

```text
Session S bound Space A
runtime explicitSpaceId = Space B
→ explicit conflict
→ Session remains Space A
```

Update the existing eval that currently expects changed-cwd repeated SessionStart to produce a conflict. The conflict case should be driven by trusted conflicting runtime configuration rather than mutable provider cwd.

---

# 3. FIX-02 — Apply one local trust boundary to all privileged daemon APIs

**Priority:** P2 blocker before P3  
**Category:** Local daemon security / ingress trust  
**Guardrails:** G2, G4, G12

## Problem

The daemon currently applies localhost Host/Origin validation to:

```text
/mcp
/providers/codex/lifecycle
```

but the legacy JSON REST API is routed directly to `createRequestHandler()` without the same guard.

Those legacy routes include privileged mutations such as:

```text
POST /spaces
POST /spaces/:spaceId/sessions
POST /sessions/:sessionId/events
POST /spaces/:spaceId/memories
POST /memories/:memoryId/promote
POST /memories/:memoryId/demote
POST /memories/:memoryId/status
POST /sessions/:sessionId/checkpoints
```

Some of these expose capabilities intentionally absent from MCP, including raw event append, demotion/status mutation, and raw checkpoint boundary control.

Therefore hardening only MCP/provider ingress leaves a weaker mutation path into the same unauthenticated daemon.

Additionally, JSON-body parsing currently accepts parseable JSON without requiring the intended `application/json` media type.

## Required v1 security invariant

The unauthenticated Provider Integration v1 daemon is local-only.

Normal deployment must be:

```text
loopback listener
        ↓
consistent local Host/Origin policy
        ↓
REST + lifecycle + MCP
```

Do not claim remote-host support without adding an authenticated deployment design.

## Required implementation

### A. Loopback-only listener

Reject normal daemon startup/listen configuration that binds the unauthenticated v1 daemon to a non-loopback address such as:

```text
0.0.0.0
::
LAN/public interface address
```

Allow an explicitly defined loopback set, for example:

```text
127.0.0.1
::1
localhost
```

Keep the exact helper small and testable.

Do not add auth/TLS/remote deployment in this phase.

### B. Uniform Host/Origin protection

Apply the local Host/Origin guard consistently before routing privileged daemon requests.

Preferred shape:

```text
incoming daemon request
        ↓
local Host/Origin validation
        ↓
REST | lifecycle | MCP
```

`GET /health` may be exempted if useful, but mutation/read APIs that expose project data should not remain a weaker browser-accessible surface.

Do not create provider-specific copies of the same guard.

### C. JSON media type

For routes that consume JSON bodies, require an appropriate JSON content type (`application/json`, optionally JSON-compatible suffixes if deliberately supported).

A missing/wrong media type should fail before domain mutation.

Do not weaken the Codex hook bridge; it already sends `content-type: application/json`.

The response may reuse the existing validation error model if adding a separate 415 domain error would be disproportionate. The important invariant is that browser-simple arbitrary body types cannot reach privileged JSON mutation parsing.

## Required regressions

At minimum test:

1. hostile Origin → `POST /spaces` rejected;
2. hostile Origin → raw Memory mutation rejected;
3. hostile Origin → raw checkpoint endpoint rejected;
4. hostile Origin → Codex lifecycle remains rejected;
5. hostile Origin → MCP remains rejected;
6. normal loopback HTTP/MCP/Codex requests continue to work;
7. non-loopback daemon host configuration is rejected;
8. JSON mutation request with unsupported/missing content type is rejected before mutation;
9. `GET /health` behavior matches the documented policy.

Preserve the single-owner daemon composition test.

---

# 4. GATE-03 — P2 cannot be marked Frozen before a real Codex smoke test is actually executed

**Priority:** Required acceptance gate  
**Category:** Verification truthfulness  
**Guardrails:** G7, G11, G13

## Problem

The branch contains:

- automated Codex adapter tests;
- daemon integration tests;
- a simulated Codex lifecycle eval;
- a documented manual smoke procedure.

Those are valuable, but they do not prove that an actual Codex installation loaded the hook configuration, connected to MCP, emitted the expected current native payloads, accepted the hook output, and completed the real lifecycle sequence.

The implementation plan currently states that P2 is Frozen. That claim is only valid if the real-provider smoke has actually been run.

## Required status semantics

Until real smoke is executed successfully, documentation must say something equivalent to:

```text
P2 implementation complete
P2 automated validation complete
P2 real-Codex smoke pending
```

Only after actual successful execution may it say:

```text
P2 = FROZEN
```

Do not infer smoke success from the existence of `CODEX_INTEGRATION.md`.

## Required real Codex smoke

Using a real supported Codex environment and the branch's actual hook/MCP configuration:

1. start the Memory Space daemon;
2. bind a real test project to a Space;
3. load the Codex hook configuration;
4. connect Codex to `memory_space` MCP;
5. start a real Codex session;
6. verify SessionStart injects an opaque Memory Session handle and bootstrap context;
7. submit a user prompt and allow a final assistant response;
8. verify Conversation-lite user/assistant events persisted;
9. invoke at least one shared MCP Memory tool using the injected Session handle;
10. trigger compaction so `PreCompact` executes;
11. verify post-compaction `SessionStart(source=compact)` succeeds and reuses the same internal Session even if cwd has changed;
12. resume the same native session and verify the same internal Session identity;
13. start a different Codex session in the same Space and verify prior Handoff/Core is recovered;
14. stop/unavailable the Memory daemon and verify Codex hook workflow remains non-blocking with a safe warning;
15. verify no raw DB/network/private binding details appear in provider-visible warnings.

## Evidence

If the Coding Agent can run the smoke test, create:

```text
docs/code-review/P2-CODEX-SMOKE.md
```

Record only non-secret evidence:

- date;
- Codex version/build if available;
- Memory Space commit SHA;
- which hook/config source was used;
- each smoke step pass/fail;
- observed internal Session reuse result;
- observed compact re-entry result;
- `pnpm run check` result;
- any limitation.

Do not include tokens, private transcripts, or sensitive project content.

If a real Codex environment is unavailable to the Coding Agent:

- do not fabricate the report;
- leave P2 status as smoke-pending;
- stop before P3 and report that manual execution is required.

---

# 5. DEFER-04 — Native `turn_id` duplicate-evidence risk must be documented, not over-engineered in P2

**Priority:** Non-blocking / accepted v1 limitation  
**Category:** Provider event idempotency / observability  
**Guardrails:** G7, G12, G13

## Current behavior

Codex turn-scoped hooks include `turn_id`. The adapter validates it for supported turn-scoped events but does not retain it in normalized/persisted evidence.

Codex hook configuration can load multiple matching hook sources. If the same Memory Space hook is installed globally and project-locally, the same native event may be delivered more than once and duplicate Conversation-lite evidence may be appended.

The current provider setup doc already instructs users to install the Memory Space hook in one active source. That is acceptable for v1.

## Required P2 action

Do **not** add a dedup table, distributed event registry, or a large ProviderEvent identity redesign in this hardening pass.

Instead:

1. keep the one-active-hook-source warning prominent in `CODEX_INTEGRATION.md`;
2. document duplicate delivery as an accepted v1 limitation;
3. add a short future note that a potential provider-event idempotency key can be derived from provider-native identity/event metadata when a later phase justifies it;
4. do not misuse `TranscriptRef.cursor` as `turn_id` merely to store the value;
5. if native event metadata is preserved for diagnostics, keep it non-authoritative and do not let it affect Memory policy.

No P3 blocker remains from this item once the limitation is explicit.

---

# 6. Cross-phase guardrail adoption

A new normative file now exists:

```text
docs/PROVIDER_INTEGRATION_GUARDRAILS.md
```

Before completing this CR:

- add a visible reference to the guardrail file from `PROVIDER_INTEGRATION_PLAN.md` (and optionally the main provider spec index/header if convenient);
- treat it as required reading for P3/P4 Coding Agents;
- do not copy all rules into provider-specific docs—link to the common constraints instead.

The guardrail spec intentionally captures recurring review issues:

```text
identity before binding
trusted runtime vs provider evidence vs MCP command
single durable-store owner
uniform daemon ingress trust
lifecycle fail-open vs MCP fail-visible
content fidelity / opaque transcript refs
official provider-contract verification
policy-bounded MCP surface
no store escape hatch
checkpoint boundary semantics
truthful phase status
adversarial regression requirements
spec/code/status synchronization
```

---

# 7. Preserve accepted P2 behavior

Do not regress these contracts while hardening:

```text
SessionStart       → bootstrap/injection
UserPromptSubmit   → user message evidence
Stop               → assistant message only when reliable content exists
PreCompact         → checkpointIfNeeded
SessionEnd         → checkpointIfNeeded
PreToolUse         → ignored by Conversation-lite ingestion
PostToolUse        → ignored by Conversation-lite ingestion
```

Preserve:

- full content fidelity;
- `TranscriptRef` opaque handling;
- Provider Session durable uniqueness;
- Session-bound Space isolation;
- no provider-native direct Core/status/actor control;
- exactly six MCP tools;
- lifecycle fail-open;
- explicit MCP fail-visible;
- single daemon / one MemorySpace owner;
- no transcript-format dependency;
- no P3 implementation in this CR.

---

# 8. Required verification matrix

After implementation, run the complete regression surface.

## Provider/session identity

- first Codex start creates/binds one Session;
- duplicate start reuses it;
- changed cwd does not migrate it;
- compact re-entry after changed cwd reuses it and returns bootstrap;
- resume/re-entry after changed cwd reuses it;
- trusted explicit conflicting Space returns conflict;
- provider/native identity mismatch still rejects;
- TranscriptRef identity mismatch still rejects.

## Conversation-lite

- user prompt whitespace preserved;
- assistant final content preserved;
- null/empty assistant final content ignored;
- tool events not ingested;
- provider privilege-shaped fields inert.

## Checkpoint

- dirty PreCompact completes;
- repeated clean PreCompact no-ops;
- SessionEnd with no new events no-ops;
- compact re-entry sees the checkpoint/Handoff that was just committed;
- checkpoint boundary/idempotency internals remain hidden from MCP.

## Runtime/security

- one MemorySpace daemon owner;
- lifecycle and MCP share that owner;
- REST privileged routes use the same local ingress policy;
- hostile Origin rejected on REST/lifecycle/MCP;
- non-loopback daemon bind rejected;
- wrong JSON media type rejected before mutation;
- lifecycle service unavailable remains fail-open;
- MCP service failures remain fail-visible;
- provider-facing warning contains no raw infrastructure details.

## Existing MVP/P0/P1 regressions

Preserve all existing tests for:

- cache failure tolerance;
- SQLite transaction barrier release;
- provider-session atomic get-or-create;
- Core capacity/promotion policy;
- Space isolation;
- Handoff semantics;
- MCP strict privileged-field schemas;
- shared daemon shutdown.

Run:

```bash
pnpm run check
pnpm run check:workspace
```

If GitHub Actions status is observable, report it separately. Do not call CI green unless it was actually observed.

---

# 9. Documentation updates required

Update documentation to reflect the actual post-fix state:

### `docs/PROVIDER_INTEGRATION_PLAN.md`

- link to `PROVIDER_INTEGRATION_GUARDRAILS.md`;
- remove/soften premature P2 Frozen wording until real smoke passes;
- after smoke passes, mark P2 Frozen truthfully;
- keep P3 not started.

### `docs/CODEX_INTEGRATION.md`

- explain that provider identity is reused before cwd binding on lifecycle re-entry;
- explicitly cover post-compaction SessionStart behavior;
- preserve one-active-hook-source duplicate warning;
- document loopback-only daemon limitation;
- document the real smoke result only if actually executed.

### `README.md` / API docs

- document loopback-only unauthenticated v1 daemon;
- document consistent local ingress protection;
- do not advertise non-loopback/remote deployment without auth.

---

# 10. Stop condition

This CR is complete when:

```text
FIX-01 identity-first SessionStart re-entry       ✅
FIX-02 uniform local daemon trust boundary        ✅
automated adversarial regressions                 ✅
pnpm run check                                    ✅
pnpm run check:workspace                          ✅
turn_id duplicate limitation documented           ✅
guardrail spec linked                             ✅
real Codex smoke                                  ✅ or explicitly PENDING
```

If real Codex smoke is pending:

```text
P2 implementation/hardening = complete
P2 phase                    = NOT YET FROZEN
P3                           = DO NOT START
```

If real Codex smoke passes:

```text
Provider Integration P0 = FROZEN
MCP Command Plane P1     = FROZEN
Codex Integration P2     = FROZEN
```

Then stop and request review before starting P3 Claude Code integration.

---

# 11. Coding Agent completion report

Return a concise report containing:

1. changed files;
2. how SessionStart now handles existing provider identity before cwd;
3. how compact re-entry is proven;
4. how daemon-wide local security is enforced;
5. how JSON body media type is enforced;
6. tests added/updated;
7. `pnpm run check` result;
8. `pnpm run check:workspace` result;
9. actual CI status if observable;
10. real Codex smoke result or explicit reason it remains pending;
11. any accepted v1 limitation;
12. confirmation that P3 was not started.
