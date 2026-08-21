import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  CheckpointPolicy,
  ClaudeAdapter,
  ClaudeCodeLifecycleIntegration,
  CodexAdapter,
  createDefaultMemorySpace,
  invokeClaudeCodeLifecycleHook,
  LifecycleHandler,
  ProviderSessionResolver,
  type ClaudeCodeHookOutput,
  ValidationError
} from "../src/index.ts";

function nativePayload(
  hookEventName: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: "claude-native-session-1",
    transcript_path: "/opaque/claude-code/transcript.jsonl",
    cwd: "/workspace/project",
    hook_event_name: hookEventName,
    permission_mode: "default",
    ...overrides
  };
}

test("ClaudeAdapter normalizes the supported official lifecycle surface", () => {
  const adapter = new ClaudeAdapter();
  assert.equal(adapter.name, "claude-code");
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

  assert.deepEqual(adapter.normalizeEvent(nativePayload("SessionStart", {
    source: "startup",
    model: "claude-sonnet-4-6"
  })), {
    type: "session_start",
    provider: "claude-code",
    externalSessionId: "claude-native-session-1",
    cwd: "/workspace/project",
    transcriptRef: {
      provider: "claude-code",
      externalSessionId: "claude-native-session-1",
      locator: "/opaque/claude-code/transcript.jsonl"
    }
  });
  assert.deepEqual(adapter.normalizeEvent(nativePayload("UserPromptSubmit", {
    prompt_id: "prompt-1",
    prompt: "\n  Keep exact Claude prompt whitespace\n"
  })), {
    type: "user_prompt",
    provider: "claude-code",
    externalSessionId: "claude-native-session-1",
    cwd: "/workspace/project",
    content: "\n  Keep exact Claude prompt whitespace\n",
    transcriptRef: {
      provider: "claude-code",
      externalSessionId: "claude-native-session-1",
      locator: "/opaque/claude-code/transcript.jsonl"
    }
  });
  assert.equal(adapter.normalizeEvent(nativePayload("Stop", {
    stop_hook_active: false,
    last_assistant_message: null
  })), null);
  assert.equal(adapter.normalizeEvent(nativePayload("Stop", {
    stop_hook_active: false,
    last_assistant_message: "  \n"
  })), null);
  assert.deepEqual(adapter.normalizeEvent(nativePayload("Stop", {
    prompt_id: "prompt-1",
    stop_hook_active: false,
    last_assistant_message: "Final answer\n"
  })), {
    type: "assistant_turn",
    provider: "claude-code",
    externalSessionId: "claude-native-session-1",
    cwd: "/workspace/project",
    content: "Final answer\n",
    transcriptRef: {
      provider: "claude-code",
      externalSessionId: "claude-native-session-1",
      locator: "/opaque/claude-code/transcript.jsonl"
    }
  });
  assert.equal(adapter.normalizeEvent(nativePayload("PreCompact", {
    trigger: "auto",
    custom_instructions: ""
  }))?.type, "pre_compact");
  assert.equal(adapter.normalizeEvent(nativePayload("PreCompact", {
    trigger: "auto",
    custom_instructions: null
  }))?.type, "pre_compact");
  for (const reason of [
    "clear",
    "resume",
    "logout",
    "prompt_input_exit",
    "bypass_permissions_disabled",
    "other"
  ]) {
    assert.equal(adapter.normalizeEvent(nativePayload("SessionEnd", {
      reason
    }))?.type, "session_end");
  }
  assert.equal(adapter.normalizeEvent(nativePayload("TaskCompleted", {
    task_id: "task-1"
  })), null);
  assert.equal(adapter.normalizeEvent(nativePayload("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "echo ignored" }
  })), null);
});

