# CR-PHASE4 — Provider Integration P1 Runtime Hardening

**Target branch:** `agent/provider-integration-v1`  
**Scope:** P1 MCP runtime/composition hardening before P2 Codex integration  
**Base reviewed head:** `3c2c9cc97f9216596a2928eb9b2ba1dce4cce850`  
**Status:** Action required before P2  

---

## 1. Review conclusion

Provider Integration P0 is considered frozen. The logical P1 MCP Command Plane is also substantially correct:

- exactly six intended MCP domain tools are registered;
- strict schemas reject privileged/unknown fields;
- read tools resolve Space through Session or project binding;
- durable tools require Session;
- `memory_remember` derives Space/provenance from Session and cannot create Core directly;
- `memory_promote` fixes `actor = agent` and checks Session-Space ownership;
- `memory_checkpoint` routes through shared `CheckpointPolicy` and hides checkpoint boundary controls;
- Core + Indexed progressive recall and cross-Space isolation are covered by tests;
- stable tool-level error translation exists for domain/infrastructure failures.

Do **not** redesign or expand the six-tool contract in this phase.

The remaining problems are runtime/composition problems. They must be fixed before a real Codex/Claude integration is added, otherwise provider processes may violate the frozen single-owner durable-store invariant.

The required architecture remains:

```text
                 Agent Providers
             Codex / Claude / Cursor
                 /             \
                /               \
       Lifecycle Plane       MCP Plane
                \               /
                 \             /
               one memory-space daemon
                         |
                  one MemorySpace
                         |
                      SQLite
```

The daemon must be the only durable-store owner for a configured local database.

---

# 2. FIX-01 — Restore the single-owner runtime invariant

**Priority:** P1 blocker before P2  
**Category:** Runtime composition / persistence ownership

## Problem

The frozen Provider Integration spec states that the MVP supports:

```text
one active MemorySpace process per durable store
```

and explicitly does **not** support multi-process durable-store coordination.

The current runtime exposes two independent entrypoints that can each create their own `MemorySpace` against the same SQLite path:

```text
pnpm start
→ HTTP server
→ createDefaultMemorySpace()
→ SQLite
```

and:

```text
pnpm mcp
→ stdio MCP server
→ createDefaultMemorySpace()
→ SQLite
```

This becomes dangerous as soon as real providers are configured. A normal stdio MCP configuration may spawn one child process per provider/client, producing:

```text
Codex → stdio MemorySpace process ─┐
                                  ├→ same SQLite
Claude → stdio MemorySpace process ┘
```

That violates the current concurrency model and undermines checkpoint/session ownership assumptions.

## Required invariant

For a configured durable local database:

```text
one daemon process
→ one MemorySpace instance
→ one SQLite owner
```

Both lifecycle integration and the shared MCP command plane must reuse that same `MemorySpace` instance.

Do not add distributed locks, leases, multi-process checkpoint ownership, or a second SQLite coordination design in this phase.

## Required implementation direction

Refactor runtime composition so the normal production/local integration path is conceptually:

```text
start memory-space daemon
        |
        ├── REST / lifecycle endpoints
        |
        └── MCP transport endpoint
                |
            same MemoryMcpGateway
                |
            same MemorySpace
```

The intended local shape remains compatible with:

```text
http://127.0.0.1:4310/...
http://127.0.0.1:4310/mcp
```

Use the installed MCP SDK's supported HTTP/Streamable HTTP server transport rather than inventing a custom protocol. Follow the installed package typings/API for the exact transport integration.

### Composition requirement

There should be one composition/root ownership point that creates:

```ts
const memorySpace = createDefaultMemorySpace(...)
```

and injects it into both:

```text
HTTP/lifecycle handlers
MCP server/gateway
```

Avoid separate composition roots that independently open the same database.

## Stdio policy

The current `src/mcp/stdio.ts` must not remain a second normal durable-store owner.

Choose one of the following safe outcomes:

### Preferred

```text
stdio client/proxy
→ shared daemon MCP endpoint
→ daemon-owned MemorySpace
```

The stdio process owns no SQLite database.

### Acceptable for P1 if a proxy is disproportionate

