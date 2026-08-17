import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CheckpointPolicy,
  CodexAdapter,
  CodexLifecycleIntegration,
  createDefaultMemorySpace,
  invokeCodexLifecycleHook,
  LifecycleHandler,
  ProviderSessionResolver,
  type CodexHookOutput
} from "../src/index.ts";

function nativePayload(
  hookEventName: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: "codex-session-1",
    transcript_path: "/opaque/codex/transcript.jsonl",
    cwd: "/workspace/project",
    hook_event_name: hookEventName,
    model: "codex-model",
    permission_mode: "default",
    ...overrides
  };
}

test("CodexAdapter normalizes the supported native hook surface", () => {
  const adapter = new CodexAdapter();
  assert.equal(adapter.name, "codex");
  assert.deepEqual([...adapter.capabilities].sort(), [
    "assistant_turn",
    "bootstrap_injection",
    "mcp",
    "pre_compact",
    "session_end",
    "session_identity",
    "session_start",
    "user_prompt"
  ]);

  assert.deepEqual(adapter.normalizeEvent(nativePayload("SessionStart", { source: "startup" })), {
    type: "session_start",
    provider: "codex",
    externalSessionId: "codex-session-1",
    cwd: "/workspace/project",
    transcriptRef: {
      provider: "codex",
      externalSessionId: "codex-session-1",
      locator: "/opaque/codex/transcript.jsonl"
    }
  });
  assert.deepEqual(adapter.normalizeEvent(nativePayload("UserPromptSubmit", {
    turn_id: "turn-1",
    prompt: "\n  Keep exact prompt whitespace\n"
  })), {
    type: "user_prompt",
    provider: "codex",
    externalSessionId: "codex-session-1",
    cwd: "/workspace/project",
    content: "\n  Keep exact prompt whitespace\n",
    transcriptRef: {
      provider: "codex",
      externalSessionId: "codex-session-1",
      locator: "/opaque/codex/transcript.jsonl"
    }
  });
  assert.equal(adapter.normalizeEvent(nativePayload("Stop", {
    turn_id: "turn-1", stop_hook_active: false, last_assistant_message: null
  })), null);
  assert.deepEqual(adapter.normalizeEvent(nativePayload("Stop", {
    turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "Final answer"
  })), {
    type: "assistant_turn",
    provider: "codex",
    externalSessionId: "codex-session-1",
    cwd: "/workspace/project",
    content: "Final answer",
    transcriptRef: {
      provider: "codex",
      externalSessionId: "codex-session-1",
      locator: "/opaque/codex/transcript.jsonl"
    }
  });
  assert.equal(adapter.normalizeEvent(nativePayload("PreCompact", {
    turn_id: "turn-1", trigger: "auto"
  }))?.type,
    "pre_compact");
  assert.equal(adapter.normalizeEvent(nativePayload("SessionEnd", { reason: "other" }))?.type,
    "session_end");
  assert.equal(adapter.normalizeEvent(nativePayload("PreToolUse", {
    tool_name: "Bash", tool_input: { command: "echo ignored" }
  })), null);
});

test("CodexAdapter treats provider privilege-shaped fields as inert evidence", () => {
  const normalized = new CodexAdapter().normalizeEvent(nativePayload("UserPromptSubmit", {
    turn_id: "turn-trust",
    prompt: "Remember the project decision",
    recommendedTier: "core",
    tier: "core",
    actor: "user",
    force: true,
    spaceId: "attacker-space"
  }));
  assert.deepEqual(normalized, {
    type: "user_prompt",
    provider: "codex",
    externalSessionId: "codex-session-1",
    cwd: "/workspace/project",
    content: "Remember the project decision",
    transcriptRef: {
      provider: "codex",
      externalSessionId: "codex-session-1",
      locator: "/opaque/codex/transcript.jsonl"
    }
  });
  assert.ok(normalized && !("spaceId" in normalized));
  assert.ok(normalized && !("tier" in normalized));
  assert.ok(normalized && !("actor" in normalized));
});

