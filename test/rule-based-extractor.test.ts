import assert from "node:assert/strict";
import test from "node:test";
import { RuleBasedExtractor } from "../src/adapters/rule-based-extractor.ts";
import type { ExtractionContext, MemoryCandidate, SessionEvent } from "../src/index.ts";

const context: ExtractionContext = {
  checkpointId: "checkpoint-extractor-test",
  session: {
    id: "session-extractor-test",
    spaceId: "space-extractor-test",
    agentId: "extractor-test",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }
};

function event(
  payload: Record<string, unknown>,
  type: SessionEvent["type"] = "message",
  id = "event-extractor-test"
): SessionEvent {
  return {
    id,
    sessionId: context.session.id,
    type,
    payload,
    createdAt: "2026-08-13T00:00:00.000Z",
    sequence: 1
  };
}

async function extract(text: string): Promise<MemoryCandidate[]> {
  return new RuleBasedExtractor().extract([event({ text })], context);
}

test("E1 preserves representative English and Chinese explicit prefixes", async () => {
  const cases = [
    ["Goal: Ship v1.", "goal", "Ship v1."],
    ["目标：发布 v1。", "goal", "发布 v1。"],
    ["Roadmap: Complete B2.", "roadmap", "Complete B2."],
    ["路线图：完成 B2。", "roadmap", "完成 B2。"],
    ["计划：完成 B2。", "roadmap", "完成 B2。"],
    ["Progress: Migration is complete.", "progress", "Migration is complete."],
    ["进度：迁移完成。", "progress", "迁移完成。"],
    ["已完成：迁移。", "progress", "迁移。"],
    ["Task: Prepare release notes.", "task", "Prepare release notes."],
    ["Todo: Prepare release notes.", "task", "Prepare release notes."],
    ["任务：准备发布说明。", "task", "准备发布说明。"],
    ["下一步：准备发布说明。", "task", "准备发布说明。"],
    ["Decision: Use PostgreSQL.", "decision", "Use PostgreSQL."],
    ["决定：使用 PostgreSQL。", "decision", "使用 PostgreSQL。"],
    ["Constraint: Keep the API stable.", "constraint", "Keep the API stable."],
    ["约束：保持 API 稳定。", "constraint", "保持 API 稳定。"],
    ["Convention: Use kebab-case.", "convention", "Use kebab-case."],
    ["约定：使用 kebab-case。", "convention", "使用 kebab-case。"],
    ["Blocker: Credentials are missing.", "blocker", "Credentials are missing."],
    ["阻塞：缺少凭证。", "blocker", "缺少凭证。"],
    ["Question: Which region?", "question", "Which region?"],
    ["待确认：使用哪个区域？", "question", "使用哪个区域？"],
    ["问题：使用哪个区域？", "question", "使用哪个区域？"],
    ["Fact: Config lives in config.ts.", "fact", "Config lives in config.ts."],
    ["事实：配置位于 config.ts。", "fact", "配置位于 config.ts。"]
  ] as const;

  for (const [text, type, content] of cases) {
    const candidates = await extract(text);
    assert.equal(candidates.length, 1, text);
    assert.equal(candidates[0]?.type, type, text);
    assert.equal(candidates[0]?.content, content, text);
  }
});

test("E1 preserves explicit candidate family, key, tier, operation, and reason", async () => {
  const candidates = await extract([
    "Goal: Ship v1.",
    "Fact: Config lives in config.ts."
  ].join("\n"));

  assert.deepEqual(candidates, [
    {
      family: "state",
      type: "goal",
      key: "project.goal.primary",
      content: "Ship v1.",
      confidence: 0.9,
      importance: 0.8,
      recommendedTier: "core",
      promoteReason: "Explicit project goal",
      sourceEventIds: ["event-extractor-test"],
      operation: "update"
    },
    {
      family: "knowledge",
      type: "fact",
      key: undefined,
      content: "Config lives in config.ts.",
      confidence: 0.9,
      importance: 0.5,
      recommendedTier: "indexed",
      promoteReason: undefined,
      sourceEventIds: ["event-extractor-test"],
      operation: "create"
    }
  ]);
});

