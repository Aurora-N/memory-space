# P4 — Cross-Session & Cross-Provider Durable Memory Eval

**Status:** Implementation complete; automated eval PASS; code review PASS

**Applies after:** P2 Codex Frozen; P3 Claude Code implementation/code review accepted with a scoped real-MCP execution waiver  
**Related:** `./PROVIDER_INTEGRATION_SPEC.md`, `../plans/PROVIDER_INTEGRATION_PLAN.md`, `./PROVIDER_INTEGRATION_GUARDRAILS.md`, `../reviews/CR-PHASE6.md`, `../reviews/CR-PHASE7.md`

> This document is the normative P4 execution spec. It expands and supersedes the narrower P4 scenario currently described in `../plans/PROVIDER_INTEGRATION_PLAN.md` section 8.

---

## 1. Why P4 exists

P4 must prove the real product invariant:

> Durable Memory belongs to a Space, not to one provider and not to one Session.

The system must therefore support all of the following without provider-pair-specific Memory logic:

```text
Codex Session A       → Codex Session B
Claude Session A      → Claude Session B
Codex Session A       → Claude Session B
Claude Session A      → Codex Session B
```

It must also prove multi-hop continuity:

```text
Codex A
  ↓ checkpoint
Claude B
  ↓ checkpoint
Codex C
  ↓ checkpoint
Claude D
```

Every hop uses a distinct Memory Session. Sessions in the same project share the same Space and can consume durable Core/Handoff state plus explicitly recall Indexed detail.

---

## 2. P3 acceptance waiver carried into P4

The current environment cannot complete a real Claude model-driven MCP tool invocation because the compatibility gateway rewrites Claude MCP tool names. The real Claude hook lifecycle, bootstrap, Session identity, Conversation-lite capture, checkpoint, resume, compact re-entry, cross-session Handoff, daemon fail-open, MCP connection, and exact-six discovery have already been exercised.

P4 may proceed under this scoped waiver.

The waiver means:

```text
P3 implementation             PASS
P3 automated validation       PASS
P3 code review                 PASS
P3 real hook lifecycle         PASS
P3 real MCP model invocation   BLOCKED externally
P3 phase status                ACCEPTED WITH WAIVER, not FROZEN
```

The waiver does **not** permit any of the following:

- adding Claude-only MCP aliases;
- changing the exact six-tool command plane;
- claiming a real Claude MCP execution PASS;
- converting the external blocker into a Memory Space code workaround;
- treating P3 as fully Frozen.

P4 automated tests may invoke the shared `MemoryMcpGateway` or the real daemon MCP protocol directly. This verifies the same provider-independent command plane without depending on the current gateway's model tool-name rewrite.

---

## 3. Pre-P4 provider contract cleanup

Before P4 implementation is considered review-ready, reconcile the known Claude Code native-contract drift identified after P3 review.

Current official Claude Code `SessionStart.source` values are:

```text
startup
resume
clear
compact
```

If the adapter/tests/examples still accept or advertise `source = "fork"`, remove that undocumented value from:

- Claude adapter validation;
- hook matcher examples;
- provider tests;
- Claude integration docs / review docs.

Do not confuse the Claude CLI `--fork-session` feature with a documented `SessionStart.source = "fork"` hook payload.

This cleanup must not change the provider-neutral lifecycle contract.

---

## 4. P4 architectural rule

P4 must not create a special cross-provider feature path.

Forbidden patterns include:

```ts
if (sourceProvider === "codex" && targetProvider === "claude-code") {
  // special handoff behavior
}
```

and:

```text
Codex-to-Claude converter
Claude-to-Codex memory migration
provider-scoped Memory stores
provider-specific Handoff tables
new cross-provider MCP tools
```

The correct model is only:

```text
Session A ─┐
           ├── Space X durable Memory
Session B ─┘
```

Provider identity is Session provenance. Space identity owns shared durable Memory.

---

## 5. Required automated scenario matrix

