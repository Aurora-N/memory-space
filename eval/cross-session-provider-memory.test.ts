import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer
} from "@modelcontextprotocol/server";
import {
  CheckpointPolicy,
  ClaudeCodeLifecycleIntegration,
  CodexLifecycleIntegration,
  createDefaultMemorySpace,
  createMemoryMcpServer,
  LifecycleHandler,
  ProviderSessionResolver,
  SpaceResolver,
  type ClaudeCodeLifecycleResponse,
  type CodexLifecycleResponse,
  type MemorySpace,
  type Session
} from "../src/index.ts";

type Provider = "codex" | "claude-code";
type LifecycleResponse = CodexLifecycleResponse | ClaudeCodeLifecycleResponse;

const toolNames = [
  "memory_bootstrap",
  "memory_checkpoint",
  "memory_context",
  "memory_promote",
  "memory_remember",
  "memory_search"
] as const;

const scenarios = [
  ["codex", "codex"],
  ["claude-code", "claude-code"],
  ["codex", "claude-code"],
  ["claude-code", "codex"]
] as const satisfies readonly (readonly [Provider, Provider])[];

interface EvalRuntime {
  memorySpace: MemorySpace;
  lifecycleHandler: LifecycleHandler;
  codex: CodexLifecycleIntegration;
  claude: ClaudeCodeLifecycleIntegration;
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

interface StartedSession {
  session: Session;
  externalSessionId: string;
  bootstrap: string;
}

interface RememberOutput {
  memory: {
    id: string;
    family: string;
    type: string;
    key?: string;
    content: string;
    tier: "core" | "indexed";
    status: string;
    updatedAt: string;
  };
}

interface SearchOutput {
  results: Array<{
    id: string;
    content: string;
    tier: "core" | "indexed";
  }>;
}

interface ContextOutput {
  context: string;
  memories: Array<{ id: string; tier: "core" | "indexed" }>;
}

interface CheckpointOutput {
  status: "completed" | "noop";
  checkpointId?: string;
  committedThroughEventId?: string;
  reason?: "no_uncommitted_events";
}

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(
    join(bindingDirectory, "config.json"),
    JSON.stringify({ version: 1, spaceId })
  );
}

async function openRuntime(databasePath: string): Promise<EvalRuntime> {
  const memorySpace = createDefaultMemorySpace({ databasePath });
  const lifecycleHandler = new LifecycleHandler({
    memorySpace,
    spaceResolver: new SpaceResolver(),
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy: new CheckpointPolicy(memorySpace)
  });
  const codex = new CodexLifecycleIntegration({ lifecycleHandler });
  const claude = new ClaudeCodeLifecycleIntegration({ lifecycleHandler });
  const server = createMemoryMcpServer({ memorySpace });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "memory-space-p4-eval", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let closed = false;
  return {
    memorySpace,
    lifecycleHandler,
    codex,
    claude,
    client,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([client.close(), server.close()]);
      await memorySpace.close();
    }
  };
}

function nativePayload(
  provider: Provider,
  event: "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd",
  externalSessionId: string,
  cwd: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const shared = {
    session_id: externalSessionId,
    transcript_path: join(cwd, `.${provider}`, `${externalSessionId}.jsonl`),
    cwd,
    hook_event_name: event,
    permission_mode: "default",
    ...overrides
  };
  if (provider === "codex") {
    return { ...shared, model: "codex-eval-model" };
  }
  return { ...shared, model: "claude-eval-model" };
}

async function handleNative(
  runtime: EvalRuntime,
  provider: Provider,
  payload: Record<string, unknown>,
  explicitSpaceId?: string
): Promise<LifecycleResponse> {
  if (provider === "codex") {
    const integration = explicitSpaceId === undefined
      ? runtime.codex
      : new CodexLifecycleIntegration({
        lifecycleHandler: runtime.lifecycleHandler,
        runtime: { explicitSpaceId }
      });
    return integration.handleNative(payload);
  }
  const integration = explicitSpaceId === undefined
    ? runtime.claude
    : new ClaudeCodeLifecycleIntegration({
      lifecycleHandler: runtime.lifecycleHandler,
      runtime: { explicitSpaceId }
    });
  return integration.handleNative(payload);
}

