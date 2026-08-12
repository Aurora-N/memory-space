# CR-PHASE7 — P4 Cross-Session & Cross-Provider Durable Memory Eval Review

**Reviewed commit:** `9cfeca21aec048a63193a0f9b51838ec8a2bc339`  
**Status:** PASS  
**P4 result:** implementation complete; automated eval PASS; code review PASS  
**Inherited limitation:** P3 real Claude model-driven MCP execution remains externally blocked/waived  
**Next phase:** P5 Productization

---

## 1. Review conclusion

P4 satisfies the product/automated proof required by `P4_CROSS_SESSION_PROVIDER_EVAL.md` without introducing provider-pair-specific Memory behavior.

The implementation proves that durable Memory is Space-owned rather than provider- or Session-owned.

Accepted matrix:

```text
Codex A  → Codex B       PASS
Claude A → Claude B      PASS
Codex A  → Claude B      PASS
Claude A → Codex B       PASS
```

Accepted multi-hop:

```text
Codex A → Claude B → Codex C → Claude D   PASS
```

---

## 2. Accepted properties

The review verified:

- source and target use distinct internal Sessions;
- same-provider scenarios use distinct external Session identities;
- the same external ID under different providers remains namespaced by provider;
- all matrix cases survive SQLite close/reopen;
- Core Memory appears in target default bootstrap;
- latest Handoff appears in target default bootstrap;
- Indexed-only detail remains absent from bootstrap;
- target Session recovers Indexed detail through the shared MCP command plane;
- `memory_context` renders relevant Core + Indexed context;
- reading from another Session preserves original `sourceSessionId` provenance;
- Space Y cannot observe Space X bootstrap/search/context state;
- changed cwd cannot migrate an already-bound provider Session;
- trusted explicit Space conflicts remain visible;
- repeated clean checkpoint remains a noop;
- later Sessions advance the latest Handoff;
- the MCP command plane remains exactly six tools;
- P4 added evaluation proof rather than a Codex↔Claude conversion layer.

The Pre-P4 Claude native-contract cleanup also removed undocumented `SessionStart.source = "fork"` support while preserving the provider-neutral lifecycle contract.

---

## 3. Non-blocking future test improvements

Two optional proof-strengthening items were identified but do not block P4:

1. matrix cases may directly assert `latestHandoff.sessionId === sourceSessionId` after durable reopen in addition to content-based assertions;
2. one selected P4 scenario may later be repeated through the daemon's real Streamable HTTP `/mcp` transport, although P1 already covers daemon/MCP composition and P4 currently exercises the real MCP server/tool contract through `Client` + `InMemoryTransport`.

Neither item requires architecture changes.

---

## 4. Acceptance evidence

Repository-recorded local verification for the reviewed implementation:

```text
pnpm run check           PASS — 80/80 tests
pnpm run check:workspace PASS — 80/80 tests
```

GitHub CI was not independently observed by the reviewer and is not represented as verified.

No new real-provider P4 smoke was required for this automated product-level acceptance. Existing real Codex P2 evidence and real Claude P3 hook evidence remain recorded separately.

---

## 5. P3 waiver remains scoped

P4 PASS does not synthesize the missing real Claude model-driven MCP result.

Current state remains:

```text
P3 implementation             PASS
P3 automated validation       PASS
P3 code review                 PASS
P3 real hook lifecycle         PASS
P3 real MCP model invocation   BLOCKED externally / WAIVED for progression
```

Do not add Claude-only aliases or change the exact-six MCP contract to close this external limitation.

---

## 6. Phase transition

P4 is accepted at the intended product/automated scope.

Provider Integration v1 should now stop expanding provider breadth by default. The next planned work is:

```text
P5 Productization
→ P6 Memory Quality v1
→ P7 optional MCP-first provider validation
```

See:

- `../V1_ROADMAP.md`
- `../PRODUCTIZATION_SPEC.md`
- `../MEMORY_QUALITY_V1_SPEC.md`

Do not start P6 in the same implementation pass as P5 unless explicitly requested.
