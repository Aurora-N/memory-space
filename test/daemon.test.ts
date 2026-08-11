import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import {
  createDefaultMemorySpace,
  createMemorySpaceDaemon,
  type MemorySpace
} from "../src/index.ts";

function structured<T>(result: CallToolResult): T {
  assert.ok(result.structuredContent);
  return result.structuredContent as T;
}

async function post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.ok(response.ok, `${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

test("daemon composes HTTP, lifecycle, and MCP around one MemorySpace owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-daemon-"));
  const shared = createDefaultMemorySpace();
  const originalClose = shared.close.bind(shared);
  let factoryCalls = 0;
  let closeCalls = 0;
  shared.close = async (): Promise<void> => {
    closeCalls += 1;
    await originalClose();
  };
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpRuntime: { cwd: directory, explicitSpaceId: "daemon-space" },
    memorySpaceFactory() {
      factoryCalls += 1;
      return shared;
    }
  });
  let client: Client | undefined;
  try {
    assert.equal(factoryCalls, 1);
    assert.equal(daemon.mcpGateway.memorySpace, shared);
    assert.equal(daemon.lifecycleHandler.memorySpace, shared);
    const address = await daemon.listen() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const space = await post(`${baseUrl}/spaces`, {
      id: "daemon-space", name: "Daemon Space"
    }) as { id: string };
    const session = await post(`${baseUrl}/spaces/${space.id}/sessions`, {
      provider: "daemon-test", agentId: "shared-agent"
    }) as { id: string };
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client({ name: "daemon-test", version: "1.0.0" });
    await client.connect(transport);

    const trustedBootstrap = structured<{ space: { id: string } }>(await client.callTool({
      name: "memory_bootstrap", arguments: {}
    }));
    assert.equal(trustedBootstrap.space.id, space.id);

    const remembered = structured<{ memory: { id: string; tier: string } }>(
      await client.callTool({
        name: "memory_remember",
        arguments: {
          sessionId: session.id,
          family: "knowledge",
          type: "fact",
          content: "HTTP and MCP share one in-process owner"
        }
      })
    );
    assert.equal(remembered.memory.tier, "indexed");
    const readBack = await fetch(`${baseUrl}/memories/${remembered.memory.id}`);
    assert.equal(readBack.status, 200);
    assert.equal((await readBack.json() as { content: string }).content,
      "HTTP and MCP share one in-process owner");

    const lifecycle = await daemon.lifecycleHandler.handle({
      type: "session_start",
      provider: "fake",
      externalSessionId: "daemon-lifecycle"
    }, { explicitSpaceId: space.id });
    assert.equal(lifecycle.type, "session_start");
    assert.equal(lifecycle.session.spaceId, space.id);
    const bootstrap = structured<{ space: { id: string } }>(await client.callTool({
      name: "memory_bootstrap", arguments: { sessionId: lifecycle.session.id }
    }));
    assert.equal(bootstrap.space.id, space.id);
    assert.equal(factoryCalls, 1);
  } finally {
    await client?.close();
    await daemon.close();
    await daemon.close();
    assert.equal(closeCalls, 1);
    rmSync(directory, { recursive: true, force: true });
  }
});
