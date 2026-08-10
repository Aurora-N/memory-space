# memory-space MVP Hardening Fix Spec

**Status:** Ready for implementation
**Scope:** MVP hardening only
**Primary goal:** 修复当前 MVP 中违反已冻结领域语义、影响 Cross-Session Handoff 正确性和 checkpoint 可靠性的边界问题。

---

# 1. Background

当前 `memory-space` MVP 已经完成以下核心能力：

* Space / Session / Memory 分离；
* SessionEvent append-oriented 模型；
* Explicit Memory 写入；
* Core / Indexed Memory；
* Promote / Demote；
* Checkpoint = Memory Commit Point；
* MemoryCandidate extraction；
* keyed Memory update / dedup；
* Memory history / provenance；
* HandoffSnapshot；
* deterministic bootstrap；
* lexical search / memory context；
* Store / Extractor port；
* SQLite durable persistence；
* HTTP adapter；
* automated tests + evaluation fixtures。

现有整体架构**不需要重写**。

本次任务只修复代码审查发现的边界问题，并补齐 regression tests。

---

# 2. Hard Constraints

Coding Agent 必须遵守以下原则。

## 2.1 不扩大架构范围

本轮禁止引入：

* CRDT；
* Space revision；
* 完整 OCC；
* Task lease；
* Semantic conflict resolver；
* PostgreSQL；
* Redis；
* Vector DB；
* Embedding；
* Graph DB；
* Queue / Worker；
* Provider integration；
* Auth system；
* Visual dashboard；
* LLM-based extractor；
* 新 framework / ORM；
* 大规模目录重构。

除非解决本 Spec 中问题确实不可避免，否则不要引入新的 runtime dependency。

---

## 2.2 保留现有 MVP 架构

继续保留：

```text
Space
├── Sessions
├── Memories
├── Checkpoints
└── HandoffSnapshots
```

以及：

```text
MemoryStore
MemoryExtractor
CachePort
```

现有 Domain Contract 不做破坏性调整。

---

## 2.3 保持这些核心 invariant

### Memory

```text
remember()
→ Indexed by default
```

```text
Indexed
→ promote()
→ Core
```

Persisted 不代表默认暴露。

---

### Checkpoint

Checkpoint 是：

> 将当前 Session 自上次成功 checkpoint 以来的新 SessionEvents 沉淀为 durable Memory，并生成 HandoffSnapshot 的 Memory Commit Point。

Checkpoint：

* 不代表 session close；
* 必须 retry-safe；
* boundary 只能在 commit 成功后推进；
* 同一个 idempotency key 必须代表同一次逻辑操作。

---

### Bootstrap

Bootstrap 默认暴露：

```text
Core Memory
+
Latest HandoffSnapshot
```

因此：

> HandoffSnapshot 本身也必须遵守默认上下文暴露规则，不能成为 Indexed Memory 绕过 Core policy 的后门。

---

# 3. Required Fixes

---

# FIX-01 — Prevent Indexed Memory leaking through Handoff

**Priority:** P1

## Problem

当前 `#buildSnapshot()` 从整个 Space 中读取所有 Memory：

```ts
const memories = await this.store.listMemories({
  spaceId: session.spaceId
})
```

然后将所有 active：

* task
* decision
* blocker
* question
* progress

写入 HandoffSnapshot。

这意味着：

```text
Indexed Memory
→ HandoffSnapshot
→ bootstrap()
→ 默认暴露
```

绕过了：

```text
Indexed → promote → Core
```

的渐进式披露模型。

---

## Required behavior

HandoffSnapshot 中代表**当前默认工作状态**的信息必须遵守 Core eligibility。

MVP 推荐实现：

### Active/default state

以下字段只从：

```text
tier = core
AND status = active
```

读取：

* goal
* activeTasks
* decisions
* blockers
* openQuestions
* current roadmap / next steps（如适用）

### Completed

`completed` 不应该由所有 active progress 直接生成。

允许来源：

```text
resolved task
```

