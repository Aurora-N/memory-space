import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type {
  CandidateOperation,
  Checkpoint,
  HandoffSnapshot,
  Memory,
  MemoryCandidate,
  MemoryFamily,
  MemorySearchInput,
  MemorySearchResult,
  MemoryStatus,
  MemoryTier,
  Session,
  SessionEvent,
  SessionEventType,
  Space,
} from "../domain/types.ts";
import type { CachePort } from "../ports/cache.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import type {
  SessionProjectBinding,
  SessionProjectBindingSource,
} from "../ports/session-binding.ts";
import type { MemoryHistoryRecord, MemoryStore } from "../ports/store.ts";
import {
  type CoreAdmissionReason,
  decideCoreAdmission,
  hasEffectiveExplicitPromotion,
  isCoreEligible,
  PROMOTION_OPERATION,
} from "./core-admission-policy.ts";
import { buildHandoffProjection } from "./handoff-policy.ts";
import {
  compareLexicalResults,
  normalizeLexicalText,
  scoreLexicalMemory,
} from "./lexical-retrieval.ts";
import { memoryCandidateFingerprint } from "./memory-candidate-fingerprint.ts";

const families = new Set<MemoryFamily>(["knowledge", "state", "episode", "procedure"]);
const tiers = new Set<MemoryTier>(["core", "indexed"]);
const statuses = new Set<MemoryStatus>(["active", "resolved", "superseded", "archived"]);
const eventTypes = new Set<SessionEventType>([
  "message",
  "tool_call",
  "artifact",
  "memory",
  "custom",
]);
const operations = new Set<CandidateOperation>(["create", "update", "supersede", "ignore"]);
const sections = [
  "Goal",
  "Current Roadmap",
  "Current Progress",
  "Active Tasks",
  "Decisions",
  "Constraints / Conventions",
  "Blockers",
  "Open Questions",
] as const;
type Section = (typeof sections)[number];

/** Input for creating an isolated Space; omitted IDs are generated. */
export interface CreateSpaceInput {
  id?: string;
  name: string;
  description?: string;
}
/** Input for creating a Session permanently bound to an existing Space. */
export interface CreateSessionInput {
  id?: string;
  spaceId: string;
  agentId?: string;
  provider?: string;
  externalSessionId?: string;
  summary?: string;
}
/** Idempotent provider identity used to get or create one durable Session. */
export interface ProviderSessionInput {
  id?: string;
  spaceId: string;
  provider: string;
  externalSessionId: string;
  agentId?: string;
}
/** Trusted binding provenance supplied only by lifecycle integration. */
export interface SessionProjectBindingInput {
  source: SessionProjectBindingSource;
  configPath?: string;
}
/** Input for appending one immutable event to a Session. */
export interface AppendEventInput {
  id?: string;
  sessionId: string;
  type: SessionEventType;
  payload: Record<string, unknown>;
  createdAt?: string;
}
/** Explicit memory write that cannot request a tier, with optional validated Session provenance. */
export interface RememberInput {
  spaceId: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceEventIds?: string[];
}
/** Idempotent checkpoint request through an optional explicit event boundary. */
export interface CheckpointInput {
  sessionId: string;
  toEventId?: string;
  idempotencyKey: string;
}
/** Bounded persisted evidence selected for one implicit-remember turn. */
export interface ImplicitRememberEventWindow {
  session: Session;
  events: SessionEvent[];
}
/** One extractor candidate admitted for an Indexed-only implicit commit. */
export interface CommitImplicitCandidateInput {
  sessionId: string;
  candidate: MemoryCandidate;
  inspectedEventIds: string[];
}
/** Memory identity and mutation outcome from one transactional P8 candidate commit. */
export interface CommitImplicitCandidateResult {
  memory: Memory;
  disposition: "created" | "updated" | "deduplicated";
}
/** Deterministic startup context assembled from Core Memory and the latest Handoff. */
export interface BootstrapResult {
  space: Space;
  coreMemories: Memory[];
  handoffSnapshot?: HandoffSnapshot;
  context: string;
}
/** Ranked recall results plus their provider-neutral rendered context. */
export interface ContextResult {
  query: string;
  results: MemorySearchResult[];
  rendered: string;
}
/** Deterministic cursor-based browse query over one Space. */
export interface BrowseMemoriesInput {
  spaceId: string;
  families?: MemoryFamily[];
  types?: string[];
  tiers?: MemoryTier[];
  statuses?: MemoryStatus[];
  limit?: number;
  cursor?: string;
}
/** Browse page sorted by recency, with an opaque continuation cursor when available. */
export interface BrowseMemoriesResult {
  items: Memory[];
  total: number;
  nextCursor?: string;
}
/** Read-only aggregate summary for the local Inspector. */
export interface MemoryOverviewResult {
  space: Space;
  totalMemories: number;
  counts: {
    tiers: Record<string, number>;
    statuses: Record<string, number>;
    families: Record<string, number>;
    types: Record<string, number>;
  };
  recentMemories: Memory[];
  latestHandoff?: HandoffSnapshot;
}

interface ValidatedMemory {
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
  tier: MemoryTier;
  status: MemoryStatus;
  importance: number;
  confidence: number;
}

interface CommitInput extends ValidatedMemory {
  spaceId: string;
  sourceSessionId?: string;
  sourceAgentId?: string;
  sourceEventIds: string[];
  operation: CandidateOperation;
  targetMemoryId?: string;
  reason?: string;
  admissionReason?: CoreAdmissionReason;
}

function timestamp(): string {
  return new Date().toISOString();
}