test("ClaudeAdapter enforces native shape while treating privilege fields as inert", () => {
  const adapter = new ClaudeAdapter();
  const normalized = adapter.normalizeEvent(nativePayload("UserPromptSubmit", {
    prompt: "Remember the project decision",
    recommendedTier: "core",
    tier: "core",
    actor: "user",
    force: true,
    spaceId: "attacker-space",
    idempotencyKey: "attacker-key"
  }));
  assert.deepEqual(normalized, {
    type: "user_prompt",
    provider: "claude-code",
    externalSessionId: "claude-native-session-1",
    cwd: "/workspace/project",
    content: "Remember the project decision",
    transcriptRef: {
      provider: "claude-code",
      externalSessionId: "claude-native-session-1",
      locator: "/opaque/claude-code/transcript.jsonl"
    }
  });
  assert.ok(normalized && !("spaceId" in normalized));
  assert.ok(normalized && !("tier" in normalized));
  assert.ok(normalized && !("actor" in normalized));
  assert.ok(normalized && !("idempotencyKey" in normalized));

  assert.throws(
    () => adapter.normalizeEvent(nativePayload("SessionStart", { source: "unknown" })),
    (error: unknown) => error instanceof ValidationError
  );
  assert.throws(
    () => adapter.normalizeEvent(nativePayload("SessionStart", { source: "fork" })),
    (error: unknown) => error instanceof ValidationError
  );
  assert.throws(
    () => adapter.normalizeEvent(nativePayload("PreCompact", {
      trigger: "auto",
      custom_instructions: 1
    })),
    /custom_instructions/u
  );
  assert.throws(
    () => adapter.normalizeEvent(nativePayload("Stop", {
      stop_hook_active: "false",
      last_assistant_message: "x"
    })),
    /stop_hook_active/u
  );
  assert.throws(
    () => adapter.normalizeEvent(nativePayload("SessionStart", {
      source: "startup",
      transcript_path: undefined
    })),
    /transcript_path/u
  );
});

test("Codex and Claude adapters expose provider-contract capability parity", () => {
  const codex = new CodexAdapter();
  const claude = new ClaudeAdapter();
  assert.deepEqual([...claude.capabilities].sort(), [...codex.capabilities].sort());

  const claudeTypes = [
    claude.normalizeEvent(nativePayload("SessionStart", { source: "resume" })),
    claude.normalizeEvent(nativePayload("UserPromptSubmit", { prompt: "continue" })),
    claude.normalizeEvent(nativePayload("Stop", {
      stop_hook_active: false,
      last_assistant_message: "done"
    })),
    claude.normalizeEvent(nativePayload("PreCompact", {
      trigger: "manual",
      custom_instructions: "retain decisions"
    })),
    claude.normalizeEvent(nativePayload("SessionEnd", { reason: "other" }))
  ].map((event) => event?.type);
  assert.deepEqual(claudeTypes, [
    "session_start",
    "user_prompt",
    "assistant_turn",
    "pre_compact",
    "session_end"
  ]);
});

test("Claude bootstrap injects only the opaque Session handle and native context", () => {
  const rendered = new ClaudeAdapter().renderBootstrap({
    sessionId: "ses_opaque",
    provider: "claude-code",
    context: "# Space Context\nExisting project memory"
  });
  assert.match(rendered.content, /Session: ses_opaque/u);
  assert.match(rendered.content, /Existing project memory/u);
  assert.match(rendered.content, /untrusted-project-data/u);
  assert.doesNotMatch(rendered.content, /spaceId/u);
  assert.deepEqual(rendered.metadata, {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: rendered.content
    }
  });
});

