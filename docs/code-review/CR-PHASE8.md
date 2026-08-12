# CR-PHASE8 — P5 Productization Review

**Reviewed branch:** `agent/productization-v1`  
**Reviewed commit:** `a5dccaf24ca17d21c80509a6e97ea2bc1443a3cd`  
**Re-reviewed commit:** `e57095ce363afdbe4bb24ddf597f3933760a2ba6`
**Status:** PASS — FIX-01, FIX-02, and DOC-03 closed
**Phase result:** P5 implementation, validation, and code review PASS
**Next phase:** P6 Stage A ready

---

## 1. Review conclusion

P5 is close to acceptance. The implementation correctly keeps the product CLI outside the durable-store ownership boundary, reuses the canonical P4 eval instead of copying it, preserves the exact six-tool MCP contract, and keeps the P3 Claude real-MCP waiver honest.

The following are accepted:

```text
CLI is a daemon client, not a SQLite owner      PASS
LocalMemorySpaceClient loopback boundary         PASS
init create-before-bind ordering                 PASS
atomic/no-clobber binding write                  PASS
idempotent same-binding init                     PASS
doctor exact-six MCP discovery                   PASS
status read-only behavior                        PASS
P4 eval canonical-runner reuse                   PASS
runtime MCP dependency placement                 PASS
P3 scoped waiver preservation                    PASS
```

Two issues block P5 review completion:

```text
FIX-01 Claude Code config-scope detection        REQUIRED
FIX-02 nested Space init semantics                REQUIRED
```

A documentation cleanup is also requested but is not independently blocking:

```text
DOC-03 Claude identical-hook dedup wording        SHOULD FIX
```

Do not expand P5 with unrelated CLI features while addressing this review.

---

# 2. FIX-01 — Claude Code config detection must cover supported scopes

## Problem

`src/cli/provider-config.ts` currently detects Claude lifecycle hooks only from:

```text
<project>/.claude/settings.json
~/.claude/settings.json
```

and detects Claude MCP only from:

```text
<project>/.mcp.json
```

That is incomplete for the current Claude Code configuration model.

Current Claude Code settings scopes include:

```text
User    ~/.claude/settings.json
Project <project>/.claude/settings.json
Local   <project>/.claude/settings.local.json
```

Current MCP installation scopes include:

```text
Project <project>/.mcp.json
Local   ~/.claude.json under projects[<project>].mcpServers
User    ~/.claude.json user-level MCP configuration
```

Official references:

- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/mcp

Because `memory-space doctor` is intended to answer whether the current project is configured correctly, a valid local- or user-scoped Claude configuration must not be reported as `partial` or `not-configured` merely because `.mcp.json` is absent.

## Required behavior

Extend Claude detection to cover at least:

### Hooks

```text
~/.claude/settings.json
<project>/.claude/settings.json
<project>/.claude/settings.local.json
```

### MCP

```text
<project>/.mcp.json
~/.claude.json user scope
~/.claude.json projects[<resolved-current-project>] local scope
```

Do not treat an MCP entry belonging only to another project in `~/.claude.json` as configuration for the current project.

## Implementation guidance

Do not implement this by searching the entire `~/.claude.json` text for `memory_space`.

Prefer structured JSON parsing and inspect only the relevant locations.

The detector remains best-effort. It must not print or return credentials, environment values, headers, or tokens from provider configuration.

The provider detector may stay provider-local; do not move Claude config parsing into Memory Core or the common lifecycle contract.

## Required regressions

Add tests for at least:

```text
project .mcp.json                               → Claude detected
project .claude/settings.local.json hook        → hook detected
local ~/.claude.json current-project MCP        → Claude detected
user ~/.claude.json MCP                         → Claude detected
unrelated project MCP in ~/.claude.json only    → current project NOT detected
multiple active distinct Memory Space scopes    → ambiguous/warn as appropriate
secret fields in parsed provider config         → never emitted in doctor output
```

Keep detection deterministic for paths containing spaces and non-ASCII characters where supported by Node/platform behavior.

---

# 3. FIX-02 — `init` must distinguish local binding from inherited nearest binding

## Problem

`runInit()` currently uses the same nearest-ancestor resolver used for runtime Space resolution:

```text
resolveOptionalBinding(cwd)
→ SpaceResolver.resolve({ cwd })
→ nearest ancestor .memory-space/config.json
```

That behavior is correct for runtime resolution, `doctor`, and `status`, but it is insufficient for project initialization.

The frozen Provider Integration contract explicitly supports nested Space overrides in a monorepo:

```text
repo/.memory-space/config.json          → Space A
repo/apps/web/.memory-space/config.json → Space B
```

with the nearest binding winning for `repo/apps/web`.

Current `init` behavior prevents creating the legitimate nested binding when an ancestor Space already exists.

Example:

```text
repo/.memory-space/config.json = Space A
repo/apps/web/                  = no local binding
```

User runs:

```bash
cd repo/apps/web
memory-space init --space-id space-b
```

The current implementation resolves ancestor Space A and reports a binding conflict instead of allowing an explicit local nested binding for Space B.

## Required design distinction

P5 must distinguish:

```text
local/exact project binding
!=
nearest effective runtime binding
```

Conceptually, use separate operations such as:

