import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryCandidateFingerprint } from "../src/application/memory-candidate-fingerprint.ts";
import {
  CheckpointPolicy,
  createDefaultMemorySpace,
  ImplicitRecallService,
  ImplicitRememberService,
  LifecycleHandler,
  type MemoryCandidate,
  type MemoryCandidateCommitReceipt,
  type MemoryExtractor,
  MemorySpace,
  NoopCache,
  ProviderSessionResolver,
  RuleBasedExtractor,
  type SessionEvent,
  SpaceResolver,
  SqliteMemoryStore,
} from "../src/index.ts";

function bind(directory: string, implicitRemember: unknown = { mode: "conservative" }): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(
    join(bindingDirectory, "config.json"),
    JSON.stringify({
      version: 1,
      spaceId: "space-p8",
      implicitRecall: { mode: "exact" },
      implicitRemember,
    })
  );
}

async function configuredLifecycle(directory: string, extractor?: MemoryExtractor) {
  const memorySpace = createDefaultMemorySpace({ extractor });
  await memorySpace.createSpace({ id: "space-p8", name: "P8" });
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    implicitRemember: new ImplicitRememberService(memorySpace),
  });
  const started = await handler.handle({
    type: "session_start",
    provider: "fake",
    externalSessionId: "native-p8",
    cwd: directory,
  });
  if (started.type !== "session_start") throw new Error("Expected session_start");
  return { memorySpace, handler, session: started.session };
}

test("opaque stable assignment is deterministic and ordinary equality prose is ignored", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "assignment extraction" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const user = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: {
      role: "user",
      content: [
        "CROSS_AGENT_TEST_20260817 = lavender-731",
        "ordinary value = another value",
        "x == y",
      ].join("\n"),
    },
  });
  const candidates = await memorySpace.extractMemoryCandidates([user], {
    session,
    trigger: "implicit_remember",
    operationId: "implicit-assignment",
  });
  assert.deepEqual(candidates, [
    {
      family: "knowledge",
      type: "fact",
      key: "CROSS_AGENT_TEST_20260817",
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
      confidence: 0.98,
      importance: 0.5,
      recommendedTier: "indexed",
      sourceEventIds: [user.id],
      operation: "update",
    },
  ]);
  await memorySpace.close();
});

