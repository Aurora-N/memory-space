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
  renderClaudeCodeBootstrap,
  type ClaudeCodeBootstrapOutput
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
    throw new ValidationError("Claude Code hook payload must be a JSON object");
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

function transcriptRef(
  value: unknown,
  externalSessionId: string
): TranscriptRef {
  return {
    provider: "claude-code",
    externalSessionId,
    locator: requiredString(value, "Claude Code transcript_path")
  };
}

function oneOf(value: unknown, label: string, allowed: readonly string[]): void {
  const normalized = requiredString(value, label);
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`${label} is unsupported: ${normalized}`);
  }
}

function base(input: Record<string, unknown>): ProviderEventBase {
  const externalSessionId = requiredString(input.session_id, "Claude Code session_id");
  return {
    provider: "claude-code",
    externalSessionId,
    cwd: requiredString(input.cwd, "Claude Code cwd"),
    transcriptRef: transcriptRef(input.transcript_path, externalSessionId)
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude-code";
  readonly capabilities = capabilities;

  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null {
    const input = record(payload);
    const hookEventName = requiredString(
      input.hook_event_name,
      "Claude Code hook_event_name"
    );
    if (!supportedEvents.has(hookEventName)) return null;
    const common = base(input);

    if (hookEventName === "SessionStart") {
      oneOf(input.source, "Claude Code SessionStart source", [
        "startup", "resume", "clear", "compact", "fork"
      ]);
      return { ...common, type: "session_start" };
    }
    if (hookEventName === "UserPromptSubmit") {
      return {
        ...common,
        type: "user_prompt",
        content: requiredContent(input.prompt, "Claude Code UserPromptSubmit prompt")
      };
    }
    if (hookEventName === "Stop") {
      if (typeof input.stop_hook_active !== "boolean") {
        throw new ValidationError(
          "Claude Code Stop stop_hook_active must be a boolean"
        );
      }
      if (input.last_assistant_message === null
        || input.last_assistant_message === undefined) return null;
      if (typeof input.last_assistant_message !== "string") {
        throw new ValidationError(
          "Claude Code Stop last_assistant_message must be a string"
        );
      }
      if (input.last_assistant_message.trim() === "") return null;
      return {
        ...common,
        type: "assistant_turn",
        content: input.last_assistant_message
      };
    }
    if (hookEventName === "PreCompact") {
      oneOf(input.trigger, "Claude Code PreCompact trigger", ["manual", "auto"]);
      if (input.custom_instructions !== null
        && typeof input.custom_instructions !== "string") {
        throw new ValidationError(
          "Claude Code PreCompact custom_instructions must be a string or null"
        );
      }
      return { ...common, type: "pre_compact" };
    }
    oneOf(input.reason, "Claude Code SessionEnd reason", [
      "clear",
      "resume",
      "logout",
      "prompt_input_exit",
      "bypass_permissions_disabled",
      "other"
    ]);
    return { ...common, type: "session_end" };
  }

  renderBootstrap(input: ProviderBootstrapRenderInput): ClaudeCodeBootstrapOutput {
    return renderClaudeCodeBootstrap(input);
  }
}
