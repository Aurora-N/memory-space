# memory-space

A cross-session memory layer for AI agents.

This repository is currently in the specification-first MVP phase. The goal of the first release is to prove that **Cross-Session Handoff works reliably inside the same Space**.

## Specs

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product goals, MVP scope, behaviors, success criteria, non-goals
- [`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md) — Space / Session / SessionEvent / Memory / Checkpoint / HandoffSnapshot contracts and invariants
- [`docs/MVP_PLAN.md`](docs/MVP_PLAN.md) — AI-coding-oriented vertical slices, acceptance criteria, test strategy, and implementation order

## Status

**Domain contract: MVP v1 frozen.**

Implementation details that are not explicitly frozen in the specs must not be invented silently by coding agents. Record them as an ADR/TODO or ask for a decision before introducing irreversible architecture.
