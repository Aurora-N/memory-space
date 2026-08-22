import type {
  SemanticExtractionConfiguration,
  SemanticModelConfiguration,
} from "../binding/project-config.ts";
import type { MemoryCandidate, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import type {
  SemanticModelResolution,
  SemanticExtractionModelEvent,
  SemanticModelResolver,
} from "../ports/semantic-extraction-model.ts";
import { SemanticExtractionModelError } from "../ports/semantic-extraction-model.ts";
import {
  parseSemanticExtractionResponse,
  semanticExtractionLimits,
  type SemanticRejectionReason,
  validateSemanticProposal,
} from "../application/semantic-extraction-policy.ts";

/** Version-one provider-neutral proposal instruction; deterministic validation remains authoritative. */
export const semanticExtractionPromptV1 = [
  "Return only a JSON object with schemaVersion 1 and candidates.",
  "Propose only durable project knowledge stated directly by the user.",
  "Each candidate content must be an exact substring of one evidence quote.",
  "Each evidence quote must be an exact substring of its referenced user event.",
  "Do not propose current actions, one-off results, guesses, hypotheticals, temporary experiments, credentials, requests, assistant-only claims, keys, tiers, operations, or Memory commands.",
  "Allowed family: knowledge, state.",
  "Allowed types: fact, decision, constraint, convention, goal, task, progress, blocker, question.",
  "Allowed assertion: direct, uncertain, hypothetical.",
  "Allowed durability: durable, interaction_local.",
].join("\n");

export type SemanticExtractionExecutionStatus = "off" | "ok" | "unavailable" | "failed";

/** Sanitized candidate rejection metadata without source content or model reasoning. */
export interface SemanticExtractionRejectedItem {
  type?: string;
  reason: SemanticRejectionReason;
  sourceEventIds: string[];
}

/** Sanitized diagnostics for one semantic extraction operation. */
export interface SemanticExtractionDiagnostic {
  operationId: string;
  status: SemanticExtractionExecutionStatus;
  backend?: "external" | "local" | "host-agent";
  adapter?: string;
  provider?: string;
  reason?: string;
  inputChars: number;
  proposedCount: number;
  groundedCount: number;
  durationMs: number;
  rejected: SemanticExtractionRejectedItem[];
}

/** Best-effort observer that cannot affect extraction or lifecycle outcomes. */
export interface SemanticExtractionDiagnosticSink {
  record(diagnostic: SemanticExtractionDiagnostic): void;
}

export interface SemanticExtractionConfigurationResolver {
  resolve(context: ExtractionContext): Promise<SemanticExtractionConfiguration>;
}

/** Sanitized configured-semantic failure used to preserve checkpoint failure semantics. */
export class SemanticExtractionError extends Error {
  readonly code: string;

  constructor(code: string, message = "Semantic extraction unavailable") {
    super(message);
    this.name = "SemanticExtractionError";
    this.code = code;
  }
}

function eventContent(event: SessionEvent): string | undefined {
  const content = event.payload.content ?? event.payload.text;
  return typeof content === "string" ? content : undefined;
}

function messageRole(event: SessionEvent): "user" | "assistant" | undefined {
  return event.payload.role === "user" || event.payload.role === "assistant"
    ? event.payload.role
    : undefined;
}

function suffixWithoutBrokenSurrogate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let start = value.length - maximum;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

/** Builds one deterministic bounded model view without mutating persisted events. */
export function buildSemanticModelEvents(
  events: readonly SessionEvent[],
  maximum: number = semanticExtractionLimits.maxInputChars
): SemanticExtractionModelEvent[] {
  const messages = events.flatMap((event) => {
    const content = eventContent(event);
    const role = messageRole(event);
    return event.type === "message" && role !== undefined && content !== undefined
      ? [{ event, role, content }]
      : [];
  });
  const latestUser = messages.findLast((item) => item.role === "user");
  const latest = messages.at(-1);
  const priority = [latestUser, latest, ...[...messages].reverse()].filter(
    (item): item is (typeof messages)[number] => item !== undefined
  );
  const selected = new Map<string, SemanticExtractionModelEvent>();
  const sequences = new Map(messages.map((item) => [item.event.id, item.event.sequence]));
  let chars = 0;
  for (const item of priority) {
    if (selected.has(item.event.id)) continue;
    const remaining = maximum - chars;
    if (remaining <= 0) break;
    const content = suffixWithoutBrokenSurrogate(item.content, remaining);
    selected.set(item.event.id, { id: item.event.id, role: item.role, content });
    chars += content.length;
  }
  return [...selected.values()].sort((left, right) => {
    const leftSequence = sequences.get(left.id) ?? 0;
    const rightSequence = sequences.get(right.id) ?? 0;
    return leftSequence - rightSequence;
  });
}

/**
 * Adds grounded semantic candidates while keeping model/runtime failures optional
 * at turn time and checkpoint-significant when semantic extraction was configured.
 */
export class SemanticMemoryExtractor implements MemoryExtractor {
  readonly configurationResolver: SemanticExtractionConfigurationResolver;
  readonly modelResolver: SemanticModelResolver<SemanticModelConfiguration>;
  readonly diagnostics?: SemanticExtractionDiagnosticSink;
  readonly now: () => number;

  constructor(options: {
    configurationResolver: SemanticExtractionConfigurationResolver;
    modelResolver: SemanticModelResolver<SemanticModelConfiguration>;
    diagnostics?: SemanticExtractionDiagnosticSink;
    now?: () => number;
  }) {
    this.configurationResolver = options.configurationResolver;
    this.modelResolver = options.modelResolver;
    this.diagnostics = options.diagnostics;
    this.now = options.now ?? Date.now;
  }

  async extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]> {
    const startedAt = this.now();
    let configuration: SemanticExtractionConfiguration;
    try {
      configuration = await this.configurationResolver.resolve(context);
    } catch {
      this.record({
        operationId: context.operationId,
        status: "failed",
        reason: "configuration_unavailable",
        inputChars: 0,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      });
      return this.failOrSkip(context, "configuration_unavailable");
    }
    if (configuration.effectiveMode !== "grounded" || !configuration.model) {
      this.record({
        operationId: context.operationId,
        status: "off",
        inputChars: 0,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      });
      return [];
    }
    if (!context.sourceEvents) {
      this.record({
        operationId: context.operationId,
        status: "failed",
        backend: configuration.model.backend,
        reason: "authoritative_source_events_missing",
        inputChars: 0,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      });
      return this.failOrSkip(context, "authoritative_source_events_missing");
    }
    const modelEvents = buildSemanticModelEvents(events);
    const inputChars = modelEvents.reduce((total, event) => total + event.content.length, 0);
    let resolution: SemanticModelResolution;
    try {
      resolution = await this.modelResolver.resolve(configuration.model, {
        sessionProvider: context.session.provider,
        timeoutMs: configuration.timeoutMs,
      });
    } catch {
      this.record({
        operationId: context.operationId,
        status: "failed",
        backend: configuration.model.backend,
        reason: "backend_resolution_failed",
        inputChars,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      });
      return this.failOrSkip(context, "backend_resolution_failed");
    }
    if (!resolution.available) {
      const diagnostic: SemanticExtractionDiagnostic = {
        operationId: context.operationId,
        status: "unavailable",
        backend: resolution.backend,
        adapter: resolution.adapter,
        provider: resolution.provider,
        reason: resolution.reason,
        inputChars,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      };
      this.record(diagnostic);
      return this.failOrSkip(context, resolution.reason);
    }

    let raw: unknown;
    try {
      raw = await resolution.model.extract({
        schemaVersion: 1,
        instruction: semanticExtractionPromptV1,
        events: modelEvents,
      });
    } catch (error) {
      const reason =
        error instanceof SemanticExtractionModelError || error instanceof SemanticExtractionError
          ? error.code
          : "model_request_failed";
      this.record({
        operationId: context.operationId,
        status: "failed",
        backend: resolution.backend,
        adapter: resolution.adapter,
        provider: resolution.provider,
        reason,
        inputChars,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [],
      });
      return this.failOrSkip(context, reason);
    }

    const response = parseSemanticExtractionResponse(raw);
    if (!response) {
      this.record({
        operationId: context.operationId,
        status: "failed",
        backend: resolution.backend,
        adapter: resolution.adapter,
        provider: resolution.provider,
        reason: "semantic_model_invalid",
        inputChars,
        proposedCount: 0,
        groundedCount: 0,
        durationMs: this.now() - startedAt,
        rejected: [{ reason: "semantic_model_invalid", sourceEventIds: [] }],
      });
      return this.failOrSkip(context, "semantic_model_invalid");
    }

    const allowedEventIds = new Set(events.map((event) => event.id));
    const sourceEvents = context.sourceEvents;
    const sourceEventsById = new Map(sourceEvents.map((event) => [event.id, event]));
    const candidates: MemoryCandidate[] = [];
    const rejected: SemanticExtractionRejectedItem[] = [];
    for (const proposal of response.candidates) {
      const decision = validateSemanticProposal({
        proposal,
        allowedEventIds,
        sourceEventsById,
      });
      if (decision.accepted) candidates.push(decision.candidate);
      else {
        rejected.push({
          type: decision.type,
          reason: decision.reason,
          sourceEventIds: decision.sourceEventIds,
        });
      }
    }
    this.record({
      operationId: context.operationId,
      status: "ok",
      backend: resolution.backend,
      adapter: resolution.adapter,
      provider: resolution.provider,
      inputChars,
      proposedCount: response.candidates.length,
      groundedCount: candidates.length,
      durationMs: this.now() - startedAt,
      rejected,
    });
    return candidates;
  }

  private failOrSkip(context: ExtractionContext, reason: string): MemoryCandidate[] {
    if (context.trigger === "checkpoint") {
      throw new SemanticExtractionError(reason);
    }
    return [];
  }

  private record(diagnostic: SemanticExtractionDiagnostic): void {
    try {
      this.diagnostics?.record(diagnostic);
    } catch {
      // Semantic diagnostics are non-authoritative and must not affect extraction.
    }
  }
}