P4 automated validation MUST cover all four source/target combinations:

| Source Session | Target Session | Required |
|---|---|---|
| Codex A | Codex B | yes |
| Claude A | Claude B | yes |
| Codex A | Claude B | yes |
| Claude A | Codex B | yes |

Prefer one parameterized scenario harness rather than four mostly duplicated test files.

Conceptually:

```ts
const scenarios = [
  ["codex", "codex"],
  ["claude-code", "claude-code"],
  ["codex", "claude-code"],
  ["claude-code", "codex"]
] as const;
```

Provider lifecycle setup must still flow through the real adapter/integration boundary for that provider. Do not replace provider startup with direct `createSession()` calls merely to simplify the eval.

---

## 6. Canonical source-session setup

Each scenario begins with a distinct source provider-native Session identity in `Space X`.

The source Session must produce three different classes of durable evidence:

### 6.1 Core item

Create an Indexed Memory through the shared MCP command layer and promote it through policy.

Example:

```text
family: state
type: decision
key: project.database
content: Production database is SQLite.
```

The exact content may differ, but it must be unique enough to assert precisely.

### 6.2 Indexed-only detail

Remember one detail that stays Indexed.

Example:

```text
family: knowledge
type: fact
content: Migration helper lives in scripts/db/migrate.ts.
```

This detail must remain absent from default bootstrap and recoverable only through explicit recall.

### 6.3 Conversation-lite + Handoff

Append real normalized user/assistant evidence through provider lifecycle handling.

Example semantics:

```text
current progress: provider integration is complete
next step: implement cross-session durable eval
```

Checkpoint through the shared `CheckpointPolicy` / MCP checkpoint path so a latest Handoff is produced.

---

## 7. Durable-store restart boundary

At least the cross-provider scenarios MUST prove persistence through a close/reopen boundary:

```text
source Session writes/checkpoints
→ close MemorySpace / SQLite owner
→ reopen same database
→ start target Session
```

Prefer applying the same helper to all matrix cases when this does not create unnecessary test time.

The reopened application must not rely on retained in-memory objects from the source phase.

---

## 8. Target-session assertions

The target Session must use a different provider-native identity from the source Session.

For same-provider scenarios:

```text
source.externalSessionId != target.externalSessionId
```

For cross-provider scenarios:

```text
source.provider != target.provider
```

For every scenario:

```text
source.id != target.id
source.spaceId == target.spaceId
```

Then assert all of the following.

### 8.1 Core is in default bootstrap

Target Session bootstrap includes the source Session's promoted Core decision.

### 8.2 Latest Handoff is in default bootstrap

Target Session bootstrap includes the latest checkpoint/Handoff state produced by the source Session.

### 8.3 Indexed detail is not in default bootstrap

The low-level Indexed detail must not leak into deterministic startup context.

This protects progressive disclosure.

### 8.4 Explicit search recovers Indexed detail

Use the shared MCP command plane (`MemoryMcpGateway` or an MCP protocol client against `/mcp`) with the **target Session ID**.

`memory_search` must recover the Indexed detail from the shared Space.

Do not call raw `memorySpace.search()` as the only P4 proof because that bypasses P1 command-plane behavior.

### 8.5 Context recall works

`memory_context` using the target Session must render relevant Core/Indexed context for an appropriate query.

### 8.6 Provenance is preserved

Reading a Memory from the target Session must not mutate its origin.

If Memory M was created by source Session A:

```text
M.sourceSessionId == sourceSession.id
```

must remain true after target Session B recalls it.

### 8.7 Space isolation remains strict

Create `Space Y` with another Session and assert that neither bootstrap nor search/context can observe Space X's Core, Indexed, or Handoff data.

---

## 9. Handoff advancement test

P4 must prove that shared state continues to evolve, not merely that an old Handoff is readable.

After target Session B consumes source state:

```text
Session B
→ append new Conversation-lite evidence
→ checkpoint
→ latest Handoff becomes B's Handoff
```

