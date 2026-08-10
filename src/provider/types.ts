import { ValidationError } from "../domain/errors.ts";

export type ProviderCapability =
  | "session_identity"
  | "session_start"
  | "user_prompt"
  | "assistant_turn"
  | "pre_compact"
  | "session_end"
  | "bootstrap_injection"
  | "mcp";

export type CheckpointTrigger = "explicit" | "pre_compact" | "session_end" | "task_completed";

export interface TranscriptRef {
  provider: string;
  locator: string;
  externalSessionId?: string;
  cursor?: string;
  updatedAt?: string;
}

export interface ProviderEventBase {
  provider: string;
  externalSessionId?: string;
  cwd?: string;
  occurredAt?: string;
  transcriptRef?: TranscriptRef;
}

export interface ProviderSessionStartEvent extends ProviderEventBase { type: "session_start" }
export interface ProviderUserPromptEvent extends ProviderEventBase { type: "user_prompt"; content: string }
export interface ProviderAssistantTurnEvent extends ProviderEventBase { type: "assistant_turn"; content: string }
export interface ProviderPreCompactEvent extends ProviderEventBase { type: "pre_compact" }
export interface ProviderSessionEndEvent extends ProviderEventBase { type: "session_end" }

export type ProviderLifecycleEvent =
  | ProviderSessionStartEvent
  | ProviderUserPromptEvent
  | ProviderAssistantTurnEvent
  | ProviderPreCompactEvent
  | ProviderSessionEndEvent;

export interface ProviderBootstrapRenderInput {
  sessionId: string;
  provider: string;
  context: string;
}

export interface ProviderBootstrapOutput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  normalizeEvent(payload: unknown): ProviderLifecycleEvent | null;
  renderBootstrap?(input: ProviderBootstrapRenderInput): ProviderBootstrapOutput;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function transcriptRef(value: unknown): TranscriptRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("providerEvent.transcriptRef must be an object");
  }
  const ref = value as Record<string, unknown>;
  return {
    provider: requiredString(ref.provider, "transcriptRef.provider"),
    locator: requiredString(ref.locator, "transcriptRef.locator"),
    externalSessionId: optionalString(ref.externalSessionId, "transcriptRef.externalSessionId"),
    cursor: optionalString(ref.cursor, "transcriptRef.cursor"),
    updatedAt: optionalString(ref.updatedAt, "transcriptRef.updatedAt")
  };
}

export function validateProviderLifecycleEvent(value: unknown): ProviderLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Provider lifecycle event must be an object");
  }
  const input = value as Record<string, unknown>;
  const type = requiredString(input.type, "providerEvent.type");
  const occurredAt = optionalString(input.occurredAt, "providerEvent.occurredAt");
  if (occurredAt && Number.isNaN(Date.parse(occurredAt))) {
    throw new ValidationError("providerEvent.occurredAt must be a valid date-time");
  }
  const base: ProviderEventBase = {
    provider: requiredString(input.provider, "providerEvent.provider"),
    externalSessionId: optionalString(input.externalSessionId, "providerEvent.externalSessionId"),
    cwd: optionalString(input.cwd, "providerEvent.cwd"),
    occurredAt,
    transcriptRef: transcriptRef(input.transcriptRef)
  };
  if (type === "user_prompt" || type === "assistant_turn") {
    return { ...base, type, content: requiredString(input.content, "providerEvent.content") };
  }
  if (type === "session_start" || type === "pre_compact" || type === "session_end") {
    return { ...base, type };
  }
  throw new ValidationError(`Unsupported provider lifecycle event type: ${type}`);
}