test("assistant lifecycle persists the event before implicit remember and fails open", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-order-"));
  bind(directory);
  const memorySpace = createDefaultMemorySpace();
  await memorySpace.createSpace({ id: "space-p8", name: "P8 order" });
  const diagnostics: string[] = [];
  let observedAssistant = false;
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    implicitRemember: {
      async rememberTurn(input) {
        const events = await memorySpace.listEvents(input.sessionId);
        observedAssistant = events.some(
          (event) => event.payload.role === "assistant" && event.payload.content === "done"
        );
        throw new Error("implicit remember unavailable");
      },
    },
    onWarning(diagnostic) {
      diagnostics.push(diagnostic.warning.error.code);
    },
  });
  try {
    const started = await handler.handle({
      type: "session_start",
      provider: "fake",
      externalSessionId: "native-order",
      cwd: directory,
    });
    if (started.type !== "session_start") throw new Error("Expected session_start");
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-order",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    const result = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-order",
      cwd: directory,
      content: "done",
    });
    assert.equal(result.type, "assistant_turn");
    assert.equal(observedAssistant, true);
    assert.equal(result.implicitRemember?.effectiveMode, "off");
    assert.deepEqual(diagnostics, ["IMPLICIT_REMEMBER_UNAVAILABLE"]);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, 2);
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conservative lifecycle creates Indexed Memory without checkpoint or Handoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-lifecycle-"));
  bind(directory);
  const { memorySpace, handler, session } = await configuredLifecycle(directory);
  try {
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    const result = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "Recorded.",
    });
    if (result.type !== "assistant_turn") throw new Error("Expected assistant_turn");
    assert.equal(result.implicitRemember?.committed.length, 1);
    const memories = await memorySpace.search({
      spaceId: session.spaceId,
      query: "",
      statuses: ["active"],
    });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memory.key, "CROSS_AGENT_TEST_20260817");
    assert.equal(memories[0]?.memory.tier, "indexed");
    const unchanged = await memorySpace.getSession(session.id);
    assert.equal(unchanged.lastCheckpointEventId, undefined);
    assert.equal(unchanged.latestHandoffSnapshotId, undefined);
    await assert.rejects(memorySpace.getLatestHandoff(session.spaceId), /not found/u);
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mode off and per-turn opt-out persist events with zero implicit Memory write", async () => {
  for (const scenario of [
    {
      config: { mode: "off" },
      prompt: "CROSS_AGENT_TEST_20260817 = lavender-731",
      bypassed: false,
    },
    {
      config: { mode: "conservative" },
      prompt: "不要记住这次内容\nCROSS_AGENT_TEST_20260817 = lavender-731",
      bypassed: true,
    },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-bypass-"));
    bind(directory, scenario.config);
    const { memorySpace, handler, session } = await configuredLifecycle(directory);
    try {
      await handler.handle({
        type: "user_prompt",
        provider: "fake",
        externalSessionId: "native-p8",
        cwd: directory,
        content: scenario.prompt,
      });
      const result = await handler.handle({
        type: "assistant_turn",
        provider: "fake",
        externalSessionId: "native-p8",
        cwd: directory,
        content: "done",
      });
      if (result.type !== "assistant_turn") throw new Error("Expected assistant_turn");
      assert.equal(result.implicitRemember?.bypassed, scenario.bypassed);
      assert.equal((await memorySpace.search({ spaceId: session.spaceId, query: "" })).length, 0);
      assert.equal((await memorySpace.listEvents(session.id)).length, 2);
    } finally {
      await memorySpace.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("implicit remember prioritizes latest user evidence within bounded extraction input", async () => {
  let inspected: SessionEvent[] = [];
  const extractor: MemoryExtractor = {
    async extract(events) {
      inspected = events;
      return [];
    },
  };
  const memorySpace = createDefaultMemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "bounded implicit window" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const events: SessionEvent[] = [];
  for (const [role, content] of [
    ["user", "old1"],
    ["assistant", "old2"],
    ["user", "0123456789ABCDEFGHIJ"],
    ["assistant", "done"],
  ] as const) {
    events.push(
      await memorySpace.appendEvent({
        sessionId: session.id,
        type: "message",
        payload: { role, content },
      })
    );
  }
  await new ImplicitRememberService(memorySpace, {
    maxEventsPerImplicitRemember: 3,
    maxInputCharsPerImplicitRemember: 12,
  }).rememberTurn({
    sessionId: session.id,
    throughEventId: events.at(-1)?.id ?? "",
    mode: "conservative",
  });
  assert.deepEqual(
    inspected.map((event) => event.id),
    [events[2]?.id]
  );
  assert.deepEqual(
    inspected.map((event) => event.payload.content),
    ["89ABCDEFGHIJ"]
  );
  assert.equal(
    inspected.reduce(
      (total, event) =>
        total + (typeof event.payload.content === "string" ? event.payload.content.length : 0),
      0
    ),
    12
  );
  assert.equal(
    (await memorySpace.listEvents(session.id))[2]?.payload.content,
    "0123456789ABCDEFGHIJ"
  );
  await memorySpace.close();
});

test("full authoritative user evidence enforces opt-out before bounded extraction", async () => {
  class CountingReceiptStore extends SqliteMemoryStore {
    receiptWrites = 0;

    override async insertMemoryCandidateCommitReceipt(
      receipt: MemoryCandidateCommitReceipt
    ): Promise<void> {
      this.receiptWrites += 1;
      await super.insertMemoryCandidateCommitReceipt(receipt);
    }
  }

  for (const assistantContent of ["done", "a".repeat(30_000)]) {
    const store = new CountingReceiptStore();
    const memorySpace = new MemorySpace({
      store,
      extractor: new RuleBasedExtractor(),
      cache: new NoopCache(),
    });
    const space = await memorySpace.createSpace({ name: "authoritative opt-out" });
    const session = await memorySpace.createSession({ spaceId: space.id });
    const prompt = [
      "不要记住这次内容",
      "x".repeat(30_000),
      "LONG_OPT_OUT_1 = should-not-persist",
    ].join("\n");
    await memorySpace.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { role: "user", content: prompt },
    });
    const assistant = await memorySpace.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { role: "assistant", content: assistantContent },
    });

    const result = await new ImplicitRememberService(memorySpace).rememberTurn({
      sessionId: session.id,
      throughEventId: assistant.id,
      mode: "conservative",
    });

    assert.equal(result.bypassed, true);
    assert.deepEqual(result.inspectedEventIds, []);
    assert.equal((await memorySpace.search({ spaceId: space.id, query: "" })).length, 0);
    assert.equal(store.receiptWrites, 0);
    const persisted = await memorySpace.listEvents(session.id);
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0]?.payload.content, prompt);
    assert.equal(persisted[1]?.payload.content, assistantContent);
    await memorySpace.close();
  }
});

