# ADR 0001: TypeScript modular monolith with zero runtime dependencies

- Status: accepted for MVP
- Date: 2026-08-10

## Context

The frozen specifications intentionally leave the server framework, ORM, and database implementation open. The MVP must prove cross-session handoff, transactional checkpoint boundaries, durable storage, and deterministic recall without pre-building distributed infrastructure.

## Decision

Use a TypeScript/Node.js 22 modular monolith and the runtime's built-in SQLite driver.

- `MemorySpace` is the application/domain API and depends on an asynchronous `MemoryStore` port.
- SQLite is the zero-configuration default `MemoryStore` adapter with versioned migrations.
- A future PostgreSQL adapter will implement the same store and transaction port; PostgreSQL is not required to run the MVP.
- Redis is represented by a separate asynchronous `CachePort`. It may cache bootstrap results or coordinate future work, but it is never the durable source of truth.
- The checkpoint's candidate commit, handoff snapshot, and session boundary advance share one database transaction.
- The extractor is injected through an isolated `extract(events, context)` port.
- A thin HTTP adapter exposes the MVP capability surface.
- Entity dates cross API boundaries as ISO-8601 strings. This is a reversible serialization choice, not a change to the domain's conceptual `Date` fields.
- Core capacity is a deterministic configurable limit (64 by default). Reaching it rejects promotion; automatic compaction remains out of scope.

## Consequences

The application has no runtime package dependencies or external service credentials. TypeScript and Node type definitions are development dependencies. SQLite can later be replaced behind the application API. Node's SQLite module is currently marked experimental, so a future production hardening slice should either pin a runtime or replace the adapter. Search uses deterministic lexical matching for the MVP; vector or hybrid retrieval is deferred.
