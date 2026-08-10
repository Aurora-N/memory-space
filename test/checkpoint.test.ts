import assert from "node:assert/strict";
import test from "node:test";
import type { ExtractionContext, MemoryCandidate, MemoryExtractor, SessionEvent } from "../src/index.ts";
import { ConflictError, MemorySpace, NoopExtractor, ValidationError } from "../src/index.ts";

class RecordingExtractor implements MemoryExtractor {
  batches: string[][] = [];

  async extract(events: SessionEvent[], _context: ExtractionContext): Promise<MemoryCandidate[]> {
    this.batches.push(events.map((event) => event.id));
    return events.map((event) => ({
      family: "episode", type: "interaction", content: String(event.payload.text),
      confidence: 1, recommendedTier: "indexed", sourceEventIds: [event.id], operation: "create"
    }));
  }
}

test("checkpoint is idempotent and advances an event-identity boundary", async () => {
  const extractor = new RecordingExtractor();
  const memorySpace = new MemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "checkpoint" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const e1 = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "one" } });
  const e2 = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "two" } });
  const e3 = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "three" } });
  const first = await memorySpace.checkpoint({ sessionId: session.id, toEventId: e3.id, idempotencyKey: "cp-1" });
  assert.equal(first.status, "completed");
  assert.deepEqual(extractor.batches, [[e1.id, e2.id, e3.id]]);
  const memoryIdsBeforeRetry = (await memorySpace.search({ spaceId: space.id, query: "" }))
    .map((result) => result.memory.id);
  const handoffBeforeRetry = await memorySpace.getLatestHandoff(space.id);

  const retry = await memorySpace.checkpoint({ sessionId: session.id, toEventId: e3.id, idempotencyKey: "cp-1" });
  assert.equal(retry.id, first.id);
  assert.equal(extractor.batches.length, 1);
  assert.deepEqual(
    (await memorySpace.search({ spaceId: space.id, query: "" })).map((result) => result.memory.id),
    memoryIdsBeforeRetry
  );
  assert.equal((await memorySpace.getLatestHandoff(space.id)).id, handoffBeforeRetry.id);

  const e4 = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "four" } });
  await assert.rejects(
    memorySpace.checkpoint({ sessionId: session.id, toEventId: e4.id, idempotencyKey: "cp-1" }),
    (error: unknown) => error instanceof ConflictError && error.code === "IDEMPOTENCY_MISMATCH"
  );
  const e5 = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "five" } });
  const second = await memorySpace.checkpoint({ sessionId: session.id, toEventId: e5.id, idempotencyKey: "cp-2" });
  assert.equal(second.fromEventId, e3.id);
  assert.deepEqual(extractor.batches[1], [e4.id, e5.id]);
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, e5.id);
  await memorySpace.close();
});

test("concurrent requests with the same idempotency key share one processing checkpoint", async () => {
  let extractionCalls = 0;
  let extractionStarted!: () => void;
  let releaseExtraction!: () => void;
  const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
  const extractor: MemoryExtractor = {
    async extract(events) {
      extractionCalls += 1;
      extractionStarted();
      await gate;
      return [{
        family: "knowledge", type: "decision", key: "project.database",
        content: "PostgreSQL", confidence: 1, recommendedTier: "indexed",
        sourceEventIds: [events[0].id], operation: "update"
      }];
    }
  };
  const memorySpace = new MemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "concurrent-idempotency" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const event = await memorySpace.appendEvent({
    sessionId: session.id, type: "message", payload: { text: "database choice" }
  });

  const firstRequest = memorySpace.checkpoint({
    sessionId: session.id, toEventId: event.id, idempotencyKey: "same-key"
  });
  await started;
  const concurrentRetry = await memorySpace.checkpoint({
    sessionId: session.id, toEventId: event.id, idempotencyKey: "same-key"
  });
  assert.equal(concurrentRetry.status, "processing");
  assert.equal(extractionCalls, 1);

  releaseExtraction();
  const completed = await firstRequest;
  assert.equal(completed.id, concurrentRetry.id);
  assert.equal(completed.status, "completed");
  assert.equal((await memorySpace.search({
    spaceId: space.id, query: "", types: ["decision"]
  })).length, 1);
  const laterRetry = await memorySpace.checkpoint({
    sessionId: session.id, toEventId: event.id, idempotencyKey: "same-key"
  });
  assert.equal(laterRetry.id, completed.id);
  assert.equal(extractionCalls, 1);
  await memorySpace.close();
});

test("failed checkpoint rolls back memory, snapshot and boundary and can be retried", async () => {
  let invalid = true;
  const extractor: MemoryExtractor = {
    async extract(events) {
      if (invalid) return [{
        family: "state", type: "task", content: "bad provenance", confidence: 1,
        recommendedTier: "indexed", sourceEventIds: ["outside"], operation: "create"
      }];
      return [{
        family: "state", type: "task", content: "valid", confidence: 1,
        recommendedTier: "indexed", sourceEventIds: [events[0].id], operation: "create"
      }];
    }
  };
  const memorySpace = new MemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "rollback" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const event = await memorySpace.appendEvent({ sessionId: session.id, type: "message", payload: { text: "x" } });
  await assert.rejects(
    memorySpace.checkpoint({ sessionId: session.id, toEventId: event.id, idempotencyKey: "retry-me" }),
    (error: unknown) => error instanceof ValidationError
  );
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, undefined);
  assert.equal((await memorySpace.search({ spaceId: space.id, query: "" })).length, 0);
  await assert.rejects(memorySpace.getLatestHandoff(space.id), /not found/);

  invalid = false;
  const retried = await memorySpace.checkpoint({
    sessionId: session.id, toEventId: event.id, idempotencyKey: "retry-me"
  });
  assert.equal(retried.status, "completed");
  assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, event.id);
  await memorySpace.close();
});

test("checkpoint succeeds with zero candidates and never closes a Session", async () => {
  const memorySpace = new MemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "zero" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const event = await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: {} });
  await memorySpace.checkpoint({ sessionId: session.id, toEventId: event.id, idempotencyKey: "zero" });
  const stillUsable = await memorySpace.appendEvent({ sessionId: session.id, type: "custom", payload: { after: true } });
  assert.equal(stillUsable.sessionId, session.id);
  await memorySpace.close();
});
