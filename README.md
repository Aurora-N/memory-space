# memory-space

> 面向编码 Agent 的、与 Provider 无关的持久记忆层。
>
> A provider-neutral persistent memory layer for coding agents.

[中文](#readme-zh) · [English](#readme-en)

```text
Codex ─┐
Claude ├─ MCP + Lifecycle → MemorySpace → SQLite
Other ─┘
```

它让项目记忆跨越 Session、进程重启和 Provider，同时控制：哪些内容值得记住、哪些内容可被搜索、哪些内容进入默认上下文，以及哪些状态应交接给下一个 Agent。

It preserves durable project memory across sessions, process restarts, and providers, while controlling what gets remembered, what is searchable, what becomes default context, and what is handed off to the next agent.

```mermaid
flowchart LR
  subgraph Agents["Coding Agents"]
    Codex["Codex"]
    Claude["Claude Code"]
    Other["Other agents<br/>(adapter required)"]
  end

  subgraph Integration["Provider-neutral Integration"]
    Lifecycle["Lifecycle Hooks<br/>bootstrap · prompt recall · capture · checkpoint"]
    MCP["MCP Command Plane<br/>exactly six tools"]
  end

  subgraph Runtime["Local Memory Space Daemon"]
    Handler["LifecycleHandler"]
    MemorySpace["MemorySpace<br/>policy + orchestration<br/>Core / Indexed / Handoff projection"]
  end

  SQLite[("SQLite<br/>source of truth")]

  Codex --> Lifecycle
  Codex --> MCP
  Claude --> Lifecycle
  Claude --> MCP
  Other -.-> Lifecycle
  Other -.-> MCP
  Lifecycle --> Handler --> MemorySpace
  MCP --> MemorySpace
  MemorySpace -->|"checkpoint transaction"| SQLite
  SQLite -->|"bootstrap + implicit/explicit recall"| MemorySpace
```

> **能力说明 / Capability note:** “Provider-neutral” 指共享的 contract 与 runtime，不表示所有 Agent 都能零配置接入。Codex 与 Claude Code 都已通过真实 prompt-time recall bridge；Claude Code 模型主动调用 MCP 仍取决于网关是否保留标准工具名；其他 Agent 需要单独实现 adapter。

---

<a id="readme-zh"></a>

## 中文

> [切换到 English](#readme-en)

### 它解决什么问题

编码 Agent 通常只了解当前对话。换一个 Session、重启进程，或者从 Codex 切换到 Claude Code 后，重要的项目决策、约束、进行中的任务和阻塞信息很容易丢失。直接把完整历史对话塞回上下文，又会带来噪音、成本和安全边界不清的问题。

memory-space 把“聊天记录”与“项目记忆”分开：

- 对话只是证据，Memory 才是经过策略筛选的持久状态；
- `Core` Memory 自动进入默认上下文，但容量和类型受到控制；
- `Indexed` Memory 不进入 bootstrap；默认可在 prompt 提交时按稳定 key 自动召回，也可显式搜索；
- `Handoff Snapshot` 保存下一位 Agent 真正需要接手的工作状态；
- 所有 Memory 都归属于一个 `Space`，不会跨项目泄漏。

### 核心能力

| 能力 | 它做什么 |
| --- | --- |
| 跨 Session 持久化 | 新 Session 可以恢复同一 Space 的 Core Memory 和最新 Handoff。 |
| 跨进程恢复 | SQLite 关闭并重新打开后，Space、Session、Memory、Checkpoint 和 Handoff 仍然存在。 |
| 跨 Provider 交接 | Codex 与 Claude Code 共享同一个 MemorySpace、生命周期 contract 和同一组六个 MCP 工具；Lifecycle/Handoff 已验证，Claude 模型主动调用 MCP 仍受当前网关兼容性影响。 |
| 渐进式披露 | Core 默认可见；Indexed 不进入 bootstrap，可按项目配置进行有界 prompt-time 召回或显式搜索。 |
| 可控记忆写入 | 显式记忆默认进入 Indexed；提升到 Core 需要经过策略与容量检查。 |
| 确定性 Checkpoint | Memory 更新、Handoff 创建和事件边界推进在一个事务中提交，并支持幂等重试。 |
| 来源与变更历史 | Memory 保留来源 Session/Event、版本、状态变化和提升/降级（promotion/demotion）历史。 |
| 本地可视化检查 | 只读 Inspector 展示 Memory、历史、真实 bootstrap、最新 Handoff，以及 Stored 与 Disclosed 的差异。 |
| 本地优先 | v1 daemon 只监听 loopback，SQLite 是默认且唯一的持久权威数据源（Source of Truth）。 |

### 它如何工作

集成有两条通道：Lifecycle hook 负责自动启动上下文、prompt-time Indexed 召回、捕获对话证据和触发 checkpoint；MCP 负责 Agent 主动发起的搜索、记忆、提升和 checkpoint 命令。两条通道最终都进入同一个本地 memory-space daemon 与 `MemorySpace` 实例。

1. 项目通过 `.memory-space/config.json` 绑定到一个 `Space`。
2. Agent 启动 Session 时，Lifecycle hook 解析或复用内部 Session，并注入 Core Memory 与最新 Handoff。
3. 完整用户 prompt 和可靠的最终回复文本被记录为轻量对话事件；完整 transcript 文件不会被默认读取或复制进数据库。
4. 每次用户 prompt 先被持久化，再按项目 `implicitRecall.mode` 从同一 Space 的 active Indexed Memory 中执行有界召回；Agent 仍可通过 MCP 显式搜索、记忆或提升 Memory。
5. `PreCompact`、`SessionEnd` 或显式 checkpoint 将新事件提取为候选项；领域与准入策略再决定创建、更新、忽略及 Core/Indexed tier，最后在事务中更新 Memory 与 HandoffSnapshot。
6. 同一 Provider 的 resume 复用原内部 Session；另一个 Provider 会创建自己的 Session，但只要绑定同一 Space，就能通过 Core/Handoff 接手工作，并通过 prompt-time 或显式召回读取 Indexed 细节。

### 核心模型

| 概念 | 含义 |
| --- | --- |
| `Space` | 项目记忆的隔离边界。一个 Memory 只能属于一个 Space。 |
| `Session` | 某个 Provider 的一次对话身份；恢复后继续绑定原 Space。 |
| `SessionEvent` | 追加式证据，例如用户消息、Agent 回复或结构化 Memory 事件。 |
| `Memory` | 经过领域与准入策略验证的持久项目知识或工作状态，带类型、状态、版本和来源追踪（provenance）。 |
| `Core` | 有界的默认上下文，适合稳定决策、约束、目标和需跨 Session 延续的工作状态。 |
| `Indexed` | 不进入 bootstrap 的可搜索细节；可按 prompt 相关性有界注入，显式 remember 默认创建于此。 |
| `Checkpoint` | 将未提交事件原子地转换为 Memory 更新和 Handoff 的边界。 |
| `HandoffSnapshot` | 每次 checkpoint 生成的不可变交接快照，包含下一位 Agent 需要的目标、已完成事项、活跃任务、决策、阻塞、问题和下一步。它不是新的 Memory tier，也不会覆盖 Core。 |

### 快速开始

要求：Git、Node.js `>= 22.13.0`、pnpm `11.x`。以下命令从仓库根目录运行：

```bash
git clone https://github.com/Aurora-N/memory-space.git
cd memory-space
corepack enable
pnpm install
pnpm run check
pnpm inspector:build
```

`pnpm start` 保持原有的前台 daemon 语义。在第一个终端中指定目标项目并启动；需要关闭时按 `Ctrl+C`：

```bash
MEMORY_SPACE_CWD=/absolute/path/to/project pnpm start
```

默认 daemon 只监听 `http://127.0.0.1:4310`，数据仍写入启动目录下的 `./data/memory-space.db`。如需自定义，继续使用 `.env.example` 中已有的环境变量。

在第二个终端中初始化绑定，然后打开 Inspector：

```bash
pnpm memory-space init /absolute/path/to/project --name "My project"
pnpm memory-space configure codex /absolute/path/to/project --dry-run
pnpm memory-space configure codex /absolute/path/to/project
# 或配置 Claude Code；建议先预览，再写入项目级配置
pnpm memory-space configure claude-code /absolute/path/to/project --dry-run
pnpm memory-space configure claude-code /absolute/path/to/project
pnpm memory-space inspect /absolute/path/to/project

# 检查当前项目
pnpm memory-space doctor /absolute/path/to/project
pnpm memory-space status /absolute/path/to/project

# 只解绑该目录；不会删除 Space 或 Memory，也不会移除祖先绑定
pnpm memory-space unbind /absolute/path/to/project
```

`inspect` 是纯检查/打开命令：它不会启动 daemon、创建 Space 或写入绑定；daemon 未运行、运行目录不匹配或项目尚未绑定时会给出错误。使用 `--no-open` 可只完成检查并打印 URL。

`configure codex` 与 `configure claude-code` 是对称的显式、项目级配置命令，均支持 `--dry-run`、幂等合并和 loopback-only `--endpoint`。Codex 命令写入 `.codex/hooks.json` 与 `.codex/config.toml`；Claude Code 命令写入 `.claude/settings.json` 与 `.mcp.json`。已有 Memory Space 冲突配置、覆盖当前项目的其他活动 scope、损坏文件或非普通文件会导致整次预检失败。命令不会修改用户目录中的 `~/.codex`、`~/.claude/settings.json` 或 `~/.claude.json`，也不会输出现有 token、header 或 env。配置后重新启动对应 Agent，并分别用 `/hooks` 与 `/mcp` 确认连接。

`unbind --space-id <expected-id>` 可在删除前校验 Space ID。若当前目录只继承祖先配置，`unbind` 不会创建或删除任何文件；损坏的本地配置会原样保留并报告错误。

`init` 会把自动召回边界明确写入项目绑定，默认是稳定 key 精确召回：

```json
{
  "version": 1,
  "spaceId": "space_...",
  "implicitRecall": { "mode": "exact" }
}
```

将 `mode` 改为 `lexical` 可再启用完整 prompt 的确定性词面召回；改为 `off` 可关闭自动 Indexed 披露。旧绑定缺少该字段时仍兼容并按 `exact` 工作。配置损坏、当前目录绑定与 Session Space 不一致，或召回服务故障时，本次召回会关闭，但 prompt 仍会正常继续。

如果只需要绑定、不希望启动 Inspector，仍可在已运行的 daemon 上使用 `init`。它只创建或确认 Space，并原子写入项目绑定，不会修改全局 Codex 或 Claude 配置。接下来按 Provider 文档配置 hooks 与 MCP：

- [Codex 集成](docs/CODEX_INTEGRATION.md)
- [Claude Code 集成](docs/CLAUDE_CODE_INTEGRATION.md)

#### 打开本地 Memory Inspector

Inspector 是 daemon 同源托管的只读可视化界面。完整启动顺序为：

```bash
pnpm inspector:build
MEMORY_SPACE_CWD=/absolute/path/to/project pnpm start
# 在另一个终端，确保 init 已完成后：
pnpm memory-space inspect /absolute/path/to/project
```

打开 <http://127.0.0.1:4310/inspector/>。你可以查看 Overview、搜索和筛选 Memories、打开 provenance/history 详情、核对真实 bootstrap context、查看最新 Handoff，并在 Validation 中比较 Stored 与 Disclosed 状态。界面没有创建、编辑、删除、提升或状态变更操作，不会污染用于验证的 Memory。

开发界面时可保持 daemon 运行，另开终端执行 `pnpm inspector:dev`，再访问 <http://127.0.0.1:5173/inspector/>。

最短的隐式跨 Agent 验证路径：先用任一 Agent 执行 `memory_remember` 写入 key 为 `CROSS_AGENT_TEST_20260817`、content 为 `CROSS_AGENT_TEST_20260817 = lavender-731` 的 Indexed Memory；打开另一个 Provider 的新 Session，只输入 `CROSS_AGENT_TEST_20260817`。在默认 `exact` 模式下，它应直接回答 `lavender-731`，无需用户要求调用 `memory_search`。完整自动化验证命令见下文。

### MCP 工具

所有 Provider 共用且只公开以下六个工具：

| 工具 | 用途 |
| --- | --- |
| `memory_bootstrap` | 加载当前 Session 或项目绑定的 Core Memory 与最新 Handoff；已知 Session 时同时返回内部 handle。 |
| `memory_context` | 根据 query 从当前 Space 的 active Core/Indexed Memory 构建结构化上下文。 |
| `memory_search` | 在当前 Space 中显式召回 Core 或 Indexed Memory。 |
| `memory_remember` | 创建显式持久 Memory；默认是 Indexed。 |
| `memory_promote` | 在策略、所有权和容量检查后将 Memory 提升到 Core。 |
| `memory_checkpoint` | 将当前 Session 尚未提交的事件推进到下一个持久边界。 |

工具参数不允许 Agent 自行指定可信的 `spaceId`、tier、actor 或 checkpoint 边界。项目绑定和 Session 身份由受信任的本地运行时解析。

### Provider 支持

| Provider | 当前状态 |
| --- | --- |
| Codex | Lifecycle、共享 MCP、自动化验证、真实 Codex smoke 与 P7 prompt-time recall bridge 已通过。 |
| Claude Code | Lifecycle、bootstrap、自动化验证和 P7 prompt-time recall bridge 已通过；当前兼容网关会改写 MCP 双下划线工具名，因此真实模型驱动 MCP 仍是外部阻塞项。 |
| 其他 Agent | 可以复用 provider-neutral lifecycle contract 与六工具 MCP；仍需实现并验证对应 adapter。 |

项目不会为某个 Provider 增加专属 MCP alias 或第七个工具来绕过兼容问题。

### 安全与一致性边界

- v1 daemon 未提供远程认证，因此只允许 `127.0.0.1`、`::1` 和 `localhost`；不支持 LAN/公网部署。
- 除 `GET /health` 外，daemon 路由都会验证 localhost Host/Origin；JSON mutation 要求正确的 `Content-Type`。
- `Space` 是同一 daemon 内的逻辑项目隔离，不是多用户认证边界；因此 v1 daemon 只能在受信任的本机使用。
- 一个 daemon 只创建一个 `MemorySpace`/SQLite owner；不要让多个进程同时拥有同一数据库文件。
- Lifecycle 失败采用“失败不阻断”（fail-open），不应阻断 Agent；显式 MCP Memory 命令采用“失败可见”（fail-visible）。
- Bootstrap 会把召回内容标记为不可信项目数据，不能让 Memory 提升为系统级指令。
- `CachePort` 是尽力而为的派生状态（best-effort derived state）；缓存失败不能使 Store 中的正确数据失效。
- Checkpoint 写操作、HandoffSnapshot 和事件边界在同一个 Store 事务中提交。

### 存储与扩展边界

当前 v1 使用 SQLite 作为零配置默认实现。应用层依赖异步端口，而不是直接依赖 SQLite：

- `MemoryStore`：SQLite 是当前实现；PostgreSQL adapter 仅预留接口，尚未交付。
- `CachePort`：默认是 no-op；Redis cache adapter 仅预留接口，且未来也不能成为 Source of Truth。
- `MemoryExtractor`：当前是确定性的 rule-based extractor，可替换，但远程/LLM extractor 不属于 v1。

### 项目状态

- MVP 与领域模型：Frozen。
- Provider Integration P0–P4：产品级自动化范围已完成；Claude 真实模型驱动 MCP 保留明确的外部兼容例外说明（waiver）。
- P5 Productization：Complete / Review Pass。
- P6 Memory Quality v1：Complete / Review Pass / Frozen。
- P6 B4 Semantic Retrieval / Dedup：经过评估后主动延期到 v2，而不是遗漏功能。详见 [ADR 0004](docs/adr/0004-semantic-recall-options-after-b1.md)。
- P7 Implicit Prompt-Time Recall：实现与自动化/真实 Provider 验证已完成，等待独立 code review，尚未 Frozen。

v1 已知仍存在无词面重叠的语义表达不一致（semantic wording mismatch）和无稳定 key 的重复记忆（unkeyed duplicate）；当前证据不足以证明 embedding/vector infrastructure 的收益值得引入其存储、迁移、隐私、离线和模型版本复杂度。后续由真实自用（dogfooding）数据决定是否在 v2 重启。

### 如何验证

```bash
# lint + typecheck + 全量测试 + provider smoke self-tests
pnpm run check

# 为未来 monorepo 执行所有 workspace check
pnpm run check:workspace

# 跨 Session / Provider 产品证明
pnpm memory-space eval cross-session

# 20-Session Memory Quality 评估
pnpm memory-space eval quality
pnpm memory-space eval quality --json

# B3 Core/Handoff before/after gate
pnpm memory-space eval quality --compare-stage-b2-core-handoff

# P7 prompt-time Indexed recall（含 Codex/Claude 4×4）
pnpm memory-space eval implicit-recall
pnpm memory-space eval implicit-recall --json
```

真实 Provider smoke 需要本机已安装并完成认证的对应 CLI：

```bash
pnpm run smoke:codex:p2 -- --preflight
pnpm run smoke:codex:p2

pnpm run smoke:claude:p3 -- --preflight
pnpm run smoke:claude:p3 -- --hooks-only

# P7 原生 capability 与真实 production bridge
pnpm run smoke:p7:capability
pnpm run smoke:p7
```

### 已知限制

- 未认证的远程/LAN daemon 不在 v1 支持范围内。
- SQLite 采用单 active owner 假设；PostgreSQL adapter 尚未实现。
- 当前 extractor 和 retrieval 是保守、确定性的规则/词面策略，不提供通用语义理解。
- semantic retrieval、vector database 和 semantic consolidation 已延期到 v2。
- Claude Code 在特定兼容网关下的真实 MCP tool call 仍受工具名改写问题阻塞。
- 完整 transcript ingestion、provider event 通用幂等和多进程 SQLite ownership 尚未实现。

### 文档入口

- [产品规格](docs/PRODUCT_SPEC.md)
- [领域模型](docs/DOMAIN_MODEL.md)
- [HTTP / daemon API](docs/API.md)
- [本地 Memory Inspector](docs/LOCAL_INSPECTOR_SPEC.md)
- [Provider Integration Guardrails](docs/PROVIDER_INTEGRATION_GUARDRAILS.md)
- [Codex 集成](docs/CODEX_INTEGRATION.md)
- [Claude Code 集成](docs/CLAUDE_CODE_INTEGRATION.md)
- [v1 Roadmap](docs/V1_ROADMAP.md)
- [P6 Memory Quality v1](docs/MEMORY_QUALITY_V1_SPEC.md)
- [P6 B3 结果](docs/quality/P6_STAGE_B3_RESULT.md)
- [P7 Implicit Recall 规格](docs/P7_IMPLICIT_RECALL_SPEC.md)
- [P7 验证结果](docs/quality/P7_IMPLICIT_RECALL_RESULT.md)
- [ADR 0004：Semantic Memory 延期到 v2](docs/adr/0004-semantic-recall-options-after-b1.md)

---

<a id="readme-en"></a>

## English

> [切换到中文](#readme-zh)

### What problem does it solve?

Coding agents usually understand only the current conversation. Important decisions, constraints, active work, and blockers are easily lost when a session ends, a process restarts, or work moves from Codex to Claude Code. Re-injecting a full transcript is noisy, expensive, and difficult to govern.

memory-space separates conversation evidence from durable project memory:

- conversation events are evidence; validated `Memory` is durable state;
- bounded `Core` Memory becomes default context;
- `Indexed` Memory stays out of bootstrap and can be recalled automatically by stable key at prompt time or searched explicitly;
- a `HandoffSnapshot` carries only the working state the next agent needs;
- every Memory belongs to one isolated `Space`.

### Core capabilities

| Capability | What it provides |
| --- | --- |
| Cross-session persistence | A new Session restores Core Memory and the latest Handoff from the same Space. |
| Process recovery | Space, Session, Memory, Checkpoint, and Handoff survive a SQLite close/reopen. |
| Cross-provider handoff | Codex and Claude Code share one MemorySpace, lifecycle contract, and six-tool MCP surface. Lifecycle/Handoff is verified; direct Claude model-driven MCP remains gateway-dependent. |
| Progressive disclosure | Core is visible by default; Indexed stays out of bootstrap and supports bounded project-configured prompt-time or explicit recall. |
| Governed writes | Explicit Memory starts Indexed; Core promotion is policy- and capacity-checked. |
| Deterministic checkpoints | Memory updates, Handoff creation, and event-boundary advancement commit transactionally and retry safely. |
| Provenance and history | Memory retains source Session/Event information, versions, status changes, and tier-transition history. |
| Local visual inspection | A read-only Inspector presents Memory, history, real bootstrap, latest Handoff, and Stored-versus-Disclosed validation. |
| Local-first runtime | The v1 daemon is loopback-only and SQLite is the default and only durable source of truth. |

### How it works

The integration has two channels. Lifecycle hooks bootstrap context, perform prompt-time Indexed recall, capture conversation evidence, and trigger checkpoints. MCP carries agent-initiated search, remember, promote, and checkpoint commands. Both channels enter the same local memory-space daemon and `MemorySpace` instance.

1. A project binds to a `Space` through `.memory-space/config.json`.
2. On Session start, a lifecycle hook resolves or reuses the internal Session and injects Core Memory plus the latest Handoff.
3. Full user prompts and reliable final-response text are captured as lightweight conversation events; transcript files are not read or copied by default.
4. Each user prompt is persisted first, then project `implicitRecall.mode` may perform bounded recall from active Indexed Memory in the same Space. MCP remains available for explicit search, remember, and promote operations.
5. `PreCompact`, `SessionEnd`, or an explicit checkpoint extracts candidates. Domain and admission policy then decide create/update/ignore behavior and the Core/Indexed tier before Memory and HandoffSnapshot are updated transactionally.
6. A same-provider resume reuses its internal Session. Another provider creates its own Session, but the same Space lets it continue through Core/Handoff and retrieve Indexed detail implicitly or explicitly.

### Memory model

| Concept | Meaning |
| --- | --- |
| `Space` | Project-level logical isolation boundary. A Memory belongs to exactly one Space. |
| `Session` | A durable provider conversation identity bound to one Space. |
| `SessionEvent` | Append-oriented evidence such as a prompt, response, or structured Memory event. |
| `Memory` | Durable knowledge or working state validated by domain/admission policy, with type, status, version, and provenance. |
| `Core` | Type- and capacity-bounded default context for stable decisions, constraints, goals, and continuation state. |
| `Indexed` | Searchable detail excluded from bootstrap; bounded prompt-relevant injection is configurable. Explicit remember starts here. |
| `Checkpoint` | Atomic boundary that turns uncommitted events into Memory changes and a Handoff. |
| `HandoffSnapshot` | Immutable checkpoint output containing goal, completed work, active tasks, decisions, blockers, questions, and next steps. It is not a Memory tier and does not overwrite Core. |

### Quick start

Requirements: Git, Node.js `>= 22.13.0`, and pnpm `11.x`. Run these commands from the repository root:

```bash
git clone https://github.com/Aurora-N/memory-space.git
cd memory-space
corepack enable
pnpm install
pnpm run check
pnpm inspector:build
```

`pnpm start` retains its original foreground-daemon behavior. Start it for the target project in the first terminal; press `Ctrl+C` there to stop it:

```bash
MEMORY_SPACE_CWD=/absolute/path/to/project pnpm start
```

The daemon still listens only on `http://127.0.0.1:4310` by default and stores data in `./data/memory-space.db` relative to its launch directory. Existing `.env.example` variables remain the customization mechanism.

```bash
pnpm memory-space init /absolute/path/to/project --name "My project"
pnpm memory-space configure codex /absolute/path/to/project --dry-run
pnpm memory-space configure codex /absolute/path/to/project
# Or configure Claude Code; preview before writing project-scoped files
pnpm memory-space configure claude-code /absolute/path/to/project --dry-run
pnpm memory-space configure claude-code /absolute/path/to/project
pnpm memory-space inspect /absolute/path/to/project

pnpm memory-space doctor /absolute/path/to/project
pnpm memory-space status /absolute/path/to/project

# Removes only this directory's exact binding; preserves Space and Memory
pnpm memory-space unbind /absolute/path/to/project
```

`inspect` only validates and opens: it never starts the daemon, creates a Space, or writes a binding. It fails visibly when the daemon is unavailable, attached to another project, or the project is unbound. Use `--no-open` to validate and print the URL without opening a browser.

`configure codex` and `configure claude-code` are symmetric, explicit project-scoped commands. Both support `--dry-run`, idempotent merging, and a loopback-only `--endpoint`. Codex writes `.codex/hooks.json` and `.codex/config.toml`; Claude Code writes `.claude/settings.json` and `.mcp.json`. Conflicting Memory Space configuration, another active scope covering the project, malformed files, or non-regular files fail the whole preflight. Neither command edits user-level `~/.codex`, `~/.claude/settings.json`, or `~/.claude.json`, nor prints existing tokens, headers, or environment values. Restart the configured agent afterward, then verify `/hooks` and `/mcp`.

`unbind --space-id <expected-id>` guards the removal with an expected Space ID. An inherited ancestor binding is never removed, and malformed local configuration is preserved with a visible error.

`init` writes an explicit project disclosure policy and defaults it to exact stable-key recall:

```json
{
  "version": 1,
  "spaceId": "space_...",
  "implicitRecall": { "mode": "exact" }
}
```

Set the mode to `lexical` to add deterministic full-prompt lexical recall, or
to `off` to disable automatic Indexed disclosure. Older bindings without the
field remain valid and default to `exact`. Invalid/mismatched binding policy or
a recall-service failure disables recall for that prompt without blocking it.

If you only need a binding and already have a daemon running, `init` remains available. It creates or confirms the Space and atomically writes the project binding without editing global Codex or Claude configuration. Continue with the [Codex guide](docs/CODEX_INTEGRATION.md) or [Claude Code guide](docs/CLAUDE_CODE_INTEGRATION.md).

#### Open the local Memory Inspector

The daemon serves the read-only Inspector on the same local origin. The complete sequence is:

```bash
pnpm inspector:build
MEMORY_SPACE_CWD=/absolute/path/to/project pnpm start
# In another terminal, after init has completed:
pnpm memory-space inspect /absolute/path/to/project
```

Open <http://127.0.0.1:4310/inspector/>. The UI provides Overview, Memory search and filters, provenance/history detail, the exact production bootstrap context, the latest Handoff, and Stored-versus-Disclosed validation. It has no create, edit, delete, promote, or status-change controls.

For frontend development, keep the daemon running, execute `pnpm inspector:dev` in another terminal, and open <http://127.0.0.1:5173/inspector/>.

For a minimal cross-agent implicit-recall exercise, use either provider to create an Indexed Memory with key `CROSS_AGENT_TEST_20260817` and content `CROSS_AGENT_TEST_20260817 = lavender-731`. Start a new Session in the other provider and submit only `CROSS_AGENT_TEST_20260817`. Default `exact` mode should return `lavender-731` without asking the model to call `memory_search`.

### MCP tools

Every provider shares exactly six tools:

| Tool | Purpose |
| --- | --- |
| `memory_bootstrap` | Load Core Memory and the latest Handoff for the current Session or project binding; return the internal handle when a Session is known. |
| `memory_context` | Build query-relevant structured context from active Core/Indexed Memory in the current Space. |
| `memory_search` | Explicitly recall Core or Indexed Memory from the current Space. |
| `memory_remember` | Create explicit durable Memory, defaulting to Indexed. |
| `memory_promote` | Promote Memory to Core after ownership, policy, and capacity checks. |
| `memory_checkpoint` | Advance uncommitted Session events to the next durable boundary. |

Tool callers cannot supply trusted Space, tier, actor, or checkpoint-boundary controls. Those values come from the trusted local runtime and Session binding.

### Provider support

| Provider | Current status |
| --- | --- |
| Codex | Lifecycle, shared MCP, automated validation, real Codex smoke, and the P7 prompt-time recall bridge pass. |
| Claude Code | Lifecycle/bootstrap, automated validation, and the P7 prompt-time recall bridge pass. Real model-driven MCP remains blocked by the active compatibility gateway rewriting double-underscore MCP tool names. |
| Other agents | May reuse the provider-neutral lifecycle contract and six-tool MCP plane, but require their own implemented and validated adapter. |

The project does not add provider-specific MCP aliases or a seventh tool to work around client compatibility issues.

### Safety and consistency boundaries

- The unauthenticated v1 daemon accepts only `127.0.0.1`, `::1`, and `localhost`; LAN/remote deployment is unsupported.
- All daemon routes except `GET /health` validate localhost Host/Origin, and JSON mutations require the correct media type.
- A `Space` is logical project isolation inside one daemon, not a multi-user authentication boundary. Use v1 only on a trusted local machine.
- One daemon provides the single `MemorySpace`/SQLite owner; do not run multiple owners against the same database.
- Lifecycle failures are fail-open for the coding agent; explicit MCP Memory commands remain fail-visible.
- Bootstrap labels recalled Memory as untrusted project data, never as higher-priority instructions.
- `CachePort` is best-effort derived state. Cache failure cannot invalidate correct Store data.
- Checkpoint mutations, Handoff creation, and the event boundary commit in one Store transaction.

### Storage and extension boundaries

SQLite is the zero-configuration v1 implementation. The application depends on asynchronous ports rather than SQLite directly:

- `MemoryStore`: SQLite is implemented; a PostgreSQL adapter interface is reserved but not shipped.
- `CachePort`: no-op by default; a Redis cache adapter interface is reserved and must never become the source of truth.
- `MemoryExtractor`: deterministic rule-based implementation in v1; remote/LLM extraction is outside v1 scope.

### Project status

- MVP and domain model: Frozen.
- Provider Integration P0–P4: complete at the reviewed product/automation scope, with an explicit external compatibility waiver for real Claude model-driven MCP.
- P5 Productization: Complete / Review Pass.
- P6 Memory Quality v1: Complete / Review Pass / Frozen.
- P6 B4 Semantic Retrieval / Dedup: deliberately deferred to v2. See [ADR 0004](docs/adr/0004-semantic-recall-options-after-b1.md).
- P7 Implicit Prompt-Time Recall: implemented and validated with deterministic and real-provider evidence; awaiting independent code review, not frozen.

Known v1 limitations include semantic wording mismatches with no lexical overlap and unkeyed duplicates. Current evidence does not show that embedding/vector infrastructure is worth its storage, migration, privacy, offline, and model-version complexity. Real dogfooding data should drive any v2 reopening.

### Validation

```bash
pnpm run check
pnpm run check:workspace
pnpm memory-space eval cross-session
pnpm memory-space eval quality
pnpm memory-space eval quality --json
pnpm memory-space eval quality --compare-stage-b2-core-handoff
pnpm memory-space eval implicit-recall
pnpm memory-space eval implicit-recall --json
```

Real-provider runners additionally require an installed and authenticated provider CLI:

```bash
pnpm run smoke:codex:p2 -- --preflight
pnpm run smoke:codex:p2

pnpm run smoke:claude:p3 -- --preflight
pnpm run smoke:claude:p3 -- --hooks-only
pnpm run smoke:p7:capability
pnpm run smoke:p7
```

### Known limitations

- Unauthenticated LAN/remote daemon deployment is outside v1 scope.
- SQLite assumes one active owner; the PostgreSQL adapter is not implemented.
- Extraction and retrieval are conservative deterministic rule/lexical policies, not general semantic understanding.
- Semantic retrieval, vector infrastructure, and semantic consolidation are deferred to v2.
- Real Claude Code MCP tool calls remain blocked under gateways that rewrite MCP tool names.
- Full transcript ingestion, generic provider-event idempotency, and multi-process SQLite ownership are not implemented.

### Documentation

- [Product spec](docs/PRODUCT_SPEC.md)
- [Domain model](docs/DOMAIN_MODEL.md)
- [HTTP / daemon API](docs/API.md)
- [Local Memory Inspector](docs/LOCAL_INSPECTOR_SPEC.md)
- [Provider Integration Guardrails](docs/PROVIDER_INTEGRATION_GUARDRAILS.md)
- [Codex integration](docs/CODEX_INTEGRATION.md)
- [Claude Code integration](docs/CLAUDE_CODE_INTEGRATION.md)
- [v1 roadmap](docs/V1_ROADMAP.md)
- [P6 Memory Quality v1](docs/MEMORY_QUALITY_V1_SPEC.md)
- [P6 B3 result](docs/quality/P6_STAGE_B3_RESULT.md)
- [P7 implicit recall spec](docs/P7_IMPLICIT_RECALL_SPEC.md)
- [P7 validation result](docs/quality/P7_IMPLICIT_RECALL_RESULT.md)
- [ADR 0004: defer semantic memory to v2](docs/adr/0004-semantic-recall-options-after-b1.md)
