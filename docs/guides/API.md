# memory-space daemon API

[中文](./API.zh-CN.md)

The default unauthenticated v1 daemon is local-only. It accepts only the
explicit loopback listen hosts `127.0.0.1`, `::1`, and `localhost`; remote or
LAN deployment is unsupported without a future authenticated design. It owns
one `MemorySpace` and serves the JSON HTTP API plus the Streamable HTTP MCP
endpoint at `/mcp`.

Every route except `GET /health` passes the same localhost Host/Origin guard
before routing. Every HTTP endpoint that consumes a JSON body requires
`Content-Type: application/json` (parameters such as `charset=utf-8` are
accepted); missing or other media types are rejected before mutation. HTTP API
error responses use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  }
}
```

## Capability map

| Capability | HTTP endpoint |
| --- | --- |
| MCP command plane | `GET /mcp`, `POST /mcp`, `DELETE /mcp` |
| Codex lifecycle plane | `POST /providers/codex/lifecycle` |
| `space.create` | `POST /spaces` |
| `space.get` | `GET /spaces/:spaceId` |
| `session.create` | `POST /spaces/:spaceId/sessions` |
| `session.get` | `GET /sessions/:sessionId` |
| `session.appendEvent` | `POST /sessions/:sessionId/events` |
| `memory.remember` | `POST /spaces/:spaceId/memories` |
| `memory.get` | `GET /memories/:memoryId` |
| `memory.search` | `GET /spaces/:spaceId/memories/search?query=...` |
| Inspector Memory browse | `GET /spaces/:spaceId/memories` |
| Inspector overview | `GET /spaces/:spaceId/overview` |
| Inspector trusted binding | `GET /inspector/api/binding` |
| Inspector trusted Sessions | `GET /inspector/api/sessions` |
| Inspector trusted Session events | `GET /inspector/api/sessions/:sessionId/events` |
| `memory.context` | `POST /spaces/:spaceId/memory-context` |
| `memory.promote` | `POST /memories/:memoryId/promote` |
| `memory.demote` | `POST /memories/:memoryId/demote` |
| memory status transition | `POST /memories/:memoryId/status` |
| memory provenance/history | `GET /memories/:memoryId/history` |
| `checkpoint.create` | `POST /sessions/:sessionId/checkpoints` |
| `checkpoint.get` | `GET /checkpoints/:checkpointId` |
| `handoff.getLatest` | `GET /spaces/:spaceId/handoff/latest` |
| `bootstrap` | `GET /spaces/:spaceId/bootstrap` |

Search supports comma-separated `families`, `types`, `tiers`, and `statuses`, plus a `limit` from 1 to 100. Omitted statuses default to `active`.

Inspector browse supports the same comma-separated filters, a `limit` from 1
to 100, and an opaque `cursor`. It is a database-browse operation ordered by
latest update, not a relevance search; omitted statuses include all statuses.
The binding endpoint resolves the daemon's trusted explicit Space or nearest
project config and does not accept a caller-selected Space. See
[`../specs/LOCAL_INSPECTOR_SPEC.md`](../specs/LOCAL_INSPECTOR_SPEC.md).

The Codex lifecycle endpoint accepts native Codex hook JSON and always returns
a provider-facing `ok`, `ignored`, or fail-open `warning` result after a valid
HTTP request. It never accepts a trusted Memory command or a caller-controlled
Space/tier/actor override. See [`./CODEX_INTEGRATION.md`](./CODEX_INTEGRATION.md).

`memory.remember` always creates new Memory as Indexed; callers must use the promotion endpoint afterward. Supplying `tier` to the HTTP remember endpoint is rejected. The HTTP promotion endpoint accepts only `reason`; its actor is fixed to `agent` because the MVP has no authenticated user boundary. Trusted application callers may still request user-authoritative promotion directly.

## Checkpoint event input

The deterministic MVP extractor recognizes normalized `memory` events and conservative message forms such as:

```text
目标：交付跨 Agent 记忆系统
数据库确定使用 PostgreSQL。
先完成 recall API
```

For deterministic provider integration, append a structured event:

```json
{
  "type": "memory",
  "payload": {
    "candidate": {
      "family": "knowledge",
      "type": "decision",
      "key": "project.database",
      "content": "PostgreSQL",
      "confidence": 1,
      "recommendedTier": "core",
      "promoteReason": "Project-wide database decision",
      "operation": "update"
    }
  }
}
```

The adapter fills `sourceEventIds` with the containing event ID when omitted. Extraction only proposes candidates; the domain policy validates and commits them.