Start Session C in the same Space and assert:

- C sees B's latest Handoff, not stale A-only next-step state;
- previous durable Core remains available unless explicitly changed by domain semantics;
- Indexed provenance from A remains intact.

This is required for both same-provider/cross-provider continuity semantics, even if implemented once in a dedicated multi-hop scenario.

---

## 10. Required multi-hop scenario

Implement one deterministic chain:

```text
Codex A
→ Claude B
→ Codex C
→ Claude D
```

Suggested semantic progression:

```text
Codex A:
  Core: database = SQLite
  Handoff: next = finish provider abstraction

Claude B:
  reads A state
  writes: provider abstraction complete
  Handoff: next = add cross-provider eval

Codex C:
  reads B Handoff
  remembers Indexed detail:
    eval file lives at eval/cross-session-provider-memory.test.ts
  Handoff: next = verify progressive recall

Claude D:
  bootstrap sees latest Handoff/Core
  bootstrap does NOT expose the Indexed eval-file detail
  explicit memory_search/context does recover it
```

This test proves continued Space-level memory evolution across alternating provider Sessions.

---

## 11. Recommended eval structure

Prefer one new high-value eval file:

```text
eval/
├── provider-codex-handoff.test.ts
├── provider-claude-code-handoff.test.ts
└── cross-session-provider-memory.test.ts
```

Reusable helpers may be introduced under test/eval support code when they remain provider-neutral or cleanly dispatch through each provider adapter.

Useful helper concepts:

```text
startProviderSession(provider, externalSessionId, cwd)
emitUserPrompt(provider, externalSessionId, content)
emitAssistantTurn(provider, externalSessionId, content)
rememberViaMcp(sessionId, ...)
promoteViaMcp(sessionId, memoryId, reason)
checkpointViaMcp(sessionId)
bootstrapViaProvider(provider, externalSessionId)
searchViaMcp(sessionId, query)
contextViaMcp(sessionId, query)
```

Do not make helpers bypass provider lifecycle or MCP boundaries merely to make assertions easier.

---

## 12. Real-provider validation scope

P4 should distinguish automated product proof from currently available real-provider evidence.

### 12.1 Real Codex

Where practical, the existing working real Codex environment may validate a same-Space new-session bootstrap/Handoff and MCP recall flow.

### 12.2 Real Claude hooks

The existing Claude hooks-only environment may validate:

```text
new Claude Session
→ same Space
→ bootstrap consumes prior Handoff/Core
→ lifecycle continues/checkpoints
```

### 12.3 Real Claude model-driven MCP recall

This remains:

```text
BLOCKED / WAIVED
```

until first-party Anthropic authentication or a name-preserving compatibility gateway is available.

Do not synthesize a PASS. Do not add alias tools.

The automated MCP command-plane validation in P4 must still pass independently.

---

## 13. Adversarial regressions

P4 must retain and/or add assertions for:

- distinct external Session IDs do not accidentally resume the same internal Session;
- same external ID under different providers remains two provider identities unless provider semantics say otherwise;
- target Session cannot use cwd to rebind source/target Space identity after binding;
- target Session cannot search another Space;
- recalled Memory provenance cannot be rewritten to the reader Session;
- bootstrap does not disclose Indexed-only detail;
- clean repeated checkpoint is noop;
- SQLite reopen does not lose provider Session mapping, Core, Indexed, or latest Handoff;
- no provider-specific fields become privileged Memory inputs;
- exact shared six MCP tools remain unchanged.

---

## 14. Non-goals

Do not implement during P4:

- embeddings/vector search;
- provider-event dedup tables unless a P4 correctness bug proves they are required;
- transcript ingestion;
- Claude-specific MCP aliases;
- cross-provider conversion layers;
- provider-specific Memory tables;
- new raw REST/MCP debug commands;
- distributed store ownership;
- remote auth/deployment;
- Cursor integration.