以及未来显式 completion 类型。

MVP 暂时不要自动把任意 active `progress` 当作 completed。

---

## Example

存在：

```ts
{
  type: "task",
  content: "修改 auth.ts 第 183 行",
  tier: "indexed",
  status: "active"
}
```

checkpoint 后：

```text
HandoffSnapshot.activeTasks
```

不得包含该内容。

bootstrap 也不得看到它。

但：

```ts
memory.search(...)
```

仍应可以检索到它。

---

## Tests required

新增 regression test：

```text
Indexed task
Indexed decision
Indexed blocker
Indexed question

→ checkpoint
→ bootstrap

assert:
以上内容均不出现在 bootstrap context
```

同时验证：

```text
memory.search()
```

依然能找到这些 Indexed Memory。

---

# FIX-02 — Close remember() → Core promotion bypass

**Priority:** P1

## Problem

目前：

```ts
interface RememberInput {
  ...
  tier?: MemoryTier
}
```

因此调用方可以：

```ts
memory.remember({
  ...,
  tier: "core"
})
```

直接创建 Core Memory。

这绕过了：

```text
promote()
→ eligibility policy
→ promotion reason
→ Core capacity
```

的领域操作。

---

## Required behavior

公开的 `memory.remember()`：

```text
必须始终创建 Indexed Memory
```

除非发生：

```text
keyed update existing Core Memory
```

这种已有 canonical Memory 的更新场景。

也就是说：

```text
remember(new memory)
→ indexed
```

用户或 Agent 如果想让它进入 Core：

```text
remember()
↓
promote()
```

---

## Required API change

推荐从公开 `RememberInput` 中移除：

```ts
tier?: MemoryTier
```

或者在公开 API 明确拒绝：

```text
tier = core
```

推荐前者。

内部 `CommitInput` / MemoryCandidate 仍然可以包含 tier，因为 checkpoint extractor 需要：

```text
recommendedTier
```

由 Domain Policy 最终判断。

---

## Important compatibility rule

如果 keyed Memory 已经是：

```text
tier = core
```

随后：

```ts
remember({
  key: sameKey,
  content: updatedValue
})
```

不应该因为 `remember()` 默认 Indexed 而自动把已有 Core Memory demote。

已有 Core Memory 更新后应保持 Core，除非发生显式：

```text
demote()
```

或 status policy。

---

## Tests required

新增：

```ts
remember(...)
```

验证：

```text
result.tier === "indexed"
```

并确保 TS public API 不允许：

```ts
remember({ tier: "core" })
```

如果 runtime HTTP 收到：

```json
{
  "tier": "core"
}
```

必须：

* 忽略未知字段，或者
* 返回 validation error。

推荐返回 validation error，避免错误调用静默成功。

---

# FIX-03 — Do not trust HTTP caller-provided promotion actor

**Priority:** P1

## Problem

当前 HTTP：

```ts
POST /memories/:id/promote

{
  "actor": "user"
}
```

客户端可以自行声明自己是 user。

而 user promotion 被设计为 authoritative。

因此任何 Agent 都能伪造：

```json
{
  "actor": "user"
}
```

绕过 Agent promotion eligibility。

---

## Required behavior

当前 MVP 尚未实现 Auth。

因此 HTTP adapter 不应接受客户端指定：

```text
actor
```

MVP HTTP promote endpoint 固定视为：

```text
actor = agent
```

请求：

```json
{
  "reason": "Project-wide architecture decision"
}
```

内部：

```ts
memorySpace.promote(memoryId, {
  actor: "agent",
  reason
})
```

---

## User-authoritative promotion

Application API 可以暂时继续支持：

```ts
actor: "user"
```

用于：

* tests；
* future trusted UI；
* future auth layer。

但是 HTTP 外部调用不能自称 user。

---

## Tests required

HTTP：

```json
{
  "actor": "user"
}
```

不能导致 user-authoritative promotion。

推荐：

* reject unsupported `actor` field；
* 或完全忽略 actor，并按 agent policy 执行。

