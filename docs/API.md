# memory-space daemon API

The default daemon listens on `127.0.0.1:4310`, owns one `MemorySpace`, and serves the JSON HTTP API plus the Streamable HTTP MCP endpoint at `/mcp`. HTTP API error responses use:

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
| `space.create` | `POST /spaces` |
| `space.get` | `GET /spaces/:spaceId` |
| `session.create` | `POST /spaces/:spaceId/sessions` |
| `session.get` | `GET /sessions/:sessionId` |
| `session.appendEvent` | `POST /sessions/:sessionId/events` |
| `memory.remember` | `POST /spaces/:spaceId/memories` |
| `memory.get` | `GET /memories/:memoryId` |
| `memory.search` | `GET /spaces/:spaceId/memories/search?query=...` |
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
