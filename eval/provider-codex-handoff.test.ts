import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckpointPolicy,
  CodexLifecycleIntegration,
  createDefaultMemorySpace,
  LifecycleHandler,
  ProviderSessionResolver,
  SpaceResolver
} from "../src/index.ts";

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(join(bindingDirectory, "config.json"), JSON.stringify({ version: 1, spaceId }));
}

function nativePayload(
  hookEventName: string,
  cwd: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: "codex-native-session",
    transcript_path: join(cwd, ".codex", "transcript.jsonl"),
    cwd,
    hook_event_name: hookEventName,
    model: "codex-model",
    permission_mode: "default",
    ...overrides
  };
}

function integration(memorySpace: ReturnType<typeof createDefaultMemorySpace>) {
  return new CodexLifecycleIntegration({
    lifecycleHandler: new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace)
    })
  });
}

test("eval Codex native lifecycle completes durable bootstrap, capture, checkpoint, and resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-codex-eval-"));
  const nested = join(directory, "nested");
  const databasePath = join(directory, "memory.db");
  mkdirSync(nested);
  bind(directory, "codex-space-a");
  bind(nested, "codex-space-b");

  try {
    const first = createDefaultMemorySpace({ databasePath });
    await first.createSpace({ id: "codex-space-a", name: "Codex Space A" });
    await first.createSpace({ id: "codex-space-b", name: "Codex Space B" });

    const prior = await first.createSession({ spaceId: "codex-space-a", provider: "prior-agent" });
    const goal = await first.remember({
      spaceId: "codex-space-a",
      sourceSessionId: prior.id,
      family: "state",
      type: "goal",
      key: "project.goal.primary",
      content: "Deliver Codex provider integration"
    });
    await first.promote(goal.id, { actor: "agent", reason: "Active project goal" });
    const priorEvent = await first.appendEvent({
      sessionId: prior.id,
      type: "message",
      payload: { role: "user", content: "数据库确定使用 SQLite；下一步完成 Codex hooks。" }
    });
    await first.checkpoint({
      sessionId: prior.id,
      toEventId: priorEvent.id,
      idempotencyKey: "codex-eval-prior-handoff"
    });

    const codex = integration(first);
    const started = await codex.handleNative(nativePayload("SessionStart", directory, {
      source: "startup"
    }));
    assert.equal(started.status, "ok");
    assert.equal(started.type, "session_start");
    if (started.status !== "ok" || started.type !== "session_start") {
      throw new Error("Expected successful Codex SessionStart");
    }
    assert.match(started.output?.hookSpecificOutput?.additionalContext ?? "", /Session: [0-9a-f-]+/u);
    assert.match(started.output?.hookSpecificOutput?.additionalContext ?? "", /Deliver Codex/u);
    assert.match(started.output?.hookSpecificOutput?.additionalContext ?? "", /SQLite/u);
    assert.doesNotMatch(started.output?.hookSpecificOutput?.additionalContext ?? "", /codex-space-a/u);

    const duplicate = await codex.handleNative(nativePayload("SessionStart", directory, {
      source: "resume"
    }));
    assert.equal(duplicate.status, "ok");
    if (duplicate.status !== "ok") throw new Error("Expected duplicate start to succeed");
    assert.equal(duplicate.sessionId, started.sessionId);

    await codex.handleNative(nativePayload("UserPromptSubmit", directory, {
      turn_id: "turn-1",
      prompt: "Implement Codex P2",
      recommendedTier: "core",
      tier: "core",
      actor: "user",
      force: true,
      spaceId: "codex-space-b"
    }));
    await codex.handleNative(nativePayload("Stop", directory, {
      turn_id: "turn-1",
      stop_hook_active: false,
      last_assistant_message: "进度：P2 implementation is ready"
    }));
    await codex.handleNative(nativePayload("UserPromptSubmit", nested, {
      turn_id: "turn-2",
      prompt: "Continue after cwd changed"
    }));

    const session = await first.getSession(started.sessionId);
    assert.equal(session.spaceId, "codex-space-a");
    const events = await first.listEvents(session.id);
    assert.deepEqual(events.map((event) => event.payload), [
      {
        role: "user",
        content: "Implement Codex P2",
        contentMode: "full",
        transcriptRef: {
          provider: "codex",
          externalSessionId: "codex-native-session",
          locator: join(directory, ".codex", "transcript.jsonl")
        }
      },
      {
        role: "assistant",
        content: "进度：P2 implementation is ready",
        contentMode: "full",
        transcriptRef: {
          provider: "codex",
          externalSessionId: "codex-native-session",
          locator: join(directory, ".codex", "transcript.jsonl")
        }
      },
      {
        role: "user",
        content: "Continue after cwd changed",
        contentMode: "full",
        transcriptRef: {
          provider: "codex",
          externalSessionId: "codex-native-session",
          locator: join(nested, ".codex", "transcript.jsonl")
        }
      }
    ]);
    assert.equal(events.some((event) => "tier" in event.payload || "actor" in event.payload), false);

    const compacted = await codex.handleNative(nativePayload("PreCompact", nested, {
      turn_id: "turn-2", trigger: "auto"
    }));
    assert.equal(compacted.status, "ok");
    if (compacted.status !== "ok") throw new Error("Expected PreCompact success");
    assert.equal(compacted.checkpointStatus, "completed");
    const repeated = await codex.handleNative(nativePayload("PreCompact", nested, {
      turn_id: "turn-2", trigger: "auto"
    }));
    assert.equal(repeated.status, "ok");
    if (repeated.status !== "ok") throw new Error("Expected repeated PreCompact success");
    assert.equal(repeated.checkpointStatus, "noop");
    const ended = await codex.handleNative(nativePayload("SessionEnd", nested, { reason: "other" }));
    assert.equal(ended.status, "ok");
    if (ended.status !== "ok") throw new Error("Expected SessionEnd success");
    assert.equal(ended.checkpointStatus, "noop");

    const conflictingStart = await codex.handleNative(nativePayload("SessionStart", nested, {
      source: "resume"
    }));
    assert.equal(conflictingStart.status, "warning");
    if (conflictingStart.status !== "warning") throw new Error("Expected binding conflict warning");
    assert.equal(conflictingStart.warning.error.code, "PROVIDER_SESSION_SPACE_CONFLICT");
    assert.doesNotMatch(conflictingStart.warning.error.message, /codex-space|codex-native-session/u);
    assert.doesNotMatch(conflictingStart.output.systemMessage ?? "", /codex-space|codex-native-session/u);
    assert.equal((await first.getSession(session.id)).spaceId, "codex-space-a");
    await first.close();

    const reopened = createDefaultMemorySpace({ databasePath });
    const resumed = await integration(reopened).handleNative(nativePayload("SessionStart", directory, {
      source: "resume"
    }));
    assert.equal(resumed.status, "ok");
    if (resumed.status !== "ok") throw new Error("Expected durable resume success");
    assert.equal(resumed.sessionId, session.id);
    assert.match(resumed.output?.hookSpecificOutput?.additionalContext ?? "", /P2 implementation is ready/u);
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
