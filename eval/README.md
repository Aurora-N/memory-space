# MVP evaluation harness

JSON fixtures under `fixtures/` drive automated scenarios for the four frozen MVP abilities:

- extraction;
- keyed update/dedup;
- Indexed recall;
- cross-session handoff;
- Codex native lifecycle bootstrap/capture/checkpoint/resume;
- Claude Code native lifecycle bootstrap/capture/checkpoint/resume and
  cross-provider handoff parity;
- parameterized Codex/Claude same-provider and cross-provider durable Memory;
- SQLite close/reopen, Space isolation, provenance preservation, progressive
  recall, Handoff advancement, and Codex→Claude→Codex→Claude multi-hop state.

Run them together with unit/integration tests using `pnpm test` or the complete quality gate with `pnpm run check`. New fixtures can extend the scenario arrays without changing persistence or domain code.

The P4 cross-session proof is implemented once in
`eval/support/cross-session-runner.ts`. The `node:test` wrapper and P5 CLI both
call that canonical runner, so the product demo does not maintain a weaker
second implementation:

```bash
pnpm memory-space eval cross-session
pnpm memory-space eval cross-session --json
```

The runner owns only isolated temporary SQLite files and never opens the
daemon's configured database. Real Claude model-driven MCP remains a separate
waived external acceptance gate and is not reported as deterministic eval PASS.