test("long assistant response cannot displace latest user assignment evidence", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "long assistant retention" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const user = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "LONG_ASSISTANT_TEST_1 = durable" },
  });
  const assistantContent = `${"😀".repeat(15_000)}tail`;
  const assistant = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "assistant", content: assistantContent },
  });

  const result = await new ImplicitRememberService(memorySpace).rememberTurn({
    sessionId: session.id,
    throughEventId: assistant.id,
    mode: "conservative",
  });

  assert.equal(result.committed.length, 1);
  const memory = await memorySpace.getMemory(result.committed[0]?.memoryId ?? "");
  assert.equal(memory.key, "LONG_ASSISTANT_TEST_1");
  assert.equal(memory.tier, "indexed");
  const persisted = await memorySpace.listEvents(session.id);
  assert.equal(persisted[0]?.id, user.id);
  assert.equal(persisted[1]?.payload.content, assistantContent);
  await memorySpace.close();
});

test("strict admission rejects assistant-only, low-confidence, transient, and existing Core targets", async () => {
  const candidates: MemoryCandidate[] = [
    {
      family: "knowledge",
      type: "fact",
      key: "LOW_CONFIDENCE_1",
      content: "LOW_CONFIDENCE_1 = weak",
      confidence: 0.5,
      recommendedTier: "indexed",
      sourceEventIds: [],
      operation: "update",
    },
  ];
  const extractor: MemoryExtractor = {
    async extract(events) {
      return candidates.map((candidate) => ({
        ...candidate,
        sourceEventIds: [events[0]?.id ?? "missing"],
      }));
    },
  };
  const memorySpace = createDefaultMemorySpace({ extractor });
  const space = await memorySpace.createSpace({ name: "strict admission" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const user = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "durable project fact" },
  });
  const assistant = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "assistant", content: "ASSISTANT_ONLY_1 = invented" },
  });
  const service = new ImplicitRememberService(memorySpace);
  const low = await service.rememberTurn({
    sessionId: session.id,
    throughEventId: assistant.id,
    mode: "conservative",
  });
  assert.deepEqual(
    low.rejected.map((item) => item.reason),
    ["low_confidence"]
  );

  const defaultMemorySpace = createDefaultMemorySpace();
  const defaultSpace = await defaultMemorySpace.createSpace({ name: "assistant only" });
  const defaultSession = await defaultMemorySpace.createSession({ spaceId: defaultSpace.id });
  const assistantOnly = await defaultMemorySpace.appendEvent({
    sessionId: defaultSession.id,
    type: "message",
    payload: { role: "assistant", content: "ASSISTANT_ONLY_1 = invented" },
  });
  const assistantResult = await new ImplicitRememberService(defaultMemorySpace).rememberTurn({
    sessionId: defaultSession.id,
    throughEventId: assistantOnly.id,
    mode: "conservative",
  });
  assert.deepEqual(
    assistantResult.rejected.map((item) => item.reason),
    ["missing_user_evidence"]
  );

  await defaultMemorySpace.appendEvent({
    sessionId: defaultSession.id,
    type: "message",
    payload: { role: "user", content: "Task: I am currently checking this file." },
  });
  const transientAssistant = await defaultMemorySpace.appendEvent({
    sessionId: defaultSession.id,
    type: "message",
    payload: { role: "assistant", content: "done" },
  });
  const transientResult = await new ImplicitRememberService(defaultMemorySpace).rememberTurn({
    sessionId: defaultSession.id,
    throughEventId: transientAssistant.id,
    mode: "conservative",
  });
  assert.equal(transientResult.committed.length, 0);

  const core = await defaultMemorySpace.remember({
    spaceId: defaultSpace.id,
    family: "knowledge",
    type: "fact",
    key: "CORE_COLLISION_1",
    content: "CORE_COLLISION_1 = original",
  });
  await defaultMemorySpace.promote(core.id, { actor: "user" });
  await defaultMemorySpace.appendEvent({
    sessionId: defaultSession.id,
    type: "message",
    payload: { role: "user", content: "CORE_COLLISION_1 = changed" },
  });
  const collisionAssistant = await defaultMemorySpace.appendEvent({
    sessionId: defaultSession.id,
    type: "message",
    payload: { role: "assistant", content: "done" },
  });
  const collision = await new ImplicitRememberService(defaultMemorySpace).rememberTurn({
    sessionId: defaultSession.id,
    throughEventId: collisionAssistant.id,
    mode: "conservative",
  });
  assert.ok(collision.rejected.some((item) => item.reason === "existing_core_memory"));
  assert.equal(
    (await defaultMemorySpace.getMemory(core.id)).content,
    "CORE_COLLISION_1 = original"
  );
  assert.equal((await defaultMemorySpace.getMemory(core.id)).tier, "core");

  assert.equal(user.sessionId, session.id);
  await memorySpace.close();
  await defaultMemorySpace.close();
});