function boundedContentSuffix(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let start = value.length - maxChars;
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

function boundEventContent(event: SessionEvent, maxChars: number): SessionEvent {
  const field =
    typeof event.payload.content === "string"
      ? "content"
      : typeof event.payload.text === "string"
        ? "text"
        : undefined;
  if (!field) return event;
  const content = event.payload[field] as string;
  const bounded = boundedContentSuffix(content, maxChars);
  return bounded === content
    ? event
    : {
        ...event,
        payload: { ...event.payload, [field]: bounded },
      };
}

function compareRecentlyUpdated(a: Memory, b: Memory): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

function countBy(memories: Memory[], value: (memory: Memory) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const memory of memories) counts.set(value(memory), (counts.get(value(memory)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function encodeBrowseCursor(memory: Memory): string {
  return Buffer.from(
    JSON.stringify({ updatedAt: memory.updatedAt, id: memory.id }),
    "utf8"
  ).toString("base64url");
}

function decodeBrowseCursor(value: string): { updatedAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.updatedAt !== "string" ||
      typeof cursor.id !== "string" ||
      cursor.updatedAt === "" ||
      cursor.id === ""
    )
      throw new Error("invalid");
    return { updatedAt: cursor.updatedAt, id: cursor.id };
  } catch {
    throw new ValidationError("browse cursor is invalid");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, label);
}

function score(value: unknown, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > 1) {
    throw new ValidationError(`${label} must be a finite number between 0 and 1`);
  }
  return result;
}

function optionalIsoDateTime(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const input = requiredString(value, label);
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new ValidationError(`${label} must be a valid date-time`);
  return new Date(parsed).toISOString();
}

function validateSessionProjectBinding(
  value: SessionProjectBindingInput | undefined
): SessionProjectBindingInput | undefined {
  if (value === undefined) return undefined;
  if (value.source === "config") {
    return {
      source: value.source,
      configPath: requiredString(value.configPath, "projectBinding.configPath"),
    };
  }
  if (value.source === "explicit") {
    if (value.configPath !== undefined) {
      throw new ValidationError("Explicit project binding cannot include configPath");
    }
    return { source: value.source };
  }
  throw new ValidationError("projectBinding.source must be config or explicit");
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "(none)";
}
function summary(memory: Memory): string {
  return memory.key
    ? `[${memory.id}] (${memory.key}) ${memory.content}`
    : `[${memory.id}] ${memory.content}`;
}

function sectionFor(memory: Memory): Section {
  const mapping: Record<string, Section> = {
    goal: "Goal",
    roadmap: "Current Roadmap",
    progress: "Current Progress",
    task: "Active Tasks",
    decision: "Decisions",
    fact: "Decisions",
    constraint: "Constraints / Conventions",
    convention: "Constraints / Conventions",
    rule: "Constraints / Conventions",
    instruction: "Constraints / Conventions",
    blocker: "Blockers",
    question: "Open Questions",
  };
  return (
    mapping[memory.type] ??
    (memory.family === "knowledge"
      ? "Decisions"
      : memory.family === "procedure"
        ? "Constraints / Conventions"
        : "Current Progress")
  );
}

/**
 * Application facade for all Memory Space operations.
 * Delivery layers share one instance; durable writes complete before methods return.
 */
export class MemorySpace {
  readonly store: MemoryStore;
  readonly extractor: MemoryExtractor;
  readonly cache: CachePort;
  readonly coreLimit: number;
  readonly #inFlightCheckpoints = new Map<string, Promise<Checkpoint>>();

  constructor(options: {
    store: MemoryStore;
    extractor: MemoryExtractor;
    cache: CachePort;
    coreLimit?: number;
  }) {
    this.store = options.store;
    this.extractor = options.extractor;
    this.cache = options.cache;
    this.coreLimit = options.coreLimit ?? 64;
    if (!Number.isInteger(this.coreLimit) || this.coreLimit < 1) {
      throw new ValidationError("coreLimit must be a positive integer");
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async createSpace(input: CreateSpaceInput): Promise<Space> {
    const now = timestamp();
    const space: Space = {
      id: optionalString(input.id, "space.id") ?? randomUUID(),
      name: requiredString(input.name, "space.name"),
      description: optionalString(input.description, "space.description"),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.insertSpace(space);
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new ConflictError(`Space already exists: ${space.id}`);
      throw error;
    }
    return space;
  }

  async getSpace(id: string): Promise<Space> {
    const value = await this.store.findSpace(requiredString(id, "spaceId"));
    if (!value) throw new NotFoundError("Space", id);
    return value;
  }

  async createSession(
    input: CreateSessionInput,
    projectBindingInput?: SessionProjectBindingInput
  ): Promise<Session> {
    const space = await this.getSpace(input.spaceId);
    const projectBinding = validateSessionProjectBinding(projectBindingInput);
    const now = timestamp();
    const session: Session = {
      id: optionalString(input.id, "session.id") ?? randomUUID(),
      spaceId: space.id,
      agentId: optionalString(input.agentId, "session.agentId"),
      provider: optionalString(input.provider, "session.provider"),
      externalSessionId: optionalString(input.externalSessionId, "session.externalSessionId"),
      summary: optionalString(input.summary, "session.summary"),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.transaction(async () => {
      await this.store.insertSession(session);
      if (projectBinding) {
        await this.store.insertSessionProjectBinding({
          sessionId: session.id,
          spaceId: session.spaceId,
          ...projectBinding,
        });
      }
    });
    return session;
  }

  async getSession(id: string): Promise<Session> {
    const value = await this.store.findSession(requiredString(id, "sessionId"));
    if (!value) throw new NotFoundError("Session", id);
    return value;
  }

  async getOrCreateProviderSession(
    input: ProviderSessionInput,
    projectBindingInput?: SessionProjectBindingInput
  ): Promise<Session> {
    const space = await this.getSpace(input.spaceId);
    const projectBinding = validateSessionProjectBinding(projectBindingInput);
    const provider = requiredString(input.provider, "provider");
    const externalSessionId = requiredString(input.externalSessionId, "externalSessionId");
    const now = timestamp();
    const candidate: Session = {
      id: optionalString(input.id, "session.id") ?? randomUUID(),
      spaceId: space.id,
      provider,
      externalSessionId,
      agentId: optionalString(input.agentId, "session.agentId"),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.transaction(async () => {
      const session = (await this.store.getOrCreateProviderSession(candidate)).session;
      if (session.spaceId !== space.id) {
        throw new ConflictError(
          `Provider Session ${provider}:${externalSessionId} is bound to Space ${session.spaceId}, not ${space.id}`,
          "PROVIDER_SESSION_SPACE_CONFLICT"
        );
      }
      if (projectBinding) {
        await this.store.insertSessionProjectBinding({
          sessionId: session.id,
          spaceId: session.spaceId,
          ...projectBinding,
        });
      }
      return session;
    });
  }

  async findProviderSession(
    provider: string,
    externalSessionId: string
  ): Promise<Session | undefined> {
    return this.store.findSessionByProviderIdentity(
      requiredString(provider, "provider"),
      requiredString(externalSessionId, "externalSessionId")
    );
  }

  /** Lists Sessions for one trusted Space in deterministic recency order. */
  async listSessions(spaceId: string): Promise<Session[]> {
    const space = await this.getSpace(spaceId);
    return this.store.listSessions(space.id);
  }

  async appendEvent(input: AppendEventInput): Promise<SessionEvent> {
    const session = await this.getSession(input.sessionId);
    if (!eventTypes.has(input.type))
      throw new ValidationError(`Unsupported event.type: ${input.type}`);
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new ValidationError("event.payload must be an object");
    }
    const event = await this.store.insertEvent({
      id: optionalString(input.id, "event.id") ?? randomUUID(),
      sessionId: session.id,
      type: input.type,
      payload: input.payload,
      createdAt: optionalIsoDateTime(input.createdAt, "event.createdAt") ?? timestamp(),
    });
    await this.store.updateSession({ ...session, updatedAt: timestamp() });
    return event;
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    await this.getSession(sessionId);
    return this.store.listEvents(sessionId);
  }

  async getLatestSessionEvent(sessionId: string): Promise<SessionEvent | undefined> {
    const session = await this.getSession(sessionId);
    return this.store.findLatestEvent(session.id);
  }

  async getSessionProjectBinding(sessionId: string): Promise<SessionProjectBinding | undefined> {
    const session = await this.getSession(sessionId);
    return this.store.findSessionProjectBinding(session.id);
  }

  async getImplicitRememberEventWindow(input: {
    sessionId: string;
    throughEventId: string;
    maxEvents: number;
    maxInputChars: number;
  }): Promise<ImplicitRememberEventWindow> {
    const session = await this.getSession(input.sessionId);
    if (!Number.isInteger(input.maxEvents) || input.maxEvents < 1) {
      throw new ValidationError("maxEvents must be a positive integer");
    }
    if (!Number.isInteger(input.maxInputChars) || input.maxInputChars < 1) {
      throw new ValidationError("maxInputChars must be a positive integer");
    }
    const throughEvent = await this.#sessionEvent(session.id, input.throughEventId);
    const fromEvent = session.lastCheckpointEventId
      ? await this.#sessionEvent(session.id, session.lastCheckpointEventId)
      : undefined;
    if (throughEvent.sequence <= (fromEvent?.sequence ?? 0)) {
      throw new ValidationError("throughEventId must be after the checkpoint boundary");
    }
    const recent = await this.store.listRecentEvents(
      session.id,
      fromEvent?.sequence ?? 0,
      throughEvent.sequence,
      input.maxEvents
    );
    const selected: SessionEvent[] = [];
    let chars = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const event = recent[index];
      if (!event) continue;
      const content = event.payload.content ?? event.payload.text;
      const eventChars = typeof content === "string" ? content.length : 0;
      const remaining = input.maxInputChars - chars;
      if (remaining <= 0) break;
      selected.push(boundEventContent(event, remaining));
      chars += Math.min(eventChars, remaining);
      if (chars >= input.maxInputChars) break;
    }
    selected.reverse();
    return { session, events: selected };
  }

  async extractMemoryCandidates(
    events: SessionEvent[],
    context: ExtractionContext
  ): Promise<MemoryCandidate[]> {
    const candidates = await this.extractor.extract(events, context);
    if (!Array.isArray(candidates)) {
      throw new ValidationError("Extractor must return a MemoryCandidate array");
    }
    return candidates;
  }

  async findActiveMemoryByNormalizedKey(spaceId: string, key: string): Promise<Memory | undefined> {
    const space = await this.getSpace(requiredString(spaceId, "spaceId"));
    const candidate = requiredString(key, "memory.key");
    const normalizedCandidate = normalizeLexicalText(candidate);
    const rawMatch = await this.store.findActiveMemoryByKey(space.id, candidate);
    if (rawMatch && normalizeLexicalText(rawMatch.key ?? "") === normalizedCandidate) {
      return rawMatch;
    }
    const active = await this.store.listMemories({
      spaceId: space.id,
      statuses: ["active"],
    });
    return active.find(
      (memory) =>
        memory.key !== undefined && normalizeLexicalText(memory.key) === normalizedCandidate
    );
  }

  async commitImplicitCandidate(
    input: CommitImplicitCandidateInput
  ): Promise<CommitImplicitCandidateResult> {
    const session = await this.getSession(input.sessionId);
    const eventIds = new Set(input.inspectedEventIds);
    const candidate = this.#validateCandidate(input.candidate, 0, eventIds);
    if (candidate.operation === "ignore" || candidate.operation === "supersede") {
      throw new ValidationError("Implicit remember candidate must be create or update");
    }
    const result = await this.store.transaction(async () => {
      const fingerprint = memoryCandidateFingerprint(session.id, candidate);
      const receipt = await this.store.findMemoryCandidateCommitReceipt(session.id, fingerprint);
      if (receipt) {
        return {
          memory: await this.getMemory(receipt.memoryId),
          disposition: "deduplicated" as const,
        };
      }
      const existing = candidate.targetMemoryId
        ? await this.getMemory(candidate.targetMemoryId)
        : candidate.key
          ? await this.findActiveMemoryByNormalizedKey(session.spaceId, candidate.key)
          : undefined;
      if (existing?.tier === "core") {
        throw new ConflictError(
          "Implicit remember cannot mutate existing Core Memory",
          "IMPLICIT_REMEMBER_CORE_TARGET"
        );
      }
      const beforeVersion = existing?.version;
      const memory = await this.#commitMemory(
        {
          ...candidate,
          spaceId: session.spaceId,
          sourceSessionId: session.id,
          sourceAgentId: session.agentId,
          tier: "indexed",
          admissionReason: "not-recommended",
          reason: "implicit remember",
        },
        "implicit"
      );
      await this.store.insertMemoryCandidateCommitReceipt({
        id: randomUUID(),
        sessionId: session.id,
        fingerprint,
        memoryId: memory.id,
        firstCommitSource: "implicit",
        sourceEventIds: [...new Set(candidate.sourceEventIds)].sort(),
        createdAt: timestamp(),
      });
      return {
        memory,
        disposition:
          existing === undefined
            ? ("created" as const)
            : beforeVersion === memory.version
              ? ("deduplicated" as const)
              : ("updated" as const),
      };
    });
    await this.#safeInvalidate(session.spaceId);
    return result;
  }

  async remember(input: RememberInput): Promise<Memory> {
    if ("tier" in input) {
      throw new ValidationError(
        "memory.remember does not accept tier; use promote() after remember()"
      );
    }
    const space = await this.getSpace(input.spaceId);
    const validated = this.#validateMemory(input);
    let session: Session | undefined;
    if (input.sourceSessionId) {
      session = await this.getSession(input.sourceSessionId);
      if (session.spaceId !== space.id)
        throw new ValidationError("sourceSessionId must belong to memory.spaceId");
    }
    const sourceEventIds = input.sourceEventIds ?? [];
    if (sourceEventIds.length > 0) {
      if (!session) {
        throw new ValidationError(
          "sourceEventIds require sourceSessionId for provenance validation"
        );
      }
      for (const eventId of sourceEventIds) await this.#sessionEvent(session.id, eventId);
    }
    const memory = await this.store.transaction(() =>
      this.#commitMemory(
        {
          ...validated,
          spaceId: space.id,
          sourceSessionId: session?.id,
          sourceAgentId: input.sourceAgentId ?? session?.agentId,
          sourceEventIds,
          operation: validated.key ? "update" : "create",
          reason: "explicit remember",
        },
        "explicit"
      )
    );
    await this.#safeInvalidate(space.id);
    return memory;
  }

  async getMemory(id: string): Promise<Memory> {
    const value = await this.store.findMemory(requiredString(id, "memoryId"));
    if (!value) throw new NotFoundError("Memory", id);
    return value;
  }

  async getMemoryHistory(id: string): Promise<MemoryHistoryRecord[]> {
    await this.getMemory(id);
    return this.store.listMemoryHistory(id);
  }

  async browseMemories(input: BrowseMemoriesInput): Promise<BrowseMemoriesResult> {
    await this.getSpace(input.spaceId);
    const limit = input.limit ?? 50;
    this.#validateFilters({ ...input, query: "", limit });
    const memories = (
      await this.store.listMemories({
        spaceId: input.spaceId,
        families: input.families,
        types: input.types,
        tiers: input.tiers,
        statuses: input.statuses,
      })
    ).sort(compareRecentlyUpdated);
    const cursor = input.cursor === undefined ? undefined : decodeBrowseCursor(input.cursor);
    const pageStart =
      cursor === undefined
        ? 0
        : memories.findIndex(
            (memory) =>
              memory.updatedAt < cursor.updatedAt ||
              (memory.updatedAt === cursor.updatedAt && memory.id < cursor.id)
          );
    const start = pageStart < 0 ? memories.length : pageStart;
    const items = memories.slice(start, start + limit);
    const hasMore = start + items.length < memories.length;
    const lastItem = items.at(-1);
    return {
      items,
      total: memories.length,
      nextCursor: hasMore && lastItem ? encodeBrowseCursor(lastItem) : undefined,
    };
  }

  async overview(spaceId: string): Promise<MemoryOverviewResult> {
    const space = await this.getSpace(spaceId);
    const memories = (await this.store.listMemories({ spaceId })).sort(compareRecentlyUpdated);
    const latestHandoff = await this.store.findLatestHandoff(spaceId);
    return {
      space,
      totalMemories: memories.length,
      counts: {
        tiers: countBy(memories, (memory) => memory.tier),
        statuses: countBy(memories, (memory) => memory.status),
        families: countBy(memories, (memory) => memory.family),
        types: countBy(memories, (memory) => memory.type),
      },
      recentMemories: memories.slice(0, 8),
      latestHandoff,
    };
  }

  async promote(
    memoryId: string,
    options: { reason?: string; actor?: "user" | "agent" } = {}
  ): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (memory.status !== "active")
      throw new ConflictError("Only active memory can be promoted", "MEMORY_NOT_ACTIVE");
    if (memory.tier === "core") return memory;
    const actor = options.actor ?? "agent";
    if (actor === "agent") {
      requiredString(options.reason, "promotion reason");
      if (!isCoreEligible(memory)) {
        throw new ConflictError(
          "Memory is not deterministically eligible for agent promotion",
          "PROMOTION_REJECTED"
        );
      }
    }
    const result = await this.store.transaction(() =>
      this.#changeTier(
        memory,
        "core",
        options.reason ?? "user requested promotion",
        actor === "agent" ? PROMOTION_OPERATION.explicitAgent : PROMOTION_OPERATION.explicitUser
      )
    );
    await this.#safeInvalidate(memory.spaceId);
    return result;
  }

  async demote(memoryId: string, options: { reason?: string } = {}): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (memory.tier === "indexed") return memory;
    const result = await this.store.transaction(() =>
      this.#changeTier(memory, "indexed", options.reason ?? "explicit demotion")
    );
    await this.#safeInvalidate(memory.spaceId);
    return result;
  }

  async setMemoryStatus(
    memoryId: string,
    status: MemoryStatus,
    options: { reason?: string } = {}
  ): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (!statuses.has(status)) throw new ValidationError(`Unsupported memory status: ${status}`);
    const tier = status === "active" ? memory.tier : "indexed";
    if (memory.status === status && memory.tier === tier) return memory;
    const updated = {
      ...memory,
      status,
      tier,
      version: memory.version + 1,
      updatedAt: timestamp(),
    };
    await this.store.transaction(async () => {
      await this.store.updateMemory(updated);
      await this.#history(updated.id, "status", memory, updated, options.reason);
    });
    await this.#safeInvalidate(memory.spaceId);
    return updated;
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    await this.getSpace(input.spaceId);
    this.#validateFilters(input);
    const memories = await this.store.listMemories({
      spaceId: input.spaceId,
      families: input.families,
      types: input.types,
      tiers: input.tiers,
      statuses: input.statuses ?? ["active"],
    });
    const query = input.query ?? "";
    const matches = memories.map((memory) => {
      if (query.trim() === "") {
        return {
          memory,
          score: 1,
          canonicalSlotConflict: false,
          strongExact: false,
          keyContentMatchedTokens: [] as string[],
          unresolvedQueryTokens: [] as string[],
        };
      }
      const match = scoreLexicalMemory(query, memory);
      return {
        memory,
        score: match.relevant ? match.score : 0,
        canonicalSlotConflict: match.canonicalSlotConflict,
        strongExact: match.exactKey || match.exactContentPhrase,
        keyContentMatchedTokens: match.keyContentMatchedTokens,
        unresolvedQueryTokens: match.unresolvedQueryTokens,
      };
    });
    const hasUnsupportedCanonicalConflict = matches.some(
      (candidate) =>
        candidate.canonicalSlotConflict &&
        candidate.unresolvedQueryTokens.some(
          (unresolvedToken) =>
            !matches.some(
              (support) =>
                support.memory.id !== candidate.memory.id &&
                support.score > 0 &&
                support.keyContentMatchedTokens.includes(unresolvedToken)
            )
        )
    );
    if (
      query.trim() !== "" &&
      !matches.some((match) => match.strongExact) &&
      hasUnsupportedCanonicalConflict
    )
      return [];
    const results = matches
      .filter((result) => query.trim() === "" || result.score > 0)
      .map(({ memory, score }) => ({ memory, score }));
    results.sort(compareLexicalResults);
    return results.slice(0, input.limit ?? 20);
  }

  async findActiveIndexedMemoryByNormalizedKey(
    spaceId: string,
    key: string
  ): Promise<Memory | undefined> {
    const match = await this.findActiveMemoryByNormalizedKey(spaceId, key);
    return match?.tier === "indexed" ? match : undefined;
  }

  async context(input: MemorySearchInput): Promise<ContextResult> {
    const results = await this.search(input);
    const rendered = [
      `# Memory Context: ${input.query ?? ""}`,
      "",
      results.length
        ? results
            .map(({ memory }) =>
              [
                `## ${memory.type}: ${memory.key ?? memory.id}`,
                memory.content,
                `Memory: ${memory.id} | Tier: ${memory.tier} | Source session: ${memory.sourceSessionId ?? "unknown"}`,
              ].join("\n")
            )
            .join("\n\n")
        : "(no relevant memory)",
    ].join("\n");
    return { query: input.query ?? "", results, rendered };
  }

  async bootstrap(spaceId: string): Promise<BootstrapResult> {
    const cacheKey = `bootstrap:${spaceId}`;
    const cached = await this.#safeCacheGet<BootstrapResult>(cacheKey);
    if (cached) return cached;
    const space = await this.getSpace(spaceId);
    const coreMemories = (
      await this.store.listMemories({
        spaceId,
        tiers: ["core"],
        statuses: ["active"],
      })
    ).sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        (a.key ?? "").localeCompare(b.key ?? "") ||
        a.id.localeCompare(b.id)
    );
    const handoffSnapshot = await this.store.findLatestHandoff(spaceId);
    const lines = ["# Space Context"];
    for (const section of sections) {
      lines.push(
        "",
        `## ${section}`,
        list(coreMemories.filter((memory) => sectionFor(memory) === section).map(summary))
      );
    }
    const handoff = handoffSnapshot
      ? [
          handoffSnapshot.goal ? `Goal: ${handoffSnapshot.goal}` : "",
          ...handoffSnapshot.completed.map((value) => `Completed: ${value}`),
          ...handoffSnapshot.activeTasks.map((value) => `Active task: ${value}`),
          ...handoffSnapshot.decisions.map((value) => `Decision: ${value}`),
          ...handoffSnapshot.blockers.map((value) => `Blocker: ${value}`),
          ...handoffSnapshot.openQuestions.map((value) => `Open question: ${value}`),
          ...handoffSnapshot.nextSteps.map((value) => `Next step: ${value}`),
        ].filter(Boolean)
      : [];
    lines.push("", "## Latest Handoff", list(handoff));
    const result = { space, coreMemories, handoffSnapshot, context: lines.join("\n") };
    await this.#safeCacheSet(cacheKey, result, 60);
    return result;
  }

  async checkpoint(input: CheckpointInput): Promise<Checkpoint> {
    const session = await this.getSession(input.sessionId);
    const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");
    const operationKey = `${session.id}:${idempotencyKey}`;
    const activeOperation = this.#inFlightCheckpoints.get(operationKey);
    if (activeOperation) {
      const result = await activeOperation;
      this.#assertCheckpointIdentity(input.toEventId, result);
      return result;
    }
    const operation = this.#executeCheckpoint(session, input, idempotencyKey);
    this.#inFlightCheckpoints.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlightCheckpoints.get(operationKey) === operation) {
        this.#inFlightCheckpoints.delete(operationKey);
      }
    }
  }

  async #executeCheckpoint(
    session: Session,
    input: CheckpointInput,
    idempotencyKey: string
  ): Promise<Checkpoint> {
    let existing = await this.store.findCheckpointByIdempotency(session.id, idempotencyKey);
    if (existing?.status === "completed") {
      this.#assertCheckpointIdentity(input.toEventId, existing);
      return existing;
    }
    const fromEvent = session.lastCheckpointEventId
      ? await this.#sessionEvent(session.id, session.lastCheckpointEventId)
      : undefined;
    if (existing) this.#assertCheckpointIdentity(input.toEventId, existing);
    const resolvedToEventId = input.toEventId ?? existing?.toEventId;
    const toEvent = resolvedToEventId
      ? await this.#sessionEvent(session.id, resolvedToEventId)
      : await this.store.findLatestEvent(session.id);
    if (!toEvent) throw new ValidationError("Cannot checkpoint a session with no events");
    if (toEvent.sequence <= (fromEvent?.sequence ?? 0)) {
      throw new ValidationError(
        "toEventId must be after the previous successful checkpoint boundary"
      );
    }
    const events = await this.store.listEvents(
      session.id,
      fromEvent?.sequence ?? 0,
      toEvent.sequence
    );
    let checkpoint: Checkpoint = existing
      ? {
          ...existing,
          fromEventId: session.lastCheckpointEventId,
          toEventId: toEvent.id,
          status: "processing",
          handoffSnapshotId: undefined,
          error: undefined,
          completedAt: undefined,
        }
      : {
          id: randomUUID(),
          spaceId: session.spaceId,
          sessionId: session.id,
          fromEventId: session.lastCheckpointEventId,
          toEventId: toEvent.id,
          idempotencyKey,
          status: "processing",
          createdAt: timestamp(),
        };
    if (existing) {
      await this.store.updateCheckpoint(checkpoint);
    } else {
      const claimed = await this.store.getOrCreateCheckpoint(checkpoint);
      checkpoint = claimed.checkpoint;
      if (!claimed.created) {
        existing = claimed.checkpoint;
        this.#assertCheckpointIdentity(input.toEventId ?? toEvent.id, existing);
        if (existing.status === "completed") return existing;
        checkpoint = {
          ...existing,
          fromEventId: session.lastCheckpointEventId,
          status: "processing",
          handoffSnapshotId: undefined,
          error: undefined,
          completedAt: undefined,
        };
        await this.store.updateCheckpoint(checkpoint);
      }
    }

    let candidates: unknown[] = [];
    let completed: Checkpoint;
    try {
      const projectBinding = await this.store.findSessionProjectBinding(session.id);
      candidates = await this.extractor.extract(events, {
        session,
        trigger: "checkpoint",
        operationId: checkpoint.id,
        checkpointId: checkpoint.id,
        projectBinding,
      });
      if (!Array.isArray(candidates))
        throw new ValidationError("Extractor must return a MemoryCandidate array");
      const eventIds = new Set(events.map((event) => event.id));
      const normalized = candidates.map((candidate, index) =>
        this.#validateCandidate(candidate, index, eventIds)
      );
      completed = await this.store.transaction(async () => {
        const currentSession = await this.getSession(session.id);
        if (currentSession.lastCheckpointEventId !== session.lastCheckpointEventId) {
          throw new ConflictError(
            "Checkpoint boundary changed while processing",
            "STALE_CHECKPOINT_BOUNDARY"
          );
        }
        for (const candidate of normalized) {
          if (candidate.operation !== "ignore") {
            const admission = decideCoreAdmission(candidate);
            const fingerprint = memoryCandidateFingerprint(session.id, candidate);
            const receipt = await this.store.findMemoryCandidateCommitReceipt(
              session.id,
              fingerprint
            );
            const memory = await this.#commitMemory(
              {
                ...candidate,
                targetMemoryId: receipt?.memoryId ?? candidate.targetMemoryId,
                spaceId: session.spaceId,
                sourceSessionId: session.id,
                sourceAgentId: session.agentId,
                tier: admission.tier,
                admissionReason: admission.reason,
                reason: candidate.promoteReason ?? "checkpoint extraction",
              },
              "extractor"
            );
            if (!receipt) {
              await this.store.insertMemoryCandidateCommitReceipt({
                id: randomUUID(),
                sessionId: session.id,
                fingerprint,
                memoryId: memory.id,
                firstCommitSource: "checkpoint",
                sourceEventIds: [...new Set(candidate.sourceEventIds)].sort(),
                createdAt: timestamp(),
              });
            }
          }
        }
        await this.store.replaceCandidates(
          checkpoint.id,
          normalized.map((candidate) => ({
            candidate,
            accepted: candidate.operation !== "ignore",
            rejectionReason:
              candidate.operation === "ignore" ? "extractor ignored candidate" : undefined,
          }))
        );
        const snapshot = await this.#buildSnapshot(session, checkpoint.id);
        await this.store.insertHandoff(snapshot);
        const completedAt = timestamp();
        const done: Checkpoint = {
          ...checkpoint,
          status: "completed",
          handoffSnapshotId: snapshot.id,
          completedAt,
        };
        await this.store.updateCheckpoint(done);
        await this.store.updateSession({
          ...session,
          lastCheckpointEventId: toEvent.id,
          latestHandoffSnapshotId: snapshot.id,
          updatedAt: completedAt,
        });
        return done;
      });
    } catch (error) {
      const failed: Checkpoint = {
        ...checkpoint,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.store.updateCheckpoint(failed);
      await this.store.replaceCandidates(
        checkpoint.id,
        candidates.map((candidate) => ({
          candidate,
          accepted: false,
          rejectionReason: failed.error,
        }))
      );
      throw error;
    }
    await this.#safeInvalidate(session.spaceId);
    return completed;
  }

  #assertCheckpointIdentity(requestedToEventId: string | undefined, checkpoint: Checkpoint): void {
    if (requestedToEventId && requestedToEventId !== checkpoint.toEventId) {
      throw new ConflictError(
        "idempotencyKey was already used with a different toEventId",
        "IDEMPOTENCY_MISMATCH"
      );
    }
  }

  async getCheckpoint(id: string): Promise<Checkpoint> {
    const value = await this.store.findCheckpoint(requiredString(id, "checkpointId"));
    if (!value) throw new NotFoundError("Checkpoint", id);
    return value;
  }

  async getLatestHandoff(spaceId: string): Promise<HandoffSnapshot> {
    await this.getSpace(spaceId);
    const value = await this.store.findLatestHandoff(spaceId);
    if (!value) throw new NotFoundError("HandoffSnapshot for Space", spaceId);
    return value;
  }

  async getHandoff(id: string): Promise<HandoffSnapshot> {
    const value = await this.store.findHandoff(requiredString(id, "handoffId"));
    if (!value) throw new NotFoundError("HandoffSnapshot", id);
    return value;
  }

  #validateMemory(input: Partial<RememberInput> | Partial<MemoryCandidate>): ValidatedMemory {
    const family = requiredString(input.family, "memory.family") as MemoryFamily;
    if (!families.has(family)) throw new ValidationError(`Unsupported memory.family: ${family}`);
    const explicitTier = "tier" in input ? input.tier : undefined;
    const tier = (explicitTier ??
      (input as Partial<MemoryCandidate>).recommendedTier ??
      "indexed") as MemoryTier;
    if (!tiers.has(tier)) throw new ValidationError(`Unsupported memory.tier: ${tier}`);
    const status = ("status" in input ? input.status : undefined) ?? "active";
    if (!statuses.has(status)) throw new ValidationError(`Unsupported memory.status: ${status}`);
    if (
      input.data !== undefined &&
      (!input.data || typeof input.data !== "object" || Array.isArray(input.data))
    ) {
      throw new ValidationError("memory.data must be an object");
    }
    return {
      family,
      type: requiredString(input.type, "memory.type"),
      key: optionalString(input.key, "memory.key"),
      content: requiredString(input.content, "memory.content"),
      data: input.data,
      tier,
      status,
      importance: score(input.importance, 0.5, "memory.importance"),
      confidence: score(input.confidence, 1, "memory.confidence"),
    };
  }

  #validateCandidate(
    value: unknown,
    index: number,
    eventIds: Set<string>
  ): MemoryCandidate & ValidatedMemory {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`Candidate ${index} must be an object`);
    }
    const candidate = value as Partial<MemoryCandidate>;
    const memory = this.#validateMemory(candidate);
    const operation = candidate.operation ?? "create";
    if (!operations.has(operation))
      throw new ValidationError(`Candidate ${index} has invalid operation`);
    if (!Array.isArray(candidate.sourceEventIds) || candidate.sourceEventIds.length === 0) {
      throw new ValidationError(`Candidate ${index} must include sourceEventIds`);
    }
    if (candidate.sourceEventIds.some((id) => !eventIds.has(id))) {
      throw new ValidationError(`Candidate ${index} references an event outside this checkpoint`);
    }
    if (operation === "update" && !memory.key && !candidate.targetMemoryId) {
      throw new ValidationError(`Candidate ${index} update requires key or targetMemoryId`);
    }
    return {
      ...memory,
      recommendedTier: memory.tier,
      operation,
      sourceEventIds: [...new Set(candidate.sourceEventIds)],
      targetMemoryId: optionalString(candidate.targetMemoryId, "candidate.targetMemoryId"),
      promoteReason: optionalString(candidate.promoteReason, "candidate.promoteReason"),
    };
  }

  #validateFilters(input: MemorySearchInput): void {
    const validate = <T>(values: T[] | undefined, allowed: Set<T> | undefined, label: string) => {
      if (values === undefined) return;
      if (!Array.isArray(values) || values.length === 0)
        throw new ValidationError(`${label} filter must be a non-empty array`);
      if (allowed && values.some((value) => !allowed.has(value)))
        throw new ValidationError(`Invalid ${label} filter`);
    };
    validate(input.families, families, "family");
    validate(input.tiers, tiers, "tier");
    validate(input.statuses, statuses, "status");
    if (
      !Number.isInteger(input.limit ?? 20) ||
      (input.limit ?? 20) < 1 ||
      (input.limit ?? 20) > 100
    ) {
      throw new ValidationError("search limit must be an integer between 1 and 100");
    }
  }

  async #sessionEvent(sessionId: string, eventId: string): Promise<SessionEvent> {
    const event = await this.store.findEvent(sessionId, eventId);
    if (!event)
      throw new ValidationError(`Event ${eventId} does not belong to Session ${sessionId}`);
    return event;
  }

  async #assertCoreCapacity(spaceId: string, excludeMemoryId?: string): Promise<void> {
    const core = await this.store.listMemories({ spaceId, tiers: ["core"], statuses: ["active"] });
    if (core.filter((memory) => memory.id !== excludeMemoryId).length >= this.coreLimit) {
      throw new ConflictError(
        `Core Memory capacity of ${this.coreLimit} reached`,
        "CORE_CAPACITY_REACHED"
      );
    }
  }

  async #existingTierForAdmission(
    existing: Memory,
    input: CommitInput,
    actor: "explicit" | "implicit" | "extractor",
    equivalent: boolean
  ): Promise<MemoryTier> {
    if (actor === "explicit") return existing.tier;
    if (actor === "implicit") return "indexed";
    if (input.admissionReason === "eligible") return "core";
    if (input.admissionReason === "bounded-local") {
      if (equivalent && existing.tier === "core") {
        const history = await this.store.listMemoryHistory(existing.id);
        if (hasEffectiveExplicitPromotion(existing, history)) return "core";
      }
      return "indexed";
    }
    return existing.tier;
  }

  async #commitMemory(
    input: CommitInput,
    actor: "explicit" | "implicit" | "extractor"
  ): Promise<Memory> {
    let existing = input.targetMemoryId
      ? await this.getMemory(input.targetMemoryId)
      : input.key
        ? await this.store.findActiveMemoryByKey(input.spaceId, input.key)
        : undefined;
    if (existing && existing.spaceId !== input.spaceId)
      throw new ValidationError("targetMemoryId belongs to another Space");
    if (existing?.key && (existing.family !== input.family || existing.type !== input.type)) {
      throw new ConflictError(
        `Memory key ${existing.key} is already bound to ${existing.family}/${existing.type}`,
        "MEMORY_KEY_SCHEMA_CONFLICT"
      );
    }
    if (input.operation === "supersede" && existing) {
      const superseded: Memory = {
        ...existing,
        status: "superseded",
        tier: "indexed",
        version: existing.version + 1,
        updatedAt: timestamp(),
      };
      await this.store.updateMemory(superseded);
      await this.#history(
        superseded.id,
        "supersede",
        existing,
        superseded,
        input.reason,
        input.sourceSessionId,
        input.sourceEventIds
      );
      if (!input.key) return superseded;
      existing = undefined;
    }
    const now = timestamp();
    if (existing) {
      for (const eventId of input.sourceEventIds)
        await this.store.addMemorySource(existing.id, eventId, now);
      const equivalent =
        normalizeLexicalText(existing.content) === normalizeLexicalText(input.content);
      if (equivalent) {
        let result = existing;
        const nextTier = await this.#existingTierForAdmission(existing, input, actor, true);
        if (nextTier !== existing.tier) {
          result = await this.#changeTier(
            existing,
            nextTier,
            input.reason,
            nextTier === "core" ? PROMOTION_OPERATION.automatic : "demote:automatic-bounded"
          );
        }
        await this.#history(
          existing.id,
          "deduplicate",
          existing,
          result,
          input.reason,
          input.sourceSessionId,
          input.sourceEventIds
        );
        return result;
      }
      const nextTier =
        input.status === "active"
          ? await this.#existingTierForAdmission(existing, input, actor, false)
          : "indexed";
      if (nextTier === "core") await this.#assertCoreCapacity(input.spaceId, existing.id);
      const updated: Memory = {
        ...existing,
        family: input.family,
        type: input.type,
        content: input.content,
        data: input.data,
        tier: nextTier,
        status: input.status,
        importance: input.importance,
        confidence: input.confidence,
        sourceSessionId: input.sourceSessionId,
        sourceAgentId: input.sourceAgentId,
        version: existing.version + 1,
        updatedAt: now,
      };
      await this.store.updateMemory(updated);
      await this.#history(
        updated.id,
        "update",
        existing,
        updated,
        input.reason,
        input.sourceSessionId,
        input.sourceEventIds
      );
      if (existing.tier === "indexed" && updated.tier === "core") {
        await this.#history(
          updated.id,
          PROMOTION_OPERATION.automatic,
          { ...updated, tier: "indexed" },
          updated,
          input.reason,
          input.sourceSessionId,
          input.sourceEventIds
        );
      }
      return updated;
    }
    const tier = input.status === "active" ? input.tier : "indexed";
    if (tier === "core") await this.#assertCoreCapacity(input.spaceId);
    const created: Memory = {
      id: randomUUID(),
      spaceId: input.spaceId,
      family: input.family,
      type: input.type,
      key: input.key,
      content: input.content,
      data: input.data,
      tier,
      status: input.status,
      importance: input.importance,
      confidence: input.confidence,
      sourceSessionId: input.sourceSessionId,
      sourceAgentId: input.sourceAgentId,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insertMemory(created);
    for (const eventId of input.sourceEventIds)
      await this.store.addMemorySource(created.id, eventId, now);
    await this.#history(
      created.id,
      "create",
      undefined,
      created,
      input.reason,
      input.sourceSessionId,
      input.sourceEventIds
    );
    return created;
  }

  async #changeTier(
    memory: Memory,
    tier: MemoryTier,
    reason?: string,
    operation = tier === "core" ? PROMOTION_OPERATION.automatic : "demote"
  ): Promise<Memory> {
    if (tier === "core") await this.#assertCoreCapacity(memory.spaceId, memory.id);
    const updated = { ...memory, tier, version: memory.version + 1, updatedAt: timestamp() };
    await this.store.updateMemory(updated);
    await this.#history(updated.id, operation, memory, updated, reason);
    return updated;
  }

  async #history(
    memoryId: string,
    operation: string,
    before?: Memory,
    after?: Memory,
    reason?: string,
    sourceSessionId?: string,
    sourceEventIds: string[] = []
  ): Promise<void> {
    await this.store.addMemoryHistory({
      memoryId,
      operation,
      before,
      after,
      reason,
      sourceSessionId,
      sourceEventIds,
      createdAt: timestamp(),
    });
  }

  async #buildSnapshot(session: Session, checkpointId: string): Promise<HandoffSnapshot> {
    const activeCore = await this.store.listMemories({
      spaceId: session.spaceId,
      tiers: ["core"],
      statuses: ["active"],
    });
    const resolvedTasks = await this.store.listMemories({
      spaceId: session.spaceId,
      types: ["task"],
      statuses: ["resolved"],
    });
    const completedTasks: Memory[] = [];
    for (const memory of resolvedTasks) {
      if (await this.#wasEverCore(memory.id)) completedTasks.push(memory);
    }
    const historiesByMemoryId = new Map<string, MemoryHistoryRecord[]>();
    for (const memory of activeCore) {
      if (memory.type === "task" || memory.type === "blocker" || memory.type === "question") {
        historiesByMemoryId.set(memory.id, await this.store.listMemoryHistory(memory.id));
      }
    }
    const projection = buildHandoffProjection({
      activeCore,
      completedTasks,
      historiesByMemoryId,
    });
    return {
      id: randomUUID(),
      spaceId: session.spaceId,
      sessionId: session.id,
      checkpointId,
      ...projection,
      createdAt: timestamp(),
    };
  }

  async #wasEverCore(memoryId: string): Promise<boolean> {
    const history = await this.store.listMemoryHistory(memoryId);
    return history.some((entry) => entry.before?.tier === "core" || entry.after?.tier === "core");
  }

  async #safeCacheGet<T>(key: string): Promise<T | undefined> {
    try {
      return await this.cache.get<T>(key);
    } catch {
      // Cache reads are best-effort; callers rebuild authoritative results from Store.
      return undefined;
    }
  }

  async #safeCacheSet<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch {
      // Cache is best-effort derived state; Store-built results remain authoritative.
    }
  }

  async #safeInvalidate(spaceId: string): Promise<void> {
    try {
      await this.cache.delete(`bootstrap:${spaceId}`);
    } catch {
      // Cache is best-effort derived state and cannot change durable operation success.
    }
  }
}
