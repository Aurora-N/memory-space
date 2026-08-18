import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CheckpointPolicy,
  ClaudeCodeLifecycleIntegration,
  createDefaultMemorySpace,
  LifecycleHandler,
  ProviderSessionResolver,
  SpaceResolver
} from "../src/index.ts";

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(
    join(bindingDirectory, "config.json"),
    JSON.stringify({ version: 1, spaceId })
  );
}

function nativePayload(
  hookEventName: string,
  cwd: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    session_id: "claude-native-session",
    transcript_path: join(cwd, ".claude", "transcript.jsonl"),
    cwd,
    hook_event_name: hookEventName,
    model: "claude-sonnet-4-6",
    permission_mode: "default",
    ...overrides
  };
}

function integration(
  memorySpace: ReturnType<typeof createDefaultMemorySpace>,
  explicitSpaceId?: string
) {
  return new ClaudeCodeLifecycleIntegration({
    lifecycleHandler: new LifecycleHandler({
      memorySpace,
      spaceResolver: new SpaceResolver(),
      sessionResolver: new ProviderSessionResolver(memorySpace),
      checkpointPolicy: new CheckpointPolicy(memorySpace)
    }),
    runtime: { explicitSpaceId }
  });
}

test("eval Claude native lifecycle completes durable bootstrap, capture, checkpoint, and resume", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-claude-eval-"));
  const nested = join(directory, "nested");
  const databasePath = join(directory, "memory.db");
  mkdirSync(nested);
  bind(directory, "claude-space-a");
  bind(nested, "claude-space-b");

  try {
    const first = createDefaultMemorySpace({ databasePath });
    await first.createSpace({ id: "claude-space-a", name: "Claude Space A" });
    await first.createSpace({ id: "claude-space-b", name: "Claude Space B" });

    const prior = await first.createSession({
      spaceId: "claude-space-a",
      provider: "prior-agent"
    });
    const goal = await first.remember({
      spaceId: "claude-space-a",
      sourceSessionId: prior.id,
      family: "state",
      type: "goal",
      key: "project.goal.primary",
      content: "Deliver Claude Code provider integration"
    });
    await first.promote(goal.id, {
      actor: "agent",
      reason: "Active project goal"
    });
    const priorEvent = await first.appendEvent({
      sessionId: prior.id,
      type: "message",
      payload: {
        role: "user",
        content: "Decision: SQLite remains the local default."
      }
    });
    await first.checkpoint({
      sessionId: prior.id,
      toEventId: priorEvent.id,
      idempotencyKey: "claude-eval-prior-handoff"
    });

    const claude = integration(first);
    const started = await claude.handleNative(nativePayload(
      "SessionStart",
      directory,
      { source: "startup" }
    ));
    assert.equal(started.status, "ok");
    assert.equal(started.type, "session_start");
    if (started.status !== "ok" || started.type !== "session_start") {
      throw new Error("Expected successful Claude Code SessionStart");
    }
    assert.match(
      started.output?.hookSpecificOutput?.additionalContext ?? "",
      /Session: [0-9a-f-]+/u
    );
    assert.match(
      started.output?.hookSpecificOutput?.additionalContext ?? "",
      /Deliver Claude Code/u
    );
    assert.match(
      started.output?.hookSpecificOutput?.additionalContext ?? "",
      /SQLite/u
    );
    assert.doesNotMatch(
      started.output?.hookSpecificOutput?.additionalContext ?? "",
      /claude-space-a/u
    );

    const duplicate = await claude.handleNative(nativePayload(
      "SessionStart",
      directory,
      { source: "resume" }
    ));
    assert.equal(duplicate.status, "ok");
    if (duplicate.status !== "ok") throw new Error("Expected duplicate start to succeed");
    assert.equal(duplicate.sessionId, started.sessionId);

    const prompt = "\n  Implement Claude Code P3\n";
    const assistant = "进度：Claude Code P3 implementation is ready\n";
    await claude.handleNative(nativePayload("UserPromptSubmit", directory, {
      prompt_id: "prompt-1",
      prompt,
      recommendedTier: "core",
      tier: "core",
      actor: "user",
      force: true,
      spaceId: "claude-space-b",
      idempotencyKey: "provider-controlled"
    }));
    await claude.handleNative(nativePayload("Stop", directory, {
      prompt_id: "prompt-1",
      stop_hook_active: false,
      last_assistant_message: assistant
    }));
    await claude.handleNative(nativePayload("UserPromptSubmit", nested, {
      prompt_id: "prompt-2",
      prompt: "Continue after cwd changed"
    }));

    const session = await first.getSession(started.sessionId);
    assert.equal(session.spaceId, "claude-space-a");
    assert.equal(session.provider, "claude-code");
    assert.equal(session.agentId, "claude-code");
    const events = await first.listEvents(session.id);
    assert.deepEqual(events.map((event) => event.payload), [
      {
        role: "user",
        content: prompt,
        contentMode: "full",
        transcriptRef: {
          provider: "claude-code",
          externalSessionId: "claude-native-session",
          locator: join(directory, ".claude", "transcript.jsonl")
        }
      },
      {
        role: "assistant",
        content: assistant,
        contentMode: "full",
        transcriptRef: {
          provider: "claude-code",
          externalSessionId: "claude-native-session",
          locator: join(directory, ".claude", "transcript.jsonl")
        }
      },
      {
        role: "user",
        content: "Continue after cwd changed",
        contentMode: "full",
        transcriptRef: {
          provider: "claude-code",
          externalSessionId: "claude-native-session",
          locator: join(nested, ".claude", "transcript.jsonl")
        }
      }
    ]);
    assert.equal(events.some((event) => "tier" in event.payload
      || "actor" in event.payload
      || "idempotencyKey" in event.payload), false);

    const compacted = await claude.handleNative(nativePayload(
      "PreCompact",
      nested,
      { trigger: "auto", custom_instructions: "" }
    ));
    assert.equal(compacted.status, "ok");
    if (compacted.status !== "ok") throw new Error("Expected PreCompact success");
    assert.equal(compacted.checkpointStatus, "completed");
    const repeated = await claude.handleNative(nativePayload(
      "PreCompact",
      nested,
      { trigger: "auto", custom_instructions: "" }
    ));
    assert.equal(repeated.status, "ok");
    if (repeated.status !== "ok") throw new Error("Expected repeated PreCompact success");
    assert.equal(repeated.checkpointStatus, "noop");

    const compactReentry = await claude.handleNative(nativePayload(
      "SessionStart",
      nested,
      { source: "compact" }
    ));
    assert.equal(compactReentry.status, "ok");
    if (compactReentry.status !== "ok") {
      throw new Error("Expected compact re-entry success");
    }
    assert.equal(compactReentry.sessionId, started.sessionId);
    assert.match(
      compactReentry.output?.hookSpecificOutput?.additionalContext ?? "",
      /P3 implementation is ready/u
    );
    assert.equal((await first.getSession(session.id)).spaceId, "claude-space-a");

    const resumedAfterCwdChange = await claude.handleNative(nativePayload(
      "SessionStart",
      nested,
      { source: "resume" }
    ));
    assert.equal(resumedAfterCwdChange.status, "ok");
    if (resumedAfterCwdChange.status !== "ok") {
      throw new Error("Expected changed-cwd resume success");
    }
    assert.equal(resumedAfterCwdChange.sessionId, started.sessionId);
    assert.equal((await first.getSession(session.id)).spaceId, "claude-space-a");

    const conflictingStart = await integration(first, "claude-space-b").handleNative(
      nativePayload("SessionStart", nested, { source: "resume" })
    );
    assert.equal(conflictingStart.status, "warning");
    if (conflictingStart.status !== "warning") {
      throw new Error("Expected explicit binding conflict warning");
    }
    assert.equal(conflictingStart.warning.error.code, "SPACE_BINDING_CONFLICT");
    assert.doesNotMatch(
      conflictingStart.warning.error.message,
      /claude-space|claude-native-session/u
    );
    assert.doesNotMatch(
      conflictingStart.output.systemMessage ?? "",
      /claude-space|claude-native-session/u
    );
    assert.equal((await first.getSession(session.id)).spaceId, "claude-space-a");

    await claude.handleNative(nativePayload("UserPromptSubmit", nested, {
      prompt_id: "prompt-3",
      prompt: "下一步完成 Claude Code P3 frozen"
    }));
    const ended = await claude.handleNative(nativePayload(
      "SessionEnd",
      nested,
      { reason: "other" }
    ));
    assert.equal(ended.status, "ok");
    if (ended.status !== "ok") throw new Error("Expected SessionEnd success");
    assert.equal(ended.checkpointStatus, "completed");
    const repeatedEnd = await claude.handleNative(nativePayload(
      "SessionEnd",
      nested,
      { reason: "other" }
    ));
    assert.equal(repeatedEnd.status, "ok");
    if (repeatedEnd.status !== "ok") {
      throw new Error("Expected repeated SessionEnd success");
    }
    assert.equal(repeatedEnd.checkpointStatus, "noop");
    await first.close();

    const reopened = createDefaultMemorySpace({ databasePath });
    const resumed = await integration(reopened).handleNative(nativePayload(
      "SessionStart",
      directory,
      { source: "resume" }
    ));
    assert.equal(resumed.status, "ok");
    if (resumed.status !== "ok") throw new Error("Expected durable resume success");
    assert.equal(resumed.sessionId, session.id);
    assert.match(
      resumed.output?.hookSpecificOutput?.additionalContext ?? "",
      /P3 implementation is ready/u
    );
    await reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
