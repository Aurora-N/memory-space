import { randomUUID } from "node:crypto";
import { RuleBasedExtractor } from "../adapters/rule-based-extractor.ts";
import { SqliteMemoryStore } from "../adapters/sqlite/sqlite-store.ts";
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
  Space
} from "../domain/types.ts";
import { NoopCache, type CachePort } from "../ports/cache.ts";
import type { MemoryExtractor } from "../ports/extractor.ts";
import type { MemoryHistoryRecord, MemoryStore } from "../ports/store.ts";

const families = new Set<MemoryFamily>(["knowledge", "state", "episode", "procedure"]);
const tiers = new Set<MemoryTier>(["core", "indexed"]);
const statuses = new Set<MemoryStatus>(["active", "resolved", "superseded", "archived"]);
const eventTypes = new Set<SessionEventType>(["message", "tool_call", "artifact", "memory", "custom"]);
const operations = new Set<CandidateOperation>(["create", "update", "supersede", "ignore"]);
const coreEligibleTypes = new Set([
  "goal", "roadmap", "progress", "task", "blocker", "decision", "constraint",
  "convention", "question", "rule", "instruction"
]);
const sections = [
  "Goal", "Current Roadmap", "Current Progress", "Active Tasks", "Decisions",
  "Constraints / Conventions", "Blockers", "Open Questions"
] as const;
type Section = typeof sections[number];

export interface CreateSpaceInput { id?: string; name: string; description?: string }
export interface CreateSessionInput {
  id?: string; spaceId: string; agentId?: string; provider?: string;
  externalSessionId?: string; summary?: string;
}
export interface AppendEventInput {
  id?: string; sessionId: string; type: SessionEventType;
  payload: Record<string, unknown>; createdAt?: string;
}
export interface RememberInput {
  spaceId: string; family: MemoryFamily; type: string; key?: string; content: string;
  data?: Record<string, unknown>; tier?: MemoryTier; status?: MemoryStatus;
  importance?: number; confidence?: number; sourceSessionId?: string;
  sourceAgentId?: string; sourceEventIds?: string[];
}
export interface CheckpointInput { sessionId: string; toEventId?: string; idempotencyKey: string }
export interface BootstrapResult {
  space: Space; coreMemories: Memory[]; handoffSnapshot?: HandoffSnapshot; context: string;
}
export interface ContextResult { query: string; results: MemorySearchResult[]; rendered: string }

interface ValidatedMemory {
  family: MemoryFamily; type: string; key?: string; content: string;
  data?: Record<string, unknown>; tier: MemoryTier; status: MemoryStatus;
  importance: number; confidence: number;
}

interface CommitInput extends ValidatedMemory {
  spaceId: string; sourceSessionId?: string; sourceAgentId?: string;
  sourceEventIds: string[]; operation: CandidateOperation; targetMemoryId?: string;
  reason?: string;
}

function timestamp(): string { return new Date().toISOString(); }

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

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function queryTokens(value: string): string[] {
  const normalized = normalize(value);
  const tokens = normalized.match(/[a-z0-9_.+-]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(tokens.flatMap((token) => {
    if (!/^[\p{Script=Han}]+$/u.test(token) || token.length < 2) return [token];
    return Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2));
  }))];
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function list(values: string[]): string { return values.length ? values.map((value) => `- ${value}`).join("\n") : "(none)"; }
function summary(memory: Memory): string {
  return memory.key ? `[${memory.id}] (${memory.key}) ${memory.content}` : `[${memory.id}] ${memory.content}`;
}

function sectionFor(memory: Memory): Section {
  const mapping: Record<string, Section> = {
    goal: "Goal", roadmap: "Current Roadmap", progress: "Current Progress",
    task: "Active Tasks", decision: "Decisions", fact: "Decisions",
    constraint: "Constraints / Conventions", convention: "Constraints / Conventions",
    rule: "Constraints / Conventions", instruction: "Constraints / Conventions",
    blocker: "Blockers", question: "Open Questions"
  };
  return mapping[memory.type]
    ?? (memory.family === "knowledge" ? "Decisions"
      : memory.family === "procedure" ? "Constraints / Conventions" : "Current Progress");
}

export class MemorySpace {
  readonly store: MemoryStore;
  readonly extractor: MemoryExtractor;
  readonly cache: CachePort;
  readonly coreLimit: number;