Remove/de-emphasize the stdio entrypoint from the supported shared-runtime path and document it as an explicitly isolated **standalone development mode** that must not run concurrently with the daemon or another stdio instance against the same DB.

However, P2 provider integration must use the shared daemon path, not multiple database-owning stdio child processes.

Do not describe a database-owning stdio child process as the "shared MCP server".

## Required tests

Add a composition/integration test that proves the normal daemon path constructs/injects one `MemorySpace` instance for HTTP/lifecycle-facing behavior and MCP-facing behavior.

The test does not need to inspect private object identity if the public composition API makes that awkward; it may prove the invariant through an injected/fake `MemorySpace` or factory call counter.

At minimum verify:

1. daemon composition creates the durable `MemorySpace` once;
2. MCP requests and HTTP/domain operations observe the same in-process state;
3. normal shared runtime does not launch another SQLite-owning MCP process;
4. shutdown closes the shared `MemorySpace` once.

Preserve all existing SQLite/provider-session/checkpoint concurrency tests.

---

# 3. FIX-02 — Implement trusted runtime `explicitSpaceId` override

**Priority:** Required contract completion before P2  
**Category:** Space resolution / trusted runtime context

## Problem

The frozen resolution contract is:

```text
sessionId supplied
→ Session.spaceId authoritative
→ cwd/override cannot rebind the Session

sessionId absent
→ trusted explicit Space override
→ otherwise nearest ancestor .memory-space/config.json
```

Current `MCPRequestContextResolver` supports Session and cwd resolution, but the MCP runtime does not expose a trusted `explicitSpaceId` configuration path.

Do **not** solve this by adding `spaceId` to any MCP tool input.

## Required invariant

Agent-controlled tool arguments must still never contain `spaceId`.

Trusted runtime configuration may provide an explicit Space override:

```text
runtime/config explicitSpaceId ✅
MCP tool argument spaceId      ❌
```

Session always wins:

```text
sessionId present
→ Session.spaceId
→ ignore cwd / explicitSpaceId for rebinding purposes
```

No Session:

```text
explicitSpaceId present
→ resolve that Space

else
→ nearest ancestor binding from trusted cwd
```

## Recommended shape

A shape similar to the following is acceptable:

```ts
interface MCPRuntimeContext {
  cwd?: string;
  explicitSpaceId?: string;
}
```

or constructor options:

```ts
createMemoryMcpServer({
  memorySpace,
  cwd,
  explicitSpaceId
})
```

Then call the existing `SpaceResolver` using both trusted values.

Do not duplicate Space binding logic inside MCP code.

## Required tests

Add tests for:

1. no Session + explicitSpaceId → explicit Space selected;
2. no Session + explicitSpaceId conflicting with cwd binding → explicit Space wins;
3. Session + conflicting explicitSpaceId → Session Space wins;
4. Session + conflicting cwd → Session Space wins;
5. tool schemas still do not expose `spaceId`.

---

# 4. FIX-03 — Define schema-validation error behavior instead of accidentally promising one envelope

**Priority:** P2 non-blocking, but must be decided/documented in this hardening pass  
**Category:** MCP public error semantics

## Problem

Domain/tool execution errors flow through:

```text
MemoryMcpGateway operation
→ execute()
→ failedResult()
→ MemoryMcpError envelope
```

This correctly hides raw SQLite/internal failures.

Strict MCP/Zod schema failures occur before the gateway operation is executed. Existing tests only prove that invalid privileged inputs are rejected; they intentionally accept either a thrown protocol validation failure or an `isError` result.

Therefore the implementation currently proves:

```text
invalid input is rejected
```

but does not prove:

```text
all validation errors use MemoryMcpError
```

Trying to force SDK-level schema failures through the custom envelope may add unnecessary protocol plumbing.

## Required decision

For P1, adopt and document this boundary unless there is already a clean SDK-supported hook:

```text
MCP protocol/schema validation failure
→ MCP SDK/protocol validation error

valid schema + domain/integration execution failure
→ stable MemoryMcpError envelope
```

This is acceptable because both remain fail-visible.

