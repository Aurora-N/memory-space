# Provider Integration Implementation Guardrails

**Status:** Normative cross-phase implementation constraints  
**Applies to:** Provider Integration P2 and later, and any future refactor touching P0/P1 boundaries  
**Related:** `PROVIDER_INTEGRATION_SPEC.md`, `PROVIDER_INTEGRATION_PLAN.md`, `DOMAIN_MODEL.md`

---

## 1. Purpose

This document captures recurring implementation constraints that have repeatedly surfaced during Provider Integration code reviews.

It is intentionally narrower than the product/domain spec. It exists to stop the same classes of bugs from reappearing as new providers, transports, and lifecycle events are added.

When this document conflicts with the frozen domain model, the frozen domain model wins. When a provider's current official behavior conflicts with an assumption in this document, stop and update the integration contract deliberately instead of silently working around it in provider-specific code.

Coding Agents implementing P2+ MUST review this file before changing provider, lifecycle, daemon, MCP, Session binding, or checkpoint code.

---

# G1 — Provider Session identity is authoritative after first binding

The most important lifecycle invariant is:

```text
provider-native identity is first observed
        ↓
resolve trusted project binding once
        ↓
create/bind Memory Session
        ↓
Session.spaceId is frozen
```

For a provider with stable native identity:

```text
(provider, externalSessionId)
        ↓
one Memory Session
```

After that Session exists, later lifecycle events and repeated `SessionStart` deliveries MUST resolve the existing Memory Session by provider identity before considering `cwd`.

### Required behavior

First observation:

```text
no existing provider Session
→ trusted explicit Space override, otherwise project binding from cwd
→ atomic get-or-create
→ freeze Session.spaceId
```

Subsequent observation:

```text
existing provider Session
→ reuse Session
→ Session.spaceId authoritative
→ cwd MUST NOT rebind it
```

This applies to duplicate starts, provider resume events, post-compaction starts, and other lifecycle re-entry for the same canonical provider-native identity.

A changing `cwd` is runtime evidence, not Session identity.

If a trusted operator/runtime `explicitSpaceId` intentionally conflicts with an already-bound Session, fail with an explicit binding conflict. Never silently migrate the Session.

### Forbidden pattern

```text
repeated SessionStart
→ resolve current cwd again
→ derive another Space
→ compare/migrate
```

This is unsafe because an agent may legitimately change working directory inside a monorepo during the lifetime of one provider Session.

### Required tests for every provider with resume/re-entry

- initial start binds once;
- duplicate start reuses the same internal Session;
- cwd changes after binding do not change Space;
- provider re-entry after cwd change still bootstraps the original Session Space;
- a trusted explicit conflicting Space does not silently rebind.

---

# G2 — Separate evidence, trusted runtime context, and privileged commands

Three input classes must remain distinct:

```text
Provider-native lifecycle payload
→ evidence

Daemon/provider runtime configuration
→ trusted binding/config context

MCP domain tool invocation
→ explicit agent command subject to policy
```

Provider lifecycle text and fields MUST NOT directly control:

```text
spaceId
tier
status
actor
force
confidence
importance
checkpoint boundary
idempotency key
```

Trusted runtime values such as project cwd or `explicitSpaceId` MUST NOT be exposed as ordinary agent-controlled MCP tool fields.

Do not collapse request context and trusted runtime context into one public surface merely because it reduces constructor parameters.

---

# G3 — One durable-store owner remains a hard MVP constraint

Normal runtime topology MUST remain:

```text
one memory-space daemon
        ↓
one MemorySpace instance
        ↓
one durable SQLite owner
```

HTTP, lifecycle adapters, checkpoint orchestration, and MCP transport MUST reuse that same application instance.

Database-owning stdio/provider child processes are not a supported shared runtime.

Standalone development modes may own SQLite only when explicitly opt-in and clearly documented as mutually exclusive with the daemon and other standalone instances.

Do not solve ownership conflicts by adding distributed locks, leases, or a second multi-process checkpoint protocol in Provider Integration v1.

---

# G4 — Privileged local daemon surfaces share one ingress trust boundary

Do not harden only the newest route while leaving older privileged local endpoints weaker.

The daemon currently has no authentication. Therefore all privileged local surfaces MUST be treated consistently:

```text
REST/domain mutation API
Provider lifecycle ingress
MCP endpoint
```

The default v1 daemon MUST be loopback-only unless an authenticated remote deployment design is introduced explicitly.

At minimum:

- reject non-loopback runtime binding for the unauthenticated v1 daemon;
- apply local Host/Origin protections consistently to privileged daemon routes;
- JSON body routes should require the intended JSON content type rather than accepting arbitrary browser-simple form/content types;
- do not create an unprotected provider route alongside protected MCP routes.

`GET /health` may be treated separately if needed.

### Required regression shape

A hostile browser origin must not be able to mutate Memory state through a legacy REST endpoint even if the newer provider/MCP endpoints are protected.

---

# G5 — Lifecycle is fail-open; explicit Memory commands are fail-visible

Provider lifecycle integration is auxiliary to the coding workflow:

```text
hook/lifecycle failure
→ warning/diagnostic
→ provider continues
```

Explicit MCP operations are commands:

```text
MCP command failure
→ visible structured/protocol error
```

Never report a checkpoint or durable write as successful when it failed.

Diagnostic/logging sinks are non-authoritative and MUST NOT be allowed to turn fail-open lifecycle behavior into fail-closed behavior.

