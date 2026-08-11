import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport, type CallToolResult, type McpServer } from "@modelcontextprotocol/server";
import {
  createDefaultMemorySpace,
  createMemoryMcpServer,
  NoopExtractor,
  type MemoryMcpError,
  type MemorySpace
} from "../src/index.ts";

const toolNames = [
  "memory_bootstrap",
  "memory_checkpoint",
  "memory_context",
  "memory_promote",
  "memory_remember",
  "memory_search"
] as const;

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(join(bindingDirectory, "config.json"), JSON.stringify({ version: 1, spaceId }));
}

function structured<T>(result: CallToolResult): T {
  assert.ok(result.structuredContent);
  return result.structuredContent as T;
}

function errorOutput(result: CallToolResult): MemoryMcpError {
  assert.equal(result.isError, true);
  return structured<MemoryMcpError>(result);
}

async function connect(memorySpace: MemorySpace, cwd?: string, explicitSpaceId?: string): Promise<{
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}> {
  const server = createMemoryMcpServer({ memorySpace, cwd, explicitSpaceId });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "memory-space-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    }
  };
}

async function assertSchemaValidationFailure(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /validation|invalid arguments/iu);
  } catch (error) {
    assert.match(String(error), /validation|invalid arguments|invalid params/iu);
  }
}

test("MCP publishes exactly six strict domain tools with no privileged inputs", async () => {
  const memorySpace = createDefaultMemorySpace();
  const connection = await connect(memorySpace);
  try {
    const listed = await connection.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...toolNames]);
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      assert.equal(schema.additionalProperties, false, `${tool.name} must reject unknown fields`);
      const properties = schema.properties as Record<string, unknown>;
      assert.equal("spaceId" in properties, false);
    }
    const remember = listed.tools.find((tool) => tool.name === "memory_remember")!;
    const rememberProperties = remember.inputSchema.properties as Record<string, unknown>;
    for (const forbidden of [
      "spaceId", "tier", "status", "actor", "confidence", "importance",
      "sourceAgentId", "sourceEventIds", "version"
    ]) {
      assert.equal(forbidden in rememberProperties, false);
    }
    const promote = listed.tools.find((tool) => tool.name === "memory_promote")!;
    const promoteProperties = promote.inputSchema.properties as Record<string, unknown>;
    for (const forbidden of ["spaceId", "actor", "tier", "force"]) {
      assert.equal(forbidden in promoteProperties, false);
    }
    const checkpoint = listed.tools.find((tool) => tool.name === "memory_checkpoint")!;
    const checkpointProperties = checkpoint.inputSchema.properties as Record<string, unknown>;
    for (const forbidden of ["spaceId", "toEventId", "fromEventId", "idempotencyKey", "trigger"]) {
      assert.equal(forbidden in checkpointProperties, false);
    }
    await assertSchemaValidationFailure(connection.client, "memory_search", {
      query: "secret", spaceId: "spoofed", tier: "core", status: "active"
    });
    await assertSchemaValidationFailure(connection.client, "memory_search", {
      query: "secret", cwd: "/agent-controlled"
    });
  } finally {
    await connection.close();
    await memorySpace.close();
  }
});