Do not bypass strict Zod schemas merely to make every failure look identical.

## Required updates

- document the distinction in MCP error documentation/README/spec notes;
- keep raw SQLite/internal details hidden from domain/integration failures;
- preserve strict rejection of forbidden fields;
- update tests so the intended distinction is explicit rather than incidental.

If the installed SDK provides a straightforward supported method to normalize schema errors without weakening validation, using it is acceptable, but do not build custom protocol machinery for this phase.

## Required tests

Keep/extend tests proving:

1. unknown/privileged fields fail at schema/protocol boundary;
2. domain validation errors after schema acceptance return stable `MemoryMcpError`;
3. closed DB/internal failure returns `MEMORY_SERVICE_UNAVAILABLE` without raw storage details.

---

# 5. FIX-04 — Make shared-daemon request binding context explicit

**Priority:** Required design hardening for shared daemon; implementation scope should stay small  
**Category:** Multi-project local runtime context

## Problem

`MCPRequestContext` conceptually supports:

```ts
{
  cwd?: string;
  sessionId?: string;
}
```

but the current exposed server effectively uses a constructor-level fixed cwd because each tool call only forwards `sessionId`.

That works for a one-project stdio child process but becomes ambiguous with one shared daemon serving multiple projects.

A shared daemon cannot safely infer a different caller project from arbitrary process-global `cwd` on each MCP request.

## Required invariant

There are two safe request classes:

### Session-bound operations

```text
sessionId
→ Session.spaceId authoritative
```

No request cwd is required for correctness.

### No-Session read operations

They need a **trusted runtime binding context** supplied by the transport/client configuration, not an agent-controlled `spaceId`.

Examples of acceptable trusted context include:

```text
explicitSpaceId configured for this MCP endpoint/client
trusted project cwd configured for this MCP endpoint/client
```

Do not add agent-controlled `cwd` or `spaceId` fields to the six tool schemas just to solve daemon routing.

## Implementation guidance

Keep P1 simple. It is acceptable for the shared daemon MCP endpoint to be configured with one trusted project cwd/explicitSpaceId per configured client endpoint/session if that matches the selected transport setup.

What must be avoided is silently assuming:

```text
process.cwd() of the daemon
== cwd of every provider/project caller
```

Document the chosen trust source clearly.

Do not implement a workspace registry, dynamic auth system, multi-tenant routing layer, or Space federation in this phase.

## Required tests

At minimum prove:

1. Session-bound MCP reads/writes are independent of daemon cwd;
2. no-Session reads use the configured trusted runtime binding context;
3. an unrelated daemon process cwd cannot override an existing Session's Space;
4. tool input cannot inject cwd/spaceId unless the frozen tool contract is intentionally revised (it should not be revised in P1).

---

# 6. Documentation/status corrections

**Priority:** Required

The current README/plan says P1 is complete. After this review, use more precise status until runtime hardening passes.

During implementation, prefer wording such as:

```text
P1 MCP logical tool surface complete; runtime hardening in progress
```

After all requirements in this CR pass:

```text
P1 MCP Command Plane = FROZEN
```

Update documentation so it no longer instructs users to run two normal database-owning processes against the same default SQLite file.

Document clearly:

- supported shared daemon startup;
- MCP endpoint/transport used by providers;
- whether stdio is a proxy or standalone-dev-only;
- trusted cwd/explicitSpaceId source;
- schema/protocol validation error vs domain `MemoryMcpError` distinction;
- single active durable-store owner limitation.

Do not weaken the limitation by claiming SQLite/WAL now provides supported multi-process ownership semantics. WAL does not replace the frozen application ownership invariant.

---

# 7. Preserve these existing P1 contracts

The following behavior is already correct and should not be redesigned while fixing runtime composition.

Exactly six tools:

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

Preserve:

```text
memory_bootstrap/session optional
memory_context/session optional
memory_search/session optional
memory_remember/session required
memory_promote/session required
memory_checkpoint/session required
```

Agent must still not control:

```text
spaceId
tier
status
actor
force
confidence
importance
sourceAgentId
sourceEventIds
checkpoint toEventId
checkpoint fromEventId
checkpoint idempotencyKey
checkpoint trigger
```