优先选择 **reject**，行为更明确。

---

# FIX-04 — Make checkpoint same-key creation race-safe

**Priority:** P1

## Problem

当前逻辑：

```text
findCheckpointByIdempotency()
↓
none
↓
insertCheckpoint()
```

存在 race window：

```text
Request A → find none
Request B → find none

Request A → insert
Request B → insert
```

数据库虽然有：

```sql
UNIQUE(session_id, idempotency_key)
```

但 B 可能直接得到 SQLite unique exception。

当前已有并发测试并没有覆盖这个窗口，因为第二个请求是在第一个 checkpoint 已经写入 DB 并进入 extractor 后才开始。

---

## Required behavior

同一个：

```text
sessionId + idempotencyKey
```

必须原子地：

```text
get existing
OR
create one
```

两个真正同时开始的请求：

```text
只能产生一个 checkpoint row
只能调用 extractor 一次
不能暴露底层 UNIQUE error
```

---

## Recommended implementation

将创建逻辑下沉到 Store。

例如新增：

```ts
getOrCreateCheckpoint(
  checkpoint: Checkpoint
): Promise<{
  checkpoint: Checkpoint
  created: boolean
}>
```

SQLite 使用：

```sql
INSERT ... ON CONFLICT(session_id, idempotency_key)
DO NOTHING
```

然后：

```text
SELECT checkpoint
```

不要依赖：

```text
try INSERT
catch string.includes("UNIQUE")
```

作为主要并发控制机制。

---

## Required test

构造两个真正同时开始的：

```ts
Promise.all([
  checkpoint(...sameKey),
  checkpoint(...sameKey)
])
```

测试需要确保 race 发生在 checkpoint creation 前后，而不是第二个请求等第一个已经进入 extractor 后才调用。

Acceptance：

```text
same checkpoint id
only one extraction
only one snapshot
only one durable memory effect
no raw SQLite exception
```

---

# FIX-05 — Recover stale `processing` checkpoints after process crash

**Priority:** P1

## Problem

当前：

```ts
if (existing?.status === "processing") {
  return existing
}
```

如果：

```text
checkpoint inserted as processing
↓
process crashes
```

重启后：

```text
DB = processing
```

但实际上没有任何 worker 在处理。

之后相同 retry 永远得到：

```text
processing
```

形成永久卡死 checkpoint。

---

## MVP Required behavior

当前是：

```text
single-process MVP
```

因此不需要实现 lease / distributed ownership。

只需要区分：

```text
processing + 当前进程确实有 in-flight checkpoint
```

和：

```text
processing + 当前进程没有对应 operation
```

后者视为：

> crash/restart 遗留 checkpoint。

允许使用相同 idempotency key 重新执行。

---

## Suggested implementation

Application 内维护：

```ts
Map<string, Promise<Checkpoint>>
```

key：

```text
sessionId:idempotencyKey
```

当前进程发起 checkpoint：

```text
register in-flight Promise
```

完成/失败：

```text
remove
```

如果数据库发现：

```text
status = processing
```

并且：

```text
inFlightMap.has(key)
```

则共享当前 processing operation。

如果：

```text
status = processing
AND
!inFlightMap.has(key)
```

视为 stale processing：

```text
retry same checkpoint
```

---

## Do NOT implement

本轮不要引入：

```text
leaseUntil
workerId
heartbeat
distributed lock
```

这些属于后续高级并发。

---

## Required test

模拟：

```text
DB 中已有 processing checkpoint
↓
关闭 MemorySpace
↓
重新创建 MemorySpace
↓
same idempotency key retry
```

应最终：

```text
completed
```

而不是永久停留 processing。

---

# FIX-06 — Idempotency key must stay bound to original toEventId

**Priority:** P1

## Problem

失败 checkpoint：

```text
toEventId = E10
```

失败后产生：

```text
E11
E12
```

如果 retry：

```ts
checkpoint({
  sameIdempotencyKey
  // omit toEventId
})
```

当前实现可能重新：

