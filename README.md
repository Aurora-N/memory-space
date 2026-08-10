# memory-space

A cross-session memory layer for AI agents.

The MVP implements a durable, provider-independent memory layer that proves **Cross-Session Handoff inside the same Space**.

## What works

- Space-scoped Sessions and append-oriented normalized events
- explicit durable Memory, defaulting to Indexed
- Core promotion/demotion and deterministic fixed-template bootstrap
- retry-safe, transactional checkpoints with isolated candidate extraction
- keyed update/dedup with provenance and mutation history
- checkpoint-time Handoff Snapshots
- Space-isolated lexical search and structured agent context
- TypeScript application API plus a thin JSON HTTP adapter
- data-driven cross-agent handoff evaluation

## Run locally

Requires Node.js 22.13 or newer.

```bash
corepack enable
pnpm install
pnpm run check
cp .env.example .env
pnpm start
```

The server defaults to `http://127.0.0.1:4310` and persists to `./data/memory-space.db`. Environment values can be exported from `.env.example`; the server intentionally does not hide configuration loading inside the domain layer.

This repository is also a pnpm workspace. The current MVP remains the root package; future deployable applications belong in `apps/*`, reusable packages in `packages/*`, and repository tooling in `tools/*`. Shared toolchain versions use the workspace catalog. Run `pnpm run check:workspace` to execute each workspace package's `check` script when present.

```bash
curl -s -X POST http://127.0.0.1:4310/spaces \
  -H 'content-type: application/json' \
  -d '{"name":"My project"}'
```

See [`docs/API.md`](docs/API.md) for the full endpoint map and normalized checkpoint event examples.

## Architecture

The implementation is a TypeScript modular monolith. The application layer depends on two asynchronous ports:

- `MemoryStore` is the durable source-of-truth boundary. `SqliteMemoryStore` is the zero-configuration MVP adapter; a future PostgreSQL adapter can implement the same contract.
- `CachePort` is optional and defaults to a no-op. A future Redis adapter can cache bootstrap results without becoming the checkpoint consistency boundary.

Checkpoint memory mutations, snapshot creation, and event-boundary advancement commit in one store transaction. The rule-based extractor is also replaceable through `MemoryExtractor`.

Implementation choices are recorded in [`docs/adr/0001-zero-dependency-modular-monolith.md`](docs/adr/0001-zero-dependency-modular-monolith.md).

The MVP uses Node's built-in test runner; the decision and Vitest adoption triggers are recorded in [`docs/adr/0002-use-node-test-for-mvp.md`](docs/adr/0002-use-node-test-for-mvp.md).

The MVP's single-active-process checkpoint assumption and future Provider-to-candidate trust boundary are frozen in [`docs/adr/0003-mvp-execution-and-candidate-trust-boundaries.md`](docs/adr/0003-mvp-execution-and-candidate-trust-boundaries.md).

## Specs

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product goals, MVP scope, behaviors, success criteria, non-goals
- [`docs/DOMAIN_MODEL.md`](docs/DOMAIN_MODEL.md) — Space / Session / SessionEvent / Memory / Checkpoint / HandoffSnapshot contracts and invariants
- [`docs/MVP_PLAN.md`](docs/MVP_PLAN.md) — AI-coding-oriented vertical slices, acceptance criteria, test strategy, and implementation order

## Status

**MVP status: frozen after CR-PHASE2 hardening.**

**Domain contract: MVP v1 frozen.**

**Implementation status: MVP capability surface complete and covered by automated tests/eval.**
