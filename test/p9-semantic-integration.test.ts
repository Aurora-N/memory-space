import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemorySpaceDaemon } from "../src/index.ts";

function projectFixture(name: string): {
  directory: string;
  project: string;
  databasePath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), `memory-space-p9-${name}-`));
  const project = join(directory, "project");
  mkdirSync(join(project, ".memory-space"), { recursive: true });
  writeFileSync(
    join(project, ".memory-space", "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        spaceId: `space-${name}`,
        implicitRecall: { mode: "lexical" },
        implicitRemember: { mode: "conservative" },
        semanticExtraction: {
          mode: "grounded",
          model: {
            backend: "external",
            adapter: "openai-compatible",
            baseUrl: "https://semantic.example.test/v1",
            model: "fixture-model",
          },
          timeoutMs: 1_000,
        },
      },
      null,
      2
    )}\n`
  );
  return { directory, project, databasePath: join(directory, "memory.db") };
}

function semanticResponse(candidate?: {
  content: string;
  eventId: string;
  quote?: string;
}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              schemaVersion: 1,
              candidates: candidate
                ? [
                    {
                      family: "knowledge",
                      type: "fact",
                      content: candidate.content,
                      assertion: "direct",
                      durability: "durable",
                      evidence: [
                        { eventId: candidate.eventId, quote: candidate.quote ?? candidate.content },
                      ],
                    },
                  ]
                : [],
            }),
          },
        },
      ],
    }),
    { status: 200 }
  );
}

function semanticCandidatesResponse(
  candidates: Array<{ content: string; eventId: string; quote?: string }>
): Response {
  const payload = candidates.map((candidate) => ({
    family: "knowledge",
    type: "fact",
    content: candidate.content,
    assertion: "direct",
    durability: "durable",
    evidence: [{ eventId: candidate.eventId, quote: candidate.quote ?? candidate.content }],
  }));
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: JSON.stringify({ schemaVersion: 1, candidates: payload }) } },
      ],
    }),
    { status: 200 }
  );
}

async function startSession(
  daemon: ReturnType<typeof createMemorySpaceDaemon>,
  project: string,
  name: string
) {
  await daemon.memorySpace.createSpace({ id: `space-${name}`, name });
  const started = await daemon.lifecycleHandler.handle({
    type: "session_start",
    provider: "fake",
    externalSessionId: `native-${name}`,
    cwd: project,
  });
  if (started.type !== "session_start") throw new Error("Expected Session start");
  return started.session;
}

test("natural variant conversation becomes Indexed through the production P9/P8 path", async () => {
  const fixture = projectFixture("variant");
  let requests = 0;
  const source =
    "上传组件是通过 variant 来判断是否使用新版样式的，现在 variant 一共有 a、b、c 三种。";
  let userEventId = "";
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async (_url, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const modelInput = JSON.parse(body.messages[1]?.content ?? "{}") as {
        events: Array<{ id: string; role: string; content: string }>;
      };
      userEventId =
        modelInput.events.find((event) => event.role === "user" && event.content === source)?.id ??
        "";
      return semanticResponse({ content: source, eventId: userEventId });
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "variant");
    const user = await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-variant",
      cwd: fixture.project,
      content: source,
    });
    if (user.type !== "user_prompt") throw new Error("Expected user prompt");
    const turn = await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-variant",
      cwd: fixture.project,
      content: "收到。",
    });
    if (turn.type !== "assistant_turn") throw new Error("Expected assistant turn");

    assert.equal(requests, 1);
    assert.equal(userEventId, user.event.id);
    assert.equal(turn.implicitRemember?.committed.length, 1);
    const memories = await daemon.memorySpace.browseMemories({ spaceId: session.spaceId });
    assert.equal(memories.items.length, 1);
    assert.equal(memories.items[0]?.key, undefined);
    assert.equal(memories.items[0]?.content, source);
    assert.equal(memories.items[0]?.tier, "indexed");
    assert.equal(
      (await daemon.memorySpace.getSession(session.id)).lastCheckpointEventId,
      undefined
    );
    await assert.rejects(daemon.memorySpace.getLatestHandoff(session.spaceId), /not found/u);
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current-turn opt-out bypasses semantic extraction before any model request", async () => {
  const fixture = projectFixture("opt-out");
  let requests = 0;
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async () => {
      requests += 1;
      return semanticResponse();
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "opt-out");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-opt-out",
      cwd: fixture.project,
      content: "不要记住这次内容\n上传组件的 variant 有 a、b、c 三种。",
    });
    const turn = await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-opt-out",
      cwd: fixture.project,
      content: "收到。",
    });
    if (turn.type !== "assistant_turn") throw new Error("Expected assistant turn");
    assert.equal(turn.implicitRemember?.bypassed, true);
    assert.equal(requests, 0);
    assert.equal(
      (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items.length,
      0
    );
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("semantic backend failure cannot suppress deterministic implicit remember", async () => {
  const fixture = projectFixture("fallback");
  let requests = 0;
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async () => {
      requests += 1;
      return new Response("unavailable", { status: 503 });
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "fallback");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-fallback",
      cwd: fixture.project,
      content: "CROSS_AGENT_TEST_20260817 = lavender-731",
    });
    const turn = await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-fallback",
      cwd: fixture.project,
      content: "done",
    });
    if (turn.type !== "assistant_turn") throw new Error("Expected assistant turn");
    assert.equal(requests, 1);
    assert.equal(turn.implicitRemember?.committed.length, 1);
    const memories = await daemon.memorySpace.browseMemories({ spaceId: session.spaceId });
    assert.equal(memories.items.length, 1);
    assert.equal(memories.items[0]?.key, "CROSS_AGENT_TEST_20260817");
    assert.equal(memories.items[0]?.tier, "indexed");
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("configured semantic checkpoint failure leaves boundary and Handoff unchanged", async () => {
  const fixture = projectFixture("checkpoint-failure");
  let fail = true;
  let userEventId = "";
  const source = "数据库目前使用 PostgreSQL。";
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async (_url, init) => {
      if (fail) return new Response("unavailable", { status: 503 });
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const modelInput = JSON.parse(body.messages[1]?.content ?? "{}") as {
        events: Array<{ id: string; role: string; content: string }>;
      };
      userEventId =
        modelInput.events.find((event) => event.role === "user" && event.content === source)?.id ??
        "";
      return semanticResponse({ content: source, eventId: userEventId });
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "checkpoint-failure");
    const user = await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-checkpoint-failure",
      cwd: fixture.project,
      content: source,
    });
    if (user.type !== "user_prompt") throw new Error("Expected user prompt");

    await assert.rejects(
      daemon.memorySpace.checkpoint({
        sessionId: session.id,
        toEventId: user.event.id,
        idempotencyKey: "semantic-checkpoint",
      }),
      /Semantic extraction unavailable/u
    );
    assert.equal(
      (await daemon.memorySpace.getSession(session.id)).lastCheckpointEventId,
      undefined
    );
    await assert.rejects(daemon.memorySpace.getLatestHandoff(session.spaceId), /not found/u);

    fail = false;
    const retried = await daemon.memorySpace.checkpoint({
      sessionId: session.id,
      idempotencyKey: "semantic-checkpoint",
    });
    assert.equal(retried.status, "completed");
    assert.equal(
      (await daemon.memorySpace.getSession(session.id)).lastCheckpointEventId,
      user.event.id
    );
    assert.equal(userEventId, user.event.id);
    const memories = await daemon.memorySpace.browseMemories({ spaceId: session.spaceId });
    assert.equal(memories.items.length, 1);
    assert.equal(memories.items[0]?.content, source);
    assert.equal(memories.items[0]?.tier, "indexed");
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("alternate semantic substrings at later Stop reuse one durable identity", async () => {
  const fixture = projectFixture("alternate-stop");
  const source = "现在 variant 一共有 a、b、c 三种。";
  let calls = 0;
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
        events: Array<{ id: string; role: string }>;
      };
      const eventId = input.events.find((event) => event.role === "user")?.id ?? "missing";
      return semanticResponse({
        content: calls === 1 ? "variant 一共有 a、b、c 三种" : "现在 variant 一共有 a、b、c 三种",
        quote: source,
        eventId,
      });
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "alternate-stop");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-alternate-stop",
      cwd: fixture.project,
      content: source,
    });
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-alternate-stop",
      cwd: fixture.project,
      content: "收到。",
    });
    const first = (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items[0];
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-alternate-stop",
      cwd: fixture.project,
      content: "继续。",
    });
    const memories = (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, first?.id);
    assert.equal(memories[0]?.version, first?.version);
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("alternate semantic substring at checkpoint converges without version inflation", async () => {
  const fixture = projectFixture("alternate-checkpoint");
  const source = "现在 variant 一共有 a、b、c 三种。";
  let calls = 0;
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
        events: Array<{ id: string; role: string }>;
      };
      const eventId = input.events.find((event) => event.role === "user")?.id ?? "missing";
      return semanticResponse({
        content: calls === 1 ? "variant 一共有 a、b、c 三种" : "现在 variant 一共有 a、b、c 三种",
        quote: source,
        eventId,
      });
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "alternate-checkpoint");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-alternate-checkpoint",
      cwd: fixture.project,
      content: source,
    });
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-alternate-checkpoint",
      cwd: fixture.project,
      content: "收到。",
    });
    const before = (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items[0];
    const checkpoint = await daemon.memorySpace.checkpoint({
      sessionId: session.id,
      idempotencyKey: "alternate-checkpoint",
    });
    assert.equal(checkpoint.status, "completed");
    const memories = (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]?.id, before?.id);
    assert.equal(memories[0]?.version, before?.version);
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("two semantic facts in separate clauses of one event remain distinct", async () => {
  const fixture = projectFixture("two-facts");
  const source = "项目数据库使用 PostgreSQL，缓存使用 Redis。";
  const daemon = createMemorySpaceDaemon({
    databasePath: fixture.databasePath,
    mcpRuntime: { cwd: fixture.project },
    semanticFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
        events: Array<{ id: string; role: string }>;
      };
      const eventId = input.events.find((event) => event.role === "user")?.id ?? "missing";
      return semanticCandidatesResponse([
        { content: "项目数据库使用 PostgreSQL", quote: source, eventId },
        { content: "缓存使用 Redis", quote: source, eventId },
      ]);
    },
  });
  try {
    const session = await startSession(daemon, fixture.project, "two-facts");
    await daemon.lifecycleHandler.handle({
      type: "user_prompt",
      provider: "fake",
      externalSessionId: "native-two-facts",
      cwd: fixture.project,
      content: source,
    });
    await daemon.lifecycleHandler.handle({
      type: "assistant_turn",
      provider: "fake",
      externalSessionId: "native-two-facts",
      cwd: fixture.project,
      content: "收到。",
    });
    const memories = (await daemon.memorySpace.browseMemories({ spaceId: session.spaceId })).items;
    assert.equal(memories.length, 2);
    assert.deepEqual(
      memories.map((memory) => memory.content).sort(),
      ["缓存使用 Redis", "项目数据库使用 PostgreSQL"].sort()
    );
  } finally {
    await daemon.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
