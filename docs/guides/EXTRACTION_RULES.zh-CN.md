# 项目自动提取规则

[English](./EXTRACTION_RULES.md)

项目自动提取规则用于扩展内置的确定性 extractor。它不允许执行代码、任意正则、
Provider 私有 payload，也不能绕过 Memory 准入策略。

默认 extractor 保持领域中立，只识别决策、约束、目标、当前任务等通用持久记忆语义，
不内置数据库、前端框架、云平台等特定技术领域词汇。项目需要这些约定时，应在本文件
中显式配置。

## 文件位置与生效时机

把可选规则文件放在有效项目绑定旁：

```text
<绑定目录>/.memory-space/config.json
<绑定目录>/.memory-space/extraction-rules.json
```

最近祖先的 `config.json` 仍决定 Space。Memory Space 只读取该绑定旁的规则文件，
并且仅在其 `spaceId` 与当前 checkpoint Session 一致时应用。因此，继承祖先绑定的
子目录也会继承祖先规则文件。

规则会在每次 checkpoint 时重新读取。有效修改会在下一个 `PreCompact`、
`SessionEnd` 或显式 `memory_checkpoint` 生效，不需要重启 daemon。prompt 和最终
回复 hook 只追加证据，不会立即执行规则。

使用 `MEMORY_SPACE_SPACE_ID` 作为显式受信任覆盖时，不加载项目规则文件，因为此时
没有可用于确认规则归属的绑定文件。

## 示例

可复制并修改
[`examples/memory-space/extraction-rules.json`](../../examples/memory-space/extraction-rules.json)：

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

以下两行都会生成 key 为 `project.frontend.framework` 的候选项：

```text
前端框架使用 React。
Frontend framework: Vue
```

- `value: "identifier"`：提取第一个 ASCII 标识符，支持首字母后的数字以及
  `_`、`.`、`+`、`-`，会排除句末标点；
- `value: "text"`：提取前缀后的完整非空文本并去除首尾空白。

### 迁移原数据库约定

数据库句式不再内置。需要保留原行为的项目可添加以下普通规则：

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

## 配置字段

顶层字段：

| 字段 | 约束 |
| --- | --- |
| `version` | 必填，固定为整数 `1`。 |
| `rules` | 必填数组，最多 64 条规则。 |

规则字段：

| 字段 | 约束 |
| --- | --- |
| `id` | 必填且唯一，最多 80 字符，只允许小写字母、数字、`.`、`_`、`-`。 |
| `enabled` | 可选布尔值，默认为 `true`；设为 `false` 时忽略该规则。 |
| `family` | 必填：`knowledge`、`state`、`episode` 或 `procedure`。 |
| `type` | 必填的小写类型标识，最多 64 字符。 |
| `key` | 可选稳定 Memory key，最多 128 字符。有 key 时执行更新/去重，无 key 时创建候选项。 |
| `match` | 必填的有界前缀匹配器。 |
| `contentTemplate` | 必填，最多 500 字符，只能使用 `${value}` 占位符。 |
| `coreCandidate` | 可选布尔值，默认为 `false`；只推荐进入 Core，不能强制进入。 |

`match` 字段：

| 字段 | 约束 |
| --- | --- |
| `kind` | 固定为 `prefix`；不支持任意正则和可执行 matcher。 |
| `prefixes` | 1–16 个行首前缀，每个最多 120 字符。 |
| `value` | 可选：`text` 或 `identifier`，默认 `text`。 |
| `caseSensitive` | 可选布尔值，默认为 `false`。 |

未知字段会被拒绝。文件必须是合法 JSON、普通非符号链接文件，大小不超过
64 KiB；捕获值和最终渲染内容也有长度上限。

## 安全与策略边界

- 用户规则只做增量扩展，内置确定性规则继续生效；
- 规则只能从已持久化的消息事件生成 `MemoryCandidate`；
- `coreCandidate: true` 仍受类型资格、临时范围过滤、Core 容量、provenance、
  checkpoint 事务和 Space 隔离约束；
- 用户不能配置可信 confidence、importance、tier、status、actor、目标 Memory ID、
  来源事件、operation 或 checkpoint 边界；
- 当前命令、工具调用和测试等临时叙述仍会被过滤；
- 可以用相同 family/type 扩展已有 key；配置内冲突的 key schema 会被拒绝；
- 内置规则 ID 被保留，不能覆盖。

规则文件无效时采用 fail-closed：配置规则不会被应用，checkpoint 不会部分提交。
Lifecycle hook 对 Provider 仍保持 fail-open；显式 MCP checkpoint 会返回可见失败。

## 校验

运行：

```bash
pnpm memory-space doctor /absolute/path/to/project
```

`extraction-rules` 检查项会显示启用规则数量或具体错误。checkpoint 成功后，可通过
Inspector 或 `memory_search` 检查生成的 Memory、tier 和 provenance。