test("memory_bootstrap uses Session Space over conflicting cwd and reports unbound safely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-mcp-bootstrap-"));
  const unboundDirectory = mkdtempSync(join(tmpdir(), "memory-space-mcp-unbound-"));
  const memorySpace = createDefaultMemorySpace();
  try {
    const spaceA = await memorySpace.createSpace({ id: "mcp-space-a", name: "Space A" });
    const spaceB = await memorySpace.createSpace({ id: "mcp-space-b", name: "Space B" });
    const sessionA = await memorySpace.createSession({ spaceId: spaceA.id, provider: "fake" });
    const sessionB = await memorySpace.createSession({ spaceId: spaceB.id, provider: "fake" });
    bind(directory, spaceB.id);
    const connection = await connect(memorySpace, directory, spaceA.id);
    try {
      const bySession = structured<{ space: { id: string }; session: { id: string } }>(
        await connection.client.callTool({
          name: "memory_bootstrap", arguments: { sessionId: sessionA.id }
        })
      );
      assert.equal(bySession.space.id, spaceA.id);
      assert.equal(bySession.session.id, sessionA.id);
      assert.equal("coreMemories" in bySession, false);
      const byExplicit = structured<{ space: { id: string }; session?: unknown }>(
        await connection.client.callTool({ name: "memory_bootstrap", arguments: {} })
      );
      assert.equal(byExplicit.space.id, spaceA.id);
      assert.equal(byExplicit.session, undefined);
      const explicitCannotRebindSession = structured<{ space: { id: string } }>(
        await connection.client.callTool({
          name: "memory_bootstrap", arguments: { sessionId: sessionB.id }
        })
      );
      assert.equal(explicitCannotRebindSession.space.id, spaceB.id);
    } finally {
      await connection.close();
    }

    const cwdOnly = await connect(memorySpace, directory);
    try {
      const byCwd = structured<{ space: { id: string }; session?: unknown }>(
        await cwdOnly.client.callTool({ name: "memory_bootstrap", arguments: {} })
      );
      assert.equal(byCwd.space.id, spaceB.id);
      assert.equal(byCwd.session, undefined);
    } finally {
      await cwdOnly.close();
    }

    const unbound = await connect(memorySpace, unboundDirectory);
    try {
      const result = await unbound.client.callTool({ name: "memory_bootstrap", arguments: {} });
      assert.deepEqual(errorOutput(result), {
        code: "SPACE_NOT_BOUND",
        message: "No Memory Space binding is available for this request",
        retryable: false
      });
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      assert.doesNotMatch(text, new RegExp(unboundDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    } finally {
      await unbound.close();
    }
  } finally {
    await memorySpace.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(unboundDirectory, { recursive: true, force: true });
  }
});

test("memory_context and memory_search recall Core plus Indexed without cross-Space leakage", async () => {
  const memorySpace = createDefaultMemorySpace();
  const spaceA = await memorySpace.createSpace({ name: "Recall A" });
  const spaceB = await memorySpace.createSpace({ name: "Recall B" });
  const sessionA = await memorySpace.createSession({ spaceId: spaceA.id });
  const sessionB = await memorySpace.createSession({ spaceId: spaceB.id });
  const core = await memorySpace.remember({
    spaceId: spaceA.id,
    sourceSessionId: sessionA.id,
    family: "state",
    type: "decision",
    content: "Architecture keeps SQLite as the default store"
  });
  await memorySpace.promote(core.id, { actor: "user", reason: "test setup" });
  const indexed = await memorySpace.remember({
    spaceId: spaceA.id,
    sourceSessionId: sessionA.id,
    family: "knowledge",
    type: "fact",
    content: "Architecture adapter lives in src/adapters/sqlite"
  });
  const other = await memorySpace.remember({
    spaceId: spaceB.id,
    sourceSessionId: sessionB.id,
    family: "knowledge",
    type: "fact",
    content: "Architecture secret belongs only to Space B"
  });
  const connection = await connect(memorySpace);
  try {
    const context = structured<{ context: string; memories: Array<{ id: string; tier: string }> }>(
      await connection.client.callTool({
        name: "memory_context",
        arguments: { sessionId: sessionA.id, query: "Architecture", maxItems: 10 }
      })
    );
    assert.deepEqual(new Set(context.memories.map((memory) => memory.id)), new Set([core.id, indexed.id]));
    assert.doesNotMatch(context.context, /Space B/u);

    const search = structured<{ results: Array<{ id: string; tier: string }> }>(
      await connection.client.callTool({
        name: "memory_search",
        arguments: { sessionId: sessionA.id, query: "adapter", families: ["knowledge"] }
      })
    );
    assert.deepEqual(search.results, [{
      id: indexed.id,
      family: "knowledge",
      type: "fact",
      content: "Architecture adapter lives in src/adapters/sqlite",
      tier: "indexed",
      score: 11,
      updatedAt: indexed.updatedAt
    }]);
    assert.equal(search.results.some((result) => result.id === other.id), false);
  } finally {
    await connection.close();
    await memorySpace.close();
  }
});

