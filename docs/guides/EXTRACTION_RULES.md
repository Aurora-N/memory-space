# Project Extraction Rules

[中文](./EXTRACTION_RULES.zh-CN.md)

Project extraction rules extend the deterministic built-in extractor without
adding executable code, arbitrary regular expressions, provider-specific
payloads, or a path around Memory admission policy.

The default extractor is domain-neutral. It recognizes general durable-memory
semantics such as explicit decisions, constraints, goals, and current tasks,
but it does not reserve database, framework, cloud, or other technology-domain
vocabulary. Add those conventions here when a project needs them.

## Location and lifecycle

Place the optional file next to the effective project binding:

```text
<binding-directory>/.memory-space/config.json
<binding-directory>/.memory-space/extraction-rules.json
```

The nearest ancestor `config.json` still selects the Space. Memory Space loads
the rule file beside that selected binding and applies it only when its
`spaceId` matches the checkpoint Session. A nested directory inheriting an
ancestor binding therefore inherits the ancestor rule file.

For provider Sessions, the binding source selected at first Session creation is
stored with the Session. Daemon restarts and later provider `cwd` changes do not
silently switch that Session to another project's rule file. At checkpoint,
the binding file at that exact stored path must still be a valid regular binding
for the Session's frozen Space. If it is missing, malformed, no longer a regular
accepted binding file, or rebound to another Space, project rules are not
applied to that Session. Memory Space does not search for a replacement binding
from the daemon's current `cwd`.

Rules are read at each checkpoint, so a valid change applies to the next
`PreCompact`, `SessionEnd`, or explicit `memory_checkpoint`. Prompt and final
response hooks only append evidence; they do not evaluate rules immediately.

When `MEMORY_SPACE_SPACE_ID` is used as an explicit trusted override, no
project rule file is loaded because there is no binding file that can own it.

## Example

Copy and adapt
[`examples/memory-space/extraction-rules.json`](../../examples/memory-space/extraction-rules.json):

```json
{
  "version": 1,
  "rules": [
    {
      "id": "project.frontend.framework",
      "family": "knowledge",
      "type": "decision",
      "key": "project.frontend.framework",
      "match": {
        "kind": "prefix",
        "prefixes": ["前端框架使用", "Frontend framework:"],
        "value": "identifier",
        "caseSensitive": false
      },
      "contentTemplate": "前端框架使用 ${value}",
      "coreCandidate": true
    }
  ]
}
```

This rule turns either of these lines into the keyed candidate
`project.frontend.framework`:

```text
前端框架使用 React。
Frontend framework: Vue
```

With `value: "identifier"`, the captured value is the first ASCII identifier,
including letters, digits after the first character, `_`, `.`, `+`, and `-`.
The examples therefore produce `React` and `Vue` without trailing punctuation.

Use `value: "text"` to capture the complete trimmed remainder of the line.

### Migrating the former database convention

Database wording is not built in. Add this ordinary project rule when that
convention is useful:

```json
{
  "id": "project.database",
  "family": "knowledge",
  "type": "decision",
  "key": "project.database",
  "match": {
    "kind": "prefix",
    "prefixes": [
      "数据库已确定使用",
      "数据库确定使用",
      "数据库已使用",
      "数据库使用"
    ],
    "value": "identifier",
    "caseSensitive": false
  },
  "contentTemplate": "数据库使用 ${value}",
  "coreCandidate": true
}
```

## Schema

Top-level fields:

| Field | Contract |
| --- | --- |
| `version` | Required integer `1`. |
| `rules` | Required array with at most 64 entries. |

Rule fields:

| Field | Contract |
| --- | --- |
| `id` | Required unique identifier, at most 80 characters: lowercase letters, digits, `.`, `_`, `-`. |
| `enabled` | Optional boolean, default `true`. Disabled rules are ignored. |
| `family` | Required: `knowledge`, `state`, `episode`, or `procedure`. |
| `type` | Required lowercase type identifier, at most 64 characters. |
| `key` | Optional stable Memory key, at most 128 characters. A keyed rule updates/deduplicates that Memory; an unkeyed rule creates a new candidate. One enabled key may be owned by only one rule in a document. |
| `match` | Required bounded prefix matcher described below. |
| `contentTemplate` | Required template, at most 500 characters, using only `${value}`. |
| `coreCandidate` | Optional boolean, default `false`. It recommends Core but cannot force it. |

When several phrases represent the same keyed Memory, put those alternatives
in one rule's `prefixes` array. Multiple enabled rules with the same `key` are
invalid, even when their family and type are identical. Disabled rules do not
participate in this check.

Matcher fields:

| Field | Contract |
| --- | --- |
| `kind` | Must be `prefix`. Arbitrary regex and executable matchers are rejected. |
| `prefixes` | 1–16 non-empty line-start prefixes, each at most 120 characters. |
| `value` | Optional `text` or `identifier`; default `text`. |
| `caseSensitive` | Optional boolean; default `false`. |

Unknown fields are rejected. The file must be valid JSON, a regular
non-symlink file, and no larger than 64 KiB. Captured values and rendered
content are also bounded.

## Policy boundaries

- Project rules are additive. Built-in deterministic extraction remains active.
- Rules only emit `MemoryCandidate` values from persisted message evidence.
- `coreCandidate: true` sets a recommendation and a generated reason. Existing
  type eligibility, bounded-local filtering, Core capacity, provenance,
  checkpoint transaction, and Space isolation still apply.
- Configured confidence and importance are fixed by the runtime; the file
  cannot supply trusted scores, tier, status, actor, target Memory ID, source
  event IDs, operation, or checkpoint boundaries.
- Existing transient-evidence filtering still rejects current command/tool/test
  narration.
- A configured rule may extend a built-in key only with the same family/type
  schema. Conflicting configured schemas are rejected.
- Built-in rule IDs are reserved and cannot be replaced.

An invalid file fails configured extraction closed. The checkpoint is not
partially committed; lifecycle hooks remain fail-open for the provider, while
explicit MCP checkpoint calls surface the failure.

## Validate

Run:

```bash
pnpm memory-space doctor /absolute/path/to/project
```

The `extraction-rules` check reports the number of enabled rules or an
actionable validation error. After a successful checkpoint, use the Inspector
or `memory_search` to verify the resulting Memory and tier.
