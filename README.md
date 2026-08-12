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
- provider-neutral MCP command plane with six policy-bounded tools
- Codex and Claude Code lifecycle adapters sharing one provider-neutral integration core
- parameterized same-provider, cross-provider, restart, isolation, and multi-hop
  durable-memory evaluation

## Run locally

Requires Node.js 22.13 or newer.

```bash
corepack enable
pnpm install
pnpm run check
cp .env.example .env
pnpm start
```

The server defaults to `http://127.0.0.1:4310` and persists to `./data/memory-space.db`. The unauthenticated v1 daemon accepts only `127.0.0.1`, `::1`, or `localhost`; remote/LAN deployment is unsupported. Environment values can be exported from `.env.example`; the server intentionally does not hide configuration loading inside the domain layer.

This repository is also a pnpm workspace. The current MVP remains the root package; future deployable applications belong in `apps/*`, reusable packages in `packages/*`, and repository tooling in `tools/*`. Shared toolchain versions use the workspace catalog. Run `pnpm run check:workspace` to execute each workspace package's `check` script when present.

```bash
curl -s -X POST http://127.0.0.1:4310/spaces \
  -H 'content-type: application/json' \
  -d '{"name":"My project"}'
```

See [`docs/API.md`](docs/API.md) for the full endpoint map and normalized checkpoint event examples.

## Shared daemon and MCP command plane

`pnpm start` is the supported runtime. One daemon creates one `MemorySpace`/SQLite owner and serves both the existing HTTP API and the Streamable HTTP MCP endpoint:

```bash
MEMORY_SPACE_DB=./data/memory-space.db \
MEMORY_SPACE_CWD=/absolute/path/to/bound/project \
pnpm start
```

```text
HTTP API: http://127.0.0.1:4310/...
MCP:      http://127.0.0.1:4310/mcp
```

Providers must connect to the daemon MCP URL instead of spawning a database-owning MCP child process. Every daemon route except `GET /health` validates localhost Host and Origin values before routing to reduce DNS-rebinding exposure. JSON body endpoints require `Content-Type: application/json` before any mutation.

The provider-neutral `LifecycleHandler` is composed against the daemon's same
`MemorySpace`; Codex, Claude Code, REST, checkpoint orchestration, and the MCP
command plane therefore share the same in-process owner.

For no-Session read tools, `MEMORY_SPACE_SPACE_ID` is the highest-priority trusted explicit Space override. Otherwise, `MEMORY_SPACE_CWD` is the trusted directory used for nearest-ancestor `.memory-space/config.json` resolution; it defaults to daemon cwd only when not configured. One daemon endpoint therefore has one trusted no-Session project context. A supplied Session ID is always authoritative and cannot be rebound by either setting. Neither `cwd` nor `spaceId` is accepted as a tool argument.

Durable tools (`memory_remember`, `memory_promote`, and `memory_checkpoint`) always require a Session. The MCP surface is exactly `memory_bootstrap`, `memory_context`, `memory_search`, `memory_remember`, `memory_promote`, and `memory_checkpoint`. It intentionally exposes no raw CRUD or agent-controlled Space, tier, actor, or checkpoint-boundary fields.

Strict schema failures happen before tool execution and use the MCP SDK/protocol validation error. Inputs that pass schema validation but fail domain or integration execution return the stable `MemoryMcpError` structured envelope. Both are fail-visible; raw SQLite/internal details are never the intended public tool result.

An isolated stdio development mode remains available only with explicit opt-in:

```bash
MEMORY_SPACE_ALLOW_STANDALONE=1 \
MEMORY_SPACE_DB=/path/to/isolated-development.db \
pnpm mcp:standalone
```

Standalone mode owns its SQLite connection. Never point it at a database used by the daemon or another standalone process; it is not the supported provider runtime.

## Provider integrations

P2 supports Codex's native `SessionStart`, `UserPromptSubmit`, `Stop`,
`PreCompact`, and `SessionEnd` hooks through the daemon's local lifecycle
endpoint. The hook bridge captures conversation-lite evidence, injects
bootstrap context, checkpoints supported boundaries, and fails open when the
Memory service is unavailable. Codex connects to the same daemon over MCP for
explicit Memory commands.

Claude Code P3 implements the same provider-neutral lifecycle shape and uses the
same six-tool MCP command plane. Real Claude hook lifecycle/bootstrap behavior
has passed; real model-driven MCP execution is currently blocked by the active
compatibility gateway rewriting Claude MCP tool names. That external limitation
is recorded as a scoped progression waiver rather than a false PASS or a reason
to add Claude-only alias tools.

See [`docs/CODEX_INTEGRATION.md`](docs/CODEX_INTEGRATION.md) for Codex setup and
real-provider evidence.

See [`docs/CLAUDE_CODE_INTEGRATION.md`](docs/CLAUDE_CODE_INTEGRATION.md) for
Claude Code hook/MCP setup, lifecycle semantics, and the current real-provider
limitation.

P4 is defined in
[`docs/P4_CROSS_SESSION_PROVIDER_EVAL.md`](docs/P4_CROSS_SESSION_PROVIDER_EVAL.md).
It expands the product proof from one Codex→Claude path to same-provider,
cross-provider, multi-hop, restart, Space-isolation, progressive-disclosure, and
provenance validation.

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
- [`docs/PROVIDER_INTEGRATION_GUARDRAILS.md`](docs/PROVIDER_INTEGRATION_GUARDRAILS.md) — normative provider/runtime implementation constraints
- [`docs/P4_CROSS_SESSION_PROVIDER_EVAL.md`](docs/P4_CROSS_SESSION_PROVIDER_EVAL.md) — normative P4 cross-session and cross-provider durable-memory eval

## Status

**MVP status: frozen after CR-PHASE2 hardening.**

**Domain contract: MVP v1 frozen.**

**Implementation status: MVP capability surface complete and covered by automated tests/eval.**

**Provider Integration P0: FROZEN. MCP Command Plane P1: FROZEN after CR-PHASE4.**

**Codex P2: FROZEN after the recorded real-Codex CLI smoke.**

**Claude Code P3: implementation, automated validation, code review, and real
hook lifecycle PASS. Real model-driven MCP execution remains externally blocked;
P3 is ACCEPTED WITH A SCOPED PROGRESSION WAIVER and is not represented as fully
FROZEN.**

**P4 implementation: COMPLETE. Automated cross-session/cross-provider eval:
PASS. Code review: pending.**

P4 proves Codex→Codex, Claude→Claude, Codex→Claude, Claude→Codex, and
Codex→Claude→Codex→Claude continuity through distinct provider Sessions and
SQLite reopen while preserving progressive disclosure, provenance, Space
isolation, Handoff advancement, and the exact shared six-tool command plane.

Real Codex evidence: [`docs/validation/CODEX_P2_SMOKE.md`](docs/validation/CODEX_P2_SMOKE.md).
Claude hook/MCP blocker evidence: [`docs/validation/CLAUDE_P3_SMOKE.md`](docs/validation/CLAUDE_P3_SMOKE.md).
