# P5 — Productization Spec

**Status:** CR-PHASE8 fixes implemented; awaiting re-review
**Phase:** P5  
**Depends on:** Provider Integration P0–P4 complete at their recorded acceptance levels  
**Related:** `V1_ROADMAP.md`, `PROVIDER_INTEGRATION_GUARDRAILS.md`, `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`

> P5 improves local product usability. It MUST NOT silently change the frozen Memory product/domain semantics.

---

## 1. Objective

Make the proven local Memory Space workflow practical to initialize, diagnose, inspect, and demonstrate.

Today a developer may need to manually combine:

```text
start daemon
create Space through REST
write .memory-space/config.json
inspect provider hook/MCP config
check daemon/MCP health
run eval commands separately
```

P5 should turn those steps into a small, safe CLI/developer experience without creating another database owner or privileged backdoor.

Required user-facing capabilities:

```text
memory-space init
memory-space doctor
memory-space status
memory-space eval cross-session
```

Names may be adapted only if repository conventions strongly require it; equivalent capabilities are mandatory.

---

# 2. Architectural constraints

## 2.1 CLI is a client, not another durable-store owner

Normal P5 commands MUST NOT directly open the same SQLite database as the running daemon.

Supported topology remains:

```text
CLI / provider / developer
        ↓
loopback daemon
        ↓
one MemorySpace
        ↓
one SQLite owner
```

If a command needs durable state, prefer the existing local daemon API/application boundary.

Do not solve convenience by introducing a second long-lived `MemorySpace` process.

## 2.2 Frozen domain semantics remain unchanged

P5 must not change:

- Space/Session/Memory ownership;
- Core vs Indexed semantics;
- checkpoint/Handoff semantics;
- provider Session identity rules;
- exact six MCP tool contract;
- lifecycle fail-open / MCP fail-visible behavior.

## 2.3 No remote/auth expansion

P5 remains local-first and loopback-only.

Do not add:

- LAN binding;
- remote sync;
- accounts/team auth;
- hosted control plane;
- cloud database migration.

## 2.4 Human CLI authority is distinct from agent authority

A local developer CLI may display or manage trusted project binding information that must never become an agent-controlled MCP field.

Do not expose CLI conveniences such as `spaceId` as new MCP arguments.

---

# 3. `memory-space init`

## 3.1 Goal

Initialize a project for Memory Space safely and idempotently.

Conceptual flow:

```text
resolve target cwd
→ inspect existing nearest/project binding
→ verify daemon availability
→ create or select local Space
→ write .memory-space/config.json
→ report next provider configuration steps
```

## 3.2 Required behavior

At minimum support initialization of the current/explicit project directory.

The command should:

1. detect an existing `.memory-space/config.json` at the target project;
2. refuse to silently replace a conflicting binding;
3. be idempotent when the same intended binding already exists;
4. create the Space through the supported daemon/application boundary when creation is requested;
5. write the v1 binding shape:

```json
{
  "version": 1,
  "spaceId": "..."
}
```

6. use atomic/safe file replacement where practical;
7. never place credentials in the binding file;
8. print the exact next steps for Codex/Claude configuration rather than silently rewriting global provider config by default.

## 3.3 Conflict policy

Examples:

```text
existing same binding
→ success / already initialized

existing different binding
→ visible conflict
→ no overwrite without an explicit human-only force/rebind action

malformed binding
→ visible validation error
→ preserve original file
```

If a force/rebind option is introduced, it must be explicit and must remain a human CLI operation, not an MCP capability.

## 3.4 Required tests

- empty project initializes successfully;
- same initialization is idempotent;
- conflicting existing binding is not overwritten;
- malformed existing config is preserved/reported;
- daemon unavailable produces a useful failure;
- Space creation failure does not leave a misleading binding file;
- paths with spaces/non-ASCII characters work where supported by Node/platform behavior.

---

# 4. `memory-space doctor`

## 4.1 Goal

Answer the operational question:

> Why is Memory Space not working in this project?

Doctor is diagnostic and should be primarily read-only.

## 4.2 Required checks

For the target cwd, report at least:

```text
Daemon reachable
Daemon loopback endpoint
Project binding file found
Binding config valid
Nearest binding source/path
Bound Space exists
MCP endpoint reachable
Exact six Memory MCP tools discoverable
Codex integration config detected / not detected / ambiguous
Claude Code integration config detected / not detected / ambiguous
Known Claude real-MCP waiver status/documentation pointer
```