test("memory_remember derives Space and provenance from Session and rejects spoofing", async () => {
  const memorySpace = createDefaultMemorySpace();
  const spaceA = await memorySpace.createSpace({ name: "Remember A" });
  const spaceB = await memorySpace.createSpace({ name: "Remember B" });
  const sessionA = await memorySpace.createSession({ spaceId: spaceA.id, agentId: "agent-a" });
  const connection = await connect(memorySpace);
  try {
    const output = structured<{ memory: { id: string; tier: string } }>(
      await connection.client.callTool({
        name: "memory_remember",
        arguments: {
          sessionId: sessionA.id,
          family: "knowledge",
          type: "fact",
          content: "Durable Indexed detail"
        }
      })
    );
    assert.equal(output.memory.tier, "indexed");
    const persisted = await memorySpace.getMemory(output.memory.id);
    assert.equal(persisted.spaceId, spaceA.id);
    assert.equal(persisted.spaceId === spaceB.id, false);
    assert.equal(persisted.sourceSessionId, sessionA.id);
    assert.equal(persisted.sourceAgentId, "agent-a");

    const missing = await connection.client.callTool({
      name: "memory_remember",
      arguments: {
        sessionId: "missing-session",
        family: "knowledge",
        type: "fact",
        content: "must fail"
      }
    });
    assert.equal(errorOutput(missing).code, "SESSION_NOT_FOUND");
    await assertSchemaValidationFailure(connection.client, "memory_remember", {
      family: "knowledge", type: "fact", content: "no session"
    });
    await assertSchemaValidationFailure(connection.client, "memory_remember", {
      sessionId: sessionA.id,
      family: "state",
      type: "goal",
      content: "Core spoof",
      tier: "core",
      status: "active",
      actor: "user"
    });

    await memorySpace.remember({
      spaceId: spaceA.id,
      family: "knowledge",
      type: "fact",
      key: "mcp.stable-key",
      content: "Original schema"
    });
    const schemaConflict = await connection.client.callTool({
      name: "memory_remember",
      arguments: {
        sessionId: sessionA.id,
        family: "state",
        type: "decision",
        key: "mcp.stable-key",
        content: "Attempted schema mutation"
      }
    });
    assert.equal(errorOutput(schemaConflict).code, "VALIDATION_ERROR");
  } finally {
    await connection.close();
    await memorySpace.close();
  }
});

test("memory_promote fixes actor=agent and enforces policy, capacity, and Space ownership", async () => {
  const memorySpace = createDefaultMemorySpace({ coreLimit: 2 });
  const spaceA = await memorySpace.createSpace({ name: "Promote A" });
  const spaceB = await memorySpace.createSpace({ name: "Promote B" });
  const sessionA = await memorySpace.createSession({ spaceId: spaceA.id });
  const eligible = await memorySpace.remember({
    spaceId: spaceA.id, sourceSessionId: sessionA.id,
    family: "state", type: "goal", content: "Ship P1"
  });
  const ineligible = await memorySpace.remember({
    spaceId: spaceA.id, sourceSessionId: sessionA.id,
    family: "knowledge", type: "fact", content: "Unkeyed local fact"
  });
  const crossSpace = await memorySpace.remember({
    spaceId: spaceB.id, family: "state", type: "goal", content: "Other Space goal"
  });
  const connection = await connect(memorySpace);
  try {
    const promoted = structured<{ memory: { id: string; tier: string } }>(
      await connection.client.callTool({
        name: "memory_promote",
        arguments: { sessionId: sessionA.id, memoryId: eligible.id, reason: "Project-wide goal" }
      })
    );
    assert.equal(promoted.memory.tier, "core");
    const rejected = await connection.client.callTool({
      name: "memory_promote",
      arguments: { sessionId: sessionA.id, memoryId: ineligible.id, reason: "Try bypass" }
    });
    assert.equal(errorOutput(rejected).code, "PROMOTION_REJECTED");
    const conflict = await connection.client.callTool({
      name: "memory_promote",
      arguments: { sessionId: sessionA.id, memoryId: crossSpace.id, reason: "Try cross Space" }
    });
    assert.equal(errorOutput(conflict).code, "SPACE_BINDING_CONFLICT");
    const missing = await connection.client.callTool({
      name: "memory_promote",
      arguments: { sessionId: sessionA.id, memoryId: "missing-memory", reason: "Must fail" }
    });
    assert.equal(errorOutput(missing).code, "MEMORY_NOT_FOUND");
    await assertSchemaValidationFailure(connection.client, "memory_promote", {
      sessionId: sessionA.id,
      memoryId: ineligible.id,
      reason: "User spoof",
      actor: "user",
      force: true
    });

    const secondCore = await memorySpace.remember({
      spaceId: spaceA.id, family: "state", type: "decision", content: "Second Core"
    });
    await memorySpace.promote(secondCore.id, { actor: "user" });
    const overCapacity = await memorySpace.remember({
      spaceId: spaceA.id, family: "state", type: "goal", content: "Over capacity"
    });
    const capacity = await connection.client.callTool({
      name: "memory_promote",
      arguments: { sessionId: sessionA.id, memoryId: overCapacity.id, reason: "Still bounded" }
    });
    assert.equal(errorOutput(capacity).code, "CORE_CAPACITY_REACHED");
  } finally {
    await connection.close();
    await memorySpace.close();
  }
});

