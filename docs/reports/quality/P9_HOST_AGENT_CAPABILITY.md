# P9 Host-Agent Semantic Capability

**Date:** 2026-08-20

**P9 semantic extraction spec:** `dee763a1df265b3a93809bb2ce4edf129fa52fe1`

**P9 backend amendment:** `cc8c86930cc4a729772534448f3d0ceabf24518d`

## Summary

| Provider | CLI | Status | Reason |
|---|---|---|---|
| Claude Code | 2.1.112 | PASS | Real isolated structured extraction and production pipeline smoke passed |
| Codex | 0.147.0 | UNSUPPORTED | CLI contract does not expose a reviewed way to disable all tools, MCP, and hooks |

## Claude Code

The reviewed invocation uses:

```text
claude -p
--output-format json
--json-schema <strict P9 schema>
--tools ""
--strict-mcp-config
--mcp-config {"mcpServers":{}}
--setting-sources ""
--disable-slash-commands
--no-session-persistence
--permission-mode dontAsk
```

The process runs in a new empty temporary directory with:

```text
MEMORY_SPACE_INTERNAL_INVOCATION=semantic-extraction
```

Memory Space provider hooks recognize this marker and return before reading
stdin, resolving a Session, contacting the daemon, recalling Memory, writing
Memory, or spawning another semantic child. Only a narrow environment allowlist
is inherited; unrelated API credentials are not forwarded.

Real capability observations:

- non-interactive one-shot invocation: PASS;
- strict structured output: PASS;
- built-in tools disabled: PASS;
- Memory Space MCP disabled through strict empty MCP configuration: PASS;
- project/user settings sources disabled: PASS;
- isolated temporary cwd: PASS;
- session persistence disabled: PASS;
- exact event ID and verbatim quote proposal: PASS;
- no tool use or permission denial in observed result: PASS;
- bounded 30 second timeout and output limits: PASS;
- deterministic hook recursion bypass: PASS;
- production daemon variant-to-Indexed pipeline: PASS;
- Session B lexical recall of `a、b、c`: PASS;
- extra semantic-child Session/Event/receipt creation: not observed.

Command:

```text
node scripts/p9-real-smoke.mjs --provider claude-code
```

Observed result:

```json
{
  "provider": "claude-code",
  "status": "PASS",
  "semanticMemoryRows": 2,
  "indexedOnly": true,
  "crossSessionRecall": true
}
```

Claude Code `--bare` was deliberately not used because version 2.1.112 documents
that it does not read OAuth/keychain authentication. The reviewed invocation
instead disables settings sources, tools, MCP, slash commands, persistence, and
project discovery through an empty cwd while retaining the user's existing
Claude Code account.

## Codex

Codex `exec` supports non-interactive operation, output schemas, ephemeral
sessions, ignored user config/rules, isolated cwd, and sandbox selection.
However, Codex CLI 0.147.0 does not expose a reviewed contract that disables all
tools, MCP servers, and lifecycle hooks for this child process.

Because the P9 host-agent gate requires proven tool/MCP/hook isolation, Codex is
recorded as **UNSUPPORTED**, not PASS. The resolver returns
`capability_unsupported`, setup rejects an explicit Codex host selection, and
no Codex host semantic adapter is shipped.

The recursion marker is still implemented in the Codex Memory Space hook as
defense in depth, but that marker alone is not sufficient to satisfy the host
capability gate.