---

## 15. Completion gates

Before requesting P4 code review, Coding Agent must report:

1. P3 pre-P4 native-contract cleanup result;
2. exact files changed;
3. matrix results for:
   - Codex → Codex;
   - Claude → Claude;
   - Codex → Claude;
   - Claude → Codex;
4. multi-hop result;
5. SQLite close/reopen result;
6. progressive-disclosure result;
7. provenance-preservation result;
8. Space-isolation result;
9. exact-six MCP regression result;
10. `pnpm run check` result;
11. `pnpm run check:workspace` result;
12. real-provider evidence actually executed;
13. Claude real-MCP waiver still pending or resolved.

Accepted final status under the inherited external Claude MCP blocker:

```text
P4 implementation:          COMPLETE
P4 automated eval:          PASS
P4 code review:              PASS
P4 real cross-session hook: PASS where executed
P4 real Claude MCP recall:  WAIVED / external blocker
```

Do not claim the external Claude MCP check passed until it actually does.

---

## 16. P4 success statement

P4 succeeds at the product/automated level when the repository can prove:

> A durable Memory written by one Session remains Space-owned and can be consumed by another distinct Session regardless of whether the reader uses the same provider or a different provider; Core/Handoff state is available by default, Indexed detail remains progressive, provenance is preserved, state survives durable-store reopen, and later Sessions can advance the shared Handoff without provider-pair-specific logic.

---

## 17. Implementation evidence

Implemented in:

```text
eval/cross-session-provider-memory.test.ts
```

The parameterized eval passes all four required combinations:

| Source | Target | Distinct Session | SQLite reopen | Core + Handoff bootstrap | Indexed recall |
|---|---|---:|---:|---:|---:|
| Codex | Codex | PASS | PASS | PASS | PASS |
| Claude Code | Claude Code | PASS | PASS | PASS | PASS |
| Codex | Claude Code | PASS | PASS | PASS | PASS |
| Claude Code | Codex | PASS | PASS | PASS | PASS |

The same eval also passes:

- exact shared six-tool MCP discovery and protocol calls;
- Indexed absence from bootstrap plus explicit `memory_search/context` recall;
- source provenance preservation after target reads;
- changed-cwd no-migration and trusted explicit conflict;
- provider-namespaced identity for the same external ID;
- Space Y bootstrap/search/context isolation;
- repeated clean checkpoint `noop`;
- `Codex A → Claude B → Codex C → Claude D` Handoff advancement.

The Pre-P4 Claude cleanup now accepts only `startup`, `resume`, `clear`, and
`compact` as native `SessionStart.source` values. The provider-neutral
lifecycle contract and frozen Memory/MCP contracts were not changed.

P3's scoped progression waiver remains unchanged: real Claude hook lifecycle
is accepted, while real Claude model-driven MCP invocation remains externally
blocked/waived because the active compatibility gateway rewrites tool names.

Recorded local verification on 2026-08-12:

```text
pnpm run check           PASS — 80/80 tests
pnpm run check:workspace PASS — 80/80 tests
```

No new real-provider P4 smoke was executed in this implementation turn. The
recorded real Codex P2 and real Claude P3 hook-only evidence remain applicable;
real Claude model-driven MCP remains waived. GitHub CI status was not
independently confirmed.

---

## 18. Code review result

`docs/reviews/CR-PHASE7.md` records the P4 review PASS for commit
`9cfeca21aec048a63193a0f9b51838ec8a2bc339`.

No P4 correctness or architecture blocker remains. Two optional future test-strengthening items were noted: direct latest-Handoff provenance assertion after reopen, and one selected Streamable HTTP `/mcp` P4 scenario. Neither changes the accepted P4 architecture or blocks the next phase.

P4 is closed at its intended product/automated scope. Continue with `../plans/V1_ROADMAP.md` and `./PRODUCTIZATION_SPEC.md` rather than adding more provider-specific P4 behavior.