Preserve:

```text
remember → Indexed
promote → actor=agent + domain policy
search/context → active Core + Indexed
checkpoint → CheckpointPolicy(trigger=explicit)
```

Do not add raw CRUD/debug/admin MCP tools.

---

# 8. Out of scope for CR-PHASE4

Do not implement the following yet:

- Codex ProviderAdapter;
- Claude Code ProviderAdapter;
- Cursor lifecycle support;
- provider-native hook parsing;
- full transcript reading/extraction;
- autonomous summarization;
- task-completed checkpoint policy changes;
- distributed SQLite ownership/locks;
- remote/team auth;
- multi-user/multi-tenant routing;
- vector search;
- additional MCP tools.

This CR ends P1. P2 starts separately.

---

# 9. Recommended implementation order

Implement in this order to reduce rework:

```text
1. Refactor composition root to one daemon-owned MemorySpace
2. Mount shared MCP transport on the daemon
3. Remove/convert/de-emphasize DB-owning stdio runtime
4. Add trusted explicitSpaceId to MCP runtime resolution
5. Clarify trusted cwd/request binding context
6. Document schema-vs-domain error boundary
7. Update README / Provider Integration Plan status
8. Run full regression suite
```

Do not change the six-tool public contract unless a test demonstrates a frozen spec contradiction.

---

# 10. Verification matrix

Before marking this CR complete, verify all of the following.

## Runtime ownership

- [ ] normal daemon creates exactly one durable `MemorySpace`;
- [ ] HTTP/lifecycle-facing code and MCP gateway reuse that instance;
- [ ] supported MCP runtime does not independently open the same SQLite DB;
- [ ] shutdown closes shared resources cleanly;
- [ ] no new multi-process coordination mechanism was introduced.

## Space resolution

- [ ] Session always determines Space when sessionId is present;
- [ ] trusted explicitSpaceId works without a Session;
- [ ] explicitSpaceId beats cwd binding when no Session exists;
- [ ] cwd/explicit override cannot rebind an existing Session;
- [ ] agent cannot submit spaceId;
- [ ] no-Session reads have a documented trusted binding context.

## MCP contract

- [ ] exactly six tools remain;
- [ ] strict schemas remain;
- [ ] durable tools require Session;
- [ ] remember cannot directly create Core;
- [ ] promote actor remains agent;
- [ ] checkpoint internals remain hidden;
- [ ] Core + Indexed recall remains Space-isolated.

## Errors

- [ ] protocol/schema failures are explicitly documented/tested;
- [ ] domain/integration failures return stable `MemoryMcpError`;
- [ ] raw SQLite/internal errors are not public tool output;
- [ ] failures remain fail-visible.

## Existing regressions

- [ ] Provider Session identity/frozen Space tests pass;
- [ ] TranscriptRef/Session provenance tests pass;
- [ ] SQLite transaction-barrier tests pass;
- [ ] checkpoint idempotency/concurrency tests pass;
- [ ] cache failure tests pass;
- [ ] cross-Space memory tests pass;
- [ ] existing evals pass.

---

# 11. Required commands

Run the repository quality gate:

```bash
pnpm run check
```

Also run the workspace gate if supported by the current repository state:

```bash
pnpm run check:workspace
```

If CI is available, confirm the branch/head workflow run succeeds. Do not report CI as green based only on local commands.

---

# 12. Completion report

When finished, report only:

1. files changed;
2. final daemon/runtime topology;
3. how the single durable-store owner invariant is enforced by composition;
4. what happened to the stdio entrypoint;
5. how trusted `explicitSpaceId` and cwd binding context are supplied;
6. documented behavior for schema/protocol validation errors vs `MemoryMcpError`;
7. new/updated tests;
8. `pnpm run check` result;
9. `pnpm run check:workspace` result;
10. CI status if independently observed;
11. any remaining P1 blocker.

If all requirements pass, mark:

```text
Provider Integration P0 = FROZEN
MCP Command Plane P1    = FROZEN
```

Then stop.

**Do not begin P2 Codex integration in the same change set.**
