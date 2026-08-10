import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryExtractor } from "../src/index.ts";
import { CheckpointPolicy, createDefaultMemorySpace, NoopExtractor, ValidationError } from "../src/index.ts";

test("CheckpointPolicy checkpoints only new events through the latest boundary", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "checkpoint policy" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const policy = new CheckpointPolicy(memorySpace);

  assert.deepEqual(await policy.checkpointIfNeeded({ sessionId: session.id, trigger: "explicit" }), {
    status: "noop", reason: "no_uncommitted_events", sessionId: session.id, trigger: "explicit"
  });
  await assert.rejects(
    policy.checkpointIfNeeded({ sessionId: session.id, trigger: "timer" as never }),
    (error: unknown) => error instanceof ValidationError
  );
  await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { content: "one" } });
  const latest = await memorySpace.appendEvent({
    sessionId: session.id, type: "message", payload: { content: "two" }
  });
  const completed = await policy.checkpointIfNeeded({ sessionId: session.id, trigger: "pre_compact" });
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") assert.equal(completed.checkpoint.toEventId, latest.id);
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, latest.id);

  const retry = await policy.checkpointIfNeeded({ sessionId: session.id, trigger: "pre_compact" });
  assert.equal(retry.status, "noop");
  const otherTrigger = await policy.checkpointIfNeeded({ sessionId: session.id, trigger: "session_end" });
  assert.equal(otherTrigger.status, "noop");
  await memorySpace.close();
});

test("CheckpointPolicy propagates domain and extractor failures", async () => {
  const extractor: MemoryExtractor = {
    async extract() { throw new Error("extractor unavailable"); }
  };
  const memorySpace = createDefaultMemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "checkpoint policy failure" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: {} });
  await assert.rejects(
    new CheckpointPolicy(memorySpace).checkpointIfNeeded({ sessionId: session.id, trigger: "session_end" }),
    /extractor unavailable/u
  );
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, undefined);
  await memorySpace.close();
});
