import assert from "node:assert/strict";
import test from "node:test";
import type { CachePort, MemoryExtractor } from "../src/index.ts";
import { createDefaultMemorySpace } from "../src/index.ts";

class ThrowingDeleteCache implements CachePort {
  async get<T>(_key: string): Promise<T | undefined> { return undefined; }
  async set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {}
  async delete(_key: string): Promise<void> { throw new Error("cache unavailable"); }
}

test("cache invalidation failure cannot turn a committed checkpoint into failure", async () => {
  const extractor: MemoryExtractor = {
    async extract(events) {
      return [{
        family: "knowledge", type: "decision", key: "project.cache-boundary",
        content: "Durable state wins", confidence: 1, recommendedTier: "indexed",
        sourceEventIds: [events[0].id], operation: "update"
      }];
    }
  };
  const memorySpace = createDefaultMemorySpace({ cache: new ThrowingDeleteCache(), extractor });
  const space = await memorySpace.createSpace({ name: "checkpoint cache failure" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const event = await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: {} });

  const completed = await memorySpace.checkpoint({
    sessionId: session.id, toEventId: event.id, idempotencyKey: "cache-delete-fails"
  });

  assert.equal(completed.status, "completed");
  assert.equal((await memorySpace.getCheckpoint(completed.id)).status, "completed");
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, event.id);
  assert.equal((await memorySpace.getLatestHandoff(space.id)).checkpointId, completed.id);
  assert.equal((await memorySpace.search({ spaceId: space.id, query: "Durable state wins" })).length, 1);
  await memorySpace.close();
});

test("cache invalidation failure cannot turn a durable remember into failure", async () => {
  const memorySpace = createDefaultMemorySpace({ cache: new ThrowingDeleteCache() });
  const space = await memorySpace.createSpace({ name: "remember cache failure" });

  const remembered = await memorySpace.remember({
    spaceId: space.id, family: "knowledge", type: "fact", content: "Persist despite cache failure"
  });

  assert.equal(remembered.tier, "indexed");
  assert.deepEqual(await memorySpace.getMemory(remembered.id), remembered);
  await memorySpace.close();
});
