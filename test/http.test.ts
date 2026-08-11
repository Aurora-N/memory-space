import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { MemorySpace } from "../src/index.ts";
import { createDefaultMemorySpace } from "../src/index.ts";
import { createRequestHandler } from "../src/http/server.ts";

interface HttpResult {
  status: number;
  body: Record<string, any>;
}

function createClient(memorySpace: MemorySpace) {
  const handler = createRequestHandler(memorySpace);
  return async (
    method: string,
    url: string,
    body?: Record<string, unknown>,
    options: { contentType?: string | null } = {}
  ): Promise<HttpResult> => {
    const input = body ? [Buffer.from(JSON.stringify(body))] : [];
    const incoming = Readable.from(input) as IncomingMessage;
    incoming.method = method;
    incoming.url = url;
    const contentType = options.contentType === undefined
      ? body ? "application/json" : undefined
      : options.contentType ?? undefined;
    incoming.headers = contentType ? { "content-type": contentType } : {};
    let status = 0;
    let responseBody = "";
    const response = {
      writeHead(value: number) { status = value; },
      end(value?: string) { responseBody = value ?? ""; }
    } as unknown as ServerResponse;
    await handler(incoming, response);
    return { status, body: JSON.parse(responseBody) as Record<string, any> };
  };
}

test("HTTP adapter exposes the Space/Session/Memory path", async () => {
  const memorySpace = createDefaultMemorySpace();
  const request = createClient(memorySpace);
  try {
    assert.equal((await request("GET", "/health")).status, 200);
    const created = await request("POST", "/spaces", { name: "HTTP" });
    assert.equal(created.status, 201);
    const session = await request("POST", `/spaces/${created.body.id}/sessions`, { agentId: "http-agent" });
    const memory = await request("POST", `/spaces/${created.body.id}/memories`, {
      sourceSessionId: session.body.id, family: "knowledge", type: "fact", content: "HTTP works"
    });
    assert.equal(memory.status, 201);
    assert.equal(memory.body.tier, "indexed");
    const missing = await request("GET", "/spaces/missing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");
  } finally {
    await memorySpace.close();
  }
});

test("HTTP rejects missing or wrong JSON media types before mutation", async () => {
  const memorySpace = createDefaultMemorySpace();
  const request = createClient(memorySpace);
  try {
    const missing = await request(
      "POST", "/spaces", { id: "missing-content-type", name: "Missing" }, { contentType: null }
    );
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, "VALIDATION_ERROR");

    const wrong = await request(
      "POST", "/spaces", { id: "wrong-content-type", name: "Wrong" }, { contentType: "text/plain" }
    );
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error.code, "VALIDATION_ERROR");

    assert.equal((await request("POST", "/spaces", {
      id: "missing-content-type", name: "Created after rejection"
    })).status, 201);
    assert.equal((await request("POST", "/spaces", {
      id: "wrong-content-type", name: "Created after rejection"
    }, { contentType: "application/json; charset=utf-8" })).status, 201);
  } finally {
    await memorySpace.close();
  }
});

test("HTTP adapter completes the cross-Agent Handoff flow idempotently", async () => {
  const memorySpace = createDefaultMemorySpace();
  const request = createClient(memorySpace);
  try {
    const space = (await request("POST", "/spaces", { name: "HTTP Handoff" })).body;
    const sessionA = (await request("POST", `/spaces/${space.id}/sessions`, {
      agentId: "agent-a", provider: "codex"
    })).body;
    const detail = (await request("POST", `/spaces/${space.id}/memories`, {
      sourceSessionId: sessionA.id, family: "knowledge", type: "fact",
      content: "Recall endpoint 位于 src/modules/recall.ts"
    })).body;
    assert.equal(detail.tier, "indexed");
    const goal = (await request("POST", `/spaces/${space.id}/memories`, {
      sourceSessionId: sessionA.id, family: "state", type: "goal",
      key: "project.goal.primary", content: "完成跨 Agent 记忆管理系统"
    })).body;
    const promotion = await request("POST", `/memories/${goal.id}/promote`, {
      reason: "项目主要目标"
    });
    assert.equal(promotion.body.tier, "core");
    const event = (await request("POST", `/sessions/${sessionA.id}/events`, {
      type: "message", payload: { text: "数据库确定使用 PostgreSQL。\n先完成 recall API" }
    })).body;
    const checkpointBody = {
      toEventId: event.id, idempotencyKey: "http-handoff-checkpoint"
    };
    const checkpoint = await request("POST", `/sessions/${sessionA.id}/checkpoints`, checkpointBody);
    assert.equal(checkpoint.status, 201);
    assert.equal(checkpoint.body.status, "completed");

    const checkpointRetry = await request("POST", `/sessions/${sessionA.id}/checkpoints`, checkpointBody);
    assert.equal(checkpointRetry.body.id, checkpoint.body.id);
    const sessionB = (await request("POST", `/spaces/${space.id}/sessions`, {
      agentId: "agent-b", provider: "another-agent"
    })).body;
    const bootstrap = await request("GET", `/spaces/${sessionB.spaceId}/bootstrap`);
    assert.match(bootstrap.body.context, /完成跨 Agent 记忆管理系统/u);
    assert.match(bootstrap.body.context, /数据库使用 PostgreSQL/u);
    assert.match(bootstrap.body.context, /完成 recall API/u);
    assert.doesNotMatch(bootstrap.body.context, /src\/modules\/recall\.ts/u);
    assert.equal(bootstrap.body.handoffSnapshot.sessionId, sessionA.id);

    const search = await request(
      "GET", `/spaces/${space.id}/memories/search?query=${encodeURIComponent("recall endpoint module")}`
    );
    assert.equal(search.body[0].memory.id, detail.id);
    assert.equal(search.body[0].memory.tier, "indexed");
  } finally {
    await memorySpace.close();
  }
});

test("HTTP rejects direct Core remember and caller-provided promotion actor", async () => {
  const memorySpace = createDefaultMemorySpace();
  const request = createClient(memorySpace);
  try {
    const space = (await request("POST", "/spaces", { name: "HTTP trust boundary" })).body;
    const directCore = await request("POST", `/spaces/${space.id}/memories`, {
      family: "state", type: "goal", content: "Bypass", tier: "core"
    });
    assert.equal(directCore.status, 422);
    assert.equal(directCore.body.error.code, "VALIDATION_ERROR");

    const memory = (await request("POST", `/spaces/${space.id}/memories`, {
      family: "knowledge", type: "fact", content: "Session-local detail"
    })).body;
    const spoof = await request("POST", `/memories/${memory.id}/promote`, {
      actor: "user", reason: "I claim to be the user"
    });
    assert.equal(spoof.status, 422);
    assert.equal(spoof.body.error.code, "VALIDATION_ERROR");
    assert.equal((await memorySpace.getMemory(memory.id)).tier, "indexed");
  } finally {
    await memorySpace.close();
  }
});
