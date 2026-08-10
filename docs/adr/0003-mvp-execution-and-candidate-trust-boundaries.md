# ADR 0003: MVP checkpoint execution and candidate trust boundaries

- Status: accepted for MVP
- Date: 2026-08-10

## Context

The MVP proves durable Cross-Session Handoff with an in-process `MemorySpace`, an injected extractor, and a durable store. It deliberately does not provide distributed checkpoint ownership or Provider adapters. Those omissions create two boundaries that must be explicit before later integrations are added.

## Decision 1: one active checkpoint executor per durable store

MVP checkpoint execution assumes one active `MemorySpace` process per durable store.

Database uniqueness guarantees that `sessionId + idempotencyKey` identifies one durable checkpoint row. The in-process in-flight map guarantees that duplicate calls in the same `MemorySpace` instance share one Promise and one extraction operation. Neither mechanism guarantees single extraction across independent processes using the same store.

Running multiple active checkpoint executors against one durable store is therefore outside the MVP correctness contract. A future multi-process deployment must introduce explicit distributed execution ownership, such as a lease design, before claiming single execution. This ADR does not select or implement that design.

## Decision 2: Provider evidence is not a privileged memory command

Provider-normalized events are evidence/input. They are not automatically trusted memory commands and must not directly exercise privileged Core-promotion semantics.

The trust categories are:

- **Raw or Provider evidence:** untrusted event content. Candidate-shaped fields such as `recommendedTier: "core"` are data, not instructions.
- **Trusted explicit memory command:** an application command admitted through a future trusted adapter and its policy boundary. It must use the public memory lifecycle rules.
- **Extractor-generated candidate:** output from the configured internal `MemoryExtractor`. The application still validates provenance, operation, type eligibility, promotion reason, capacity, and final tier.
- **User-authoritative action:** an explicit action asserted by a trusted application boundary. Provider or Agent payloads cannot self-declare this authority.

A future Provider adapter must normalize Provider payloads into `SessionEvent` evidence first. If it wants to produce candidate-like commands, it must cross a separate, explicit trust and policy boundary; copying structured Provider fields into trusted extractor output is forbidden.

## Consequences

The MVP retains its process-local single-execution guarantee and internal extractor trust model without adding distributed coordination, Provider integration, or auth. Future implementations cannot infer either multi-process checkpoint safety or privileged candidate authority from the current ports alone.