test("conservative implicit remember rejects credential-shaped keys without broad token false positives", async () => {
  const rejectedKeys = [
    "OPENAI_API_KEY",
    "DATABASE_PASSWORD",
    "prod.access-token",
    "service/private_key",
    "OAUTH_CLIENT_SECRET",
    "LEGACY_PASSWD",
    "AUTH:CREDENTIALS",
  ];
  const allowedKeys = ["DESIGN_TOKEN_VERSION", "TOKEN_BUDGET_LIMIT", "CROSS_AGENT_TEST_20260817"];
  for (const [key, shouldReject] of [
    ...rejectedKeys.map((key) => [key, true] as const),
    ...allowedKeys.map((key) => [key, false] as const),
  ]) {
    const memorySpace = createDefaultMemorySpace();
    const space = await memorySpace.createSpace({ name: `secret guard ${key}` });
    const session = await memorySpace.createSession({ spaceId: space.id });
    await memorySpace.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { role: "user", content: `${key} = value-must-not-appear-in-result` },
    });
    const assistant = await memorySpace.appendEvent({
      sessionId: session.id,
      type: "message",
      payload: { role: "assistant", content: "done" },
    });
    const result = await new ImplicitRememberService(memorySpace).rememberTurn({
      sessionId: session.id,
      throughEventId: assistant.id,
      mode: "conservative",
    });
    if (shouldReject) {
      assert.deepEqual(result.rejected, [{ type: "fact", reason: "secret_like_evidence" }]);
      assert.equal(result.committed.length, 0);
      assert.doesNotMatch(JSON.stringify(result), /value-must-not-appear-in-result/u);
    } else {
      assert.equal(result.rejected.length, 0);
      assert.equal(result.committed.length, 1);
    }
    await memorySpace.close();
  }
});

test("recommended Core candidate is always committed as Indexed by implicit remember", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "indexed only" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "项目已经决定使用 pnpm 作为包管理器。" },
  });
  const assistant = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "assistant", content: "done" },
  });
  const result = await new ImplicitRememberService(memorySpace).rememberTurn({
    sessionId: session.id,
    throughEventId: assistant.id,
    mode: "conservative",
  });
  assert.equal(result.committed.length, 1);
  const memory = await memorySpace.getMemory(result.committed[0]?.memoryId ?? "");
  assert.equal(memory.type, "decision");
  assert.equal(memory.tier, "indexed");
  await memorySpace.close();
});

