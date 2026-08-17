# memory-space v1 Roadmap

**Status:** Active post-Provider-Integration roadmap  
**Current phase:** P7 Implicit Prompt-Time Recall — IMPLEMENTED / VALIDATED / AWAITING REVIEW
**Frozen foundations:** `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`, Provider Integration P0/P1/P2 contracts  
**Related:** `PROVIDER_INTEGRATION_PLAN.md`, `P4_CROSS_SESSION_PROVIDER_EVAL.md`, `PRODUCTIZATION_SPEC.md`, `MEMORY_QUALITY_V1_SPEC.md`, `P6_STAGE_B_RETRIEVAL_SPEC.md`, `P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`

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
P6 — Memory Quality v1                         COMPLETE / REVIEW PASS / FROZEN
     Stage A deterministic baseline            COMPLETE / REVIEW PASS / FROZEN
     Stage B1 Retrieval Precision & Abstention COMPLETE / REVIEW PASS / FROZEN
     Stage B2 Extraction Quality               COMPLETE / REVIEW PASS / FROZEN
     Stage B3 Core/Handoff Pollution            COMPLETE / REVIEW PASS / FROZEN
     Stage B4 Semantic Retrieval/Dedup          DEFERRED TO V2

P7 — Implicit Prompt-Time Indexed Recall       IMPLEMENTED / AWAITING REVIEW
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

## 4.1 Stage A — Deterministic baseline — COMPLETE / REVIEW PASS / FROZEN

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

## 4.2 Stage B1 — Retrieval Precision & Abstention — REVIEW PASS / FROZEN

**Normative execution spec:** [`P6_STAGE_B_RETRIEVAL_SPEC.md`](./P6_STAGE_B_RETRIEVAL_SPEC.md)

B1 is the frozen retrieval-quality change.

It targets:

```text
broad lexical false positives
missing abstention
ranking precision
generic key-token overlap
```

B1 should first improve the existing deterministic lexical policy rather than jump directly to embeddings/vector search.

Implemented shape:

```text
accepted Stage A machine-readable snapshot
→ provider-neutral field-aware lexical scoring
→ explicit relevance/abstention gate
→ deterministic candidate eval
→ before/after report
→ code/quality review
```

B1 must preserve accepted Stage A ground-truth labels and hard correctness invariants.

The CR-PHASE10-hardened candidate meets the local delta gate: P@1/R@1 remain at
the accepted 0.727273/0.681818 baseline, the negative-query false-positive rate
falls to 0, and abstention rises to 1. The committed comparison and detailed limitations are in
[`quality/P6_STAGE_B1_RESULT.md`](./quality/P6_STAGE_B1_RESULT.md).

B1 completed reviewer approval and is frozen. Its production retrieval behavior
is the non-regression baseline for B2.

## 4.3 Stage B2 — Extraction Generalization & Transient Rejection — COMPLETE / REVIEW PASS / FROZEN

B2 is implemented under [`P6_STAGE_B2_EXTRACTION_SPEC.md`](./P6_STAGE_B2_EXTRACTION_SPEC.md),
with the B2.1 durability/eval hardening governed by
[`P6_STAGE_B2_DURABILITY_EVAL_HARDENING_SPEC.md`](./P6_STAGE_B2_DURABILITY_EVAL_HARDENING_SPEC.md).
B2 completed final review at `e0ff2ac0248920c7c853162e4ea2f09dd2b7d260`
and is frozen. Its reviewed changes are limited to deterministic checkpoint
extraction, transient rejection, and extraction evaluation.

The next phase state is:

```text
B3 — Core / Handoff Pollution Policy COMPLETE / REVIEW PASS / FROZEN
B4 — Semantic Retrieval / Dedup DEFERRED TO V2
```

## 4.4 Stage B3 — Core / Handoff Pollution Policy — COMPLETE / REVIEW PASS / FROZEN

The reviewed normative spec is
[`P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md`](./P6_STAGE_B3_CORE_HANDOFF_POLICY_SPEC.md).
It freezes the B2 Core/Handoff before-state and governs the implemented small
deterministic admission/inclusion policy plus the B3-specific comparison
contract. Reviewed evidence is recorded in
[`quality/P6_STAGE_B3_RESULT.md`](./quality/P6_STAGE_B3_RESULT.md). The policy,
working-state provenance hardening, and deterministic comparison gates passed
final review and are frozen.

## 4.5 Stage B4 — Semantic Retrieval / Dedup — DEFERRED TO V2

B4 is an evaluated deferral, not unfinished P6 work. ADR 0004 records the
decision: deterministic v1 quality goals are complete, while the remaining
semantic wording mismatches and unkeyed duplicates are known limitations.
Current evidence does not show that embedding/vector infrastructure is worth
its storage, migration, privacy, offline, model-governance, and operational
complexity. Semantic retrieval and consolidation will be reconsidered for v2
only with representative dogfooding evidence and a separately reviewed design.

See [`adr/0004-semantic-recall-options-after-b1.md`](./adr/0004-semantic-recall-options-after-b1.md).

Changing corpus creation and search ranking in the same stage is intentionally avoided so quality deltas remain attributable.

If B1 demonstrates that remaining retrieval failures have effectively no lexical overlap, write an architecture decision before adding embeddings/vector infrastructure.

---

# 5. P7 — Implicit Prompt-Time Indexed Recall

**Normative spec:** [`P7_IMPLICIT_RECALL_SPEC.md`](./P7_IMPLICIT_RECALL_SPEC.md)

P7 closes the model-behavior gap where durable Indexed Memory existed but a
provider did not independently decide to call an MCP recall tool. Trusted
`UserPromptSubmit` middleware now performs bounded exact-key recall by default,
with project-selectable `off` and `lexical` modes.

The implementation preserves the disclosure model:

```text
Core -> bootstrap
Indexed -> implicit prompt-time recall or explicit MCP recall
current repository/runtime/user evidence -> authoritative on conflict
```

Codex and Claude Code passed both the isolated native capability spike and the
real production bridge smoke. Deterministic fixture/eval evidence is recorded
in [`quality/P7_IMPLICIT_RECALL_RESULT.md`](./quality/P7_IMPLICIT_RECALL_RESULT.md).
Independent code review remains before P7 can be marked complete/frozen.

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

P6 closes after the reviewed and frozen B3 policy. B4 is deferred to v2 and is
not a missing v1 deliverable.