test("Codex bootstrap output carries the opaque Session handle and native additionalContext", () => {
  const rendered = new CodexAdapter().renderBootstrap({
    sessionId: "ses_opaque",
    provider: "codex",
    context: "# Space Context\nExisting project memory"
  });
  assert.match(rendered.content, /Session: ses_opaque/u);
  assert.match(rendered.content, /Existing project memory/u);
  assert.doesNotMatch(rendered.content, /spaceId/u);
  assert.deepEqual(rendered.metadata, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: rendered.content
    }
  });
});

test("Codex hook client forwards only native payload and preserves daemon output", async () => {
  const expected: CodexHookOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "Memory bootstrap"
    }
  };
  const requests: Array<{ url: string; body: unknown }> = [];
  const output = await invokeCodexLifecycleHook(nativePayload("SessionStart"), {
    endpoint: "http://127.0.0.1:4310/providers/codex/lifecycle",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown
      });
      return new Response(JSON.stringify({ status: "ok", output: expected }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.deepEqual(output, expected);
  assert.deepEqual(requests, [{
    url: "http://127.0.0.1:4310/providers/codex/lifecycle",
    body: nativePayload("SessionStart")
  }]);
});

test("Codex hook client accepts event-correct prompt context and rejects mismatches", async () => {
  const promptOutput: CodexHookOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "bounded Indexed context"
    }
  };
  const accepted = await invokeCodexLifecycleHook(nativePayload("UserPromptSubmit", {
    turn_id: "turn-p7",
    prompt: "CROSS_AGENT_TEST_20260817"
  }), {
    fetch: async () => new Response(JSON.stringify({ status: "ok", output: promptOutput }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  assert.deepEqual(accepted, promptOutput);

  const mismatch = await invokeCodexLifecycleHook(nativePayload("UserPromptSubmit", {
    turn_id: "turn-p7",
    prompt: "CROSS_AGENT_TEST_20260817"
  }), {
    fetch: async () => new Response(JSON.stringify({
      status: "ok",
      output: {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "wrong event"
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  assert.deepEqual(mismatch, {
    continue: true,
    systemMessage: "Memory Space warning [MEMORY_SERVICE_UNAVAILABLE]: Memory service unavailable"
  });
});

test("Codex hook client fails open without leaking transport details", async () => {
  const output = await invokeCodexLifecycleHook(nativePayload("PreCompact"), {
    fetch: async () => { throw new Error("connect ECONNREFUSED secret-internal-host"); }
  });
  assert.deepEqual(output, {
    continue: true,
    systemMessage: "Memory Space warning [MEMORY_SERVICE_UNAVAILABLE]: Memory service unavailable"
  });

  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/adapters/providers/codex/hook.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(nativePayload("SessionStart")),
      env: {
        ...process.env,
        MEMORY_SPACE_CODEX_HOOK_URL: "http://127.0.0.1:1/providers/codex/lifecycle",
        MEMORY_SPACE_HOOK_TIMEOUT_MS: "100"
      }
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const cliOutput = JSON.parse(child.stdout) as CodexHookOutput;
  assert.match(cliOutput.systemMessage ?? "", /MEMORY_SERVICE_UNAVAILABLE/u);
  assert.doesNotMatch(child.stdout, /ECONNREFUSED|secret-internal-host/u);
});

test("Codex lifecycle Memory failure is non-blocking and provider-safe", async () => {
  const memorySpace = createDefaultMemorySpace();
  try {
    const integration = new CodexLifecycleIntegration({
      lifecycleHandler: new LifecycleHandler({
        memorySpace,
        spaceResolver: {
          async resolve() {
            throw new Error("database offline at /secret/path/memory.db");
          }
        },
        sessionResolver: new ProviderSessionResolver(memorySpace),
        checkpointPolicy: new CheckpointPolicy(memorySpace)
      })
    });
    const result = await integration.handleNative(nativePayload("SessionStart", {
      source: "startup"
    }));
    assert.deepEqual(result, {
      status: "warning",
      warning: {
        status: "warning",
        nonBlocking: true,
        type: "session_start",
        sessionId: undefined,
        error: {
          code: "MEMORY_SERVICE_UNAVAILABLE",
          message: "Memory service unavailable"
        }
      },
      output: {
        continue: true,
        systemMessage: "Memory Space warning [MEMORY_SERVICE_UNAVAILABLE]: Memory service unavailable"
      }
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|database offline/u);
  } finally {
    await memorySpace.close();
  }
});
