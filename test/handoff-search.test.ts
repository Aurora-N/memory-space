import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultMemorySpace } from "../src/index.ts";

test("Session B recovers Core + latest handoff and recalls Indexed detail", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "Cross-agent Project" });
  const sessionA = await memorySpace.createSession({ spaceId: space.id, agentId: "agent-a", provider: "codex" });
  const detail = await memorySpace.remember({
    spaceId: space.id, sourceSessionId: sessionA.id, family: "knowledge", type: "fact",
    content: "Recall endpoint lives in src/modules/recall.ts"
  });
  const goal = await memorySpace.remember({
    spaceId: space.id, sourceSessionId: sessionA.id, family: "state", type: "goal",
    key: "project.goal.primary", content: "Deliver cross-session handoff"
  });
  await memorySpace.promote(goal.id, { actor: "agent", reason: "Primary goal" });
  const event = await memorySpace.appendEvent({
    sessionId: sessionA.id, type: "message",
    payload: { text: "Decision: Use PostgreSQL for hosted deployments.\n先完成 recall API" }
  });
  await memorySpace.checkpoint({ sessionId: sessionA.id, toEventId: event.id, idempotencyKey: "handoff-1" });

  const sessionB = await memorySpace.createSession({ spaceId: space.id, agentId: "agent-b", provider: "other" });
  const boot = await memorySpace.bootstrap(sessionB.spaceId);
  assert.match(boot.context, /Deliver cross-session handoff/);
  assert.match(boot.context, /Use PostgreSQL for hosted deployments/);
  assert.match(boot.context, /完成 recall API/);
  assert.equal(boot.handoffSnapshot?.sessionId, sessionA.id);
  assert.doesNotMatch(boot.context, /src\/modules\/recall\.ts/);

  const recalled = await memorySpace.search({ spaceId: space.id, query: "recall endpoint module detail" });
  assert.equal(recalled[0].memory.id, detail.id);
  const context = await memorySpace.context({ spaceId: space.id, query: "recall endpoint" });
  assert.match(context.rendered, new RegExp(detail.id));
  assert.equal((await memorySpace.getMemory(detail.id)).tier, "indexed");
  await memorySpace.close();
});

test("search is Space-scoped and status/filter aware, including Chinese lexical recall", async () => {
  const memorySpace = createDefaultMemorySpace();
  const one = await memorySpace.createSpace({ name: "one" });
  const two = await memorySpace.createSpace({ name: "two" });
  const decision = await memorySpace.remember({
    spaceId: one.id, family: "knowledge", type: "decision",
    key: "project.database", content: "数据库使用 PostgreSQL"
  });
  await memorySpace.remember({
    spaceId: two.id, family: "knowledge", type: "decision", content: "数据库使用 MySQL"
  });
  const chinese = await memorySpace.search({ spaceId: one.id, query: "数据库之前怎么决定的？" });
  assert.deepEqual(chinese.map((result) => result.memory.id), [decision.id]);
  await memorySpace.setMemoryStatus(decision.id, "resolved");
  assert.equal((await memorySpace.search({ spaceId: one.id, query: "PostgreSQL" })).length, 0);
  assert.equal((await memorySpace.search({
    spaceId: one.id, query: "PostgreSQL", statuses: ["resolved"], tiers: ["indexed"]
  }))[0].memory.id, decision.id);
  assert.equal((await memorySpace.search({ spaceId: two.id, query: "PostgreSQL", statuses: ["resolved"] })).length, 0);
  await memorySpace.close();
});
