# Claude Code Provider 集成

[English](./CLAUDE_CODE_INTEGRATION.md)

**状态：** P3 实现、自动化验证、代码审查和真实 hook lifecycle 已通过；真实模型
驱动的 MCP 仍受外部因素阻塞。P3 已通过范围明确的推进豁免，但尚未冻结。

官方参考：

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-usage)
- [Claude Code sessions](https://code.claude.com/docs/en/sessions)

该集成使用一个长期运行的 daemon 同时承载 lifecycle 和 MCP：

```text
Claude command hooks ──POST──> /providers/claude-code/lifecycle ──┐
                                                                 ├── one MemorySpace / SQLite owner
Claude HTTP MCP ─────────────> /mcp ──────────────────────────────┘
```

hook 命令是一个有界的 HTTP bridge，永远不会拥有 SQLite。Lifecycle 失败时会
返回非阻塞的 `systemMessage` 并成功退出；显式 MCP 命令仍然 fail-visible。

## 1. 启动并绑定

在 Memory Space checkout 中启动 daemon：

```bash
pnpm start
```

默认 endpoint：

```text
HTTP:               http://127.0.0.1:4310
Claude lifecycle:   http://127.0.0.1:4310/providers/claude-code/lifecycle
MCP:                http://127.0.0.1:4310/mcp
```

`MEMORY_SPACE_CLAUDE_CODE_HOOK_URL` 用于修改 lifecycle endpoint。bridge
默认超时为 2500 ms，可通过 `MEMORY_SPACE_HOOK_TIMEOUT_MS` 修改。事件不会自动
重试，因为重放可能产生重复的 Conversation-lite 证据。

daemon 运行后，优先在 Memory Space checkout 中使用产品 CLI：

```bash
pnpm memory-space init --cwd /absolute/path/to/project --name "My Project"
```

该命令通过 daemon 创建或确认 Space，并安全写入 v1 项目绑定。它不会修改
Claude 配置。用于调试的等价手工 API 流程仍然可用：

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  -d '{"id":"my-project","name":"My Project"}' \
  http://127.0.0.1:4310/spaces
```

`<project>/.memory-space/config.json`：

```json
{
  "version": 1,
  "spaceId": "my-project"
}
```

第一次 `SessionStart` 会解析最近的绑定。之后的启动重入、resume、clear 和
compact 后启动，都会先解析持久的 `(provider, externalSessionId)` 身份。已有
内部 Session 及其 Space 是权威状态，因此更改 `cwd` 不能迁移该 Session。可信
daemon `MEMORY_SPACE_SPACE_ID` 覆盖必须与已有绑定一致。

## 2. 配置 Claude hooks

推荐使用明确的项目级 CLI 命令。先预览合并，再实际应用：

```bash
pnpm memory-space configure claude-code /absolute/path/to/project --dry-run
pnpm memory-space configure claude-code /absolute/path/to/project
```

它会结构化合并 `.claude/settings.json`，保留无关设置，并以文档规定的八秒超时
安装五个规范 lifecycle handlers。重复执行同一命令是幂等的。在写入任一
Provider 文件前，它会拒绝冲突的 Memory Space hooks、格式错误或非普通文件的
配置，以及另一个处于生效状态的 Memory Space hook scope。它永远不会修改用户级
Claude 配置，也不会打印已有 secret。

如需手工设置，将
[`examples/claude-code/settings.json`](../../examples/claude-code/settings.json)
合并到目标项目的 `.claude/settings.json` 或 `.claude/settings.local.json`，
也可以合并到用户级 `~/.claude/settings.json`。将每条命令中的
`/absolute/path/to/memory-space` 替换为当前 checkout 的绝对路径。

Claude Code 会合并所有生效 settings scope 中的 hooks。目前会对相同 handler
去重；command hook 根据命令字符串和参数去重。不同的 Memory Space 定义仍可能
同时执行。应优先保留一个规范且明确生效的定义，使 lifecycle 所有权和诊断保持
清晰。因此，即使 Claude 会对相同 handler 去重，`memory-space doctor` 在多个
生效 scope 中发现 Memory Space 定义时仍会发出警告。

原生映射遵循当前官方 lifecycle contract：

| Claude Code hook | Memory Space 行为 |
|---|---|
| `SessionStart` | 绑定或复用 Session，执行 bootstrap，注入 `additionalContext` |
| `UserPromptSubmit` | 追加原始完整用户 prompt，然后根据可信项目的 `implicitRecall.mode`，可选地注入有界的 active Indexed Memory |
| `Stop` | 当可靠的 `last_assistant_message` 非空时追加该消息 |
| `PreCompact` | 仅 checkpoint 尚未提交的事件 |
| `SessionEnd` | 仅 checkpoint 尚未提交的事件 |

Claude 的 `prompt_id`、`permission_mode`、task hooks、工具轨迹以及任何具有
特权形状的自定义字段都不是可信 Memory 命令。默认忽略 `PostToolUse`、
`TaskCompleted` 和其他 Claude 专属事件。原生 `transcript_path` 只作为不透明的
`TranscriptRef` 保存；Memory Space 不会解析或复制 transcript。

`SessionEnd` 通常有 1.5 秒的 hook 总预算。示例为每个 hook 设置八秒超时，
Claude Code 会使用该值提高总预算。

## 3. 配置共享 MCP server

`configure claude-code` 命令还会把规范的 `memory_space` HTTP server 结构化
合并到目标项目的 `.mcp.json`。它会拒绝冲突 entry，并检查 `~/.claude.json`
中的用户级和当前项目 entry，但不会把无关项目视为生效，也不会披露这些 entry
的值。只接受 loopback daemon endpoint。

如需手工设置，将
[`examples/claude-code/mcp.json`](../../examples/claude-code/mcp.json) 复制到
目标项目根目录并命名为 `.mcp.json`，或将其中的 `memory_space` entry 合并到
已有文件。Claude 还支持在 `~/.claude.json` 当前项目 entry 下配置项目本地 MCP，
以及在该文件顶层配置用户级 MCP；`memory-space doctor` 能识别这三种 scope。
运行 `/mcp`，确认 `memory_space` 已连接。

Claude 与所有其他 Provider 使用相同的六个工具：

```text
memory_bootstrap
memory_context
memory_search
memory_remember
memory_promote
memory_checkpoint
```

不存在 Claude 专属 MCP 工具。`SessionStart` 会注入不透明的内部 Session handle，
以及 Core 和最新 Handoff 上下文。持久写入和显式召回应使用该 handle。

`UserPromptSubmit` 也可以通过原生 `additionalContext` 交付 prompt-time Indexed
召回；它不会增加 Claude 专属 MCP alias 或工具。项目模式默认为 `exact`，
`lexical` 启用完整 prompt 的词面召回，`off` 关闭 Indexed 自动披露。Core 被
排除在该路径之外。绑定、配置或召回失败时，Claude prompt 仍保持 fail-open。

可选的项目特定自动提取规则通过
`.memory-space/extraction-rules.json` 在 Provider 之间共享。它们在 checkpoint
时求值，不会改变 Claude hook 或 MCP 配置。参见
[项目自动提取规则](./EXTRACTION_RULES.zh-CN.md)，并使用
`memory-space doctor` 验证。

## 4. 自动化与真实验证

常规项目检查包含原生 adapter 回归、daemon 路由、Provider 一致性和持久 Claude
lifecycle eval：

```bash
pnpm run check
pnpm run check:workspace
```

真实 Provider runner 使用临时 Claude settings、MCP 配置、workspace、SQLite 和
daemon 状态。它不会在此仓库或目标项目中创建或替换 `.claude` 文件：

```bash
pnpm run smoke:claude:p3 -- --preflight
pnpm run smoke:claude:p3
```

如果已配置的模型网关无法执行 MCP 工具，可以单独运行真实 hook lifecycle：

```bash
pnpm run smoke:claude:p3 -- --hooks-only
```

Hook-only 模式不加载 MCP 配置，但会继续完成真实 startup/bootstrap、prompt 和
最终回复捕获、SessionEnd、resume、PreCompact、`SessionStart(source=compact)`、
跨 Session Handoff，以及 daemon 不可用时的 fail-open 检查。它的机器可读结果行
为 `CLAUDE_P3_HOOK_SMOKE_RESULT`。MCP 连接、remember/search 和 Indexed 显式召回
会报告为 `SKIPPED`，`p3FreezeEligible` 为 `false`。该诊断 PASS 不满足 P3
冻结门槛。

可靠的 `Stop.last_assistant_message` 要求 Claude Code 2.1.47 或更高版本；
preflight 会拒绝更旧的 client。要在不替换全局安装的情况下测试当前官方 CLI，
请明确固定临时 package 版本：

```bash
MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --preflight

MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3

MEMORY_SPACE_CLAUDE_PACKAGE_VERSION=2.1.227 \
  pnpm run smoke:claude:p3 -- --hooks-only
```

完整运行会发起真实模型调用，可能需要几分钟。进度以八个阶段写入 stderr，并每
20 秒输出一次 `WAIT` heartbeat；stdout 上最后的 `CLAUDE_P3_SMOKE_RESULT` 行是
机器可读的。运行失败时，会保留临时 artifact 目录供检查。runner 在最终结果中
只记录非 secret 证据；不要发布 artifact 目录，因为其中包含 smoke transcript
和 debug log。

当前机器使用的 `ANTHROPIC_BASE_URL` 兼容网关会将 Claude MCP 名称，例如
`mcp__memory_space__memory_search`，改写为
`mcp_memory_space_memory_search`。即使 `/mcp` 已连接且六个工具均已发现，
Claude Code 仍会拒绝改写后的名称。这是外部 client/网关兼容性阻塞，不是增加
alias 工具的理由。请使用 Anthropic 第一方认证，或使用能够保留 MCP 工具名称的
网关，然后重新运行上述命令。在该运行输出 `overall: PASS` 前，P3 不能标记为
Frozen。

## 安全性与当前限制

- 未认证的 v1 daemon 仅限 loopback。在未来提供带认证的设计之前，不支持
  LAN/远程部署。
- 除 `GET /health` 外，所有 daemon 路由共享相同的 localhost Host/Origin
  验证。JSON lifecycle 请求要求 `Content-Type: application/json`。
- Provider payload 字段不能选择 Space、tier、status、actor、promotion、
  checkpoint 边界或幂等 key。
- Bootstrap 会明确将召回的 Memory 标记为不可信项目数据。
- 完整 transcript ingestion 和 Provider 事件去重仍被延期。
- 在 P3 状态改为 Frozen 前，必须在 `docs/reports/validation/` 下记录真实 smoke
  PASS。
