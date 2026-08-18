# P7 Provider Capability Spike

**Date:** 2026-08-17
**Review base:** `4a32ebb387a4d56627bb61554fcfb8332ffa4071`
**Platform:** macOS 15.7.3, arm64
**Scope:** P7.0A native capability and P7.0B production bridge

## Result

| Provider | CLI | UserPromptSubmit observed | Structured additionalContext emitted | Model-visible marker observed | P7.0A |
|---|---|---:|---:|---:|---|
| Codex | `codex-cli 0.147.0` | yes | yes | yes | PASS |
| Claude Code | `2.1.112 (Claude Code)` | yes | yes | yes | PASS |

Overall P7.0A: **PASS**

P7.0B Memory Space bridge: **PASS**

| Provider | Production hook client | Loopback lifecycle endpoint | Indexed exact recall | Model answer without Memory MCP | P7.0B |
|---|---:|---:|---:|---:|---|
| Codex | yes | yes | yes | `lavender-731` | PASS |
| Claude Code | yes | yes | yes | `CROSS_AGENT_TEST_20260817 = lavender-731` | PASS |

Overall P7.0B: **PASS**

## Method

The repository runner is:

```text
pnpm run smoke:p7:capability
```

Each provider was invoked through its real installed CLI and authenticated account. The runner installed only a temporary `UserPromptSubmit` command hook:

- Codex used a runner-owned project `.codex/hooks.json` in the already trusted repository. It refused to replace an existing file and removed only an unchanged runner-owned file after execution.
- Claude Code used an isolated temporary `--settings` file with no normal setting sources.
- No Memory Space daemon or MCP server participated in P7.0A.
- Hook logs retained only event shape booleans and the fixed non-secret capability output. Tokens, headers, environment values, authentication material, Session ids, and transcript contents were not recorded.

The submitted user prompt contained only the failure token. The success token existed only in hook-provided `additionalContext`, preventing a model from passing by copying or guessing it from the user prompt.

## Input observed

For both providers the command hook observed:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "<exact controlled capability prompt>"
}
```

The complete provider payload was intentionally not persisted in the validation document because unrelated native fields may contain machine- or Session-specific data.

## Output emitted

Both hooks emitted:

```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Capability marker: P7_NATIVE_USER_PROMPT_CONTEXT_20260817. Reply with exactly P7_USER_PROMPT_CONTEXT_PASS."
  }
}
```

Both real provider models returned exactly:

```text
P7_USER_PROMPT_CONTEXT_PASS
```

This proves the native installed CLIs can deliver synchronous `UserPromptSubmit.additionalContext` to model context while allowing the prompt to continue normally.

## Boundary

P7.0A proves only the native provider capability. P7.0B was subsequently run with:

```text
pnpm run smoke:p7
```

The runner used the real installed CLIs, a temporary SQLite database, the
production hook commands, loopback provider lifecycle endpoints, the production
Indexed exact-recall path, and the production renderer. The only submitted user
prompt was `CROSS_AGENT_TEST_20260817`; the value `lavender-731` came from
Memory Space `additionalContext`. Neither provider invoked `memory_search` or
`memory_context`, and the disclosed context contained no runtime Memory id.

The same run separately recorded the required real-agent behavior:

| Scenario | Codex | Claude Code | Memory MCP call |
|---|---|---|---:|
| Bare key | `lavender-731` | `CROSS_AGENT_TEST_20260817 = lavender-731` | no |
| Natural lexical query | returned `a`, `b`, `c` | returned `a`, `b`, `c` | no |
| Stale React 18 Memory vs current 19.0.0 file | reported conflict; used 19.0.0 | reported conflict; used 19.0.0 | no |
| Explicit prompt opt-out | did not return recalled values | did not return recalled values | no |

All eight provider/scenario stages passed. The stale holdout used a runner-owned
workspace file and allowed only normal repository reading; it did not expose a
Memory MCP server to the model.

The runner refuses to replace an existing project `.codex/hooks.json`, removes
only an unchanged runner-owned hook file, uses isolated Claude settings, and
preserves temporary artifacts after failure.