```text
readLocalProjectBinding(cwd)
resolveNearestBinding(cwd)
```

Exact names are not prescribed.

## Required semantics

For `doctor` and `status`:

```text
use nearest effective binding
```

For `init`:

### Case A — local config already exists

```text
same requested binding
→ idempotent success

different requested binding
→ visible BINDING_CONFLICT
→ no overwrite

malformed local config
→ visible validation error
→ preserve file
```

### Case B — no local config and no ancestor binding

```text
normal init
→ create/confirm Space
→ write local config
```

### Case C — no local config, ancestor binding exists

The CLI should preserve the inherited state by default and avoid silently shadowing it.

If the user explicitly requests a different Space, for example:

```bash
memory-space init --space-id space-b
```

it must be possible to create a local nested override without editing the ancestor binding.

A conservative acceptable flow is:

```text
no local config + inherited Space A + no explicit different target
→ report inherited binding / already effectively initialized

no local config + inherited Space A + explicit Space B
→ create/confirm Space B
→ write cwd/.memory-space/config.json
→ ancestor config remains unchanged
```

Do not add an MCP rebind capability to support this. This remains a trusted human CLI operation.

## Required regressions

Add at least:

```text
root Space A + nested no local config
→ nested resolves A

root Space A + nested init with explicit Space B
→ root still resolves A
→ nested now resolves B
→ root config unchanged

root Space A + nested init without explicit different target
→ no accidental shadow config

existing nested Space B + repeat init B
→ idempotent

existing nested Space B + request C
→ conflict, no overwrite
```

This fix must not change the frozen `SpaceResolver` runtime semantics.

---

# 4. DOC-03 — Correct Claude hook dedup wording

## Current issue

The Claude integration docs currently imply that installing the same Memory Space hook bridge in multiple active scopes may duplicate Conversation-lite evidence.

Current Claude Code behavior is more precise:

```text
all matching hooks run
identical hook handlers are deduplicated automatically
command hooks are deduplicated by command string + args
```

Official references:

- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/hooks

## Required wording direction

Update the documentation to say, conceptually:

```text
Claude merges hooks from active scopes.
Identical Memory Space handlers are currently deduplicated by Claude Code.
Non-identical Memory Space definitions may still both execute.
Prefer one canonical active definition to keep lifecycle ownership and diagnostics clear.
```

`doctor` may still warn about multiple active Memory Space definitions because multiple scopes are operationally ambiguous even when identical commands deduplicate.

This is a docs/diagnostic-accuracy cleanup, not a Memory architecture change.

---

# 5. Non-blocking future improvement — richer eval CLI failures

`runCrossSessionEval()` currently converts any scenario assertion failure into a generic message:

```text
Canonical P4 assertion failed
```

This is acceptable for P5 because the canonical node:test path still retains full assertion diagnostics.

A future CLI improvement may expose a stable failing stage/check ID without printing raw assertion stacks or temporary/private paths.

Do NOT turn this into a P5 refactor unless it is trivial while touching the runner.

---

# 6. Guardrails for the fix pass

The fix pass must preserve all accepted architecture:

```text
CLI normal path never opens SQLite
one daemon remains the active durable-store owner
exact shared MCP surface remains six tools
no Claude-only MCP aliases
no new raw admin/CRUD MCP tools
P3 real Claude MCP remains WAIVED / externally blocked
P4 canonical assertions remain intact
P6 Memory Quality implementation does not start
```

Do not introduce a new read API unless a concrete P5 requirement cannot be satisfied through existing safe boundaries.

Do not change frozen `PRODUCT_SPEC.md`, `DOMAIN_MODEL.md`, or Provider Integration runtime binding semantics to make the CLI easier.

---

# 7. Verification required before re-review

Run and record actual results for:

```bash
pnpm run check
pnpm run check:workspace
```

Also run focused CLI tests covering the two fixes.

Manual smoke should include at least:

```text
normal project init/doctor/status
nested project inheriting root binding
nested explicit Space override
Claude project-scope config detection
Claude local/user-scope config detection where practical
```

Do not claim GitHub CI green unless a real workflow/status is visible.

---

# 8. Re-review completion report

When the fixes are complete, report:

1. exact files changed;
2. Claude scopes now detected;
3. how `~/.claude.json` is parsed without cross-project false positives;
4. nested-binding init semantics;
5. proof ancestor config is preserved;
6. tests added for FIX-01;
7. tests added for FIX-02;
8. DOC-03 wording change;
9. `pnpm run check` result;
10. `pnpm run check:workspace` result;
11. manual CLI smoke performed;
12. P3 Claude MCP waiver status;
13. any remaining P5 blocker.

Stop after these fixes and documentation updates. Do not begin P6 before re-review.

---

## 9. Re-review outcome

```text
P5 implementation     COMPLETE
P5 automated tests    PASS
P5 CLI smoke          PASS
P5 code review        PASS
P6                     READY
```

FIX-01, FIX-02, and DOC-03 were implemented without weakening the accepted
boundaries. The recorded hardening verification passed 98/98 tests in both
`pnpm run check` and `pnpm run check:workspace`; the nested binding and Claude
configuration scope smoke checks passed. P3 real Claude model-driven MCP
remains externally blocked under its existing scoped waiver.
