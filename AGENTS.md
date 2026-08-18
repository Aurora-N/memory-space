# AGENTS.md

This file defines the repository-wide working contract for coding agents. More specific `AGENTS.md`
files may refine these rules for a subtree, but may not weaken frozen product or protocol contracts.

## Mission and invariants

Memory Space is a provider-neutral persistent memory layer for coding agents. Preserve these invariants:

- SQLite is the zero-configuration source of truth. PostgreSQL and Redis remain adapter seams; Redis is
  never authoritative.
- CLI, HTTP, MCP, lifecycle hooks, and the inspector enter through one composed `MemorySpace` instance.
  Delivery code must not open SQLite or depend directly on `MemoryStore`.
- Provider payloads are normalized at provider boundaries. Provider-specific shapes must not leak into
  the domain or application layers.
- The MCP contract has exactly six tools. Do not add provider aliases or a seventh tool without an
  explicitly approved contract change.
- Cache operations are best-effort derived state. A cache failure must not make a source-of-truth
  operation fail.
- Space resolution remains `cwd -> nearest ancestor binding wins`; local initialization must distinguish
  an exact binding from an inherited binding.
- Preserve deterministic evaluation, idempotency, provenance, Space isolation, and fail-open lifecycle
  behavior.

Read the relevant specification before editing behavior. Product and domain contracts live in
`docs/PRODUCT_SPEC.md`, `docs/DOMAIN_MODEL.md`, and the active phase spec. Provider work must also follow
`docs/PROVIDER_INTEGRATION_GUARDRAILS.md`. Treat a phase marked frozen as change-controlled: do not alter
its production policy merely to improve a metric or simplify a new feature.

## Architecture boundaries

Dependency direction is inward:

```text
CLI / HTTP / MCP / provider hooks / inspector
                    |
              integration layer
                    |
             application services
                 /       \
             domain      ports
                           |
                       adapters
```

- `src/domain`: domain types, invariants, and errors; no imports from outer layers.
- `src/application`: use cases and deterministic policy; may depend only on domain and ports.
- `src/ports`: implementation-neutral boundaries. Do not expose SQLite, HTTP, MCP, or provider payloads.
- `src/adapters`: concrete persistence, extraction, and provider implementations.
- `src/integration`: lifecycle and orchestration across application-facing boundaries.
- `src/cli`, `src/http`, `src/mcp`: delivery only; validate/translate requests and call application or
  integration APIs.
- `src/composition.ts`: concrete wiring and ownership. New infrastructure belongs behind a port and is
  connected here.

Do not introduce import cycles. Do not bypass `MemorySpace` to reach storage from a delivery/provider
path. Keep transport validation at trust boundaries and never log secrets, tokens, headers, environment
values, or API keys.

## TypeScript and code style

- Prefer TypeScript for product code and typed interfaces at module boundaries.
- Use `unknown` at untrusted boundaries and narrow it explicitly. Avoid `any`; if a dynamic adapter API
  makes it unavoidable, keep it at that boundary and document the reason on the suppression.
- Prefer small, explicit functions and early returns. Name policy decisions; do not hide them in clever
  boolean expressions or benchmark-only sorting.
- Use `import type` for type-only dependencies.
- Keep async work bounded. Use parallelism only when operations are independent, ordering is irrelevant,
  and resource use has a clear limit. Do not fire-and-forget source-of-truth writes.
- Preserve errors that callers can act on. Fail open only where the specification says the subsystem is
  best-effort, and explain an intentionally empty catch block.
- Avoid unrelated refactors and whole-repository formatting in feature changes.

Biome is the formatting and general linting authority. The repository also has focused architecture and
comment-policy checks:

```bash
pnpm run lint
pnpm run lint:biome
pnpm run lint:architecture
pnpm run lint:comments
```

Format only files you intentionally changed, for example:

```bash
pnpm exec biome format --write path/to/changed-file.ts
```

Do not add another overlapping formatter or general-purpose linter without first removing the conflict
and documenting the migration.

## Comments and documentation

Write code comments in English so provider teams share one searchable vocabulary.

- Comment the reason, invariant, ownership boundary, or non-obvious tradeoff—not a restatement of code.
- Add concise JSDoc to new exported ports and public contracts. Document units, ordering, idempotency,
  failure behavior, and security-sensitive assumptions where relevant.
- Explain intentional fail-open catches and every lint or TypeScript suppression.
- Use `TODO(owner-or-issue): reason`, `FIXME(owner-or-issue): reason`, or
  `XXX(owner-or-issue): reason`; do not leave ownerless placeholders.
- Update the relevant spec, ADR, validation record, or integration guide when behavior or operator steps
  change. Never expose secrets in examples or diagnostics.

Comments are not a substitute for clear names, tests, or executable invariants. Remove stale comments
when the behavior changes.

## Testing and verification

Add regression tests for the failure being fixed and boundary/negative cases around it. Prefer testing
observable contracts over private implementation details. Keep fixtures deterministic: runtime IDs,
timestamps, filesystem locations, or logical fixture keys must not become hidden ranking signals.

Use the smallest focused test while iterating, then run the repository gates before handoff:

```bash
pnpm run check
pnpm run check:workspace
```

Run phase-specific quality evaluation or real-provider smoke commands when the changed specification
requires them. Do not claim GitHub CI, a real-provider smoke, review PASS, or frozen status unless that
evidence was actually observed and the governing document authorizes the status change.

## Change discipline

- Inspect the current branch, worktree, active spec, and review document before editing.
- Preserve user changes and keep commits scoped. Generated artifacts and dependency lockfiles belong in
  the same change only when the implementation requires them.
- Do not change frozen product/domain specs, storage semantics, lifecycle schemas, provider contracts, or
  evaluation ground truth as an incidental implementation detail.
- If requirements conflict or a choice would expand scope, stop and ask. Low scores or awkward legacy
  behavior are evidence to report, not permission to redefine a contract.
- At handoff, report files changed, behavior changed, tests run, results, and remaining limitations.