```text
findLatestEvent()
→ E12
```

然后与 existing：

```text
E10
```

产生：

```text
IDEMPOTENCY_MISMATCH
```

---

## Required invariant

一旦某个：

```text
sessionId + idempotencyKey
```

已经绑定：

```text
toEventId
```

它必须永久表示同一个 checkpoint operation。

因此 resolution 顺序：

```ts
const resolvedToEventId =
  input.toEventId
  ?? existing?.toEventId
  ?? latestEvent.id
```

如果 caller 显式传入：

```text
toEventId != existing.toEventId
```

仍返回：

```text
IDEMPOTENCY_MISMATCH
```

这是正确行为。

---

## Required test

```text
E1
checkpoint(key=K, to=E1)
→ extraction failed

E2
E3 appended

retry checkpoint(key=K)
```

必须重新处理：

```text
E1
```

而不是：

```text
E1-E3
```

完成后：

```text
lastCheckpointEventId = E1
```

下一次新 checkpoint 再处理：

```text
E2-E3
```

---

# FIX-07 — Fix `progress → completed` semantic error

**Priority:** P2

## Problem

当前：

```ts
completed = [
  ...active progress,
  ...resolved task
]
```

导致：

```text
progress:
Recall Engine 完成 30%
```

被 Handoff 渲染成：

```text
Completed:
Recall Engine 完成 30%
```

语义错误。

---

## Required behavior

MVP：

```text
completed
```

只来源于：

```text
resolved task
```

或者明确表示 completed 的 structured data。

不要直接把任意 active progress 塞进 completed。

Current Progress 已经可以通过：

```text
Core progress Memory
```

在 bootstrap fixed template 中表达。

---

## Required test

Memory：

```ts
{
  type: "progress",
  tier: "core",
  status: "active",
  content: "Recall Engine 完成 30%"
}
```

checkpoint 后：

```text
Handoff.completed
```

不得包含它。

但 bootstrap：

```text
## Current Progress
```

应该仍能看到它。

---

# FIX-08 — Prevent keyed Memory domain-type mutation

**Priority:** P2

## Problem

已有：

```text
key = project.database
family = knowledge
type = decision
```

后续错误调用：

```text
same key
family = state
type = task
```

目前 keyed update 会直接覆盖：

```text
family
type
```

破坏稳定 key 的领域含义。

---

## Required invariant

同一个 active key 更新时：

```text
family
type
```

默认不可改变。

如果：

```ts
existing.family !== input.family
||
existing.type !== input.type
```

抛出：

```text
ConflictError
```

推荐 code：

```text
MEMORY_KEY_SCHEMA_CONFLICT
```

---

## Allowed behavior

以下允许变更：

```text
content
data
importance
confidence
sourceSessionId
sourceAgentId
version
updatedAt
```

tier 依照现有 promotion/demotion规则。

status 依照现有 status transition。

---

## Future

未来如果需要：

```text
key semantic migration
```

应该设计独立 domain operation。

本轮不做。

---

## Required test

```text
remember:
key = project.database
knowledge / decision

remember:
same key
state / task
```

必须 conflict。

原 Memory 保持不变。

---

# FIX-09 — Correct supported Node.js version

**Priority:** P1 packaging/runtime

## Problem

当前声明：

```json
"node": ">=22.5.0"
```

但当前运行方式依赖：

```text
--experimental-strip-types
node:sqlite
```

现有最低版本声明与实际能力不匹配。

---

## Required behavior

将 Node 最低版本调整为：

```json
"node": ">=22.13.0"
```

同步修改：

* `package.json`
* README
* ADR（如有最低版本描述）
* 其他 setup docs

确保文档和实际 runtime requirements 一致。

---

# FIX-10 — Move default adapter construction toward Composition Root

**Priority:** P2 architecture cleanup

这个问题不要求大重构。

## Current issue

`MemorySpace` application class 同时：

```ts
import SqliteMemoryStore
import RuleBasedExtractor
```

即：

```text
Application → Port
Application → Adapter
```

