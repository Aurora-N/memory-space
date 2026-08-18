# memory-space daemon API

[English](./API.md)

默认的 v1 daemon 不提供认证，仅供本机使用。它只接受明确的 loopback 监听主机
`127.0.0.1`、`::1` 和 `localhost`；在未来提供带认证的设计之前，不支持远程或
LAN 部署。daemon 拥有一个 `MemorySpace` 实例，并提供 JSON HTTP API 以及位于
`/mcp` 的 Streamable HTTP MCP endpoint。

除 `GET /health` 外，所有路由在分发前都会经过同一套 localhost Host/Origin
检查。所有接收 JSON body 的 HTTP endpoint 都要求
`Content-Type: application/json`，允许 `charset=utf-8` 等参数；缺少该 header
或使用其他 media type 时，会在发生 mutation 前被拒绝。HTTP API 错误响应格式为：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "..."
  }
}
```

## 能力映射

| 能力 | HTTP endpoint |
| --- | --- |
| MCP command plane | `GET /mcp`、`POST /mcp`、`DELETE /mcp` |
| Codex lifecycle plane | `POST /providers/codex/lifecycle` |
| `space.create` | `POST /spaces` |
| `space.get` | `GET /spaces/:spaceId` |
| `session.create` | `POST /spaces/:spaceId/sessions` |
| `session.get` | `GET /sessions/:sessionId` |
| `session.appendEvent` | `POST /sessions/:sessionId/events` |
| `memory.remember` | `POST /spaces/:spaceId/memories` |
| `memory.get` | `GET /memories/:memoryId` |
| `memory.search` | `GET /spaces/:spaceId/memories/search?query=...` |
| Inspector Memory 浏览 | `GET /spaces/:spaceId/memories` |
| Inspector 概览 | `GET /spaces/:spaceId/overview` |
| Inspector 可信绑定 | `GET /inspector/api/binding` |
| `memory.context` | `POST /spaces/:spaceId/memory-context` |
| `memory.promote` | `POST /memories/:memoryId/promote` |
| `memory.demote` | `POST /memories/:memoryId/demote` |
| Memory 状态转换 | `POST /memories/:memoryId/status` |
| Memory 来源/历史 | `GET /memories/:memoryId/history` |
| `checkpoint.create` | `POST /sessions/:sessionId/checkpoints` |
| `checkpoint.get` | `GET /checkpoints/:checkpointId` |
| `handoff.getLatest` | `GET /spaces/:spaceId/handoff/latest` |
| `bootstrap` | `GET /spaces/:spaceId/bootstrap` |

搜索支持逗号分隔的 `families`、`types`、`tiers` 和 `statuses`，以及范围为
1 到 100 的 `limit`。省略 `statuses` 时默认为 `active`。

Inspector 浏览支持相同的逗号分隔筛选项、范围为 1 到 100 的 `limit`，以及
不透明的 `cursor`。这是按最近更新时间排序的数据库浏览操作，不是相关性搜索；
省略 `statuses` 时会包含所有状态。绑定 endpoint 解析 daemon 的可信显式 Space
或最近的项目配置，不接受调用方指定的 Space。参见
[`../specs/LOCAL_INSPECTOR_SPEC.md`](../specs/LOCAL_INSPECTOR_SPEC.md)。

Codex lifecycle endpoint 接收原生 Codex hook JSON。有效 HTTP 请求经过处理后，
它始终返回面向 Provider 的 `ok`、`ignored` 或 fail-open `warning` 结果。它不接受
可信 Memory 命令，也不接受由调用方控制的 Space、tier 或 actor 覆盖。参见
[`./CODEX_INTEGRATION.zh-CN.md`](./CODEX_INTEGRATION.zh-CN.md)。

`memory.remember` 创建的新 Memory 始终为 Indexed；调用方之后必须使用 promotion
endpoint 才能提升。HTTP remember endpoint 会拒绝传入 `tier`。HTTP promotion
endpoint 只接受 `reason`；由于 MVP 没有经过认证的用户边界，其 actor 固定为
`agent`。可信 application 调用方仍可直接请求由用户授权的 promotion。

## Checkpoint 事件输入

确定性的 MVP extractor 能识别规范化的 `memory` 事件，以及以下保守的消息形式：

```text
目标：交付跨 Agent 记忆系统
数据库确定使用 PostgreSQL。
先完成 recall API
```

为了实现确定性的 Provider 集成，请追加结构化事件：

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

省略 `sourceEventIds` 时，adapter 会使用承载该候选项的事件 ID 填充它。提取过程
只负责提出候选项；domain policy 负责验证并提交。