Provider config detection should be best-effort and provider-local. Do not parse arbitrary secrets or print credentials.

## 4.3 Output model

Human output should be concise, for example:

```text
Daemon            OK
Binding           OK  my-project
Space             OK
MCP               OK  6/6 tools
Codex             OK
Claude Code       WARN  hook config found; real MCP gateway compatibility is environment-dependent
```

Also provide a machine-readable mode if practical, e.g. `--json`.

A stable result model is preferred:

```ts
interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "error";
  message: string;
  remediation?: string;
}
```

The exact type is not frozen; preserve deterministic check IDs if introduced.

## 4.4 Exit codes

Use predictable semantics:

```text
0 → no blocking errors
non-zero → one or more blocking checks failed
```

Warnings alone should not necessarily make the command fail unless they prevent the requested workflow.

## 4.5 Security

Doctor MUST NOT print:

- auth tokens;
- raw environment secrets;
- complete transcripts;
- raw SQLite errors containing private paths when a safe message exists.

---

# 5. `memory-space status`

## 5.1 Goal

Provide a concise snapshot of the currently bound local Memory Space without requiring raw REST calls or database inspection.

## 5.2 Minimum useful status

For the current project binding, report available values such as:

```text
Daemon status
Space id/name
binding source
active/durable Session count if already exposed safely by application API
Memory counts by tier/status if available without breaking boundaries
latest checkpoint metadata
latest Handoff metadata
configured provider integration hints
```

Do not add raw CRUD/admin APIs solely to satisfy a status screen.

If a value is not exposed by an appropriate application/read boundary, either add the smallest read-only application operation with tests or omit that field from v1 status.

Do not reach through `MemorySpace.store` from the CLI.

## 5.3 Human vs model surfaces

The human CLI may display the trusted Space identifier. This does not change the MCP policy that agents cannot choose `spaceId`.

---

# 6. `memory-space eval cross-session`

## 6.1 Goal

Make the strongest existing product proof easy to run and demo.

Reuse the P4 deterministic evaluation rather than reimplementing its semantics.

Desired one-command result:

```text
Codex → Codex                  PASS
Claude → Claude                PASS
Codex → Claude                 PASS
Claude → Codex                 PASS
Multi-hop                      PASS
SQLite reopen                  PASS
Space isolation                PASS
Progressive recall             PASS
Provenance preservation        PASS
Exact-six MCP                  PASS
```

## 6.2 Reuse requirement

Do not copy hundreds of lines of P4 eval logic into a CLI command.

Extract/reuse a provider-neutral eval runner only when doing so improves maintainability and keeps tests using the same assertions.

Acceptable shapes include:

```text
shared eval runner
├── node:test wrapper
└── CLI wrapper
```

or a documented package script that runs the canonical eval and emits a concise summary.

The command must not claim real Claude model-driven MCP PASS; that remains a separate external acceptance item.

---

# 7. CLI structure

Prefer the smallest repository-consistent implementation.

Possible shape:

```text
src/cli/
├── main.ts
├── init.ts
├── doctor.ts
├── status.ts
└── eval.ts
```

or fewer files if simpler.

Do not add a heavyweight CLI framework unless it materially reduces complexity. Node built-ins and existing dependencies are preferred.

If package `bin` metadata or a local wrapper script is introduced, ensure development invocation is documented and testable.

---

# 8. HTTP/application usage

CLI commands should use stable local client helpers rather than scattering raw `fetch()` calls and error parsing throughout commands.

A small client boundary is acceptable, for example:

```ts
LocalMemorySpaceClient
```

It should:

- target loopback-only daemon URLs by default;
- require JSON media types for writes;
- translate stable HTTP/domain error envelopes;
- never silently retry non-idempotent writes;
- avoid owning provider lifecycle behavior.

Do not create a second public domain model in the CLI client.

---

# 9. Tests

P5 is not complete with CLI snapshot tests alone.

Required coverage should include:

```text
init success/idempotency/conflict
binding file safety
daemon unavailable
Space creation rollback ordering
doctor healthy state
doctor broken binding
doctor MCP mismatch
status bound/unbound behavior
machine-readable output if implemented
eval command reuses/preserves P4 proof
no second durable-store owner
no exact-six MCP regression
```