port boundary 没有完全干净。

---

## Desired direction

`MemorySpace` 尽量只依赖：

```text
MemoryStore
MemoryExtractor
CachePort
```

Adapter 实例化放在：

```text
server.ts
factory / composition root
```

---

## MVP-compatible implementation

可以增加：

```ts
createDefaultMemorySpace(options)
```

或者在：

```text
src/server.ts
```

构造：

```ts
new MemorySpace({
  store: new SqliteMemoryStore(...),
  extractor: new RuleBasedExtractor(),
  cache: new NoopCache()
})
```

---

## Constraint

不要为了这个问题：

* 拆成多个 package；
* 改全部 import；
* 大规模重构目录；
* 引入 DI framework。

如果会显著扩大 diff，可以暂时只：

```text
TODO / ADR
```

但优先完成前 9 个 correctness fix。

---

# 4. Regression Test Matrix

本轮结束至少应新增以下测试。

| Case                                              | Expected                    |
| ------------------------------------------------- | --------------------------- |
| Indexed task checkpoint 后 bootstrap               | 不暴露                         |
| Indexed decision checkpoint 后 bootstrap           | 不暴露                         |
| Indexed blocker/question                          | 不暴露                         |
| Indexed detail search                             | 可以 recall                   |
| remember 新 Memory                                 | 默认 Indexed                  |
| remember 直接指定 Core                                | API 不允许 / runtime reject    |
| HTTP promotion actor=user                         | 不可绕过 Agent policy           |
| simultaneous same-key checkpoint                  | 单 checkpoint / 单 extraction |
| stale DB processing checkpoint                    | restart 后可 retry            |
| failed checkpoint + later events + retry same key | 仍绑定原 toEventId              |
| active progress                                   | 不进入 Handoff.completed       |
| resolved task                                     | 进入 Handoff.completed        |
| keyed Memory 改 family/type                        | conflict                    |
| restart DB cross-session handoff                  | Session B 能恢复               |

---

# 5. Add Durable Cross-Process Handoff Eval

现有 handoff eval 主要验证：

```text
Session A
↓
Session B
```

在同一个 `MemorySpace` instance 中。

必须增加一个更真实的 durability scenario：

```text
create persistent database

MemorySpace instance #1
↓
create Space
↓
create Session A
↓
append events
↓
checkpoint
↓
close()

MemorySpace instance #2
↓
open same database
↓
create Session B
↓
bootstrap()
```

Expected：

```text
Goal recovered
Core decisions recovered
Active task recovered
Latest Handoff recovered
Indexed detail not in bootstrap
Indexed detail still searchable
```

该 scenario 应加入 eval，而不只是普通 unit test。

---

# 6. Checkpoint Desired State After Fix

最终 checkpoint 逻辑应满足：

```text
checkpoint(request)
        │
        ▼
resolve idempotency identity
        │
        ├── completed → return completed
        │
        ├── active local in-flight → share operation
        │
        ├── stale processing → recover
        │
        └── new → atomically create
        │
        ▼
resolve immutable toEventId
        │
        ▼
load events from previous committed boundary
        │
        ▼
extract candidates
        │
        ▼
validate candidates
        │
        ▼
transaction
 ┌────────────────────────────┐
 │ keyed update / dedup       │
 │ promotion policy           │
 │ history/provenance         │
 │ build HandoffSnapshot      │
 │ checkpoint = completed     │
 │ advance Session boundary   │
 └────────────────────────────┘
        │
        ▼
invalidate bootstrap cache
```

Atomic transaction 中必须继续保持：

```text
Memory commit
+
Handoff creation
+
checkpoint completion
+
session boundary advance
```

现有这一点不要破坏。

---

# 7. Handoff Desired State After Fix

Handoff 不再是：

```text
all active Space Memory
→ snapshot
```

而应该是：

```text
Default-exposable current state
→ snapshot
```

MVP 可以理解为：

```text
active Core state
+
resolved high-level tasks
```

因此：

