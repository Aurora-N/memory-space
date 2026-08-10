import assert from "node:assert/strict";
import test from "node:test";
import type { RememberInput } from "../src/index.ts";
import { createDefaultMemorySpace, NoopExtractor } from "../src/index.ts";

test("Indexed working state cannot leak through Handoff while remaining searchable", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "progressive disclosure" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const indexed = await Promise.all([
    memorySpace.remember({ spaceId: space.id, family: "state", type: "task", content: "修改 auth.ts 第 183 行" }),
    memorySpace.remember({ spaceId: space.id, family: "knowledge", type: "decision", content: "局部决定使用临时 mock" }),
    memorySpace.remember({ spaceId: space.id, family: "state", type: "blocker", content: "局部测试数据缺失" }),
    memorySpace.remember({ spaceId: space.id, family: "state", type: "question", content: "局部函数是否改名" })
  ]);
  const event = await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: {} });
  await memorySpace.checkpoint({ sessionId: session.id, toEventId: event.id, idempotencyKey: "no-leak" });

  const bootstrap = await memorySpace.bootstrap(space.id);
  for (const memory of indexed) {
    assert.doesNotMatch(bootstrap.context, new RegExp(memory.content, "u"));
    assert.equal((await memorySpace.search({ spaceId: space.id, query: memory.content }))[0].memory.id, memory.id);
  }
  await memorySpace.close();
});

test("active Core progress is context, not completed work", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "progress semantics" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const progress = await memorySpace.remember({
    spaceId: space.id, family: "state", type: "progress", content: "Recall Engine 完成 30%"
  });
  await memorySpace.promote(progress.id, { actor: "agent", reason: "Current project-wide progress" });
  const completedTask = await memorySpace.remember({
    spaceId: space.id, family: "state", type: "task", content: "完成 schema migration"
  });
  await memorySpace.setMemoryStatus(completedTask.id, "resolved");
  const event = await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: {} });
  await memorySpace.checkpoint({ sessionId: session.id, toEventId: event.id, idempotencyKey: "progress" });

  const handoff = await memorySpace.getLatestHandoff(space.id);
  assert.doesNotMatch(handoff.completed.join("\n"), /Recall Engine 完成 30%/u);
  assert.match(handoff.completed.join("\n"), /完成 schema migration/u);
  assert.match((await memorySpace.bootstrap(space.id)).context, /## Current Progress[\s\S]*Recall Engine 完成 30%/u);
  await memorySpace.close();
});

test("explicit remember cannot create a new Core Memory", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "remember boundary" });
  await assert.rejects(
    memorySpace.remember({
      spaceId: space.id, family: "state", type: "goal", content: "Bypass", tier: "core"
    } as unknown as RememberInput),
    /use promote|does not accept tier/iu
  );
  assert.equal((await memorySpace.search({ spaceId: space.id, query: "" })).length, 0);
  await memorySpace.close();
});
