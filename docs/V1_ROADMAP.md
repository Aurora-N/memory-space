# memory-space v1 Roadmap

**Status:** Active post-Provider-Integration roadmap  
**Current phase:** P6 Stage A CR-PHASE9 fixes implemented — awaiting re-review
**Frozen foundations:** `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`, Provider Integration P0/P1/P2 contracts  
**Related:** `PROVIDER_INTEGRATION_PLAN.md`, `P4_CROSS_SESSION_PROVIDER_EVAL.md`, `PRODUCTIZATION_SPEC.md`, `MEMORY_QUALITY_V1_SPEC.md`

---

## 1. Why the roadmap changes after P4

P0–P4 have already proved the architectural claim that matters most:

> Durable Memory belongs to a Space and can survive Session, process, and provider boundaries.

The repository now has deterministic evidence for:

```text
Codex → Codex
Claude → Claude
Codex → Claude
Claude → Codex
Codex → Claude → Codex → Claude
SQLite close/reopen
Space isolation
Core/Handoff default disclosure
Indexed explicit recall
provenance preservation
```

That means adding more providers immediately has lower marginal value than proving two new properties:

1. the system is practical to install, diagnose, and demonstrate;
2. the memories it keeps remain useful and accurate over long horizons.

The next roadmap therefore shifts from horizontal provider breadth to product usability and memory quality.

---

## 2. Phase order

```text
P0 — Integration Foundation                    COMPLETE / FROZEN
P1 — MCP Command Plane                         COMPLETE / FROZEN
P2 — Codex Provider Integration                COMPLETE / FROZEN
P3 — Claude Code Provider Integration          ACCEPTED WITH SCOPED WAIVER
P4 — Cross-Session & Cross-Provider Eval       COMPLETE / REVIEW PASS

P5 — Productization                            COMPLETE / REVIEW PASS
P6 — Memory Quality v1                         STAGE A COMPLETE / REVIEW PENDING
P7 — Optional MCP-first Provider Validation    OPTIONAL
```

P3's remaining real Claude model-driven MCP check is still an external blocker. It remains visible and must not be converted into a synthetic PASS. P5/P6 must not add Claude-specific MCP aliases to work around it.

---

# 3. P5 — Productization

**Normative spec:** [`PRODUCTIZATION_SPEC.md`](./PRODUCTIZATION_SPEC.md)

## Goal

Turn the proven architecture into a local product workflow that another developer can understand and operate without manually stitching together REST calls, binding files, provider configuration, and eval commands.

P5 focuses on:

```text
memory-space init
memory-space doctor
memory-space status
memory-space eval cross-session
```

The exact executable/package shape may follow repository conventions, but the user-facing capabilities and safety boundaries in the Productization Spec are required.

## P5 success statement

P5 succeeds when a developer can:

1. initialize a project binding safely;
2. diagnose daemon/binding/provider/MCP state from one command;
3. inspect concise current Space/runtime state without raw database access;
4. run the existing cross-session durability proof from one documented command;
5. receive deterministic exit codes/output useful for both humans and scripts.

P5 must not redesign Memory semantics.

## P5 implementation status

The repository now exposes:

```text
memory-space init
memory-space doctor
memory-space status
memory-space eval cross-session
```

The first three commands use one loopback `LocalMemorySpaceClient` and never
open SQLite. The eval command reuses the canonical P4 runner with isolated
temporary storage. CR-PHASE8 hardening distinguishes local versus inherited
init bindings and detects supported Claude hook/MCP scopes without exposing
provider secrets. P5 implementation, validation, and code review are complete.

---

# 4. P6 — Memory Quality v1

**Normative spec:** [`MEMORY_QUALITY_V1_SPEC.md`](./MEMORY_QUALITY_V1_SPEC.md)

## Goal

Move from proving that Memory persists to measuring whether the resulting Memory remains useful over time.

The first deliverable is a reproducible deterministic quality baseline, not speculative retrieval architecture.

Required quality dimensions include:

```text
Extraction precision / recall
Retrieval Precision@K / Recall@K
Core pollution rate
Handoff completeness
Stale-memory rate
Duplicate-memory rate
Contradiction/supersession correctness
Bootstrap size/cost
Long-horizon continuity
```

P6 should first establish benchmark fixtures and baseline metrics. Algorithm changes should follow measured failure modes rather than precede them.

## P6 Stage A implementation status

The deterministic baseline is implemented under `eval/quality/` and is exposed
through both human-readable and JSON CLI output:

```text
memory-space eval quality
memory-space eval quality --json
```

It evaluates checkpoint extraction, positive-query lexical retrieval at each
eligible K from 1/3/5/10, negative-query false-positive/abstention behavior,
Core pollution, bootstrap critical coverage and size, Handoff completeness,
stale and duplicate Memory, supersession correctness, a 20-Session horizon,
and a small provider-neutral continuity proof. Quality scores are recorded
without invented thresholds; frozen correctness invariants remain hard
assertions. CR-PHASE9 hardening preserves production ranking and excludes
zero-relevant queries from ordinary P@K/R@K.

Stage A is awaiting baseline re-review. The corrected evidence and ranked measured
risks are in [`quality/P6_BASELINE.md`](./quality/P6_BASELINE.md). Stage B has
not started and requires explicit post-review authorization.

---

# 5. P7 — Optional MCP-first Provider Validation

Cursor or another MCP-capable agent may be added after P5/P6 when it proves a genuinely new compatibility property.

Minimum useful proof:

```text
shared MCP discovery
project Space binding
bootstrap/context/search
remember/promote/checkpoint
capability differences documented honestly
```

Do not build polling or fake lifecycle emulation solely to claim provider parity.

A new provider is optional because P4 has already proved provider independence with two lifecycle-capable providers and same-provider/cross-provider multi-session evaluation.

---

## 6. Cross-phase invariants

P5+ must continue to preserve:

- Space owns durable Memory;
- one Session belongs to exactly one frozen Space;
- provider identity is Session provenance, not Memory ownership;
- one daemon owns the active SQLite store;
- MCP remains exactly six policy-bounded Memory tools unless a separately reviewed contract revision is approved;
- lifecycle failures remain fail-open;
- explicit Memory commands remain fail-visible;
- provider evidence cannot choose Space, tier, status, actor, checkpoint boundary, or idempotency identity;
- Indexed Memory remains progressive rather than default bootstrap content;
- frozen MVP domain/product semantics are not silently changed by productization or eval work.

---

## 7. Review cadence

Use the same architecture-first workflow for each new phase:

```text
spec / acceptance criteria
→ Coding Agent implementation
→ automated verification
→ code review
→ status update
→ next phase
```

Do not start P6 implementation before P5 code review unless the reviewer explicitly allows overlap. Do not start P7 merely because it is listed; choose it only if additional provider coverage remains useful after Productization and Memory Quality work.