```text
Core
→ default disclosure

Indexed
→ explicit recall only
```

在 Handoff 中仍然成立。

---

# 8. Promotion Desired State After Fix

最终写入流程：

## Explicit

```text
remember()
↓
Indexed
```

然后：

```text
User trusted promotion
OR
Agent promote(reason)
↓
Promotion Policy
↓
Core
```

---

## Checkpoint

```text
Extractor
↓
MemoryCandidate.recommendedTier
↓
Domain Policy
↓
Core / Indexed
```

Extractor：

> 只能建议。

不能直接绕过 Domain Policy。

---

# 9. Implementation Order

Coding Agent 按以下顺序实现。

## Step 1 — Add failing regression tests first

先新增：

* Indexed Handoff leakage tests；
* remember Core bypass test；
* checkpoint retry edge tests；
* progress completed test；
* keyed schema conflict test；
* durable restart eval。

确认至少对应测试在当前代码下失败。

---

## Step 2 — Fix Handoff semantics

修：

```text
Indexed leakage
progress/completed
```

---

## Step 3 — Fix Promotion boundary

修：

```text
remember default Indexed invariant
HTTP actor spoofing
```

---

## Step 4 — Harden Checkpoint idempotency

修：

```text
atomic get-or-create
same-key race
stale processing recovery
immutable toEventId
```

---

## Step 5 — Key schema invariant

禁止：

```text
same key
→ change family/type
```

---

## Step 6 — Runtime version

Node：

```text
>=22.13.0
```

---

## Step 7 — Optional small composition-root cleanup

仅在不扩大 diff 的情况下处理。

---

## Step 8 — Run quality gate

必须运行：

```bash
pnpm run check
```

如果 workspace check 已存在：

```bash
pnpm run check:workspace
```

全部通过。

---

# 10. Acceptance Criteria

只有全部满足，才认为 MVP Hardening 完成。

## Domain correctness

* `remember()` 无法直接绕过 Promotion Policy 创建新 Core Memory；
* Indexed Memory 不会通过 Handoff 默认泄漏；
* Core / Indexed progressive disclosure invariant 成立；
* active progress 不再错误标记为 completed；
* keyed Memory 不能静默改变 family/type。

## Checkpoint correctness

* 同 key 并发不会产生 duplicate checkpoint；
* 同 key 不会重复调用 extraction；
* crash 遗留 processing 可以恢复；
* same idempotency key 永远绑定同一个 `toEventId`；
* failed retry 不会吞掉后续 events；
* boundary 只有成功 commit 后推进；
* transaction atomicity 保持不变。

## Runtime correctness

* Node engine 与实际 API requirements 一致。

## Evaluation

必须自动证明：

```text
Session A
↓
checkpoint
↓
process/storage reopen
↓
Session B
↓
bootstrap
```

仍能完成 Cross-Session Handoff。

---

# 11. Definition of Done

最终提交前 Coding Agent 输出：

1. 修改文件列表；
2. 每个 FIX 对应的实现说明；
3. 新增测试列表；
4. `pnpm run check` 结果；
5. `pnpm run check:workspace` 结果（如存在）；
6. 是否存在尚未解决的问题；
7. 是否修改了任何冻结 Domain Contract。

如果修改冻结 Domain Contract：

> 不得静默修改。

必须明确指出：

```text
Original invariant
Proposed change
Why required
Compatibility impact
```

默认情况下，本 Hardening 不应该需要修改冻结 Domain Contract。

---

# 12. Non-goal Reminder

完成本轮后立即停止。

不要顺手继续实现：

```text
Space revision
Memory OCC expectedVersion
Task claim/lease
Semantic merge
Vector search
LLM extractor
Redis
PostgreSQL
Provider hooks
MCP
Dashboard
```

这些属于下一阶段讨论。

本轮目标只有一个：

> **让已经完成的 MVP 真正符合其冻结的领域语义，并让 Cross-Session Handoff 在 retry、restart 和 progressive disclosure 边界下可靠成立。**
