# Codex Provider 集成

[English](./CODEX_INTEGRATION.md)

**状态：** P2 已在真实 Codex smoke 验证后冻结

协议参考：[Codex Hooks](https://developers.openai.com/codex/hooks) 和
[Codex MCP](https://developers.openai.com/codex/mcp)。

支持的拓扑是一个长期运行的 Memory Space daemon，加上 Codex 原生命令 hooks
和 Streamable HTTP MCP client：

```text
Codex hooks ──POST──> /providers/codex/lifecycle ──┐
                                                   ├── one MemorySpace / SQLite owner
Codex MCP ─────────> /mcp ─────────────────────────┘
```

hook 命令只是一个 HTTP bridge。它永远不会打开 SQLite；Memory Space 不可用时，
它会返回非阻塞警告并成功退出。MCP 命令仍然 fail-visible。

## 1. 启动 daemon

在 Memory Space checkout 中运行：

```bash
pnpm start
```

默认 endpoint：

```text
HTTP:            http://127.0.0.1:4310
Codex lifecycle: http://127.0.0.1:4310/providers/codex/lifecycle
MCP:             http://127.0.0.1:4310/mcp
```

可以通过 `MEMORY_SPACE_CODEX_HOOK_URL` 修改 hook endpoint。bridge 默认超时为
2500 ms，可通过 `MEMORY_SPACE_HOOK_TIMEOUT_MS` 修改。它不会自动重试，因为重放
对话事件可能产生重复证据。

## 2. 将项目绑定到 Space

daemon 运行后，优先在 Memory Space checkout 中使用产品 CLI：

```bash
pnpm memory-space init --cwd /absolute/path/to/project --name "My Project"
```

该命令通过 daemon 创建或确认 Space，并安全写入 v1 项目绑定。它不会修改
Codex 配置。用于调试的等价手工 API 流程仍然可用：

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  -d '{"id":"my-project","name":"My Project"}' \
  http://127.0.0.1:4310/spaces
```

在 `<project>/.memory-space/config.json` 中添加以下可信项目本地绑定：

```json
{
  "version": 1,
  "spaceId": "my-project"
}
```

原生 Codex `cwd` 只在首次绑定 Provider Session 时使用。之后每次
`SessionStart`，包括 `source = "compact"` 和 `"resume"`，都会先解析持久的
`(provider, externalSessionId)` 身份。已有 Session 及其 Space 是权威状态，
因此更改 cwd 不能迁移该 Session，也不会造成冲突。daemon 级
`MEMORY_SPACE_SPACE_ID` 是可信显式绑定：它可以绑定新 Session，但重新进入时必须
与已有 Session Space 一致，否则 hook 会返回非阻塞的
`SPACE_BINDING_CONFLICT` 警告。

## 3. 配置 Codex hooks

优先使用明确的项目级配置命令：

```bash
pnpm memory-space configure codex /absolute/path/to/project --dry-run
pnpm memory-space configure codex /absolute/path/to/project
```

它会合并五个规范 lifecycle hooks 和 `memory_space` MCP URL，而不会修改
`~/.codex`。该操作是幂等的，并在写入前预检两个目标文件。已有冲突的
Memory Space 定义、处于生效状态的用户级 Memory Space scope、格式错误的 JSON、
不受支持的 TOML 结构、符号链接和非普通文件都会被保留并报告，而不是覆盖。输出
只包含文件路径和变更状态，绝不会包含已有 token、header 或环境变量值。daemon
不使用默认 loopback 端口时，请使用 `--endpoint`。

如需手工配置，将
[`examples/codex/hooks.json`](../../examples/codex/hooks.json) 复制到项目的
`.codex/hooks.json` 或 `~/.codex/hooks.json`。不要同时使用项目级配置命令和
处于生效状态的用户级 Memory Space 配置。将每条命令中的
`/absolute/path/to/memory-space` 替换为当前 checkout 的绝对路径。

配置后的原生映射如下：

| Codex hook | Memory Space 行为 |
|---|---|
| `SessionStart` | 绑定或复用 Session，执行 bootstrap，注入附加上下文 |
| `UserPromptSubmit` | 追加完整用户消息，然后根据可信项目的 `implicitRecall.mode`，可选地注入有界的 active Indexed Memory |
| `Stop` | 当 `last_assistant_message` 存在且非空时追加该消息 |
| `PreCompact` | 仅 checkpoint 尚未提交的事件 |
| `SessionEnd` | 仅 checkpoint 尚未提交的事件 |

`PreToolUse` 和 `PostToolUse` 被有意排除，不会采集。Codex 会提供
`transcript_path`；Memory Space 只将其作为捕获消息上的不透明
`TranscriptRef` 保存，不会自动读取或复制 transcript。

在 Codex 中打开 `/hooks`，检查准确的命令定义并信任它们。hook 定义发生变化后
必须重新检查。项目本地 hooks 只会为可信项目加载。只能在一个生效的 hook 来源中
安装 Memory Space hook 配置；Codex 会合并匹配的 hook 来源并全部运行。

Codex 在 turn 级 hooks 中包含 `turn_id`。P2 adapter 会验证它，但不会持久化，
也不会将其作为幂等 key。因此，如果同一 hook 命令安装在多个生效来源中，可能会
捕获重复的 turn 证据。这是已接受的 P2 限制：只使用一个生效的 hook 来源。未来的
Provider 事件幂等设计可以使用 Provider、外部 Session 和事件元数据；
`TranscriptRef.cursor` 不会被改作保存 `turn_id`。

## 4. 配置 MCP

上面的显式 `configure codex` 命令也会合并项目级 MCP entry。如需手工配置，将
[`examples/codex/config.toml`](../../examples/codex/config.toml) 合并到当前
生效的 Codex `config.toml`。在 Codex 中打开 `/mcp`，确认 `memory_space`
已连接。

`SessionStart` 会注入不透明的内部 Session handle，以及 Core Memory 和最新
Handoff。持久 MCP 工具使用该 handle。项目绑定保留在可信 runtime 内部，不会
进入工具 schema。

`UserPromptSubmit` 支持 prompt-time Indexed 召回，不需要模拟 MCP 工具调用。
项目默认模式为 `exact`；使用 `lexical` 可执行完整 prompt 的词面召回，使用
`off` 可关闭 Indexed 自动披露。该路径永远不会搜索或重新注入 Core Memory。
如果绑定缺失、格式错误，或不再匹配 Session 已冻结的 Space，prompt 仍会被记录
并继续执行，但不会附带召回内容。

可选的项目特定自动提取规则通过
`.memory-space/extraction-rules.json` 在 Provider 之间共享。它们在 checkpoint
时求值，不会改变 Codex hook 或 MCP 配置。参见
[项目自动提取规则](./EXTRACTION_RULES.zh-CN.md)，并使用
`memory-space doctor` 验证。

## 5. 手工 smoke 测试

真实 Provider smoke 已于 2026-08-11 使用 `codex-cli 0.147.0` 通过。证据和准确的
Session 标识记录在
[`../reports/validation/CODEX_P2_SMOKE.md`](../reports/validation/CODEX_P2_SMOKE.md)。

可重复运行的 runner 需要已认证的 Codex CLI 和 macOS：

```bash
pnpm run smoke:codex:p2 -- --preflight
pnpm run smoke:codex:p2
```

只读 preflight 不会调用模型。完整 runner 只会回收之前运行中断后遗留的完全匹配
smoke hook，并拒绝替换任何其他项目 `.codex/hooks.json`。它使用临时 daemon 和
数据库状态；真实 Codex 调用期间会显示八个编号进度阶段，并每 20 秒输出一次
`WAIT` heartbeat。进度写入 stderr，最终机器可读结果保留在 stdout。只有在交叉
核对原生 hooks、Codex MCP 调用和持久化的 Memory Space 状态后，它才会报告
PASS。以下步骤仍适合独立手工复查：

1. 从已绑定项目启动 daemon 和 Codex。
2. 确认初始上下文包含 `Memory Space` Session handle。
3. 提交类似 `决定：本项目使用 SQLite。` 的 prompt，并让 Codex 生成最终回复。
4. 触发手工 compaction，使 `PreCompact` checkpoint 已捕获的 turn。
5. 正常关闭 Codex Session，然后恢复同一个原生 Session。
6. 确认再次注入了同一个不透明 Memory Session handle。
7. 在同一项目中启动另一个 Codex Session，确认 bootstrap 包含之前的最新 Handoff。
8. 停止 daemon 并启动另一个 Codex Session。Codex 应携带
   `MEMORY_SERVICE_UNAVAILABLE` 警告继续执行，不能声称 checkpoint 已保存。

进行本地检查时，使用注入的 Session handle：

```bash
curl --fail --silent http://127.0.0.1:4310/sessions/SESSION_HANDLE
curl --fail --silent http://127.0.0.1:4310/sessions/SESSION_HANDLE/events
```

Codex `SessionEnd` 是建议性信号，可能发生在归档/删除、正常关闭或超过 Provider
空闲 Session 边界之后；仅仅切换到其他对话不会立即产生结束信号。

## 安全性与当前限制

- 未认证的 v1 daemon 仅限 loopback：监听值只接受 `127.0.0.1`、`::1` 和
  `localhost`。不支持远程/LAN 部署。
- 除 `GET /health` 外，每条 daemon 路由都会在分发前执行相同的 localhost
  Host/Origin 验证。
- 带 JSON body 的 lifecycle 和 REST 请求要求
  `Content-Type: application/json`；缺少该 header 或使用其他 media type 时，
  会在 mutation 前被拒绝。
- Codex adapter 会忽略 `spaceId`、`tier`、`recommendedTier`、`actor` 和
  `force` 等 Provider 字段，它们不能成为有特权的 Memory 命令。
- Bootstrap 会将召回的 Memory 标记为不可信项目数据。不得将其视为更高优先级的
  指令。
- 完整 transcript ingestion 以及与 transcript 格式耦合的能力被有意延期。
- 仍不支持另一个拥有数据库的 Memory Space 进程同时访问同一 SQLite 文件。