test("Claude hook client forwards native payload and fails open safely", async () => {
  const expected: ClaudeCodeHookOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "Memory bootstrap"
    }
  };
  const requests: Array<{ url: string; body: unknown }> = [];
  const output = await invokeClaudeCodeLifecycleHook(nativePayload("SessionStart"), {
    endpoint: "http://127.0.0.1:4310/providers/claude-code/lifecycle",
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
    url: "http://127.0.0.1:4310/providers/claude-code/lifecycle",
    body: nativePayload("SessionStart")
  }]);

  const unsafeDaemonOutput = await invokeClaudeCodeLifecycleHook(
    nativePayload("SessionStart"),
    {
      fetch: async () => new Response(JSON.stringify({
        status: "ok",
        output: { continue: false, stopReason: "must block" }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    }
  );
  assert.deepEqual(unsafeDaemonOutput, {
    continue: true,
    systemMessage: "Memory Space warning [MEMORY_SERVICE_UNAVAILABLE]: Memory service unavailable"
  });

  const unavailable = await invokeClaudeCodeLifecycleHook(
    nativePayload("SessionStart"),
    { fetch: async () => { throw new Error("ECONNREFUSED private-host"); } }
  );
  assert.deepEqual(unavailable, {
    continue: true,
    systemMessage: "Memory Space warning [MEMORY_SERVICE_UNAVAILABLE]: Memory service unavailable"
  });

  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/adapters/providers/claude-code/hook.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify(nativePayload("SessionStart")),
      env: {
        ...process.env,
        MEMORY_SPACE_CLAUDE_CODE_HOOK_URL:
          "http://127.0.0.1:1/providers/claude-code/lifecycle",
        MEMORY_SPACE_HOOK_TIMEOUT_MS: "100"
      }
    }
  );
  assert.equal(child.status, 0, child.stderr);
  const cliOutput = JSON.parse(child.stdout) as ClaudeCodeHookOutput;
  assert.match(cliOutput.systemMessage ?? "", /MEMORY_SERVICE_UNAVAILABLE/u);
  assert.doesNotMatch(child.stdout, /ECONNREFUSED|private-host/u);

  const semanticChild = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "src/adapters/providers/claude-code/hook.ts"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "not-json",
      env: {
        ...process.env,
        MEMORY_SPACE_INTERNAL_INVOCATION: "semantic-extraction"
      }
    }
  );
  assert.equal(semanticChild.status, 0, semanticChild.stderr);
  assert.equal(semanticChild.stdout, "");
  assert.equal(semanticChild.stderr, "");
});

test("Claude hook client accepts event-correct prompt context and rejects mismatches", async () => {
  const promptOutput: ClaudeCodeHookOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "bounded Indexed context"
    }
  };
  const accepted = await invokeClaudeCodeLifecycleHook(nativePayload("UserPromptSubmit", {
    prompt: "CROSS_AGENT_TEST_20260817"
  }), {
    fetch: async () => new Response(JSON.stringify({ status: "ok", output: promptOutput }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });
  assert.deepEqual(accepted, promptOutput);

  const mismatch = await invokeClaudeCodeLifecycleHook(nativePayload("UserPromptSubmit", {
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

test("Claude lifecycle failures remain non-blocking and provider-safe", async () => {
  const memorySpace = createDefaultMemorySpace();
  try {
    const integration = new ClaudeCodeLifecycleIntegration({
      lifecycleHandler: new LifecycleHandler({
        memorySpace,
        spaceResolver: {
          async resolve() {
            throw new Error("database offline at /secret/path/memory.db");
          }
        },
        sessionResolver: new ProviderSessionResolver(memorySpace),
        checkpointPolicy: new CheckpointPolicy(memorySpace)
      }),
      onWarning() { throw new Error("diagnostics unavailable"); }
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

    const malformed = await integration.handleNative(nativePayload("SessionStart", {
      source: "startup",
      transcript_path: undefined
    }));
    assert.equal(malformed.status, "warning");
    if (malformed.status !== "warning") {
      throw new Error("Expected malformed native event warning");
    }
    assert.equal(malformed.warning.error.code, "VALIDATION_ERROR");
    assert.equal(
      malformed.warning.error.message,
      "The Claude Code lifecycle payload is invalid"
    );
    assert.equal(malformed.output.continue, true);
    assert.doesNotMatch(JSON.stringify(malformed), /transcript_path/u);
  } finally {
    await memorySpace.close();
  }
});