test("E2 recognizes natural durable selection decisions without a prefix", async () => {
  const candidates = await extract([
    "We selected PostgreSQL for hosted deployments.",
    "The team adopted Redis for distributed rate limiting.",
    "We adopted S3-compatible object storage.",
    "团队决定采用对象存储保存构建产物。"
  ].join("\n"));

  assert.deepEqual(candidates.map(({ family, type, content }) => ({ family, type, content })), [
    {
      family: "knowledge",
      type: "decision",
      content: "We selected PostgreSQL for hosted deployments."
    },
    {
      family: "knowledge",
      type: "decision",
      content: "The team adopted Redis for distributed rate limiting."
    },
    {
      family: "knowledge",
      type: "decision",
      content: "We adopted S3-compatible object storage."
    },
    {
      family: "knowledge",
      type: "decision",
      content: "团队决定采用对象存储保存构建产物。"
    }
  ]);

  assert.deepEqual(await extract("We selected lines 10 through 20."), []);
});

test("E3 recognizes persistent modal constraints without a prefix", async () => {
  const candidates = await extract([
    "All public APIs must remain backward compatible.",
    "Client credentials must not be written to logs.",
    "所有访问令牌必须在一小时内过期。"
  ].join("\n"));

  assert.deepEqual(candidates.map(({ family, type }) => ({ family, type })), [
    { family: "knowledge", type: "constraint" },
    { family: "knowledge", type: "constraint" },
    { family: "knowledge", type: "constraint" }
  ]);
});

test("E4 distinguishes durable project tasks from current-turn actions", async () => {
  const durable = await extract([
    "项目下一阶段需要完成数据库迁移。",
    "发布前必须完成 migration 回滚演练。",
    "The project's next phase needs to complete the database migration."
  ].join("\n"));
  assert.deepEqual(durable.map(({ type }) => type), ["task", "task", "task"]);

  assert.deepEqual(await extract("我接下来运行 migration test。"), []);
});

test("E5 rejects current execution narration", async () => {
  assert.deepEqual(await extract([
    "Task: 我现在先检查数据库文件。",
    "Task: I am currently reading the database config."
  ].join("\n")), []);
});

test("E6 rejects immediate conversational next actions", async () => {
  assert.deepEqual(await extract([
    "Task: 接下来我会运行测试并回复结果。",
    "Task: Next, I will analyze the output."
  ].join("\n")), []);
});

test("E7 extracts durable project completion as progress", async () => {
  const candidates = await extract([
    "数据库迁移已经完成。",
    "The production rollout has been completed."
  ].join("\n"));
  assert.deepEqual(candidates.map(({ type, key }) => ({ type, key })), [
    { type: "progress", key: "project.progress.current" },
    { type: "progress", key: "project.progress.current" }
  ]);
});

test("E8 rejects ephemeral operation completion narration", async () => {
  assert.deepEqual(await extract([
    "Progress: 我刚读取完配置文件。",
    "Progress: I just ran the local command."
  ].join("\n")), []);
});

test("E9 separates persistent blockers from temporary operation failure", async () => {
  const durable = await extract([
    "生产发布被缺失凭证阻塞。",
    "Production rollout is blocked by missing credentials."
  ].join("\n"));
  assert.deepEqual(durable.map(({ type }) => type), ["blocker", "blocker"]);

  assert.deepEqual(await extract([
    "Blocker: 刚才命令因为路径写错执行失败。",
    "Blocker: The tool call just failed due to a mistyped path."
  ].join("\n")), []);
});

test("E10 preserves structured Memory event compatibility", async () => {
  const candidates = await new RuleBasedExtractor().extract([
    event({
      candidate: {
        family: "knowledge",
        type: "decision",
        key: "project.database",
        content: "PostgreSQL is the hosted database.",
        data: { scope: "hosted" },
        importance: 0.9
      }
    }, "memory", "structured-event")
  ], context);

  assert.deepEqual(candidates, [{
    family: "knowledge",
    type: "decision",
    key: "project.database",
    content: "PostgreSQL is the hosted database.",
    data: { scope: "hosted" },
    importance: 0.9,
    confidence: 1,
    recommendedTier: "indexed",
    sourceEventIds: ["structured-event"],
    operation: "create"
  }]);
});

test("transient rejection uses interaction scope rather than a keyword stoplist", async () => {
  assert.deepEqual(await extract([
    "Task: Remove the temporary debug log after this command.",
    "Task: Summarize the result for the current response.",
    "任务：这次命令完成后删除临时日志。"
  ].join("\n")), []);

  const durable = await extract([
    "Task: Remove the temporary debug log after this run.",
    "Task: Document command failure recovery for the project."
  ].join("\n"));
  assert.deepEqual(durable.map(({ type, content }) => ({ type, content })), [
    { type: "task", content: "Remove the temporary debug log after this run." },
    { type: "task", content: "Document command failure recovery for the project." }
  ]);
});