Use temporary directories/databases and loopback daemon instances.

Do not modify real user Codex/Claude configuration in tests.

---

# 10. Documentation and demo UX

Update at least:

```text
README.md
.env.example if new local config is introduced
provider integration docs where setup steps change
V1_ROADMAP.md
```

README should gain a short quickstart that prefers the productized commands over manual REST/binding steps once they exist.

Keep manual low-level instructions available for debugging/reference.

---

# 11. Non-goals

Do not implement in P5:

- web dashboard;
- desktop app;
- hosted service;
- remote auth/team sync;
- vector retrieval;
- embeddings;
- automatic global provider config rewriting by default;
- provider-event dedup architecture;
- new Memory tiers;
- new MCP tools;
- Memory quality algorithm changes.

Memory quality belongs to P6.

---

# 12. Completion gate

Before requesting P5 review, report:

1. CLI entrypoint/usage;
2. `init` behavior and conflict policy;
3. `doctor` checks and exit-code semantics;
4. `status` fields and read boundaries used;
5. one-command P4 eval behavior;
6. any new application/read API introduced and why;
7. proof that CLI does not become a second SQLite owner;
8. tests added;
9. `pnpm run check` result;
10. `pnpm run check:workspace` result;
11. docs updated;
12. P3 Claude real-MCP waiver remains unchanged/resolved status.

P5 ends after code review. Do not start Memory Quality implementation in the same pass unless explicitly requested.

---

# 13. Implementation evidence

P5 adds a real TypeScript CLI entrypoint at `src/cli/main.ts` and a thin
`LocalMemorySpaceClient` at `src/cli/local-client.ts`.

Supported invocation:

```bash
pnpm memory-space init --cwd /absolute/path/to/project --name "My project"
pnpm memory-space doctor --cwd /absolute/path/to/project
pnpm memory-space doctor --cwd /absolute/path/to/project --json
pnpm memory-space status --cwd /absolute/path/to/project
pnpm memory-space eval cross-session
```

`init`, `doctor`, and `status` communicate only with the loopback daemon over
HTTP/MCP. They do not import or construct `MemorySpace`/`SqliteMemoryStore`.
No new read API was required: status uses existing health, Space, and latest
Handoff endpoints, deriving the latest checkpoint ID from the Handoff.

Binding creation uses an atomic no-clobber write after daemon Space creation or
confirmation. Existing equal bindings are idempotent; conflicting/malformed
bindings are preserved and reported. Global provider configuration is never
modified.

`eval/cross-session-provider-memory.test.ts` and the CLI both reuse
`eval/support/cross-session-runner.ts`, preserving the complete P4 matrix,
multi-hop, restart, isolation, progressive-disclosure, provenance, binding,
checkpoint-noop, and exact-six assertions. Its temporary SQLite database is
isolated from daemon state.

Recorded local validation on 2026-08-12:

```text
pre-change pnpm run check           PASS — 80/80
pre-change pnpm run check:workspace PASS — 80/80
```

Final local verification on 2026-08-12:

```text
pnpm run check           PASS — 93/93
pnpm run check:workspace PASS — 93/93
```

CR-PHASE8 hardening verification on 2026-08-12:

```text
focused CLI tests         PASS — 17/17
pnpm run check            PASS — 98/98
pnpm run check:workspace  PASS — 98/98
Codex P2 runner self-test PASS
Claude P3 runner self-test PASS
```

The hardening pass adds structured Claude scope detection for project, local,
and user configuration and separates exact local init bindings from inherited
nearest bindings. Manual smoke confirmed user-scoped Claude MCP plus project
local hooks, inherited nested resolution without a shadow file, an explicit
nested Space override, unchanged root resolution, and the canonical
cross-session eval. The implementation is awaiting CR-PHASE8 re-review; this
does not mark P5 code review as PASS.

The manual CLI smoke used one isolated loopback daemon and a temporary project:

```text
doctor before init       expected non-zero / actionable binding errors
init                     PASS
repeated init            PASS / idempotent
doctor after init        PASS with provider/Claude-waiver warnings
status                   PASS
eval cross-session       PASS
```

GitHub CI was not independently confirmed. P3 real Claude model-driven MCP
remains externally blocked / waived and is not reported as PASS.
