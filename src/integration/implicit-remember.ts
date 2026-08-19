import { decideImplicitRememberAdmission } from "../application/implicit-remember-admission.ts";
import type { ImplicitRememberMode } from "../binding/project-config.ts";
import type { Memory, MemoryCandidate, Session, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext } from "../ports/extractor.ts";
import type { SessionProjectBinding } from "../ports/session-binding.ts";
import { promptRememberDirective } from "./prompt-remember-directive.ts";

/** Observable outcome of one accepted P8 candidate commit. */
export type ImplicitRememberDisposition = "created" | "updated" | "deduplicated";

/** Sanitized identity and disposition for one committed Indexed candidate. */
export interface ImplicitRememberCommittedItem {
  memoryId: string;
  key?: string;
  type: string;
  disposition: ImplicitRememberDisposition;
}

/** Sanitized policy rejection for one extractor candidate. */
export interface ImplicitRememberRejectedItem {
  type?: string;
  reason:
    | "low_confidence"
    | "missing_user_evidence"
    | "transient_evidence"
    | "operation_not_allowed"
    | "existing_core_memory"
    | "secret_like_evidence";
}

/** Sanitized result of one bounded turn-time implicit ingestion attempt. */
export interface ImplicitRememberResult {
  configuredMode?: ImplicitRememberMode;
  effectiveMode: ImplicitRememberMode;
  bypassed: boolean;
  inspectedEventIds: string[];
  committed: ImplicitRememberCommittedItem[];
  rejected: ImplicitRememberRejectedItem[];
}

/** Trusted Session boundary and project policy for one assistant-turn ingestion attempt. */
export interface ImplicitRememberInput {
  sessionId: string;
  throughEventId: string;
  mode: ImplicitRememberMode;
  configuredMode?: ImplicitRememberMode;
}

/** Provider-neutral integration port for bounded, Indexed-only turn-time ingestion. */
export interface ImplicitRememberServicePort {
  rememberTurn(input: ImplicitRememberInput): Promise<ImplicitRememberResult>;
}

interface ImplicitRememberMemorySpace {
  getImplicitRememberUserEvidence(input: {
    sessionId: string;
    throughEventId: string;
  }): Promise<{ session: Session; event?: SessionEvent }>;
  getImplicitRememberEventWindow(input: {
    sessionId: string;
    throughEventId: string;
    requiredUserEventId?: string;
    maxEvents: number;
    maxInputChars: number;
  }): Promise<{ session: Session; events: SessionEvent[] }>;
  extractMemoryCandidates(
    events: SessionEvent[],
    context: ExtractionContext
  ): Promise<MemoryCandidate[]>;
  findActiveMemoryByNormalizedKey(spaceId: string, key: string): Promise<Memory | undefined>;
  getMemory(id: string): Promise<Memory>;
  getSessionProjectBinding(sessionId: string): Promise<SessionProjectBinding | undefined>;
  commitImplicitCandidate(input: {
    sessionId: string;
    candidate: MemoryCandidate;
    inspectedEventIds: string[];
  }): Promise<{
    memory: Memory;
    disposition: ImplicitRememberDisposition;
  }>;
}

/** Fixed work bounds for one persisted-event implicit remember attempt. */
export interface ImplicitRememberOptions {
  maxEventsPerImplicitRemember?: number;
  maxInputCharsPerImplicitRemember?: number;
}

/** P8 v1 event-count and UTF-16 input-character limits. */
export const implicitRememberDefaults = Object.freeze({
  maxEventsPerImplicitRemember: 32,
  maxInputCharsPerImplicitRemember: 24_000,
});

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

/** Runs deterministic extraction and conservative Indexed-only admission over persisted events. */
export class ImplicitRememberService implements ImplicitRememberServicePort {
  readonly memorySpace: ImplicitRememberMemorySpace;
  readonly maxEvents: number;
  readonly maxInputChars: number;

  constructor(memorySpace: ImplicitRememberMemorySpace, options: ImplicitRememberOptions = {}) {
    this.memorySpace = memorySpace;
    this.maxEvents = positiveInteger(
      options.maxEventsPerImplicitRemember,
      implicitRememberDefaults.maxEventsPerImplicitRemember,
      "maxEventsPerImplicitRemember"
    );
    this.maxInputChars = positiveInteger(
      options.maxInputCharsPerImplicitRemember,
      implicitRememberDefaults.maxInputCharsPerImplicitRemember,
      "maxInputCharsPerImplicitRemember"
    );
  }

  async rememberTurn(input: ImplicitRememberInput): Promise<ImplicitRememberResult> {
    const base: ImplicitRememberResult = {
      configuredMode: input.configuredMode,
      effectiveMode: input.mode,
      bypassed: false,
      inspectedEventIds: [],
      committed: [],
      rejected: [],
    };
    if (input.mode === "off") return base;
    const userEvidence = await this.memorySpace.getImplicitRememberUserEvidence({
      sessionId: input.sessionId,
      throughEventId: input.throughEventId,
    });
    const prompt = userEvidence.event?.payload.content ?? userEvidence.event?.payload.text;
    if (typeof prompt === "string" && promptRememberDirective(prompt) === "disable_for_turn") {
      return { ...base, bypassed: true };
    }
    const window = await this.memorySpace.getImplicitRememberEventWindow({
      sessionId: input.sessionId,
      throughEventId: input.throughEventId,
      requiredUserEventId: userEvidence.event?.id,
      maxEvents: this.maxEvents,
      maxInputChars: this.maxInputChars,
    });
    base.inspectedEventIds = window.events.map((event) => event.id);
    const projectBinding = await this.memorySpace.getSessionProjectBinding(window.session.id);
    const candidates = await this.memorySpace.extractMemoryCandidates(window.events, {
      session: window.session,
      trigger: "implicit_remember",
      operationId: `implicit:${window.session.id}:${input.throughEventId}`,
      projectBinding,
    });
    const eventsById = new Map(window.events.map((event) => [event.id, event]));
    for (const candidate of candidates) {
      const existing = candidate.targetMemoryId
        ? await this.memorySpace.getMemory(candidate.targetMemoryId)
        : candidate.key
          ? await this.memorySpace.findActiveMemoryByNormalizedKey(
              window.session.spaceId,
              candidate.key
            )
          : undefined;
      const decision = decideImplicitRememberAdmission({
        candidate,
        eventsById,
        existing,
      });
      if (!decision.accepted) {
        base.rejected.push({ type: candidate.type, reason: decision.reason });
        continue;
      }
      if (candidate.operation === "ignore") continue;
      const committed = await this.memorySpace.commitImplicitCandidate({
        sessionId: window.session.id,
        candidate: { ...candidate, recommendedTier: "indexed" },
        inspectedEventIds: base.inspectedEventIds,
      });
      base.committed.push({
        memoryId: committed.memory.id,
        key: committed.memory.key,
        type: committed.memory.type,
        disposition: committed.disposition,
      });
    }
    return base;
  }
}
