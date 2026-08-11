# Codex P2 Real Smoke

- Date: 2026-08-11
- Memory Space commit: `8373befd653415756b17d9980a2341f85674a411`
- Codex version/client: `codex-cli 0.147.0` (`codex exec` / `codex exec resume`)
- Platform: macOS 15.7.3 (arm64)

## Execution

```bash
pnpm run smoke:codex:p2 -- --preflight
pnpm run smoke:codex:p2
```

The preflight is read-only and checks the platform, authenticated Codex CLI,
source-tree state, and project hook ownership without making model calls. A
full run makes several real Codex model calls and can take a few minutes. It
prints eight numbered stages with elapsed time to stderr and emits a `WAIT`
heartbeat every 20 seconds during real Codex calls. The final
`CODEX_P2_SMOKE_RESULT` remains on stdout for machine parsing.

The runner used a temporary SQLite database and loopback daemon, a reviewed
project-local hook definition, real Codex CLI model turns, and the daemon's
Streamable HTTP MCP endpoint. It captured native hook inputs/outputs and
cross-checked them against persisted Session events, checkpoint state, Memory,
and Handoff data. The runner first verifies that `src/` matches the recorded
commit. It creates no PASS report itself. It will reclaim an exact hook file
left behind by an interrupted earlier run. Any other existing
`.codex/hooks.json` is treated as user-owned and is never overwritten; move it
aside temporarily if you want to run this isolated smoke.

Automatic compaction was induced with a bounded per-invocation Codex context
configuration. The observed native sequence included `PreCompact`, followed by
`SessionStart` with `source = "compact"`. The smoke hook set deliberately
excluded `SessionEnd`, so the observed checkpoint boundary advancement was
attributable to `PreCompact`.

## Results

- SessionStart bootstrap: PASS
- MCP connection: PASS
- memory_remember/search: PASS
- UserPromptSubmit capture: PASS
- Stop capture: PASS
- PreCompact checkpoint: PASS
- SessionStart(compact) same Session: PASS
- Resume same Session: PASS
- New Session receives latest Handoff: PASS
- Indexed detail requires explicit recall: PASS
- Daemon unavailable lifecycle fail-open: PASS
- Interrupted-run smoke hook recovery: PASS
- Project hook cleanup after success: PASS

- Initial Memory Session: `500888aa-7230-47d0-ae56-84f7361b3281`
- Resumed Memory Session: `500888aa-7230-47d0-ae56-84f7361b3281`
- Compact re-entry Memory Session: `500888aa-7230-47d0-ae56-84f7361b3281`
- Second Memory Session: `cbff454d-eee2-4e98-bf98-4f2f99fa7c1c`

- Initial Codex Session: `019ff0ae-8a06-7b20-9aa2-c78328bab8b9`
- Second Codex Session: `019ff0af-6d51-7ba0-9a3f-f73ec29ad6f8`

Overall: PASS