test("memory_checkpoint exposes completed/noop semantics and hides boundary controls", async () => {
  const memorySpace = createDefaultMemorySpace({ extractor: new NoopExtractor() });
  const space = await memorySpace.createSpace({ name: "Checkpoint" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const connection = await connect(memorySpace);
  try {
    const initial = structured<{ status: string; reason: string }>(
      await connection.client.callTool({
        name: "memory_checkpoint", arguments: { sessionId: session.id }
      })
    );
    assert.deepEqual(initial, { status: "noop", reason: "no_uncommitted_events" });
    const event = await memorySpace.appendEvent({
      sessionId: session.id, type: "message", payload: { role: "user", content: "Checkpoint P1" }
    });
    const completed = structured<{
      status: string;
      checkpointId: string;
      committedThroughEventId: string;
    }>(await connection.client.callTool({
      name: "memory_checkpoint", arguments: { sessionId: session.id }
    }));
    assert.equal(completed.status, "completed");
    assert.equal(completed.committedThroughEventId, event.id);
    const repeated = structured<{ status: string; reason: string }>(
      await connection.client.callTool({
        name: "memory_checkpoint", arguments: { sessionId: session.id }
      })
    );
    assert.deepEqual(repeated, { status: "noop", reason: "no_uncommitted_events" });
    await assertSchemaValidationFailure(connection.client, "memory_checkpoint", {
      sessionId: session.id,
      toEventId: event.id,
      idempotencyKey: "spoof",
      trigger: "session_end"
    });
  } finally {
    await connection.close();
    await memorySpace.close();
  }
});

test("MCP hides internal storage failures behind a fail-visible stable envelope", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "Unavailable" });
  const session = await memorySpace.createSession({ spaceId: space.id });
  const connection = await connect(memorySpace);
  await memorySpace.close();
  try {
    const result = await connection.client.callTool({
      name: "memory_bootstrap", arguments: { sessionId: session.id }
    });
    assert.deepEqual(errorOutput(result), {
      code: "MEMORY_SERVICE_UNAVAILABLE",
      message: "Memory service unavailable",
      retryable: true
    });
    const text = result.content.find((item) => item.type === "text")?.text ?? "";
    assert.doesNotMatch(text, /sqlite|database is closed|ERR_INVALID_STATE/iu);
  } finally {
    await connection.close();
  }
});

test("standalone development stdio entrypoint requires explicit opt-in", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-mcp-stdio-"));
  const databasePath = join(directory, "memory.db");
  const memorySpace = createDefaultMemorySpace({ databasePath });
  const space = await memorySpace.createSpace({ id: "stdio-space", name: "Stdio Space" });
  const session = await memorySpace.createSession({ spaceId: space.id, provider: "stdio-test" });
  await memorySpace.close();
  bind(directory, space.id);

  const entrypoint = fileURLToPath(new URL("../src/mcp/standalone-stdio.ts", import.meta.url));
  const rejected = spawnSync(process.execPath, ["--experimental-strip-types", entrypoint], {
    cwd: directory,
    env: { MEMORY_SPACE_DB: databasePath },
    encoding: "utf8"
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /development-only|ALLOW_STANDALONE/u);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", entrypoint],
    cwd: directory,
    env: {
      MEMORY_SPACE_DB: databasePath,
      MEMORY_SPACE_CORE_LIMIT: "64",
      MEMORY_SPACE_ALLOW_STANDALONE: "1"
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "memory-space-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...toolNames]);
    const bootstrap = structured<{ space: { id: string }; session: { id: string } }>(
      await client.callTool({
        name: "memory_bootstrap", arguments: { sessionId: session.id }
      })
    );
    assert.equal(bootstrap.space.id, space.id);
    assert.equal(bootstrap.session.id, session.id);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