test("replayed assistant Stop reuses one receipt and one Memory without duplicate update", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-replay-"));
  bind(directory);
  const { memorySpace, handler, session } = await configuredLifecycle(directory);
  try {
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    const first = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "done",
    });
    const replay = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "done",
    });
    if (first.type !== "assistant_turn" || replay.type !== "assistant_turn") {
      throw new Error("Expected assistant_turn");
    }
    assert.equal(first.implicitRemember?.committed[0]?.disposition, "created");
    assert.equal(replay.implicitRemember?.committed[0]?.disposition, "deduplicated");
    assert.equal(
      first.implicitRemember?.committed[0]?.memoryId,
      replay.implicitRemember?.committed[0]?.memoryId
    );
    const memories = await memorySpace.search({ spaceId: session.spaceId, query: "" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memory.version, 1);
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("later checkpoint reuses implicit Memory identity and preserves checkpoint semantics", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-checkpoint-"));
  bind(directory);
  const { memorySpace, handler, session } = await configuredLifecycle(directory);
  try {
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    const stopped = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
      content: "done",
    });
    if (stopped.type !== "assistant_turn") throw new Error("Expected assistant_turn");
    const implicitMemoryId = stopped.implicitRemember?.committed[0]?.memoryId;
    assert.ok(implicitMemoryId);
    assert.equal((await memorySpace.getSession(session.id)).lastCheckpointEventId, undefined);

    const ended = await handler.handle({
      type: "session_end",
      provider: "fake",
      externalSessionId: "native-p8",
      cwd: directory,
    });
    if (ended.type !== "session_end") throw new Error("Expected session_end");
    assert.equal(ended.checkpoint.status, "completed");
    const memories = await memorySpace.search({ spaceId: session.spaceId, query: "" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memory.id, implicitMemoryId);
    assert.equal(memories[0]?.memory.version, 1);
    const afterCheckpoint = await memorySpace.getSession(session.id);
    assert.ok(afterCheckpoint.lastCheckpointEventId);
    assert.ok(afterCheckpoint.latestHandoffSnapshotId);
    assert.equal(
      (await memorySpace.getLatestHandoff(session.spaceId)).checkpointId,
      ended.checkpoint.checkpoint.id
    );
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint does not replay historical implicit updates for one stable key", async () => {
  for (const values of [
    ["v1", "v2"],
    ["v1", "v2", "v3"],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-convergence-"));
    bind(directory);
    const { memorySpace, handler, session } = await configuredLifecycle(directory);
    try {
      for (const value of values) {
        await handler.handle({
          type: "user_prompt",
          provider: "fake",
          externalSessionId: "native-p8",
          cwd: directory,
          content: `CHECKPOINT_REPLAY_TEST_1 = ${value}`,
        });
        await handler.handle({
          type: "assistant_turn",
          provider: "fake",
          externalSessionId: "native-p8",
          cwd: directory,
          content: "done",
        });
      }
      const before = (
        await memorySpace.search({ spaceId: session.spaceId, query: "CHECKPOINT_REPLAY_TEST_1" })
      )[0]?.memory;
      assert.ok(before);
      assert.equal(before.content, `CHECKPOINT_REPLAY_TEST_1 = ${values.at(-1)}`);
      assert.equal(before.version, values.length);
      const historyBefore = await memorySpace.getMemoryHistory(before.id);

      const ended = await handler.handle({
        type: "session_end",
        provider: "fake",
        externalSessionId: "native-p8",
        cwd: directory,
      });
      if (ended.type !== "session_end") throw new Error("Expected session_end");

      const after = await memorySpace.getMemory(before.id);
      assert.equal(after.content, before.content);
      assert.equal(after.version, before.version);
      assert.deepEqual(await memorySpace.getMemoryHistory(before.id), historyBefore);
    } finally {
      await memorySpace.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("materialized implicit content still receives checkpoint-only Core admission", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "checkpoint admission after implicit" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "项目已经决定使用 pnpm 作为包管理器。" },
  });
  const assistant = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "assistant", content: "done" },
  });
  const implicit = await new ImplicitRememberService(memorySpace).rememberTurn({
    sessionId: session.id,
    throughEventId: assistant.id,
    mode: "conservative",
  });
  const memoryId = implicit.committed[0]?.memoryId ?? "";
  const before = await memorySpace.getMemory(memoryId);
  assert.equal(before.tier, "indexed");
  assert.equal(before.version, 1);

  await memorySpace.checkpoint({
    sessionId: session.id,
    toEventId: assistant.id,
    idempotencyKey: "checkpoint-admission-after-implicit",
  });

  const after = await memorySpace.getMemory(memoryId);
  assert.equal(after.content, before.content);
  assert.equal(after.tier, "core");
  assert.equal(after.version, 2);
  assert.deepEqual(
    (await memorySpace.getMemoryHistory(memoryId)).map((record) => record.operation),
    ["create", "promote:automatic"]
  );
  await memorySpace.close();
});

