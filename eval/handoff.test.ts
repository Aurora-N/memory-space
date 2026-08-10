import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDefaultMemorySpace } from "../src/index.ts";

interface Scenario {
  name: string;
  space: string;
  sessionA: { agentId: string; events: string[] };
  sessionB: { agentId: string; query: string };
  expected: { bootstrapContains: string[]; recallContains: string[] };
}

const scenario = JSON.parse(readFileSync(
  new URL("./fixtures/cross-session-handoff.json", import.meta.url), "utf8"
)) as Scenario;

test(`eval: ${scenario.name}`, async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ id: scenario.space, name: scenario.space });
  const sessionA = await memorySpace.createSession({ spaceId: space.id, agentId: scenario.sessionA.agentId });
  let lastEventId = "";
  for (const text of scenario.sessionA.events) {
    lastEventId = (await memorySpace.appendEvent({
      sessionId: sessionA.id, type: "message", payload: { text }
    })).id;
  }
  await memorySpace.checkpoint({ sessionId: sessionA.id, toEventId: lastEventId, idempotencyKey: scenario.name });
  const sessionB = await memorySpace.createSession({ spaceId: space.id, agentId: scenario.sessionB.agentId });
  const bootstrap = await memorySpace.bootstrap(sessionB.spaceId);
  for (const expected of scenario.expected.bootstrapContains) assert.match(bootstrap.context, new RegExp(expected, "iu"));
  const recall = await memorySpace.context({ spaceId: space.id, query: scenario.sessionB.query });
  for (const expected of scenario.expected.recallContains) assert.match(recall.rendered, new RegExp(expected, "iu"));
  await memorySpace.close();
});
