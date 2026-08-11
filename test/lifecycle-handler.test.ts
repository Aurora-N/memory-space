import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckpointPolicy,
  createDefaultMemorySpace,
  LifecycleHandler,
  NoopExtractor,
  ProviderSessionResolver,
  SpaceBindingConflictError,
  SpaceResolver,
  ValidationError
} from "../src/index.ts";

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(join(bindingDirectory, "config.json"), JSON.stringify({ version: 1, spaceId }));
}

test("LifecycleHandler binds once, captures ordered conversation-lite events, and checkpoints through policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-lifecycle-"));
  try {
    const nested = join(directory, "nested");
    mkdirSync(nested);
    bind(directory, "space-root");
    bind(nested, "space-nested");
    const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
    await memorySpace.createSpace({ id: "space-root", name: "Root" });
    await memorySpace.createSpace({ id: "space-nested", name: "Nested" });
    const sessionResolver = new ProviderSessionResolver(memorySpace);
    const handler = new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver,
      checkpointPolicy: new CheckpointPolicy(memorySpace)
    });

    const started = await handler.handle({
      type: "session_start", provider: "fake", externalSessionId: "native-1", cwd: directory
    });
    assert.equal(started.type, "session_start");
    if (started.type !== "session_start") throw new Error("Expected session_start result");
    assert.equal(started.session.spaceId, "space-root");
    assert.equal(started.bootstrap.space.id, "space-root");
    const duplicate = await handler.handle({
      type: "session_start", provider: "fake", externalSessionId: "native-1", cwd: directory
    });
    assert.equal(duplicate.session.id, started.session.id);
    const resumedAfterCwdChange = await handler.handle({
      type: "session_start", provider: "fake", externalSessionId: "native-1", cwd: nested
    });
    assert.equal(resumedAfterCwdChange.type, "session_start");
    if (resumedAfterCwdChange.type !== "session_start") {
      throw new Error("Expected session_start result after cwd change");
    }
    assert.equal(resumedAfterCwdChange.session.id, started.session.id);
    assert.equal(resumedAfterCwdChange.session.spaceId, "space-root");
    assert.equal(resumedAfterCwdChange.bootstrap.space.id, "space-root");
    const resumedWithMatchingExplicitSpace = await handler.handle({
      type: "session_start", provider: "fake", externalSessionId: "native-1", cwd: nested
    }, { explicitSpaceId: "space-root" });
    assert.equal(resumedWithMatchingExplicitSpace.session.id, started.session.id);
    await assert.rejects(
      handler.handle({
        type: "session_start", provider: "fake", externalSessionId: "native-1", cwd: nested
      }, { explicitSpaceId: "space-nested" }),
      (error: unknown) => error instanceof SpaceBindingConflictError
        && error.code === "SPACE_BINDING_CONFLICT"
    );

    await handler.handle({
      type: "user_prompt", provider: "fake", externalSessionId: "native-1",
      cwd: nested, content: "\n  Implement P0\n",
      transcriptRef: { provider: "fake", locator: "opaque://native-1" }
    });
    await handler.handle({
      type: "assistant_turn", provider: "fake", externalSessionId: "native-1",
      cwd: nested, content: "```ts\n  const done = true;\n```\n"
    });
    const events = await memorySpace.listEvents(started.session.id);
    assert.deepEqual(events.map((event) => event.payload), [
      {
        role: "user", content: "\n  Implement P0\n", contentMode: "full",
        transcriptRef: { provider: "fake", locator: "opaque://native-1" }
      },
      { role: "assistant", content: "```ts\n  const done = true;\n```\n", contentMode: "full" }
    ]);
    assert.equal((await memorySpace.getSession(started.session.id)).spaceId, "space-root");

    const compacted = await handler.handle({
      type: "pre_compact", provider: "fake", externalSessionId: "native-1", cwd: nested
    });
    assert.equal(compacted.type, "pre_compact");
    if (compacted.type !== "pre_compact") throw new Error("Expected pre_compact result");
    assert.equal(compacted.checkpoint.status, "completed");
    const ended = await handler.handle({
      type: "session_end", provider: "fake", externalSessionId: "native-1", cwd: nested
    });
    assert.equal(ended.type, "session_end");
    if (ended.type !== "session_end") throw new Error("Expected session_end result");
    assert.equal(ended.checkpoint.status, "noop");
    await memorySpace.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("LifecycleHandler supports opaque internal Session handles when provider identity is absent", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "anonymous provider session" });
  const sessionResolver = new ProviderSessionResolver(memorySpace);
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: { async resolve() { return { spaceId: space.id, source: "explicit" }; } },
    sessionResolver,
    checkpointPolicy: new CheckpointPolicy(memorySpace)
  });
  const started = await handler.handle({ type: "session_start", provider: "anonymous" });
  if (started.type !== "session_start") throw new Error("Expected session_start result");
  const turn = await handler.handle(
    { type: "user_prompt", provider: "anonymous", content: "Continue" },
    { sessionId: started.session.id }
  );
  assert.equal(turn.session.id, started.session.id);
  await memorySpace.close();
});