test("checkpoint-first candidate creates a durable receipt and remains retry-safe", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "checkpoint-first receipt" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const user = await memorySpace.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "CHECKPOINT_FIRST_TEST_1 = durable" },
  });
  const input = {
    sessionId: session.id,
    toEventId: user.id,
    idempotencyKey: "checkpoint-first-receipt",
  };
  const first = await memorySpace.checkpoint(input);
  const before = (
    await memorySpace.search({ spaceId: space.id, query: "CHECKPOINT_FIRST_TEST_1" })
  )[0]?.memory;
  assert.ok(before);
  assert.equal(before.version, 1);

  const retry = await memorySpace.checkpoint(input);
  const after = await memorySpace.getMemory(before.id);
  assert.equal(retry.id, first.id);
  assert.equal(after.version, 1);
  const history = await memorySpace.getMemoryHistory(before.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.operation, "create");
  await memorySpace.close();
});

test("new evidence for the same stable key updates the same Memory identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-key-update-"));
  bind(directory);
  const { memorySpace, handler, session } = await configuredLifecycle(directory);
  try {
    for (const value of ["lavender-731", "indigo-842"]) {
      await handler.handle({
        type: "user_prompt",
        provider: "fake",
        externalSessionId: "native-p8",
        cwd: directory,
        content: `CROSS_AGENT_TEST_20260817 = ${value}`,
      });
      await handler.handle({
        type: "assistant_turn",
        provider: "fake",
        externalSessionId: "native-p8",
        cwd: directory,
        content: "done",
      });
    }
    const memories = await memorySpace.search({ spaceId: session.spaceId, query: "" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memory.content, "CROSS_AGENT_TEST_20260817 = indigo-842");
    assert.equal(memories[0]?.memory.version, 2);
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate fingerprint ignores admission fields and canonicalizes evidence order", () => {
  const candidate: MemoryCandidate = {
    family: "knowledge",
    type: "fact",
    key: " CROSS_AGENT_TEST_20260817 ",
    content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    confidence: 0.98,
    importance: 0.5,
    recommendedTier: "indexed",
    promoteReason: "first",
    sourceEventIds: ["event-b", "event-a", "event-a"],
    operation: "update",
  };
  const changedAdmission: MemoryCandidate = {
    ...candidate,
    confidence: 0.85,
    importance: 1,
    recommendedTier: "core",
    promoteReason: "second",
    sourceEventIds: ["event-a", "event-b"],
  };
  assert.equal(
    memoryCandidateFingerprint("session-1", candidate),
    memoryCandidateFingerprint("session-1", changedAdmission)
  );
  assert.notEqual(
    memoryCandidateFingerprint("session-1", candidate),
    memoryCandidateFingerprint("session-2", candidate)
  );
  assert.notEqual(
    memoryCandidateFingerprint("session-1", candidate),
    memoryCandidateFingerprint("session-1", { ...candidate, content: "changed" })
  );
});