  constructor(options: {
    store?: MemoryStore; databasePath?: string; extractor?: MemoryExtractor;
    cache?: CachePort; coreLimit?: number;
  } = {}) {
    this.store = options.store ?? new SqliteMemoryStore(options.databasePath);
    this.extractor = options.extractor ?? new RuleBasedExtractor();
    this.cache = options.cache ?? new NoopCache();
    this.coreLimit = options.coreLimit ?? 64;
    if (!Number.isInteger(this.coreLimit) || this.coreLimit < 1) {
      throw new ValidationError("coreLimit must be a positive integer");
    }
  }

  async close(): Promise<void> { await this.store.close(); }

  async createSpace(input: CreateSpaceInput): Promise<Space> {
    const now = timestamp();
    const space: Space = {
      id: optionalString(input.id, "space.id") ?? randomUUID(),
      name: requiredString(input.name, "space.name"),
      description: optionalString(input.description, "space.description"), createdAt: now, updatedAt: now
    };
    try { await this.store.insertSpace(space); }
    catch (error) {
      if (String(error).includes("UNIQUE")) throw new ConflictError(`Space already exists: ${space.id}`);
      throw error;
    }
    return space;
  }

  async getSpace(id: string): Promise<Space> {
    const value = await this.store.findSpace(requiredString(id, "spaceId"));
    if (!value) throw new NotFoundError("Space", id);
    return value;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const space = await this.getSpace(input.spaceId);
    const now = timestamp();
    const session: Session = {
      id: optionalString(input.id, "session.id") ?? randomUUID(), spaceId: space.id,
      agentId: optionalString(input.agentId, "session.agentId"),
      provider: optionalString(input.provider, "session.provider"),
      externalSessionId: optionalString(input.externalSessionId, "session.externalSessionId"),
      summary: optionalString(input.summary, "session.summary"), createdAt: now, updatedAt: now
    };
    await this.store.insertSession(session);
    return session;
  }

  async getSession(id: string): Promise<Session> {
    const value = await this.store.findSession(requiredString(id, "sessionId"));
    if (!value) throw new NotFoundError("Session", id);
    return value;
  }

