# ADR 0004: Semantic recall options after P6 Stage B1

- Status: Deferred pending a separate architecture review
- Date: 2026-08-12
- Context: P6 Stage B1 leaves two wording-mismatch queries unresolved

## Context

The B1 candidate improves top-rank lexical precision and negative-query
abstention without recall regression. Two positive failures remain because their
query and target Memory share effectively no useful lexical token. More weight or
a looser relevance threshold would not create missing evidence and would risk
reintroducing broad false positives.

Stage B1 does not authorize semantic retrieval. This ADR records the decision
surface required by the B1 spec; it does not select or implement a new system.

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
- Evidence needed: a separate B4 architecture/spec review and a candidate that
  preserves Space isolation, provenance, filters, abstention, and exact MCP/domain
  contracts.

### 3. No semantic change

Keep deterministic lexical search and require more explicit recall wording.

- Advantages: smallest system, predictable offline behavior, no new trust or
  storage boundary.
- Costs: known paraphrase misses remain.
- Evidence needed: user/product validation that explicit wording is acceptable.

## Decision

Stop after lexical B1 and defer the semantic-recall choice. No query expansion,
embedding, vector database, or reranker is authorized by this ADR.

If product evidence shows that the remaining misses are material, request a
separate architecture review comparing options 1–3 against a broader independent
benchmark before implementation.