test("internal Session handles enforce the frozen provider identity tuple", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "strict provider identity" });
  const resolver = new ProviderSessionResolver(memorySpace);
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: { async resolve() { return { spaceId: space.id, source: "explicit" }; } },
    sessionResolver: resolver,
    checkpointPolicy: new CheckpointPolicy(memorySpace)
  });
  const anonymous = await resolver.resolve({ provider: "fake", spaceId: space.id });
  await assert.rejects(
    handler.handle(
      { type: "user_prompt", provider: "fake", externalSessionId: "native-new", content: "x" },
      { sessionId: anonymous.id }
    ),
    /does not match Session.externalSessionId/u
  );
  const generic = await memorySpace.createSession({ spaceId: space.id });
  await assert.rejects(
    handler.handle({ type: "user_prompt", provider: "fake", content: "x" }, { sessionId: generic.id }),
    /does not match Session.provider/u
  );
  const identified = await resolver.resolve({
    provider: "fake", externalSessionId: "native-1", spaceId: space.id
  });
  const matching = await handler.handle(
    { type: "user_prompt", provider: "fake", externalSessionId: "native-1", content: "matching" },
    { sessionId: identified.id }
  );
  assert.equal(matching.session.id, identified.id);
  const omitted = await handler.handle(
    { type: "assistant_turn", provider: "fake", content: "omitted external ID" },
    { sessionId: identified.id }
  );
  assert.equal(omitted.session.id, identified.id);
  await assert.rejects(
    handler.handle({
      type: "user_prompt", provider: "fake", content: "wrong transcript",
      transcriptRef: { provider: "fake", externalSessionId: "native-2", locator: "opaque://native-2" }
    }, { sessionId: identified.id }),
    /transcriptRef.externalSessionId.*Session.externalSessionId/u
  );
  const matchingTranscript = await handler.handle({
    type: "user_prompt", provider: "fake", content: "matching transcript",
    transcriptRef: { provider: "fake", externalSessionId: "native-1", locator: "opaque://native-1" }
  }, { sessionId: identified.id });
  assert.equal(matchingTranscript.session.id, identified.id);
  const transcriptWithoutExternalId = await handler.handle({
    type: "assistant_turn", provider: "fake", content: "provider-only transcript",
    transcriptRef: { provider: "fake", locator: "opaque://provider-only" }
  }, { sessionId: identified.id });
  assert.equal(transcriptWithoutExternalId.session.id, identified.id);
  await assert.rejects(
    handler.handle({ type: "user_prompt", provider: "other", content: "x" }, { sessionId: identified.id }),
    /does not match Session.provider/u
  );
  await assert.rejects(
    handler.handle(
      { type: "user_prompt", provider: "fake", externalSessionId: "native-2", content: "x" },
      { sessionId: identified.id }
    ),
    /does not match Session.externalSessionId/u
  );
  await memorySpace.close();
});

test("LifecycleHandler validates normalized events before Memory operations", async () => {
  let sessionLookups = 0;
  const memorySpace = createDefaultMemorySpace();
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: {
      async resolve() { throw new Error("not expected"); },
      async findOptional() { sessionLookups += 1; throw new Error("not expected"); },
      async find() { sessionLookups += 1; throw new Error("not expected"); }
    },
    checkpointPolicy: new CheckpointPolicy(memorySpace)
  });
  await assert.rejects(
    handler.handle({ type: "user_prompt", provider: "fake", content: "" }),
    (error: unknown) => error instanceof ValidationError
  );
  assert.equal(sessionLookups, 0);
  await memorySpace.close();
});

test("lifecycle fail-open wrapper returns a non-blocking warning", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "fail open" });
  const diagnostics: unknown[] = [];
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: { async resolve() { throw new Error("memory service offline"); } },
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    onWarning(diagnostic) { diagnostics.push(diagnostic); }
  });
  const result = await handler.handleFailOpen({
    type: "session_start", provider: "fake", externalSessionId: "native-fail", cwd: process.cwd()
  }, { explicitSpaceId: space.id });
  assert.deepEqual(result, {
    status: "warning", nonBlocking: true, type: "session_start", sessionId: undefined,
    error: { code: "MEMORY_SERVICE_UNAVAILABLE", message: "Memory service unavailable" }
  });
  assert.equal(diagnostics.length, 1);
  await memorySpace.close();
});

test("throwing diagnostic sink cannot make lifecycle fail closed", async () => {
  const memorySpace = createDefaultMemorySpace();
  const handler = new LifecycleHandler({
    memorySpace,
    spaceResolver: { async resolve() { throw new Error("memory service offline"); } },
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace),
    onWarning() { throw new Error("diagnostic sink unavailable"); }
  });
  const result = await handler.handleFailOpen({
    type: "session_start", provider: "fake", externalSessionId: "native-fail", cwd: process.cwd()
  });
  assert.deepEqual(result, {
    status: "warning", nonBlocking: true, type: "session_start", sessionId: undefined,
    error: { code: "MEMORY_SERVICE_UNAVAILABLE", message: "Memory service unavailable" }
  });
  await memorySpace.close();
});
