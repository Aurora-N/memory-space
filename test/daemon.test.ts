import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import {
  createDefaultMemorySpace,
  createMemorySpaceDaemon,
  isLoopbackHost,
  ValidationError
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

async function postWithHost(url: string, host: string, body: Record<string, unknown>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", host }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function runCodexHook(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "src/adapters/providers/codex/hook.ts"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, MEMORY_SPACE_CODEX_HOOK_URL: endpoint },
    stdio: ["pipe", "pipe", "ignore"]
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stdin.end(JSON.stringify(payload));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout };
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
    assert.equal(daemon.codexIntegration.lifecycleHandler, daemon.lifecycleHandler);
    assert.equal(daemon.claudeCodeIntegration.lifecycleHandler, daemon.lifecycleHandler);
    const address = await daemon.listen() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthFromHostileOrigin = await fetch(`${baseUrl}/health`, {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(healthFromHostileOrigin.status, 200);

    const identity = await fetch(`${baseUrl}/daemon/identity`);
    assert.equal(identity.status, 200);
    assert.deepEqual(await identity.json(), {
      cwd: directory
    });
    const rejectedIdentityOrigin = await fetch(`${baseUrl}/daemon/identity`, {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(rejectedIdentityOrigin.status, 403);

    const rejectedMcpOrigin = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: "{}"
    });
    assert.equal(rejectedMcpOrigin.status, 403);

    const missingContentType = await fetch(`${baseUrl}/spaces`, {
      method: "POST",
      body: JSON.stringify({ id: "media-space", name: "Rejected media type" })
    });
    assert.equal(missingContentType.status, 422);
    assert.equal((await missingContentType.json() as { error: { code: string } }).error.code,
      "VALIDATION_ERROR");
    await post(`${baseUrl}/spaces`, { id: "media-space", name: "Accepted JSON" });

    const rejectedSpaceOrigin = await fetch(`${baseUrl}/spaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: JSON.stringify({ id: "origin-space", name: "Must not be created" })
    });
    assert.equal(rejectedSpaceOrigin.status, 403);
    await post(`${baseUrl}/spaces`, { id: "origin-space", name: "Created locally" });

    const rejectedSpaceHost = await postWithHost(
      `${baseUrl}/spaces`, "attacker.example", { id: "host-space", name: "Must not be created" }
    );
    assert.equal(rejectedSpaceHost, 403);
    await post(`${baseUrl}/spaces`, { id: "host-space", name: "Created locally" });

    const space = await post(`${baseUrl}/spaces`, {
      id: "daemon-space", name: "Daemon Space"
    }) as { id: string };
    mkdirSync(join(directory, ".memory-space"));
    writeFileSync(join(directory, ".memory-space", "config.json"), JSON.stringify({
      version: 1,
      spaceId: space.id,
      implicitRecall: { mode: "exact" }
    }));
    const session = await post(`${baseUrl}/spaces/${space.id}/sessions`, {
      provider: "daemon-test", agentId: "shared-agent"
    }) as { id: string };

    const hostileMemoryContent = "hostile origin memory must not persist";
    const rejectedMemoryOrigin = await fetch(`${baseUrl}/spaces/${space.id}/memories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: JSON.stringify({
        sourceSessionId: session.id,
        family: "knowledge",
        type: "fact",
        content: hostileMemoryContent
      })
    });
    assert.equal(rejectedMemoryOrigin.status, 403);
    assert.deepEqual(await shared.search({
      spaceId: space.id, query: hostileMemoryContent
    }), []);

    const checkpointEvent = await post(`${baseUrl}/sessions/${session.id}/events`, {
      type: "message", payload: { role: "user", content: "checkpoint guard evidence" }
    }) as { id: string };
    const rejectedCheckpointOrigin = await fetch(`${baseUrl}/sessions/${session.id}/checkpoints`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: JSON.stringify({
        toEventId: checkpointEvent.id,
        idempotencyKey: "hostile-origin-checkpoint"
      })
    });
    assert.equal(rejectedCheckpointOrigin.status, 403);
    assert.equal((await shared.getSession(session.id)).lastCheckpointEventId, undefined);

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    client = new Client({ name: "daemon-test", version: "1.0.0" });
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /opaque Memory Space Session handle/u);
    assert.match(client.getInstructions() ?? "", /untrusted project data/u);

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

    const nativeStart = {
      session_id: "daemon-codex-session",
      transcript_path: join(directory, "transcript.jsonl"),
      cwd: directory,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "codex-model",
      permission_mode: "default"
    };
    const rejectedLifecycleMediaType = await fetch(`${baseUrl}/providers/codex/lifecycle`, {
      method: "POST",
      body: JSON.stringify({ ...nativeStart, session_id: "rejected-media-session" })
    });
    assert.equal(rejectedLifecycleMediaType.status, 422);
    assert.equal(await shared.findProviderSession("codex", "rejected-media-session"), undefined);

    const lifecycle = await post(`${baseUrl}/providers/codex/lifecycle`, nativeStart) as {
      status: string;
      type: string;
      sessionId: string;
      output: { hookSpecificOutput: { additionalContext: string } };
    };
    assert.equal(lifecycle.status, "ok");
    assert.equal(lifecycle.type, "session_start");
    assert.match(lifecycle.output.hookSpecificOutput.additionalContext,
      new RegExp(`Session: ${lifecycle.sessionId}`, "u"));
    const duplicateLifecycle = await post(`${baseUrl}/providers/codex/lifecycle`, {
      ...nativeStart, source: "resume"
    }) as { status: string; sessionId: string };
    assert.equal(duplicateLifecycle.status, "ok");
    assert.equal(duplicateLifecycle.sessionId, lifecycle.sessionId);
    const hookProcess = await runCodexHook(
      `${baseUrl}/providers/codex/lifecycle`,
      { ...nativeStart, source: "resume" }
    );
    assert.equal(hookProcess.code, 0);
    const hookOutput = JSON.parse(hookProcess.stdout) as {
      continue: boolean;
      hookSpecificOutput: { additionalContext: string };
    };
    assert.equal(hookOutput.continue, true);
    assert.match(hookOutput.hookSpecificOutput.additionalContext,
      new RegExp(`Session: ${lifecycle.sessionId}`, "u"));
    assert.equal((await shared.getSession(lifecycle.sessionId)).spaceId, space.id);
    const bootstrap = structured<{ space: { id: string } }>(await client.callTool({
      name: "memory_bootstrap", arguments: { sessionId: lifecycle.sessionId }
    }));
    assert.equal(bootstrap.space.id, space.id);

    const recallMemory = await shared.remember({
      spaceId: space.id,
      sourceSessionId: session.id,
      family: "knowledge",
      type: "fact",
      key: "CROSS_AGENT_TEST_20260817",
      content: "CROSS_AGENT_TEST_20260817 = lavender-731"
    });
    const codexPrompt = await post(`${baseUrl}/providers/codex/lifecycle`, {
      ...nativeStart,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-p7-codex",
      prompt: "CROSS_AGENT_TEST_20260817"
    }) as {
      status: string;
      type: string;
      output: { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    };
    assert.equal(codexPrompt.status, "ok");
    assert.equal(codexPrompt.type, "user_prompt");
    assert.equal(codexPrompt.output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(codexPrompt.output.hookSpecificOutput.additionalContext, /lavender-731/u);
    assert.doesNotMatch(
      codexPrompt.output.hookSpecificOutput.additionalContext,
      new RegExp(recallMemory.id, "u")
    );

    const rejectedOrigin = await fetch(`${baseUrl}/providers/codex/lifecycle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: JSON.stringify(nativeStart)
    });
    assert.equal(rejectedOrigin.status, 403);

    const nativeClaudeStart = {
      session_id: "daemon-claude-session",
      transcript_path: join(directory, "claude-transcript.jsonl"),
      cwd: directory,
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-sonnet-4-6",
      permission_mode: "default"
    };
    const rejectedClaudeMediaType = await fetch(
      `${baseUrl}/providers/claude-code/lifecycle`,
      {
        method: "POST",
        body: JSON.stringify({
          ...nativeClaudeStart,
          session_id: "rejected-claude-media-session"
        })
      }
    );
    assert.equal(rejectedClaudeMediaType.status, 422);
    assert.equal(
      await shared.findProviderSession(
        "claude-code",
        "rejected-claude-media-session"
      ),
      undefined
    );
    const claudeLifecycle = await post(
      `${baseUrl}/providers/claude-code/lifecycle`,
      nativeClaudeStart
    ) as {
      status: string;
      type: string;
      sessionId: string;
      output: { hookSpecificOutput: { additionalContext: string } };
    };
    assert.equal(claudeLifecycle.status, "ok");
    assert.equal(claudeLifecycle.type, "session_start");
    assert.match(
      claudeLifecycle.output.hookSpecificOutput.additionalContext,
      new RegExp(`Session: ${claudeLifecycle.sessionId}`, "u")
    );
    assert.equal(
      (await shared.getSession(claudeLifecycle.sessionId)).provider,
      "claude-code"
    );
    assert.notEqual(claudeLifecycle.sessionId, lifecycle.sessionId);
    const claudePrompt = await post(
      `${baseUrl}/providers/claude-code/lifecycle`,
      {
        ...nativeClaudeStart,
        hook_event_name: "UserPromptSubmit",
        prompt_id: "prompt-p7-claude",
        prompt: "CROSS_AGENT_TEST_20260817"
      }
    ) as {
      status: string;
      type: string;
      output: { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    };
    assert.equal(claudePrompt.status, "ok");
    assert.equal(claudePrompt.type, "user_prompt");
    assert.equal(claudePrompt.output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(claudePrompt.output.hookSpecificOutput.additionalContext, /lavender-731/u);
    assert.doesNotMatch(
      claudePrompt.output.hookSpecificOutput.additionalContext,
      new RegExp(recallMemory.id, "u")
    );
    const rejectedClaudeOrigin = await fetch(
      `${baseUrl}/providers/claude-code/lifecycle`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example"
        },
        body: JSON.stringify({
          ...nativeClaudeStart,
          session_id: "rejected-claude-session"
        })
      }
    );
    assert.equal(rejectedClaudeOrigin.status, 403);
    assert.equal(
      await shared.findProviderSession("claude-code", "rejected-claude-session"),
      undefined
    );
    assert.equal(factoryCalls, 1);
  } finally {
    await client?.close();
    await daemon.close();
    await daemon.close();
    assert.equal(closeCalls, 1);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon accepts only an explicit loopback host set before owner construction", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("::"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);

  let factoryCalls = 0;
  assert.throws(
    () => createMemorySpaceDaemon({
      host: "0.0.0.0",
      memorySpaceFactory() {
        factoryCalls += 1;
        throw new Error("owner construction must not run");
      }
    }),
    (error: unknown) => error instanceof ValidationError
      && /loopback/u.test(error.message)
  );
  assert.equal(factoryCalls, 0);
});

test("daemon logs sanitized recall diagnostics while keeping provider prompts fail-open", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-daemon-diagnostic-"));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]): void => { warnings.push(values); };
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "memory.db"),
    codexRuntime: {
      cwd: join(directory, "secret-project-path"),
      explicitSpaceId: "diagnostic-space"
    }
  });
  try {
    await daemon.memorySpace.createSpace({ id: "diagnostic-space", name: "Diagnostics" });
    const start = await daemon.codexIntegration.handleNative({
      session_id: "diagnostic-native-session",
      transcript_path: join(directory, "secret-transcript.jsonl"),
      cwd: join(directory, "secret-project-path"),
      hook_event_name: "SessionStart",
      source: "startup"
    });
    assert.equal(start.status, "ok");
    if (start.status !== "ok") throw new Error("Expected session start success");
    const prompt = await daemon.codexIntegration.handleNative({
      session_id: "diagnostic-native-session",
      transcript_path: join(directory, "secret-transcript.jsonl"),
      cwd: join(directory, "secret-project-path"),
      hook_event_name: "UserPromptSubmit",
      turn_id: "diagnostic-turn",
      prompt: "SECRET_PROMPT_CONTENT"
    });
    assert.deepEqual(prompt, {
      status: "ok",
      type: "user_prompt",
      sessionId: start.sessionId
    });
    assert.equal(warnings.length, 1);
    const logged = warnings.flat().join(" ");
    assert.match(logged, /IMPLICIT_RECALL_UNAVAILABLE/u);
    assert.match(logged, /Implicit Memory recall unavailable/u);
    assert.doesNotMatch(logged, /SECRET_PROMPT_CONTENT|secret-project-path|secret-transcript/u);
    assert.equal((await daemon.memorySpace.listEvents(start.sessionId)).length, 1);
  } finally {
    console.warn = originalWarn;
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
