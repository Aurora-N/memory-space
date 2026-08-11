# Claude P3 Real Smoke

**Status:** BLOCKED — this is not a PASS record and P3 is not Frozen.

- Date: 2026-08-11
- Memory Space base commit: `f30acc74029d6cc85a6c99e1dca23f47ddc10132`
- P3 implementation SHA-256: `ebef6c21b95d9b59ec0483f1c7357851e185433cc0bf4e26cbb69272137f60ad`
- Claude version/client: official `@anthropic-ai/claude-code` `2.1.227`
  executed temporarily with `pnpm dlx`
- Platform: macOS 15.7.3 (arm64)
- Source state: working tree; the implementation digest covers `src/`,
  `package.json`, and `scripts/claude-p3-real-smoke.mjs`

## Execution

```bash
MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --preflight

MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3
```

The gateway-independent hook lifecycle can be diagnosed separately without
loading MCP configuration:

```bash
MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --hooks-only
```

A hook-only `overall: PASS` is scoped evidence. Its result reports MCP checks
as `SKIPPED` and `p3FreezeEligible: false`; it must not replace the blocked
full-smoke status below.

The runner used a temporary workspace, Claude settings file, SQLite database,
and loopback daemon; full mode additionally used an isolated MCP config while
hook-only mode loaded no MCP config. It did not replace project or user
`.claude` / `.mcp.json` configuration. Failed-run artifacts were preserved
locally and were not copied into this document because they contain smoke
transcripts and debug logs.

## Hook-only result

The real hook-only command completed on 2026-08-11 with Claude Code 2.1.227
through the active API-token compatibility server:

| Check | Result |
|---|---|
| SessionStart bootstrap | PASS |
| UserPromptSubmit capture | PASS |
| Stop reliable-final capture | PASS |
| PreCompact checkpoint | PASS |
| SessionStart(compact), same Memory Session | PASS |
| Resume, same Memory Session | PASS |
| SessionEnd checkpoint | PASS |
| New Session receives latest Handoff | PASS |
| Daemon unavailable lifecycle fail-open | PASS |
| MCP connection and command execution | SKIPPED |
| Indexed explicit recall | SKIPPED |

- Initial Memory Session: `5684680f-7256-4b71-82f9-32fa8f4f0543`
- Resumed Memory Session: `5684680f-7256-4b71-82f9-32fa8f4f0543`
- Compact Memory Session: `5684680f-7256-4b71-82f9-32fa8f4f0543`
- Second Memory Session: `15242a7e-bc42-4538-a7ea-d0f16af3f9e5`

The run also exposed the real Claude 2.1.227 automatic-compact payload
`custom_instructions: null`. The adapter now accepts the observed
`string | null` shape, with a regression test. The runner accumulates enough
completed turns before forcing compact so Claude Code does not reject the
attempt as `too_few_groups`.

Hook-only Overall: **PASS**

P3 freeze eligible: **false**

## Full-smoke observed results

| Check | Result | Evidence |
|---|---|---|
| Current official CLI preflight | PASS | Claude Code 2.1.227 authenticated through the active compatibility gateway |
| SessionStart native hook | PASS | Real `SessionStart(source=startup)` payload received |
| Bootstrap injection | PASS | Real hook response contained the opaque Memory Session and seeded Core context |
| MCP HTTP connection | PASS | Claude `system/init` reported `memory_space` as connected |
| Exact shared six-tool discovery | PASS | Init listed only `memory_bootstrap`, `memory_context`, `memory_search`, `memory_remember`, `memory_promote`, and `memory_checkpoint` under the standard MCP prefix |
| UserPromptSubmit capture | PASS | The exact real prompt was persisted as a user SessionEvent |
| Stop reliable-final capture | PASS | Claude 2.1.227 emitted `last_assistant_message`; the exact final JSON text was persisted as an assistant SessionEvent |
| SessionEnd native hook | PASS | Real `SessionEnd(reason=other)` payload received |
| `memory_remember/search` execution | **BLOCKED** | The active gateway rewrote `mcp__memory_space__...` to `mcp_memory_space_...`; Claude Code rejected it as `No such tool available` |
| PreCompact / compact re-entry | NOT RUN | The fail-fast runner stopped at the MCP execution blocker |
| Resume same Session | NOT RUN | The fail-fast runner stopped at the MCP execution blocker |
| New Session receives Handoff | NOT RUN | The fail-fast runner stopped at the MCP execution blocker |
| Indexed explicit recall | NOT RUN | Requires the blocked real MCP call |
| Daemon unavailable fail-open | NOT RUN | The fail-fast runner stopped before this real-provider stage; automated regression passes |

## Blocker analysis

The daemon and Claude Code completed MCP discovery successfully. The failure
occurred after discovery, outside Memory Space:

```text
registered by Claude Code: mcp__memory_space__memory_remember
emitted by active gateway: mcp_memory_space_memory_remember
Claude Code result:         No such tool available
```

The current shell has a compatibility `ANTHROPIC_BASE_URL` and auth token. With
those variables temporarily removed, no first-party Anthropic login is
available on this machine. Adding sanitized aliases or Claude-only MCP tools
would violate the frozen exact-six shared command-plane contract, so the
project does not work around this gateway defect.

Use either:

- first-party Anthropic authentication; or
- a compatibility gateway that preserves Claude MCP tool names exactly.

Then rerun the two commands above. Only a full result ending in
`CLAUDE_P3_SMOKE_RESULT` with `overall: PASS` may replace this status and allow
P3 to be marked Frozen.

## Automated verification

- `pnpm run check`: PASS, 75/75 tests
- `pnpm run check:workspace`: PASS, 75/75 tests
- Claude smoke runner self-test: PASS

Overall: **BLOCKED / NOT PASS**
