import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProviderAdapter,
  ProviderLifecycleEvent,
  TranscriptChunk,
  TranscriptReader,
  TranscriptRef
} from "../src/index.ts";
import { validateProviderLifecycleEvent, ValidationError } from "../src/index.ts";

function eventKind(event: ProviderLifecycleEvent): string {
  switch (event.type) {
    case "session_start": return "start";
    case "user_prompt": return `user:${event.content}`;
    case "assistant_turn": return `assistant:${event.content}`;
    case "pre_compact": return "compact";
    case "session_end": return "end";
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

class FakeProvider implements ProviderAdapter {
  readonly name = "fake";
  readonly capabilities = new Set(["session_start", "user_prompt", "bootstrap_injection"] as const);

  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null {
    if (!payload || typeof payload !== "object" || !("kind" in payload)) return null;
    const native = payload as { kind?: unknown; session?: unknown; text?: unknown };
    if (native.kind === "started") {
      return validateProviderLifecycleEvent({
        type: "session_start", provider: this.name, externalSessionId: native.session
      });
    }
    if (native.kind === "prompt") {
      return validateProviderLifecycleEvent({
        type: "user_prompt", provider: this.name,
        externalSessionId: native.session, content: native.text
      });
    }
    return null;
  }

  renderBootstrap(input: { sessionId: string; provider: string; context: string }) {
    return { content: `[${input.sessionId}]\n${input.context}` };
  }
}

test("fake ProviderAdapter normalizes common lifecycle events without persistence dependencies", () => {
  const provider = new FakeProvider();
  const started = provider.normalizeEvent({ kind: "started", session: "native-1" });
  const prompt = provider.normalizeEvent({ kind: "prompt", session: "native-1", text: "Ship P0" });
  assert.ok(started);
  assert.ok(prompt);
  assert.equal(eventKind(started), "start");
  assert.equal(eventKind(prompt), "user:Ship P0");
  assert.equal(provider.normalizeEvent({ kind: "tool_call" }), null);
  assert.match(provider.renderBootstrap!({ sessionId: "session-1", provider: "fake", context: "Context" }).content, /Context/u);
});

test("malformed normalized Provider events are rejected", () => {
  assert.throws(
    () => validateProviderLifecycleEvent({ type: "user_prompt", provider: "fake", content: "" }),
    (error: unknown) => error instanceof ValidationError
  );
  assert.throws(
    () => validateProviderLifecycleEvent({ type: "unknown", provider: "fake" }),
    /Unsupported provider lifecycle event/u
  );
  assert.throws(
    () => validateProviderLifecycleEvent({
      type: "session_start", provider: "fake", transcriptRef: { provider: "fake" }
    }),
    /transcriptRef.locator/u
  );
});

test("normalized Provider message content is preserved exactly", () => {
  const content = "\n  hello\n\n";
  const event = validateProviderLifecycleEvent({ type: "user_prompt", provider: "fake", content });
  assert.equal(event.type, "user_prompt");
  if (event.type !== "user_prompt") throw new Error("Expected user_prompt event");
  assert.equal(event.content, content);
  for (const empty of ["", "   ", "\n\t"]) {
    assert.throws(
      () => validateProviderLifecycleEvent({ type: "assistant_turn", provider: "fake", content: empty }),
      (error: unknown) => error instanceof ValidationError
    );
  }
});

test("TranscriptRef provenance must match its carrying lifecycle event", () => {
  assert.throws(
    () => validateProviderLifecycleEvent({
      type: "user_prompt", provider: "codex", externalSessionId: "codex-session", content: "x",
      transcriptRef: { provider: "claude-code", externalSessionId: "codex-session", locator: "opaque" }
    }),
    /transcriptRef.provider/u
  );
  assert.throws(
    () => validateProviderLifecycleEvent({
      type: "user_prompt", provider: "codex", externalSessionId: "codex-session", content: "x",
      transcriptRef: { provider: "codex", externalSessionId: "other-session", locator: "opaque" }
    }),
    /transcriptRef.externalSessionId/u
  );
  const matching = validateProviderLifecycleEvent({
    type: "user_prompt", provider: "codex", externalSessionId: "codex-session", content: "x",
    transcriptRef: { provider: "codex", externalSessionId: "codex-session", locator: "opaque" }
  });
  assert.deepEqual(matching.transcriptRef, {
    provider: "codex", externalSessionId: "codex-session", locator: "opaque",
    cursor: undefined, updatedAt: undefined
  });
  const omitted = validateProviderLifecycleEvent({
    type: "assistant_turn", provider: "codex", externalSessionId: "codex-session", content: "x",
    transcriptRef: { provider: "codex", locator: "opaque" }
  });
  assert.equal(omitted.transcriptRef?.externalSessionId, undefined);
});

test("TranscriptReader remains a provider-neutral bounded-read port", async () => {
  const reads: Array<{ ref: TranscriptRef; limit?: number }> = [];
  const reader: TranscriptReader = {
    supports(provider) { return provider === "fake"; },
    async read(ref, options): Promise<TranscriptChunk[]> {
      reads.push({ ref, limit: options?.limit });
      return [{ content: "supplementary evidence", cursor: "next" }];
    }
  };
  const ref = { provider: "fake", locator: "opaque://transcript/1", externalSessionId: "native-1" };
  assert.equal(reader.supports("fake"), true);
  assert.deepEqual(await reader.read(ref, { limit: 1 }), [{ content: "supplementary evidence", cursor: "next" }]);
  assert.deepEqual(reads, [{ ref, limit: 1 }]);
});
