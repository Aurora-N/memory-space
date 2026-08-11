# Codex Provider Integration

**Status:** P2 local integration

Protocol references: [Codex Hooks](https://developers.openai.com/codex/hooks)
and [Codex MCP](https://developers.openai.com/codex/mcp).

The supported topology is one long-running Memory Space daemon plus Codex's
native command hooks and Streamable HTTP MCP client:

```text
Codex hooks ──POST──> /providers/codex/lifecycle ──┐
                                                   ├── one MemorySpace / SQLite owner
Codex MCP ─────────> /mcp ─────────────────────────┘
```

The hook command is only an HTTP bridge. It never opens SQLite and always exits
successfully with a non-blocking warning if Memory Space is unavailable. MCP
commands remain fail-visible.

## 1. Start the daemon

From the Memory Space checkout:

```bash
pnpm start
```

The default endpoints are:

```text
HTTP:            http://127.0.0.1:4310
Codex lifecycle: http://127.0.0.1:4310/providers/codex/lifecycle
MCP:             http://127.0.0.1:4310/mcp
```

`MEMORY_SPACE_CODEX_HOOK_URL` can change the hook endpoint. The bridge timeout
defaults to 2500 ms and can be changed with `MEMORY_SPACE_HOOK_TIMEOUT_MS`.
It does not retry automatically, because replaying a conversation event could
duplicate evidence.

## 2. Bind the project to a Space

Create the Space once through the local API:

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  -d '{"id":"my-project","name":"My Project"}' \
  http://127.0.0.1:4310/spaces
```

Add this trusted project-local binding at
`<project>/.memory-space/config.json`:

```json
{
  "version": 1,
  "spaceId": "my-project"
}
```

The native Codex `cwd` is used only when first binding a provider Session.
After that, the durable Session binding is authoritative; changing cwd cannot
migrate the Session. A daemon-level `MEMORY_SPACE_SPACE_ID` remains the trusted
explicit override and takes precedence over hook cwd.

## 3. Configure Codex hooks

Copy [`examples/codex/hooks.json`](../examples/codex/hooks.json) to either the
project's `.codex/hooks.json` or `~/.codex/hooks.json`. Replace
`/absolute/path/to/memory-space` in every command with this checkout's absolute
path.

The configured native mapping is:

| Codex hook | Memory Space behavior |
|---|---|
| `SessionStart` | bind/reuse Session, bootstrap, inject additional context |
| `UserPromptSubmit` | append the full user message |
| `Stop` | append `last_assistant_message` when present and non-empty |
| `PreCompact` | checkpoint only uncommitted events |
| `SessionEnd` | checkpoint only uncommitted events |

`PreToolUse` and `PostToolUse` are intentionally not captured. Codex supplies
`transcript_path`; Memory Space stores it only as an opaque `TranscriptRef` on
captured messages and does not read or copy the transcript automatically.

In Codex, open `/hooks`, review the exact command definitions, and trust them.
Changed hook definitions must be reviewed again. Project-local hooks only load
for a trusted project. Install the Memory Space hook configuration in only one
active hook source; Codex merges matching hook sources and runs them all.

## 4. Configure MCP

Merge [`examples/codex/config.toml`](../examples/codex/config.toml) into the
active Codex `config.toml`. In Codex, open `/mcp` and verify that
`memory_space` is connected.

`SessionStart` injects an opaque internal Session handle plus Core Memory and
the latest Handoff. Durable MCP tools use that handle. Project binding remains
inside the trusted runtime rather than the tool schema.

## 5. Manual smoke test

1. Start the daemon and Codex from the bound project.
2. Confirm the initial context contains a `Memory Space` Session handle.
3. Submit a prompt such as `决定：本项目使用 SQLite。` and let Codex produce a
   final answer.
4. Trigger manual compaction so `PreCompact` checkpoints the captured turns.
5. Close the Codex session normally, then resume the same native session.
6. Confirm the same opaque Memory Session handle is injected again.
7. Start a different Codex session in the same project and confirm bootstrap
   includes the previous latest Handoff.
8. Stop the daemon and start another Codex session. Codex should continue with
   a `MEMORY_SERVICE_UNAVAILABLE` warning; it must not claim a checkpoint was
   saved.

For local inspection, use the injected Session handle:

```bash
curl --fail --silent http://127.0.0.1:4310/sessions/SESSION_HANDLE
curl --fail --silent http://127.0.0.1:4310/sessions/SESSION_HANDLE/events
```

Codex `SessionEnd` is advisory and may occur on archive/delete, normal close,
or after the provider's idle-session boundary; merely switching away from a
conversation is not an immediate end signal.

## Security and current limits

- The daemon is local-only by default and has no authentication in v1.
- The lifecycle and MCP routes enforce localhost Host/Origin validation.
- Provider fields such as `spaceId`, `tier`, `recommendedTier`, `actor`, and
  `force` are ignored by the Codex adapter and cannot become privileged Memory
  commands.
- Bootstrap labels recalled memory as untrusted project data. It must not be
  treated as higher-priority instructions.
- Full transcript ingestion and transcript-format coupling are intentionally
  deferred.
- Running another database-owning Memory Space process against the same SQLite
  file remains unsupported.
