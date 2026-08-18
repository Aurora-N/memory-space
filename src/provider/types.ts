import { ValidationError } from "../domain/errors.ts";

/** Provider lifecycle and integration features advertised by an adapter. */
export type ProviderCapability =
  | "session_identity"
  | "session_start"
  | "user_prompt"
  | "assistant_turn"
  | "pre_compact"
  | "session_end"
  | "bootstrap_injection"
  | "mcp";

/** Lifecycle cause used to select checkpoint policy. */
export type CheckpointTrigger = "explicit" | "pre_compact" | "session_end" | "task_completed";

/** Opaque provider transcript locator preserved without provider-specific interpretation. */
export interface TranscriptRef {
  provider: string;
  locator: string;
  externalSessionId?: string;
  cursor?: string;
  updatedAt?: string;
}

/** Provider-neutral fields shared by every normalized lifecycle event. */
export interface ProviderEventBase {
  provider: string;
  externalSessionId?: string;
  cwd?: string;
  occurredAt?: string;
  transcriptRef?: TranscriptRef;
}

/** Normalized provider event indicating Session startup or resume. */
export interface ProviderSessionStartEvent extends ProviderEventBase { type: "session_start" }
/** Normalized user prompt whose content may participate in recall. */
export interface ProviderUserPromptEvent extends ProviderEventBase { type: "user_prompt"; content: string }
/** Normalized assistant turn carrying content that can be persisted as Session evidence. */
export interface ProviderAssistantTurnEvent extends ProviderEventBase { type: "assistant_turn"; content: string }
/** Normalized provider signal emitted before context compaction. */
export interface ProviderPreCompactEvent extends ProviderEventBase { type: "pre_compact" }
/** Normalized provider signal emitted when a Session ends. */
export interface ProviderSessionEndEvent extends ProviderEventBase { type: "session_end" }

/** Closed provider-neutral lifecycle event union accepted by integrations. */
export type ProviderLifecycleEvent =
  | ProviderSessionStartEvent
  | ProviderUserPromptEvent
  | ProviderAssistantTurnEvent
  | ProviderPreCompactEvent
  | ProviderSessionEndEvent;

/** Provider-neutral bootstrap data supplied to a provider-specific renderer. */
export interface ProviderBootstrapRenderInput {
  sessionId: string;
  provider: string;
  context: string;
}

/** Provider-rendered bootstrap content plus optional transport metadata. */
export interface ProviderBootstrapOutput {
  content: string;
  metadata?: Record<string, unknown>;
}

/** Boundary that normalizes provider payloads before application code sees them. */
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

function requiredContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value;
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

/** Validates an unknown normalized event and rejects provider-shape leakage. */
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
  const ref = transcriptRef(input.transcriptRef);
  const base: ProviderEventBase = {
    provider: requiredString(input.provider, "providerEvent.provider"),
    externalSessionId: optionalString(input.externalSessionId, "providerEvent.externalSessionId"),
    cwd: optionalString(input.cwd, "providerEvent.cwd"),
    occurredAt,
    transcriptRef: ref
  };
  if (ref?.provider !== undefined && ref.provider !== base.provider) {
    throw new ValidationError("transcriptRef.provider must match providerEvent.provider");
  }
  if (ref?.externalSessionId !== undefined && base.externalSessionId !== undefined
    && ref.externalSessionId !== base.externalSessionId) {
    throw new ValidationError("transcriptRef.externalSessionId must match providerEvent.externalSessionId");
  }
  if (type === "user_prompt" || type === "assistant_turn") {
    return { ...base, type, content: requiredContent(input.content, "providerEvent.content") };
  }
  if (type === "session_start" || type === "pre_compact" || type === "session_end") {
    return { ...base, type };
  }
  throw new ValidationError(`Unsupported provider lifecycle event type: ${type}`);
}
