# ADR 0004: Defer semantic memory to v2

- Status: Accepted
- Initial analysis: 2026-08-12
- Decision date: 2026-08-17
- Decision: DEFER semantic memory to v2
- Scope: Semantic retrieval, semantic consolidation/dedup, embeddings, and vector infrastructure

## Context

P6 Memory Quality v1 now has an accepted deterministic baseline plus frozen B1
retrieval, B2 extraction, and B3 Core/Handoff policies. The reviewed suite meets
the v1 deterministic quality goals and preserves the product's offline,
provider-neutral, explainable behavior.

Two capability limits remain visible:

- queries and relevant Memory with effectively no useful shared lexical wording
  may still miss;
- unkeyed semantic paraphrases may remain as duplicate Memory.

These are known limitations, not correctness failures hidden by the evaluator.
The current fixtures establish that the limits exist, but do not establish their
frequency or product impact under real use. They also do not prove that an
embedding model, vector index, or semantic consolidation pipeline would deliver
enough benefit to justify its new complexity and trust boundaries.

## Options

### 1. Lightweight deterministic query expansion

Expand a small, reviewed provider-neutral vocabulary before lexical scoring.

- Advantages: offline, deterministic, no new database or model dependency.
- Costs: synonym ownership and multilingual coverage become product policy;
  unreviewed expansion can silently broaden false positives.
- Evidence needed: independent expansion fixtures and a strict abstention
  non-regression gate.

### 2. Hybrid embedding plus lexical retrieval

Retrieve through both lexical and vector evidence, then combine their scores.

- Advantages: strongest candidate for paraphrases with no token overlap.
- Costs: embedding model/version governance, vector index/storage, migrations,
  privacy, offline behavior, deterministic evaluation, and operational ownership.
- Evidence needed: a separate v2 architecture/spec review and a candidate that
  preserves Space isolation, provenance, filters, abstention, and exact MCP/domain
  contracts.

### 3. Keep deterministic v1 and defer semantic memory

Keep deterministic lexical search and require more explicit recall wording.

- Advantages: smallest system, predictable offline behavior, no new trust or
  storage boundary.
- Costs: known paraphrase misses remain.
- Evidence needed: real dogfooding data that measures how often lexical misses or
  unkeyed duplicates materially harm continuation and recall.

## Decision

**Decision: DEFER semantic memory to v2.**

P6 Memory Quality v1 is COMPLETE / REVIEW PASS / FROZEN after Stage B3. Stage B4
Semantic Retrieval / Dedup is not a missing v1 deliverable; it is deliberately
deferred.

The decision is based on four facts:

1. The deterministic v1 quality goals are complete and reviewed.
2. Semantic wording mismatch and unkeyed duplicates are explicitly recorded
   limitations with stable benchmark evidence.
3. Current evidence is insufficient to show that embedding/vector
   infrastructure is worth its storage, migration, privacy, offline,
   model-version, evaluation, and operational complexity.
4. Semantic retrieval and consolidation should be driven by representative
   dogfooding data rather than benchmark speculation.

Therefore v1 adds no query expansion, synonym dictionary, embedding model,
vector database, semantic reranker, or automatic semantic consolidation. The
existing deterministic lexical retrieval, stable-key deduplication, provenance,
Space isolation, and exact MCP/domain contracts remain frozen.

## Consequences

- Future readers should treat B4 as evaluated and deferred, not abandoned or
  accidentally unfinished.
- Known lexical wording misses and unkeyed duplicates remain visible in quality
  reports and product documentation.
- v1 keeps zero-config SQLite operation, deterministic offline evaluation, and
  explainable retrieval behavior without a new model/index lifecycle.
- No v2 semantic design is preselected; deterministic expansion, hybrid
  retrieval, and no semantic layer remain options to compare against evidence.

## Revisit criteria for v2

Reopen this decision only when real dogfooding provides representative evidence
for at least one of these outcomes:

- recurring lexical misses materially break cross-session continuation or
  explicit recall;
- unkeyed duplicates materially pollute bootstrap, Handoff, or user-visible
  search results;
- a candidate semantic approach demonstrates a meaningful improvement on an
  independent fixture set without regression in abstention, Space isolation,
  provenance, determinism, privacy, or offline operation.

Any v2 implementation requires a separate architecture/spec review covering
model and version ownership, vector/storage migration, data retention, failure
modes, evaluation determinism, and rollback.