test("D1-D3 natural constraints require durable project subject and scope evidence", async () => {
  assert.deepEqual(await extract([
    "You must run the test now.",
    "Right now I must run the test.",
    "I must reply with the result now.",
    "你必须现在运行测试。",
    "现在我必须运行测试。"
  ].join("\n")), []);

  const durable = await extract([
    "All public APIs must remain backward compatible.",
    "Client credentials must not be written to logs.",
    "All access tokens must expire within one hour."
  ].join("\n"));
  assert.deepEqual(durable.map(({ family, type }) => ({ family, type })), [
    { family: "knowledge", type: "constraint" },
    { family: "knowledge", type: "constraint" },
    { family: "knowledge", type: "constraint" }
  ]);
});

test("D4-D6 passive completions distinguish operations from durable progress", async () => {
  assert.deepEqual(await extract([
    "The command has been completed.",
    "The test has been completed.",
    "The tool call has been completed."
  ].join("\n")), []);

  const durable = await extract([
    "The production rollout has been completed.",
    "The database migration has been completed."
  ].join("\n"));
  assert.deepEqual(durable.map(({ family, type }) => ({ family, type })), [
    { family: "state", type: "progress" },
    { family: "state", type: "progress" }
  ]);
});

test("D7-D8 operation failure needs recent scope before it is transient", async () => {
  assert.deepEqual(await extract([
    "Blocker: The tool call just failed due to a mistyped path.",
    "Blocker: This tool call failed due to malformed input."
  ].join("\n")), []);

  const durable = await extract([
    "Blocker: Build failed because production signing credentials are missing.",
    "阻塞：生产构建因缺少签名凭证而失败。"
  ].join("\n"));
  assert.deepEqual(durable.map(({ family, type }) => ({ family, type })), [
    { family: "state", type: "blocker" },
    { family: "state", type: "blocker" }
  ]);
});

test("D9-D12 Chinese durability boundary rejects operations and retains project state", async () => {
  assert.deepEqual(await extract([
    "命令已经完成。",
    "测试已经完成。",
    "工具调用已经完成。",
    "现在我必须运行测试。"
  ].join("\n")), []);

  const durable = await extract([
    "数据库迁移已经完成。",
    "生产发布已经完成。",
    "所有访问令牌必须在一小时内过期。"
  ].join("\n"));
  assert.deepEqual(durable.map(({ family, type }) => ({ family, type })), [
    { family: "state", type: "progress" },
    { family: "state", type: "progress" },
    { family: "knowledge", type: "constraint" }
  ]);
});

test("natural blockers require durable subjects and explicit durable prefixes stay authoritative", async () => {
  assert.deepEqual(await extract([
    "The current command is blocked on a bad path.",
    "This tool call is blocked by malformed input.",
    "当前命令被错误路径阻塞。"
  ].join("\n")), []);

  const durable = await extract([
    "Production rollout is blocked by missing credentials.",
    "The release is blocked on production signing credentials.",
    "Constraint: Public APIs must remain backward compatible.",
    "Progress: Production rollout has been completed.",
    "Blocker: Build failed because production signing credentials are missing."
  ].join("\n"));
  assert.deepEqual(durable.map(({ type }) => type), [
    "blocker",
    "blocker",
    "constraint",
    "progress",
    "blocker"
  ]);
});

test("B2.1 preserves keyed database and explicit current-task compatibility", async () => {
  const candidates = await extract([
    "数据库使用 PostgreSQL",
    "先完成迁移回滚演练"
  ].join("\n"));
  assert.deepEqual(candidates.map(({ type, key, content }) => ({ type, key, content })), [
    { type: "decision", key: "project.database", content: "数据库使用 PostgreSQL" },
    { type: "task", key: "project.task.current", content: "完成 迁移回滚演练" }
  ]);
});

test("T1-T4 natural Chinese tasks require a durable project boundary", async () => {
  assert.deepEqual(await extract([
    "回复前必须完成测试。",
    "输出结果前必须完成测试。",
    "迁移测试输出结果前必须完成检查。"
  ].join("\n")), []);

  const durable = await extract([
    "发布前必须完成 migration 回滚演练。",
    "部署前必须完成数据库迁移。",
    "上线之前必须完成回滚验证。",
    "项目里程碑之前必须完成兼容性验证。"
  ].join("\n"));
  assert.deepEqual(durable.map(({ family, type, recommendedTier }) => ({
    family,
    type,
    recommendedTier
  })), [
    { family: "state", type: "task", recommendedTier: "core" },
    { family: "state", type: "task", recommendedTier: "core" },
    { family: "state", type: "task", recommendedTier: "core" },
    { family: "state", type: "task", recommendedTier: "core" }
  ]);
});
