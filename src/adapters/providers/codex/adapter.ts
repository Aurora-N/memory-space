import { ValidationError } from "../../../domain/errors.ts";
import type {
  ProviderAdapter,
  ProviderBootstrapRenderInput,
  ProviderCapability,
  ProviderEventBase,
  ProviderLifecycleEvent,
  TranscriptRef
} from "../../../provider/types.ts";
import {
  renderCodexBootstrap,
  type CodexBootstrapOutput
} from "./bootstrap-renderer.ts";

const supportedEvents = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreCompact",
  "SessionEnd"
]);

const capabilities: ReadonlySet<ProviderCapability> = new Set([
  "session_identity",
  "session_start",
  "user_prompt",
  "assistant_turn",
  "pre_compact",
  "session_end",
  "bootstrap_injection",
  "mcp"
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Codex hook payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalTranscriptRef(
  value: unknown,
  externalSessionId: string
): TranscriptRef | undefined {
  if (value === null || value === undefined) return undefined;
  return {
    provider: "codex",
    externalSessionId,
    locator: requiredString(value, "Codex transcript_path")
  };
}

function oneOf(value: unknown, label: string, allowed: readonly string[]): void {
  const normalized = requiredString(value, label);
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`${label} is unsupported: ${normalized}`);
  }
}

function base(input: Record<string, unknown>): ProviderEventBase {
  const externalSessionId = requiredString(input.session_id, "Codex session_id");
  return {
    provider: "codex",
    externalSessionId,
    cwd: requiredString(input.cwd, "Codex cwd"),
    transcriptRef: optionalTranscriptRef(input.transcript_path, externalSessionId)
  };
}

/** Normalizes supported native Codex hook payloads into provider-neutral events. */
export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";
  readonly capabilities = capabilities;

  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null {
    const input = record(payload);
    const hookEventName = requiredString(input.hook_event_name, "Codex hook_event_name");
    if (!supportedEvents.has(hookEventName)) return null;
    const common = base(input);

    if (hookEventName === "SessionStart") {
      oneOf(input.source, "Codex SessionStart source", ["startup", "resume", "clear", "compact"]);
      return { ...common, type: "session_start" };
    }
    if (hookEventName === "UserPromptSubmit") {
      requiredString(input.turn_id, "Codex UserPromptSubmit turn_id");
      return {
        ...common,
        type: "user_prompt",
        content: requiredContent(input.prompt, "Codex UserPromptSubmit prompt")
      };
    }
    if (hookEventName === "Stop") {
      requiredString(input.turn_id, "Codex Stop turn_id");
      if (typeof input.stop_hook_active !== "boolean") {
        throw new ValidationError("Codex Stop stop_hook_active must be a boolean");
      }
      if (input.last_assistant_message === null || input.last_assistant_message === undefined) {
        return null;
      }
      if (typeof input.last_assistant_message !== "string") {
        throw new ValidationError("Codex Stop last_assistant_message must be a string or null");
      }
      if (input.last_assistant_message.trim() === "") return null;
      return { ...common, type: "assistant_turn", content: input.last_assistant_message };
    }
    if (hookEventName === "PreCompact") {
      requiredString(input.turn_id, "Codex PreCompact turn_id");
      oneOf(input.trigger, "Codex PreCompact trigger", ["manual", "auto"]);
      return { ...common, type: "pre_compact" };
    }
    oneOf(input.reason, "Codex SessionEnd reason", ["other"]);
    return { ...common, type: "session_end" };
  }

  renderBootstrap(input: ProviderBootstrapRenderInput): CodexBootstrapOutput {
    return renderCodexBootstrap(input);
  }
}