Provider-facing warnings must not expose raw SQLite paths, internal network details, stack traces, or private binding identifiers.

---

# G6 — Preserve conversation evidence fidelity

Conversation-lite means normalized conversation content, not rewritten content.

For user prompts and reliable assistant final messages:

- validate emptiness using trimmed semantics if needed;
- persist the original content string;
- do not trim indentation/newlines from the stored message;
- do not summarize/compress by default;
- do not ingest tool stdout, file reads, grep output, or full diffs by default.

Provider transcripts remain supplementary evidence.

`TranscriptRef.locator` is opaque. Do not couple Memory Core/checkpoint correctness to an undocumented or unstable provider transcript file format.

---

# G7 — Verify provider-native contracts against current official documentation

Provider APIs, hook payloads, lifecycle timing, configuration files, and MCP capabilities are externally versioned behavior.

Before implementing or changing a provider adapter:

1. verify the currently documented native events/fields/output semantics using the provider's official documentation;
2. write adapter tests using payloads that match those semantics;
3. keep provider-specific fields inside the adapter/integration boundary;
4. only extend the common Provider Contract when the common layer genuinely needs a provider-neutral semantic.

Do not promote one provider's richer event surface into a required common capability solely because it is available.

When provider documentation says a lifecycle event can occur during resume, compaction, or another non-obvious boundary, add a regression reproducing that lifecycle timing rather than testing only startup happy paths.

---

# G8 — Keep public command surfaces policy-bounded

The v1 MCP command plane remains exactly:

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

Do not add raw Memory CRUD/debug/admin tools as a convenience while implementing a provider.

Durable writes require Session provenance.

The agent must not directly control Space binding, tier/state internals, promotion authority, or checkpoint boundaries.

Strict MCP schema errors may remain MCP protocol/schema errors. Schema-valid domain/integration failures use the stable Memory MCP error contract.

---

# G9 — Preserve application boundaries; do not reopen persistence escape hatches

Provider integration should depend on application operations/explicit ports, not reach through application objects to raw persistence.

Avoid patterns such as:

```text
provider integration
→ memorySpace.store
→ SQLite-specific behavior
```

If integration needs an atomic persistence primitive, either:

- expose the smallest correct application operation that owns the invariant; or
- inject a deliberately scoped port where persistence semantics genuinely belong to integration.

Do not move invariants outward into one caller merely to keep application methods thin.

---

# G10 — Checkpoint semantics remain boundary-based and no-op when clean

All automatic/manual checkpoint triggers share the same semantic policy:

```text
no uncommitted SessionEvent
→ noop

uncommitted events
→ freeze latest event boundary
→ one checkpoint for that boundary
```

A trigger name is metadata, not checkpoint identity.

Events arriving during checkpoint execution remain dirty for the next checkpoint.

PreCompact/SessionEnd lifecycle failure remains fail-open; explicit MCP checkpoint failure remains fail-visible.

Do not make Stop/assistant-final automatically checkpoint unless the frozen trigger policy is intentionally revised.

---

# G11 — Phase status must reflect executed acceptance evidence

Documentation status is an engineering assertion, not a plan aspiration.

Do not write:

```text
P<n> = FROZEN
verified
complete
```

until every required gate for that phase has actually been executed.

Distinguish clearly:

```text
implementation complete
automated tests complete
CI observed green
real-provider smoke complete
phase frozen
```

If a manual/real-provider acceptance test is required but cannot be run in the current environment, document it as pending and stop before claiming the phase is frozen.

Never infer GitHub Actions success merely because local tests exist or a workflow file is present.

---

# G12 — Every phase must include adversarial boundary regressions

Provider happy-path tests are insufficient.

For changes touching lifecycle/provider/runtime boundaries, tests should cover the relevant subset of:

- duplicate native start delivery;
- resume/re-entry after cwd change;
- post-compaction lifecycle re-entry;
- conflicting trusted binding;
- provider/native identity mismatch;
- TranscriptRef identity mismatch;
- privilege-shaped provider fields (`spaceId`, `tier`, `actor`, `force`);
- no new events at checkpoint;
- daemon unavailable / storage unavailable;
- diagnostics throwing;
- hostile Host/Origin against privileged local routes;
- multiple provider hook sources / duplicate evidence risk;
- persistence across daemon restart.

A new provider must not weaken existing P0/P1 regression coverage.

---

# G13 — Keep spec/code/status synchronized

Before declaring a phase complete, inspect at least:

```text
docs/PROVIDER_INTEGRATION_SPEC.md
docs/PROVIDER_INTEGRATION_PLAN.md
provider-specific setup docs
README.md
runtime examples/config
```

If code intentionally chooses a stronger invariant than an older recommendation, update the docs rather than leaving contradictory contracts for the next Coding Agent.

Provider-specific examples must not imply unsupported runtime modes.

---

# Coding Agent completion checklist

Before asking for the next phase review, report:

1. which guardrails were relevant to the change;
2. which files changed;
3. which invariants changed or remained unchanged;
4. new adversarial regressions added;
5. `pnpm run check` result;
6. `pnpm run check:workspace` result when applicable;
7. actual CI status if observable;
8. actual real-provider smoke status if required;
9. any accepted/deferred limitation.

If a requested implementation would violate one of these guardrails or the frozen domain spec, stop that part of the work and report the conflict instead of silently changing the architecture.