  async appendEvent(input: AppendEventInput): Promise<SessionEvent> {
    const session = await this.getSession(input.sessionId);
    if (!eventTypes.has(input.type)) throw new ValidationError(`Unsupported event.type: ${input.type}`);
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new ValidationError("event.payload must be an object");
    }
    const event = await this.store.insertEvent({
      id: optionalString(input.id, "event.id") ?? randomUUID(), sessionId: session.id,
      type: input.type, payload: input.payload,
      createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : timestamp()
    });
    await this.store.updateSession({ ...session, updatedAt: timestamp() });
    return event;
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    await this.getSession(sessionId);
    return this.store.listEvents(sessionId);
  }

  async remember(input: RememberInput): Promise<Memory> {
    const space = await this.getSpace(input.spaceId);
    const validated = this.#validateMemory(input);
    let session: Session | undefined;
    if (input.sourceSessionId) {
      session = await this.getSession(input.sourceSessionId);
      if (session.spaceId !== space.id) throw new ValidationError("sourceSessionId must belong to memory.spaceId");
    }
    if ((input.sourceEventIds?.length ?? 0) > 0 && !session) {
      throw new ValidationError("sourceEventIds require sourceSessionId for provenance validation");
    }
    for (const eventId of input.sourceEventIds ?? []) await this.#sessionEvent(session!.id, eventId);
    const memory = await this.store.transaction(() => this.#commitMemory({
      ...validated, spaceId: space.id, sourceSessionId: session?.id,
      sourceAgentId: input.sourceAgentId ?? session?.agentId,
      sourceEventIds: input.sourceEventIds ?? [], operation: validated.key ? "update" : "create",
      reason: "explicit remember"
    }, "explicit"));
    await this.#invalidate(space.id);
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

  async promote(memoryId: string, options: { reason?: string; actor?: "user" | "agent" } = {}): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (memory.status !== "active") throw new ConflictError("Only active memory can be promoted", "MEMORY_NOT_ACTIVE");
    if (memory.tier === "core") return memory;
    const actor = options.actor ?? "agent";
    if (actor === "agent") {
      requiredString(options.reason, "promotion reason");
      if (!this.#coreEligible(memory)) {
        throw new ConflictError("Memory is not deterministically eligible for agent promotion", "PROMOTION_REJECTED");
      }
    }
    const result = await this.store.transaction(() =>
      this.#changeTier(memory, "core", options.reason ?? "user requested promotion")
    );
    await this.#invalidate(memory.spaceId);
    return result;
  }

  async demote(memoryId: string, options: { reason?: string } = {}): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (memory.tier === "indexed") return memory;
    const result = await this.store.transaction(() =>
      this.#changeTier(memory, "indexed", options.reason ?? "explicit demotion")
    );
    await this.#invalidate(memory.spaceId);
    return result;
  }

  async setMemoryStatus(memoryId: string, status: MemoryStatus, options: { reason?: string } = {}): Promise<Memory> {
    const memory = await this.getMemory(memoryId);
    if (!statuses.has(status)) throw new ValidationError(`Unsupported memory status: ${status}`);
    const tier = status === "active" ? memory.tier : "indexed";
    if (memory.status === status && memory.tier === tier) return memory;
    const updated = { ...memory, status, tier, version: memory.version + 1, updatedAt: timestamp() };
    await this.store.transaction(async () => {
      await this.store.updateMemory(updated);
      await this.#history(updated.id, "status", memory, updated, options.reason);
    });
    await this.#invalidate(memory.spaceId);
    return updated;
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    await this.getSpace(input.spaceId);
    this.#validateFilters(input);
    const memories = await this.store.listMemories({
      spaceId: input.spaceId, families: input.families, types: input.types,
      tiers: input.tiers, statuses: input.statuses ?? ["active"]
    });
    const query = normalize(input.query ?? "");
    const tokens = queryTokens(query);
    const results = memories.map((memory) => {
      const haystack = normalize(`${memory.key ?? ""} ${memory.type} ${memory.content} ${JSON.stringify(memory.data ?? {})}`);
      let resultScore = query && haystack.includes(query) ? 10 : 0;
      for (const token of tokens) if (haystack.includes(token)) resultScore += 1;
      if (!query) resultScore = 1;
      return { memory, score: resultScore };
    }).filter((result) => !query || result.score > 0);
    results.sort((a, b) => b.score - a.score
      || b.memory.updatedAt.localeCompare(a.memory.updatedAt)
      || a.memory.id.localeCompare(b.memory.id));
    return results.slice(0, input.limit ?? 20);
  }

  async context(input: MemorySearchInput): Promise<ContextResult> {
    const results = await this.search(input);
    const rendered = [
      `# Memory Context: ${input.query ?? ""}`, "",
      results.length ? results.map(({ memory }) => [
        `## ${memory.type}: ${memory.key ?? memory.id}`, memory.content,
        `Memory: ${memory.id} | Tier: ${memory.tier} | Source session: ${memory.sourceSessionId ?? "unknown"}`
      ].join("\n")).join("\n\n") : "(no relevant memory)"
    ].join("\n");
    return { query: input.query ?? "", results, rendered };
  }

  async bootstrap(spaceId: string): Promise<BootstrapResult> {
    const cacheKey = `bootstrap:${spaceId}`;
    const cached = await this.cache.get<BootstrapResult>(cacheKey);
    if (cached) return cached;
    const space = await this.getSpace(spaceId);
    const coreMemories = (await this.store.listMemories({
      spaceId, tiers: ["core"], statuses: ["active"]
    })).sort((a, b) => a.type.localeCompare(b.type) || (a.key ?? "").localeCompare(b.key ?? "") || a.id.localeCompare(b.id));
    const handoffSnapshot = await this.store.findLatestHandoff(spaceId);
    const lines = ["# Space Context"];
    for (const section of sections) {
      lines.push("", `## ${section}`, list(coreMemories.filter((memory) => sectionFor(memory) === section).map(summary)));
    }
    const handoff = handoffSnapshot ? [
      handoffSnapshot.goal ? `Goal: ${handoffSnapshot.goal}` : "",
      ...handoffSnapshot.completed.map((value) => `Completed: ${value}`),
      ...handoffSnapshot.activeTasks.map((value) => `Active task: ${value}`),
      ...handoffSnapshot.decisions.map((value) => `Decision: ${value}`),
      ...handoffSnapshot.blockers.map((value) => `Blocker: ${value}`),
      ...handoffSnapshot.openQuestions.map((value) => `Open question: ${value}`),
      ...handoffSnapshot.nextSteps.map((value) => `Next step: ${value}`)
    ].filter(Boolean) : [];
    lines.push("", "## Latest Handoff", list(handoff));
    const result = { space, coreMemories, handoffSnapshot, context: lines.join("\n") };
    await this.cache.set(cacheKey, result, 60);
    return result;
  }

  async checkpoint(input: CheckpointInput): Promise<Checkpoint> {
    const session = await this.getSession(input.sessionId);
    const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");
    const existing = await this.store.findCheckpointByIdempotency(session.id, idempotencyKey);
    if (existing?.status === "processing") {
      if (input.toEventId && input.toEventId !== existing.toEventId) {
        throw new ConflictError("idempotencyKey was already used with a different toEventId", "IDEMPOTENCY_MISMATCH");
      }
      return existing;
    }
    if (existing?.status === "completed") {
      if (input.toEventId && input.toEventId !== existing.toEventId) {
        throw new ConflictError("idempotencyKey was already used with a different toEventId", "IDEMPOTENCY_MISMATCH");
      }
      return existing;
    }
    const fromEvent = session.lastCheckpointEventId
      ? await this.#sessionEvent(session.id, session.lastCheckpointEventId) : undefined;
    const toEvent = input.toEventId
      ? await this.#sessionEvent(session.id, input.toEventId) : await this.store.findLatestEvent(session.id);
    if (!toEvent) throw new ValidationError("Cannot checkpoint a session with no events");
    if (toEvent.sequence <= (fromEvent?.sequence ?? 0)) {
      throw new ValidationError("toEventId must be after the previous successful checkpoint boundary");
    }
    if (existing && existing.toEventId !== toEvent.id) {
      throw new ConflictError("idempotencyKey was already used with a different toEventId", "IDEMPOTENCY_MISMATCH");
    }
    const events = await this.store.listEvents(session.id, fromEvent?.sequence ?? 0, toEvent.sequence);
    const checkpoint: Checkpoint = existing ? {
      ...existing, fromEventId: session.lastCheckpointEventId, toEventId: toEvent.id,
      status: "processing", handoffSnapshotId: undefined, error: undefined, completedAt: undefined
    } : {
      id: randomUUID(), spaceId: session.spaceId, sessionId: session.id,
      fromEventId: session.lastCheckpointEventId, toEventId: toEvent.id,
      idempotencyKey, status: "processing", createdAt: timestamp()
    };
    if (existing) await this.store.updateCheckpoint(checkpoint);
    else await this.store.insertCheckpoint(checkpoint);

    let candidates: unknown[] = [];
    try {
      candidates = await this.extractor.extract(events, { session, checkpointId: checkpoint.id });
      if (!Array.isArray(candidates)) throw new ValidationError("Extractor must return a MemoryCandidate array");
      const eventIds = new Set(events.map((event) => event.id));
      const normalized = candidates.map((candidate, index) => this.#validateCandidate(candidate, index, eventIds));
      const completed = await this.store.transaction(async () => {
        const currentSession = await this.getSession(session.id);
        if (currentSession.lastCheckpointEventId !== session.lastCheckpointEventId) {
          throw new ConflictError("Checkpoint boundary changed while processing", "STALE_CHECKPOINT_BOUNDARY");
        }
        for (const candidate of normalized) {
          if (candidate.operation !== "ignore") {
            await this.#commitMemory({
              ...candidate, spaceId: session.spaceId, sourceSessionId: session.id,
              sourceAgentId: session.agentId, tier: this.#candidateTier(candidate),
              reason: candidate.promoteReason ?? "checkpoint extraction"
            }, "extractor");
          }
        }
        await this.store.replaceCandidates(checkpoint.id, normalized.map((candidate) => ({
          candidate, accepted: candidate.operation !== "ignore",
          rejectionReason: candidate.operation === "ignore" ? "extractor ignored candidate" : undefined
        })));
        const snapshot = await this.#buildSnapshot(session, checkpoint.id);
        await this.store.insertHandoff(snapshot);
        const done: Checkpoint = {
          ...checkpoint, status: "completed", handoffSnapshotId: snapshot.id, completedAt: timestamp()
        };
        await this.store.updateCheckpoint(done);
        await this.store.updateSession({
          ...session, lastCheckpointEventId: toEvent.id,
          latestHandoffSnapshotId: snapshot.id, updatedAt: done.completedAt!
        });
        return done;
      });
      await this.#invalidate(session.spaceId);
      return completed;
    } catch (error) {
      const failed: Checkpoint = {
        ...checkpoint, status: "failed", error: error instanceof Error ? error.message : String(error)
      };
      await this.store.updateCheckpoint(failed);
      await this.store.replaceCandidates(checkpoint.id, candidates.map((candidate) => ({
        candidate, accepted: false, rejectionReason: failed.error
      })));
      throw error;
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
    const tier = (explicitTier ?? (input as Partial<MemoryCandidate>).recommendedTier ?? "indexed") as MemoryTier;
    if (!tiers.has(tier)) throw new ValidationError(`Unsupported memory.tier: ${tier}`);
    const status = ("status" in input ? input.status : undefined) ?? "active";
    if (!statuses.has(status)) throw new ValidationError(`Unsupported memory.status: ${status}`);
    if (input.data !== undefined && (!input.data || typeof input.data !== "object" || Array.isArray(input.data))) {
      throw new ValidationError("memory.data must be an object");
    }
    return {
      family, type: requiredString(input.type, "memory.type"),
      key: optionalString(input.key, "memory.key"), content: requiredString(input.content, "memory.content"),
      data: input.data, tier, status,
      importance: score(input.importance, 0.5, "memory.importance"),
      confidence: score(input.confidence, 1, "memory.confidence")
    };
  }

  #validateCandidate(value: unknown, index: number, eventIds: Set<string>): MemoryCandidate & ValidatedMemory {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError(`Candidate ${index} must be an object`);
    }
    const candidate = value as Partial<MemoryCandidate>;
    const memory = this.#validateMemory(candidate);
    const operation = candidate.operation ?? "create";
    if (!operations.has(operation)) throw new ValidationError(`Candidate ${index} has invalid operation`);
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
      ...memory, recommendedTier: memory.tier, operation,
      sourceEventIds: [...new Set(candidate.sourceEventIds)],
      targetMemoryId: optionalString(candidate.targetMemoryId, "candidate.targetMemoryId"),
      promoteReason: optionalString(candidate.promoteReason, "candidate.promoteReason")
    };
  }

  #validateFilters(input: MemorySearchInput): void {
    const validate = <T>(values: T[] | undefined, allowed: Set<T> | undefined, label: string) => {
      if (values === undefined) return;
      if (!Array.isArray(values) || values.length === 0) throw new ValidationError(`${label} filter must be a non-empty array`);
      if (allowed && values.some((value) => !allowed.has(value))) throw new ValidationError(`Invalid ${label} filter`);
    };
    validate(input.families, families, "family");
    validate(input.tiers, tiers, "tier");
    validate(input.statuses, statuses, "status");
    if (!Number.isInteger(input.limit ?? 20) || (input.limit ?? 20) < 1 || (input.limit ?? 20) > 100) {
      throw new ValidationError("search limit must be an integer between 1 and 100");
    }
  }

  async #sessionEvent(sessionId: string, eventId: string): Promise<SessionEvent> {
    const event = await this.store.findEvent(sessionId, eventId);
    if (!event) throw new ValidationError(`Event ${eventId} does not belong to Session ${sessionId}`);
    return event;
  }

  #coreEligible(memory: Pick<Memory, "type" | "key">): boolean {
    return coreEligibleTypes.has(memory.type) || (memory.type === "fact" && Boolean(memory.key));
  }

  #candidateTier(candidate: MemoryCandidate): MemoryTier {
    return candidate.recommendedTier === "core" && candidate.promoteReason && this.#coreEligible(candidate)
      ? "core" : "indexed";
  }

  async #assertCoreCapacity(spaceId: string, excludeMemoryId?: string): Promise<void> {
    const core = await this.store.listMemories({ spaceId, tiers: ["core"], statuses: ["active"] });
    if (core.filter((memory) => memory.id !== excludeMemoryId).length >= this.coreLimit) {
      throw new ConflictError(`Core Memory capacity of ${this.coreLimit} reached`, "CORE_CAPACITY_REACHED");
    }
  }

  async #commitMemory(input: CommitInput, actor: "explicit" | "extractor"): Promise<Memory> {
    let existing = input.targetMemoryId
      ? await this.getMemory(input.targetMemoryId)
      : input.key ? await this.store.findActiveMemoryByKey(input.spaceId, input.key) : undefined;
    if (existing && existing.spaceId !== input.spaceId) throw new ValidationError("targetMemoryId belongs to another Space");
    if (input.operation === "supersede" && existing) {
      const superseded: Memory = {
        ...existing, status: "superseded", tier: "indexed",
        version: existing.version + 1, updatedAt: timestamp()
      };
      await this.store.updateMemory(superseded);
      await this.#history(
        superseded.id, "supersede", existing, superseded, input.reason,
        input.sourceSessionId, input.sourceEventIds
      );
      if (!input.key) return superseded;
      existing = undefined;
    }
    const now = timestamp();
    if (existing) {
      for (const eventId of input.sourceEventIds) await this.store.addMemorySource(existing.id, eventId, now);
      if (normalize(existing.content) === normalize(input.content)) {
        let result = existing;
        if (actor === "extractor" && input.tier === "core" && existing.tier === "indexed") {
          result = await this.#changeTier(existing, "core", input.reason);
        }
        await this.#history(
          existing.id, "deduplicate", existing, result, input.reason,
          input.sourceSessionId, input.sourceEventIds
        );
        return result;
      }
      const nextTier = actor === "extractor" && input.tier === "core" ? "core" : existing.tier;
      if (nextTier === "core") await this.#assertCoreCapacity(input.spaceId, existing.id);
      const updated: Memory = {
        ...existing, family: input.family, type: input.type, content: input.content, data: input.data,
        tier: nextTier, status: input.status, importance: input.importance, confidence: input.confidence,
        sourceSessionId: input.sourceSessionId, sourceAgentId: input.sourceAgentId,
        version: existing.version + 1, updatedAt: now
      };
      await this.store.updateMemory(updated);
      await this.#history(
        updated.id, "update", existing, updated, input.reason,
        input.sourceSessionId, input.sourceEventIds
      );
      return updated;
    }
    const tier = input.status === "active" ? input.tier : "indexed";
    if (tier === "core") await this.#assertCoreCapacity(input.spaceId);
    const created: Memory = {
      id: randomUUID(), spaceId: input.spaceId, family: input.family, type: input.type,
      key: input.key, content: input.content, data: input.data, tier, status: input.status,
      importance: input.importance, confidence: input.confidence,
      sourceSessionId: input.sourceSessionId, sourceAgentId: input.sourceAgentId,
      version: 1, createdAt: now, updatedAt: now
    };
    await this.store.insertMemory(created);
    for (const eventId of input.sourceEventIds) await this.store.addMemorySource(created.id, eventId, now);
    await this.#history(created.id, "create", undefined, created, input.reason, input.sourceSessionId, input.sourceEventIds);
    return created;
  }

  async #changeTier(memory: Memory, tier: MemoryTier, reason?: string): Promise<Memory> {
    if (tier === "core") await this.#assertCoreCapacity(memory.spaceId, memory.id);
    const updated = { ...memory, tier, version: memory.version + 1, updatedAt: timestamp() };
    await this.store.updateMemory(updated);
    await this.#history(updated.id, tier === "core" ? "promote" : "demote", memory, updated, reason);
    return updated;
  }

  async #history(
    memoryId: string, operation: string, before?: Memory, after?: Memory, reason?: string,
    sourceSessionId?: string, sourceEventIds: string[] = []
  ): Promise<void> {
    await this.store.addMemoryHistory({
      memoryId, operation, before, after, reason, sourceSessionId, sourceEventIds, createdAt: timestamp()
    });
  }

  async #buildSnapshot(session: Session, checkpointId: string): Promise<HandoffSnapshot> {
    const memories = await this.store.listMemories({ spaceId: session.spaceId });
    const active = memories.filter((memory) => memory.status === "active");
    const resolved = memories.filter((memory) => memory.status === "resolved");
    const tasks = active.filter((memory) => memory.type === "task").map((memory) => memory.content);
    const explicitNext = active.flatMap((memory) => {
      const value = memory.data?.nextStep ?? memory.data?.nextSteps;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string" ? [value] : [];
    });
    return {
      id: randomUUID(), spaceId: session.spaceId, sessionId: session.id, checkpointId,
      goal: active.filter((memory) => memory.type === "goal").at(-1)?.content,
      completed: unique([
        ...active.filter((memory) => memory.type === "progress").map((memory) => memory.content),
        ...resolved.filter((memory) => memory.type === "task").map((memory) => memory.content)
      ]),
      activeTasks: unique(tasks),
      decisions: unique(active.filter((memory) => memory.type === "decision").map((memory) => memory.content)),
      blockers: unique(active.filter((memory) => memory.type === "blocker").map((memory) => memory.content)),
      openQuestions: unique(active.filter((memory) => memory.type === "question").map((memory) => memory.content)),
      nextSteps: unique([...explicitNext, ...tasks]), createdAt: timestamp()
    };
  }

  async #invalidate(spaceId: string): Promise<void> { await this.cache.delete(`bootstrap:${spaceId}`); }
}