test("candidate receipt survives SQLite reopen and deduplicates replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-reopen-"));
  const databasePath = join(directory, "memory.db");
  let assistantId = "";
  let sessionId = "";
  let spaceId = "";
  try {
    const first = createDefaultMemorySpace({ databasePath });
    const space = await first.createSpace({ name: "receipt durability" });
    spaceId = space.id;
    const session = await first.createSession({ spaceId });
    sessionId = session.id;
    await first.appendEvent({
      sessionId,
      type: "message",
      payload: { role: "user", content: "REOPEN_TEST_1 = durable" },
    });
    const assistant = await first.appendEvent({
      sessionId,
      type: "message",
      payload: { role: "assistant", content: "done" },
    });
    assistantId = assistant.id;
    const committed = await new ImplicitRememberService(first).rememberTurn({
      sessionId,
      throughEventId: assistantId,
      mode: "conservative",
    });
    assert.equal(committed.committed[0]?.disposition, "created");
    await first.close();

    const reopened = createDefaultMemorySpace({ databasePath });
    const replay = await new ImplicitRememberService(reopened).rememberTurn({
      sessionId,
      throughEventId: assistantId,
      mode: "conservative",
    });
    assert.equal(replay.committed[0]?.disposition, "deduplicated");
    const memories = await reopened.search({ spaceId, query: "" });
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.memory.version, 1);
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cwd drift to another Space fails open after persistence with zero implicit write", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-p8-cwd-drift-"));
  const projectA = join(root, "a");
  const projectB = join(root, "b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  bind(projectA);
  const bindingDirectory = join(projectB, ".memory-space");
  mkdirSync(bindingDirectory);
  writeFileSync(
    join(bindingDirectory, "config.json"),
    JSON.stringify({
      version: 1,
      spaceId: "space-other",
      implicitRemember: { mode: "conservative" },
    })
  );
  const memorySpace = createDefaultMemorySpace();
  await memorySpace.createSpace({ id: "space-p8", name: "P8 source" });
  await memorySpace.createSpace({ id: "space-other", name: "P8 other" });
  const diagnostics: string[] = [];
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    implicitRemember: new ImplicitRememberService(memorySpace),
    onWarning(diagnostic) {
      diagnostics.push(diagnostic.warning.error.code);
    },
  });
  try {
    const started = await handler.handle({
      type: "session_start",
      provider: "fake",
      externalSessionId: "native-drift",
      cwd: projectA,
    });
    if (started.type !== "session_start") throw new Error("Expected session_start");
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-drift",
      cwd: projectA,
      content: "DRIFT_TEST_1 = durable",
    });
    const stopped = await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-drift",
      cwd: projectB,
      content: "done",
    });
    assert.equal(stopped.type, "assistant_turn");
    assert.deepEqual(diagnostics, ["IMPLICIT_REMEMBER_UNAVAILABLE"]);
    assert.equal((await memorySpace.listEvents(started.session.id)).length, 2);
    assert.equal((await memorySpace.search({ spaceId: "space-p8", query: "" })).length, 0);
    assert.equal((await memorySpace.search({ spaceId: "space-other", query: "" })).length, 0);
  } finally {
    await memorySpace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P8 Indexed Memory is recalled implicitly in a new Session without Memory tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p8-closure-"));
  bind(directory);
  const memorySpace = createDefaultMemorySpace();
  await memorySpace.createSpace({ id: "space-p8", name: "P8 closure" });
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    implicitRecall: new ImplicitRecallService(memorySpace),
    implicitRemember: new ImplicitRememberService(memorySpace),
  });
  try {
    await handler.handle({
      type: "session_start",
      provider: "fake",
      externalSessionId: "closure-a",
      cwd: directory,
    });
    await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "closure-a",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    await handler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "closure-a",
      cwd: directory,
      content: "done",
    });

    await handler.handle({
      type: "session_start",
      provider: "fake",
      externalSessionId: "closure-b",
      cwd: directory,
    });
    const recalled = await handler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "closure-b",
      cwd: directory,
      content: "CROSS_AGENT_TEST_20260817",
    });
    if (recalled.type !== "user_prompt") throw new Error("Expected user_prompt");
    assert.ok(recalled.recall);
    assert.match(recalled.recall.context ?? "", /lavender-731/u);
    assert.deepEqual(
      recalled.recall.debugItems.map((item) => item.key),
      ["CROSS_AGENT_TEST_20260817"]
    );
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class ReceiptFailingStore extends SqliteMemoryStore {
  override async insertMemoryCandidateCommitReceipt(
    _receipt: MemoryCandidateCommitReceipt
  ): Promise<void> {
    throw new Error("receipt write failed");
  }
}

test("receipt failure rolls back the implicit Memory mutation", async () => {
  const isolated = new MemorySpace({
    store: new ReceiptFailingStore(),
    extractor: new RuleBasedExtractor(),
    cache: new NoopCache(),
  });
  const space = await isolated.createSpace({ name: "receipt rollback" });
  const session = await isolated.createSession({ spaceId: space.id });
  await isolated.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "user", content: "ROLLBACK_TEST_1 = durable" },
  });
  const assistant = await isolated.appendEvent({
    sessionId: session.id,
    type: "message",
    payload: { role: "assistant", content: "done" },
  });
  await assert.rejects(
    new ImplicitRememberService(isolated).rememberTurn({
      sessionId: session.id,
      throughEventId: assistant.id,
      mode: "conservative",
    }),
    /receipt write failed/u
  );
  assert.equal((await isolated.search({ spaceId: space.id, query: "" })).length, 0);
  await isolated.close();
});
