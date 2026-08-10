import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDefaultMemorySpace } from "../src/index.ts";

test("eval durability: Session B recovers handoff after persistent storage reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-durable-eval-"));
  const databasePath = join(directory, "memory.db");
  try {
    const first = createDefaultMemorySpace({ databasePath });
    const space = await first.createSpace({ name: "durable handoff" });
    const sessionA = await first.createSession({ spaceId: space.id, agentId: "agent-a" });
    const detail = await first.remember({
      spaceId: space.id, sourceSessionId: sessionA.id, family: "knowledge", type: "fact",
      content: "Indexed detail lives in src/internal/recall.ts"
    });
    const goal = await first.remember({
      spaceId: space.id, sourceSessionId: sessionA.id, family: "state", type: "goal",
      key: "project.goal.primary", content: "Ship durable cross-session handoff"
    });
    await first.promote(goal.id, { actor: "agent", reason: "Primary project goal" });
    const event = await first.appendEvent({
      sessionId: sessionA.id, type: "message",
      payload: { text: "数据库确定使用 PostgreSQL。\n先完成 recall API" }
    });
    await first.checkpoint({ sessionId: sessionA.id, toEventId: event.id, idempotencyKey: "durable-eval" });
    await first.close();

    const second = createDefaultMemorySpace({ databasePath });
    const sessionB = await second.createSession({ spaceId: space.id, agentId: "agent-b" });
    const bootstrap = await second.bootstrap(sessionB.spaceId);
    assert.match(bootstrap.context, /Ship durable cross-session handoff/u);
    assert.match(bootstrap.context, /PostgreSQL/u);
    assert.match(bootstrap.context, /recall API/iu);
    assert.equal(bootstrap.handoffSnapshot?.sessionId, sessionA.id);
    assert.doesNotMatch(bootstrap.context, /src\/internal\/recall\.ts/u);
    assert.equal((await second.search({
      spaceId: space.id, query: "internal recall detail"
    }))[0].memory.id, detail.id);
    await second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