async function startProviderSession(
  runtime: EvalRuntime,
  provider: Provider,
  externalSessionId: string,
  cwd: string,
  source: "startup" | "resume" | "clear" | "compact" = "startup",
  explicitSpaceId?: string
): Promise<StartedSession> {
  const response = await handleNative(
    runtime,
    provider,
    nativePayload(provider, "SessionStart", externalSessionId, cwd, { source }),
    explicitSpaceId
  );
  assert.equal(response.status, "ok");
  if (response.status !== "ok" || response.type !== "session_start") {
    throw new Error(`Expected ${provider} SessionStart success`);
  }
  const bootstrap = response.output?.hookSpecificOutput?.additionalContext;
  if (typeof bootstrap !== "string") {
    throw new Error(`${provider} SessionStart did not inject bootstrap context`);
  }
  return {
    session: await runtime.memorySpace.getSession(response.sessionId),
    externalSessionId,
    bootstrap
  };
}

async function emitConversation(
  runtime: EvalRuntime,
  provider: Provider,
  externalSessionId: string,
  cwd: string,
  progress: string,
  nextStep: string
): Promise<void> {
  const prompt = `progress: ${progress}`;
  const assistant = `先完成 ${nextStep}`;
  const turnId = `turn-${externalSessionId}`;
  const promptResponse = await handleNative(
    runtime,
    provider,
    nativePayload(provider, "UserPromptSubmit", externalSessionId, cwd, {
      turn_id: turnId,
      prompt_id: turnId,
      prompt,
      recommendedTier: "core",
      tier: "core",
      actor: "user",
      force: true,
      spaceId: "provider-controlled-space"
    })
  );
  assert.equal(promptResponse.status, "ok");
  if (promptResponse.status !== "ok") {
    throw new Error(`Expected ${provider} UserPromptSubmit success`);
  }
  assert.equal(promptResponse.type, "user_prompt");

  const stopResponse = await handleNative(
    runtime,
    provider,
    nativePayload(provider, "Stop", externalSessionId, cwd, {
      turn_id: turnId,
      prompt_id: turnId,
      stop_hook_active: false,
      last_assistant_message: assistant
    })
  );
  assert.equal(stopResponse.status, "ok");
  if (stopResponse.status !== "ok") {
    throw new Error(`Expected ${provider} Stop success`);
  }
  assert.equal(stopResponse.type, "assistant_turn");
}

async function mcp<T>(
  runtime: EvalRuntime,
  name: typeof toolNames[number],
  args: Record<string, unknown>
): Promise<T> {
  const result = await runtime.client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.ok(result.structuredContent, `${name} did not return structured content`);
  return result.structuredContent as T;
}

async function assertExactSix(runtime: EvalRuntime): Promise<void> {
  const listed = await runtime.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [...toolNames]
  );
}

function scenarioLabel(source: Provider, target: Provider): string {
  return `${source.replace("-code", "")}-to-${target.replace("-code", "")}`;
}

