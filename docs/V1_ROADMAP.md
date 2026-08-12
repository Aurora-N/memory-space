# memory-space v1 Roadmap

**Status:** Active post-Provider-Integration roadmap  
**Current phase:** P6 Stage B1 Retrieval Precision & Abstention — READY / AUTHORIZED  
**Frozen foundations:** `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`, Provider Integration P0/P1/P2 contracts  
**Related:** `PROVIDER_INTEGRATION_PLAN.md`, `P4_CROSS_SESSION_PROVIDER_EVAL.md`, `PRODUCTIZATION_SPEC.md`, `MEMORY_QUALITY_V1_SPEC.md`, `P6_STAGE_B_RETRIEVAL_SPEC.md`

---

## 1. Why the roadmap changes after P4

P0–P4 proved the architectural claim that matters most:

> Durable Memory belongs to a Space and can survive Session, process, and provider boundaries.

The repository has deterministic evidence for:

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

After that proof, adding providers has lower marginal value than improving usability and long-horizon Memory quality.

---

## 2. Phase order

```text
P0 — Integration Foundation                    COMPLETE / FROZEN
P1 — MCP Command Plane                         COMPLETE / FROZEN
P2 — Codex Provider Integration                COMPLETE / FROZEN
P3 — Claude Code Provider Integration          ACCEPTED WITH SCOPED WAIVER
P4 — Cross-Session & Cross-Provider Eval       COMPLETE / REVIEW PASS

P5 — Productization                            COMPLETE / REVIEW PASS
P6 — Memory Quality v1
     Stage A deterministic baseline            COMPLETE / REVIEW PASS
     Stage B1 Retrieval Precision & Abstention READY / AUTHORIZED
     Stage B2 Extraction Quality               NOT AUTHORIZED
     Stage B3 Core/Handoff Pollution            NOT AUTHORIZED
     Stage B4 Semantic Retrieval/Dedup          OPTIONAL / NOT AUTHORIZED

P7 — Optional MCP-first Provider Validation    OPTIONAL
```

P3's real Claude model-driven MCP check remains externally blocked under the existing scoped waiver. P6 must not add Claude-specific aliases or otherwise weaken the exact shared MCP contract.

---

# 3. P5 — Productization

**Normative spec:** [`PRODUCTIZATION_SPEC.md`](./PRODUCTIZATION_SPEC.md)

P5 is complete. The repository exposes:

```text
memory-space init
memory-space doctor
memory-space status
memory-space eval cross-session
```

The CLI remains a loopback daemon client rather than a second SQLite owner. CR-PHASE8 closed the Claude config-scope and nested-binding findings.

---

# 4. P6 — Memory Quality v1

**Umbrella spec:** [`MEMORY_QUALITY_V1_SPEC.md`](./MEMORY_QUALITY_V1_SPEC.md)

## 4.1 Stage A — Deterministic baseline — COMPLETE / REVIEW PASS

The accepted deterministic baseline lives under `eval/quality/` and is exposed through:

```text
memory-space eval quality
memory-space eval quality --json
```

It measures:

```text
Extraction precision / recall
positive-query Retrieval P@K / R@K
negative-query false-positive / abstention
Core pollution
bootstrap critical coverage and size
Handoff completeness
stale-memory rate
duplicate-memory rate
contradiction/supersession correctness
20-Session long-horizon continuity
provider-neutral continuity correctness
```

Accepted reference:

```text
9490ebce94928132a2fb16aca247c8ae4888a7cf
```

Review:

```text
docs/code-review/CR-PHASE9.md — PASS
```

Evidence:

```text
docs/quality/P6_BASELINE.md
```

The accepted retrieval baseline includes:

```text
P@1                         0.727273
R@1                         0.681818
P@3                         0.303030
R@3                         0.818182
P@5                         0.180000
R@5                         0.800000
P@10                        0.090000
R@10                        0.800000
Negative FP rate            1.000000
Negative abstention         0.000000
```

Stage A deliberately did not modify production extraction/retrieval algorithms.

## 4.2 Stage B1 — Retrieval Precision & Abstention — NEXT

**Normative execution spec:** [`P6_STAGE_B_RETRIEVAL_SPEC.md`](./P6_STAGE_B_RETRIEVAL_SPEC.md)

B1 is the only currently authorized production quality change.

It targets:

```text
broad lexical false positives
missing abstention
ranking precision
generic key-token overlap
```

B1 should first improve the existing deterministic lexical policy rather than jump directly to embeddings/vector search.

Expected implementation shape:

```text
accepted Stage A machine-readable snapshot
→ provider-neutral field-aware lexical scoring
→ explicit relevance/abstention gate
→ deterministic candidate eval
→ before/after report
→ code/quality review
```

B1 must preserve accepted Stage A ground-truth labels and hard correctness invariants.

B1 completes only after reviewer approval. The Coding Agent must stop before B2/B3/B4.

## 4.3 Later quality stages

Later work may be authorized separately:

```text
B2 — Extraction Generalization & Transient Rejection
B3 — Core / Handoff Pollution Policy
B4 — Semantic Dedup / Semantic Retrieval architecture decision
```

Changing corpus creation and search ranking in the same stage is intentionally avoided so quality deltas remain attributable.

If B1 demonstrates that remaining retrieval failures have effectively no lexical overlap, write an architecture decision before adding embeddings/vector infrastructure.

---

# 5. P7 — Optional MCP-first Provider Validation

Cursor or another MCP-capable agent may be added after the quality work when it proves a genuinely new compatibility property.

Minimum useful proof:

```text
shared MCP discovery
project Space binding
bootstrap/context/search
remember/promote/checkpoint
capability differences documented honestly
```

Do not build polling or fake lifecycle emulation solely to claim provider parity.

---

## 6. Cross-phase invariants

P5+ must continue to preserve:

- Space owns durable Memory;
- one Session belongs to exactly one frozen Space;
- provider identity is Session provenance, not Memory ownership;
- one daemon owns the active SQLite store;
- MCP remains exactly six policy-bounded Memory tools unless separately reviewed;
- lifecycle failures remain fail-open;
- explicit Memory commands remain fail-visible;
- provider evidence cannot choose Space, tier, status, actor, checkpoint boundary, or idempotency identity;
- Indexed Memory remains progressive rather than default bootstrap content;
- frozen MVP domain/product semantics are not silently changed by productization, eval, or quality optimization.

---

## 7. Review cadence

Use the architecture-first workflow for every new quality stage:

```text
accepted before-state
→ scoped spec / acceptance criteria
→ Coding Agent implementation
→ deterministic verification + before/after metrics
→ code review
→ status update
→ explicit authorization for the next stage
```

Current next implementation is P6 Stage B1 only.
