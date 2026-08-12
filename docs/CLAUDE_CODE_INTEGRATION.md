# Claude Code Provider Integration

**Status:** P3 implementation, automated validation, code review, and real hook
lifecycle PASS; real model-driven MCP remains externally blocked. P3 is
accepted with a scoped progression waiver and is not Frozen.

Official references:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-usage)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)

The integration uses one long-running daemon for both lifecycle and MCP:

```text
Claude command hooks ──POST──> /providers/claude-code/lifecycle ──┐
                                                                 ├── one MemorySpace / SQLite owner
Claude HTTP MCP ─────────────> /mcp ──────────────────────────────┘
```

The hook command is a bounded HTTP bridge. It never owns SQLite. Lifecycle
failures return a non-blocking `systemMessage` and exit successfully; explicit
MCP commands remain fail-visible.

## 1. Start and bind

Start the daemon from the Memory Space checkout:

```bash
pnpm start
```

The default endpoints are:

```text
HTTP:               http://127.0.0.1:4310
Claude lifecycle:   http://127.0.0.1:4310/providers/claude-code/lifecycle
MCP:                http://127.0.0.1:4310/mcp
```

`MEMORY_SPACE_CLAUDE_CODE_HOOK_URL` changes the lifecycle endpoint. The bridge
timeout defaults to 2500 ms and can be changed with
`MEMORY_SPACE_HOOK_TIMEOUT_MS`. Events are not retried automatically because a
replay could duplicate Conversation-lite evidence.

With the daemon running, prefer the product CLI from the Memory Space checkout:

```bash
pnpm memory-space init --cwd /absolute/path/to/project --name "My Project"
```

This creates/confirms the Space through the daemon and safely writes the v1
project binding. It does not edit Claude configuration. The equivalent manual
API flow remains available for debugging:

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  -d '{"id":"my-project","name":"My Project"}' \
  http://127.0.0.1:4310/spaces