for (const [sourceProvider, targetProvider] of scenarios) {
  test(`P4 durable matrix: ${sourceProvider} -> ${targetProvider}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "memory-space-p4-matrix-"));
    const spaceXDirectory = join(directory, "space-x");
    const spaceYDirectory = join(directory, "space-y");
    const databasePath = join(directory, "memory.db");
    const label = scenarioLabel(sourceProvider, targetProvider);
    const spaceX = `p4-${label}-x`;
    const spaceY = `p4-${label}-y`;
    const sourceExternalId = `native-${label}`;
    const targetExternalId = sourceProvider === targetProvider
      ? `native-${label}-target`
      : sourceExternalId;
    const coreContent = `Production database is SQLite for ${label}.`;
    const indexedContent = `Migration helper for ${label} lives in scripts/db/migrate.ts.`;
    const progress = `${label} source integration is complete`;
    const nextStep = `${label} target validates durable memory`;
    mkdirSync(spaceXDirectory);
    mkdirSync(spaceYDirectory);
    bind(spaceXDirectory, spaceX);
    bind(spaceYDirectory, spaceY);

    let runtime: EvalRuntime | undefined;
    try {
      runtime = await openRuntime(databasePath);
      await runtime.memorySpace.createSpace({ id: spaceX, name: `${label} Space X` });
      await runtime.memorySpace.createSpace({ id: spaceY, name: `${label} Space Y` });
      await assertExactSix(runtime);

      const source = await startProviderSession(
        runtime,
        sourceProvider,
        sourceExternalId,
        spaceXDirectory
      );
      const core = await mcp<RememberOutput>(runtime, "memory_remember", {
        sessionId: source.session.id,
        family: "state",
        type: "decision",
        key: "project.database",
        content: coreContent
      });
      assert.equal(core.memory.tier, "indexed");
      const promoted = await mcp<RememberOutput>(runtime, "memory_promote", {
        sessionId: source.session.id,
        memoryId: core.memory.id,
        reason: "Stable project-wide database decision"
      });
      assert.equal(promoted.memory.tier, "core");
      const indexed = await mcp<RememberOutput>(runtime, "memory_remember", {
        sessionId: source.session.id,
        family: "knowledge",
        type: "fact",
        content: indexedContent
      });
      assert.equal(indexed.memory.tier, "indexed");

      await emitConversation(
        runtime,
        sourceProvider,
        sourceExternalId,
        spaceXDirectory,
        progress,
        nextStep
      );
      const checkpoint = await mcp<CheckpointOutput>(
        runtime,
        "memory_checkpoint",
        { sessionId: source.session.id }
      );
      assert.equal(checkpoint.status, "completed");
      const cleanCheckpoint = await mcp<CheckpointOutput>(
        runtime,
        "memory_checkpoint",
        { sessionId: source.session.id }
      );
      assert.deepEqual(cleanCheckpoint, {
        status: "noop",
        reason: "no_uncommitted_events"
      });

      const sourceSessionId = source.session.id;
      const coreMemoryId = core.memory.id;
      const indexedMemoryId = indexed.memory.id;
      await runtime.close();
      runtime = await openRuntime(databasePath);
      await assertExactSix(runtime);

      const durableSource = await runtime.memorySpace.findProviderSession(
        sourceProvider,
        sourceExternalId
      );
      assert.equal(durableSource?.id, sourceSessionId);
      const target = await startProviderSession(
        runtime,
        targetProvider,
        targetExternalId,
        spaceXDirectory
      );
      assert.notEqual(target.session.id, sourceSessionId);
      assert.equal(target.session.spaceId, spaceX);
      assert.equal(durableSource?.spaceId, target.session.spaceId);
      if (sourceProvider === targetProvider) {
        assert.notEqual(sourceExternalId, targetExternalId);
      } else {
        assert.equal(sourceExternalId, targetExternalId);
        assert.notEqual(durableSource?.provider, target.session.provider);
      }
      assert.match(target.bootstrap, new RegExp(coreContent, "u"));
      assert.match(target.bootstrap, new RegExp(progress, "u"));
      assert.match(target.bootstrap, new RegExp(nextStep, "u"));
      assert.doesNotMatch(target.bootstrap, new RegExp(indexedContent, "u"));

      const search = await mcp<SearchOutput>(runtime, "memory_search", {
        sessionId: target.session.id,
        query: `Migration helper ${label}`
      });
      assert.ok(search.results.some((result) => result.id === indexedMemoryId
        && result.content === indexedContent
        && result.tier === "indexed"));
      const context = await mcp<ContextOutput>(runtime, "memory_context", {
        sessionId: target.session.id,
        query: `SQLite Migration helper ${label}`,
        maxItems: 20
      });
      assert.match(context.context, new RegExp(coreContent, "u"));
      assert.match(context.context, new RegExp(indexedContent, "u"));
      assert.ok(context.memories.some((memory) => memory.id === coreMemoryId));
      assert.ok(context.memories.some((memory) => memory.id === indexedMemoryId));
      assert.equal(
        (await runtime.memorySpace.getMemory(indexedMemoryId)).sourceSessionId,
        sourceSessionId
      );
      assert.equal(
        (await runtime.memorySpace.getMemory(coreMemoryId)).sourceSessionId,
        sourceSessionId
      );

      const changedCwd = await startProviderSession(
        runtime,
        targetProvider,
        targetExternalId,
        spaceYDirectory,
        "resume"
      );
      assert.equal(changedCwd.session.id, target.session.id);
      assert.equal(changedCwd.session.spaceId, spaceX);
      assert.match(changedCwd.bootstrap, new RegExp(coreContent, "u"));
      const conflicting = await handleNative(
        runtime,
        targetProvider,
        nativePayload(
          targetProvider,
          "SessionStart",
          targetExternalId,
          spaceXDirectory,
          { source: "resume" }
        ),
        spaceY
      );
      assert.equal(conflicting.status, "warning");
      if (conflicting.status !== "warning") {
        throw new Error("Expected trusted explicit Space conflict");
      }
      assert.equal(conflicting.warning.error.code, "SPACE_BINDING_CONFLICT");

      const isolated = await startProviderSession(
        runtime,
        targetProvider,
        `native-${label}-isolated`,
        spaceYDirectory
      );
      assert.equal(isolated.session.spaceId, spaceY);
      assert.doesNotMatch(isolated.bootstrap, new RegExp(coreContent, "u"));
      assert.doesNotMatch(isolated.bootstrap, new RegExp(indexedContent, "u"));
      assert.doesNotMatch(isolated.bootstrap, new RegExp(nextStep, "u"));
      const isolatedBootstrap = await mcp<{ context: string }>(
        runtime,
        "memory_bootstrap",
        { sessionId: isolated.session.id }
      );
      assert.doesNotMatch(isolatedBootstrap.context, new RegExp(coreContent, "u"));
      assert.doesNotMatch(isolatedBootstrap.context, new RegExp(nextStep, "u"));
      const isolatedSearch = await mcp<SearchOutput>(runtime, "memory_search", {
        sessionId: isolated.session.id,
        query: label
      });
      assert.deepEqual(isolatedSearch.results, []);
      const isolatedContext = await mcp<ContextOutput>(runtime, "memory_context", {
        sessionId: isolated.session.id,
        query: label,
        maxItems: 20
      });
      assert.deepEqual(isolatedContext.memories, []);
      assert.doesNotMatch(isolatedContext.context, new RegExp(coreContent, "u"));
      assert.doesNotMatch(isolatedContext.context, new RegExp(indexedContent, "u"));
    } finally {
      await runtime?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("P4 multi-hop: Codex A -> Claude B -> Codex C -> Claude D", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-p4-multihop-"));
  const workspace = join(directory, "workspace");
  const databasePath = join(directory, "memory.db");
  const spaceId = "p4-multi-hop-space";
  const coreContent = "Production database is SQLite for the P4 multi-hop chain.";
  const sourceIndexedContent = "A-owned migration helper remains in scripts/db/migrate.ts.";
  const indexedContent = "Eval file lives at eval/cross-session-provider-memory.test.ts.";
  mkdirSync(workspace);
  bind(workspace, spaceId);
  let runtime: EvalRuntime | undefined;

  try {
    runtime = await openRuntime(databasePath);
    await runtime.memorySpace.createSpace({ id: spaceId, name: "P4 Multi-hop" });
    await assertExactSix(runtime);

    const codexA = await startProviderSession(
      runtime,
      "codex",
      "p4-multi-codex-a",
      workspace
    );
    const core = await mcp<RememberOutput>(runtime, "memory_remember", {
      sessionId: codexA.session.id,
      family: "state",
      type: "decision",
      key: "project.database",
      content: coreContent
    });
    await mcp<RememberOutput>(runtime, "memory_promote", {
      sessionId: codexA.session.id,
      memoryId: core.memory.id,
      reason: "Stable database decision across providers"
    });
    const sourceIndexed = await mcp<RememberOutput>(runtime, "memory_remember", {
      sessionId: codexA.session.id,
      family: "knowledge",
      type: "fact",
      content: sourceIndexedContent
    });
    await emitConversation(
      runtime,
      "codex",
      codexA.externalSessionId,
      workspace,
      "provider integration foundation ready",
      "provider abstraction"
    );
    assert.equal((await mcp<CheckpointOutput>(runtime, "memory_checkpoint", {
      sessionId: codexA.session.id
    })).status, "completed");

    const claudeB = await startProviderSession(
      runtime,
      "claude-code",
      "p4-multi-claude-b",
      workspace
    );
    assert.match(claudeB.bootstrap, /完成 provider abstraction/u);
    assert.match(claudeB.bootstrap, new RegExp(coreContent, "u"));
    await emitConversation(
      runtime,
      "claude-code",
      claudeB.externalSessionId,
      workspace,
      "provider abstraction complete",
      "cross-provider eval"
    );
    assert.equal((await mcp<CheckpointOutput>(runtime, "memory_checkpoint", {
      sessionId: claudeB.session.id
    })).status, "completed");

    const codexC = await startProviderSession(
      runtime,
      "codex",
      "p4-multi-codex-c",
      workspace
    );
    assert.match(codexC.bootstrap, /完成 cross-provider eval/u);
    assert.doesNotMatch(codexC.bootstrap, /完成 provider abstraction/u);
    const indexed = await mcp<RememberOutput>(runtime, "memory_remember", {
      sessionId: codexC.session.id,
      family: "knowledge",
      type: "fact",
      content: indexedContent
    });
    await emitConversation(
      runtime,
      "codex",
      codexC.externalSessionId,
      workspace,
      "cross-provider eval implemented",
      "progressive recall verification"
    );
    assert.equal((await mcp<CheckpointOutput>(runtime, "memory_checkpoint", {
      sessionId: codexC.session.id
    })).status, "completed");

    const claudeD = await startProviderSession(
      runtime,
      "claude-code",
      "p4-multi-claude-d",
      workspace
    );
    assert.match(claudeD.bootstrap, /完成 progressive recall verification/u);
    assert.doesNotMatch(claudeD.bootstrap, /完成 cross-provider eval/u);
    assert.match(claudeD.bootstrap, new RegExp(coreContent, "u"));
    assert.doesNotMatch(claudeD.bootstrap, new RegExp(sourceIndexedContent, "u"));
    assert.doesNotMatch(claudeD.bootstrap, new RegExp(indexedContent, "u"));
    const inheritedRecall = await mcp<SearchOutput>(runtime, "memory_search", {
      sessionId: claudeD.session.id,
      query: "A-owned migration helper"
    });
    assert.ok(inheritedRecall.results.some(
      (result) => result.id === sourceIndexed.memory.id
    ));
    const recalled = await mcp<SearchOutput>(runtime, "memory_search", {
      sessionId: claudeD.session.id,
      query: "cross-session-provider-memory eval file"
    });
    assert.ok(recalled.results.some((result) => result.id === indexed.memory.id));
    const context = await mcp<ContextOutput>(runtime, "memory_context", {
      sessionId: claudeD.session.id,
      query: "SQLite cross-session-provider-memory eval file",
      maxItems: 20
    });
    assert.match(context.context, new RegExp(coreContent, "u"));
    assert.match(context.context, new RegExp(indexedContent, "u"));

    const sessions = [codexA, claudeB, codexC, claudeD];
    assert.equal(new Set(sessions.map(({ session }) => session.id)).size, 4);
    assert.ok(sessions.every(({ session }) => session.spaceId === spaceId));
    const latestHandoff = await runtime.memorySpace.getLatestHandoff(spaceId);
    assert.equal(latestHandoff.sessionId, codexC.session.id);
    assert.ok(latestHandoff.nextSteps.includes("完成 progressive recall verification"));
    assert.ok(!latestHandoff.nextSteps.includes("完成 cross-provider eval"));
    assert.equal(
      (await runtime.memorySpace.getMemory(core.memory.id)).sourceSessionId,
      codexA.session.id
    );
    assert.equal(
      (await runtime.memorySpace.getMemory(indexed.memory.id)).sourceSessionId,
      codexC.session.id
    );
    assert.equal(
      (await runtime.memorySpace.getMemory(sourceIndexed.memory.id)).sourceSessionId,
      codexA.session.id
    );
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