```

`<project>/.memory-space/config.json`:

```json
{
  "version": 1,
  "spaceId": "my-project"
}
```

The first `SessionStart` resolves the nearest binding. Later startup re-entry,
resume, clear, and post-compact starts first resolve the durable
`(provider, externalSessionId)` identity. The existing internal Session and its
Space are authoritative, so a changed `cwd` cannot migrate the Session. A
trusted daemon `MEMORY_SPACE_SPACE_ID` override must match an existing binding.

## 2. Configure Claude hooks

Merge [`examples/claude-code/settings.json`](../examples/claude-code/settings.json)
into the target project's `.claude/settings.json` or
`.claude/settings.local.json`, or into the user-level
`~/.claude/settings.json`. Replace `/absolute/path/to/memory-space` in every
command with this checkout's absolute path.

Claude Code merges hooks from all active settings scopes. Identical handlers
are currently deduplicated; command hooks are deduplicated by command string
and arguments. Non-identical Memory Space definitions may still both execute.
Prefer one canonical active definition so lifecycle ownership and diagnostics
remain clear. `memory-space doctor` therefore warns when it finds Memory Space
definitions in multiple active scopes, even when Claude would deduplicate the
identical handlers.

The native mapping follows the current official lifecycle contract:

| Claude Code hook | Memory Space behavior |
|---|---|
| `SessionStart` | bind/reuse Session, bootstrap, inject `additionalContext` |
| `UserPromptSubmit` | append the original full user prompt |
| `Stop` | append the reliable `last_assistant_message` when non-empty |
| `PreCompact` | checkpoint only uncommitted events |
| `SessionEnd` | checkpoint only uncommitted events |

Claude's `prompt_id`, `permission_mode`, task hooks, tool traces, and any
privilege-shaped custom fields are not trusted Memory commands. `PostToolUse`,
`TaskCompleted`, and other Claude-only events are ignored by default. The
native `transcript_path` is stored only as an opaque `TranscriptRef`; Memory
Space does not parse or replicate the transcript.

`SessionEnd` normally has a 1.5 second aggregate hook budget. The example sets
an eight-second per-hook timeout, which Claude Code uses to raise that budget.

## 3. Configure the shared MCP server

Copy [`examples/claude-code/mcp.json`](../examples/claude-code/mcp.json) to the
target project root as `.mcp.json`, or merge its `memory_space` entry into an
existing file. Claude also supports project-local MCP configuration under the
current project's entry in `~/.claude.json` and user-scoped MCP configuration
at the top level of that file; `memory-space doctor` recognizes all three
scopes. Run `/mcp` and verify that `memory_space` is connected.

Claude uses the same six tools as every other provider:

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

There are no Claude-specific MCP tools. `SessionStart` injects an opaque
internal Session handle plus Core and latest Handoff context. Use that handle
for durable writes and explicit recall.

## 4. Automated and real validation

The normal project check includes native adapter regressions, daemon routing,
provider parity, and a durable Claude lifecycle eval:

```bash
pnpm run check
pnpm run check:workspace
```

The real-provider runner uses temporary Claude settings, MCP config, workspace,
SQLite, and daemon state. It does not create or replace `.claude` files in this
repository or the target project:

```bash
pnpm run smoke:claude:p3 -- --preflight
pnpm run smoke:claude:p3
```

If the configured model gateway cannot execute MCP tools, run the real hook
lifecycle independently:

```bash
pnpm run smoke:claude:p3 -- --hooks-only
```

Hook-only mode does not load an MCP configuration and continues through real
startup/bootstrap, prompt and final capture, SessionEnd, resume, PreCompact,
`SessionStart(source=compact)`, cross-session Handoff, and daemon-unavailable
fail-open checks. Its machine-readable line is
`CLAUDE_P3_HOOK_SMOKE_RESULT`. MCP connection, remember/search, and Indexed
explicit recall are reported as `SKIPPED`, and `p3FreezeEligible` is `false`.
This diagnostic PASS does not satisfy the P3 freeze gate.

Reliable `Stop.last_assistant_message` requires Claude Code 2.1.47 or newer;
the preflight rejects older clients. To test the current official CLI without
replacing a global installation, pin the temporary package explicitly:

```bash
MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --preflight

MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3

MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --hooks-only
```

The full run makes real model calls and can take several minutes. Progress is
written to stderr in eight stages with 20-second `WAIT` heartbeats; the final
`CLAUDE_P3_SMOKE_RESULT` line on stdout is machine-readable. On failure, the
temporary artifact directory is preserved for inspection. The runner records
only non-secret evidence in its final result; do not publish the artifact
directory because it contains smoke transcripts and debug logs.

The current machine uses an `ANTHROPIC_BASE_URL` compatibility gateway that
rewrites Claude MCP names such as `mcp__memory_space__memory_search` to
`mcp_memory_space_memory_search`. Claude Code rejects the rewritten name even
though `/mcp` is connected and all six tools were discovered. This is an
external client/gateway compatibility blocker, not a reason to add alias tools.
Use first-party Anthropic authentication or a gateway that preserves MCP tool
names, then rerun the command above. P3 cannot be marked Frozen until that run
emits `overall: PASS`.

## Security and current limits

- The unauthenticated v1 daemon is loopback-only. LAN/remote deployment is not
  supported without a future authenticated design.
- All daemon routes except `GET /health` share the same localhost Host/Origin
  validation. JSON lifecycle requests require `Content-Type: application/json`.
- Provider payload fields cannot choose Space, tier, status, actor, promotion,
  checkpoint boundaries, or idempotency keys.
- Bootstrap explicitly labels recalled Memory as untrusted project data.
- Full transcript ingestion and provider-event deduplication remain deferred.
- A real smoke PASS must be recorded under `docs/validation/` before the P3
  status changes to Frozen.
