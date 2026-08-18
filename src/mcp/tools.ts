import type { MemorySpace } from "../application/memory-space.ts";
import type { SpaceResolver } from "../binding/space-resolver.ts";
import { NotFoundError } from "../domain/errors.ts";
import type { Memory, MemoryFamily, MemoryStatus, Session } from "../domain/types.ts";
import { CheckpointPolicy, type CheckpointCoordinator } from "../integration/checkpoint-policy.ts";
import { commandError } from "./errors.ts";
import { MCPRequestContextResolver } from "./request-context.ts";

/** Input for deterministic Core and Handoff bootstrap. */
export interface MemoryBootstrapToolInput { sessionId?: string }
/** Input for rendered active-memory context recall. */
export interface MemoryContextToolInput { query: string; sessionId?: string; maxItems?: number }
/** Input for structured active-memory search. */
export interface MemorySearchToolInput {
  query: string;
  sessionId?: string;
  families?: MemoryFamily[];
  types?: string[];
  limit?: number;
}
/** Input for a Session-scoped explicit Indexed-memory write. */
export interface MemoryRememberToolInput {
  sessionId: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  data?: Record<string, unknown>;
}
/** Input for an agent-attributed policy-controlled Core promotion. */
export interface MemoryPromoteToolInput { sessionId: string; memoryId: string; reason: string }
/** Input for an idempotent checkpoint through the latest Session event. */
export interface MemoryCheckpointToolInput { sessionId: string }

interface MemorySummary {
  id: string;
  family: MemoryFamily;
  type: string;
  key?: string;
  content: string;
  tier: "core" | "indexed";
  status: MemoryStatus;
  updatedAt: string;
}

function memorySummary(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    family: memory.family,
    type: memory.type,
    ...(memory.key ? { key: memory.key } : {}),
    content: memory.content,
    tier: memory.tier,
    status: memory.status,
    updatedAt: memory.updatedAt
  };
}

/** Application-facing implementation of the exact six MCP tool operations. */
export class MemoryMcpGateway {
  readonly memorySpace: MemorySpace;
  readonly checkpointPolicy: CheckpointCoordinator;
  readonly requestContext: MCPRequestContextResolver;

  constructor(options: {
    memorySpace: MemorySpace;
    spaceResolver?: SpaceResolver;
    checkpointPolicy?: CheckpointCoordinator;
    cwd?: string;
    explicitSpaceId?: string;
  }) {
    this.memorySpace = options.memorySpace;
    this.checkpointPolicy = options.checkpointPolicy ?? new CheckpointPolicy(options.memorySpace);
    this.requestContext = new MCPRequestContextResolver({
      memorySpace: options.memorySpace,
      spaceResolver: options.spaceResolver,
      cwd: options.cwd,
      explicitSpaceId: options.explicitSpaceId
    });
  }

  async bootstrap(input: MemoryBootstrapToolInput) {
    const resolved = await this.requestContext.resolve({ sessionId: input.sessionId });
    const result = await this.memorySpace.bootstrap(resolved.space.id);
    return {
      space: { id: result.space.id, name: result.space.name },
      ...(resolved.session ? {
        session: {
          id: resolved.session.id,
          ...(resolved.session.provider ? { provider: resolved.session.provider } : {})
        }
      } : {}),
      context: result.context,
      ...(result.handoffSnapshot ? {
        handoff: {
          checkpointId: result.handoffSnapshot.checkpointId,
          createdAt: result.handoffSnapshot.createdAt
        }
      } : {})
    };
  }

  async context(input: MemoryContextToolInput) {
    const resolved = await this.requestContext.resolve({ sessionId: input.sessionId });
    const result = await this.memorySpace.context({
      spaceId: resolved.space.id,
      query: input.query,
      tiers: ["core", "indexed"],
      statuses: ["active"],
      limit: input.maxItems
    });
    return {
      context: result.rendered,
      memories: result.results.map(({ memory }) => ({
        id: memory.id,
        type: memory.type,
        ...(memory.key ? { key: memory.key } : {}),
        tier: memory.tier
      }))
    };
  }

  async search(input: MemorySearchToolInput) {
    const resolved = await this.requestContext.resolve({ sessionId: input.sessionId });
    const results = await this.memorySpace.search({
      spaceId: resolved.space.id,
      query: input.query,
      families: input.families,
      types: input.types,
      tiers: ["core", "indexed"],
      statuses: ["active"],
      limit: input.limit
    });
    return {
      results: results.map(({ memory, score }) => ({
        id: memory.id,
        family: memory.family,
        type: memory.type,
        ...(memory.key ? { key: memory.key } : {}),
        content: memory.content,
        tier: memory.tier,
        score,
        updatedAt: memory.updatedAt
      }))
    };
  }

  async remember(input: MemoryRememberToolInput) {
    const session = await this.#requiredSession(input.sessionId);
    const memory = await this.memorySpace.remember({
      spaceId: session.spaceId,
      sourceSessionId: session.id,
      family: input.family,
      type: input.type,
      key: input.key,
      content: input.content,
      data: input.data
    });
    return { memory: memorySummary(memory) };
  }

  async promote(input: MemoryPromoteToolInput) {
    const session = await this.#requiredSession(input.sessionId);
    let memory: Memory;
    try {
      memory = await this.memorySpace.getMemory(input.memoryId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw commandError("MEMORY_NOT_FOUND", `Memory not found: ${input.memoryId}`, false, error);
      }
      throw error;
    }
    if (memory.spaceId !== session.spaceId) {
      throw commandError(
        "SPACE_BINDING_CONFLICT",
        "Memory does not belong to the Session Space"
      );
    }
    const promoted = await this.memorySpace.promote(memory.id, {
      actor: "agent",
      reason: input.reason
    });
    return { memory: memorySummary(promoted) };
  }

  async checkpoint(input: MemoryCheckpointToolInput) {
    await this.#requiredSession(input.sessionId);
    const result = await this.checkpointPolicy.checkpointIfNeeded({
      sessionId: input.sessionId,
      trigger: "explicit"
    });
    if (result.status === "noop") {
      return { status: "noop" as const, reason: "no_uncommitted_events" as const };
    }
    return {
      status: "completed" as const,
      checkpointId: result.checkpoint.id,
      committedThroughEventId: result.checkpoint.toEventId
    };
  }

  async #requiredSession(sessionId: string): Promise<Session> {
    const resolved = await this.requestContext.resolve({ sessionId });
    if (!resolved.session) {
      throw commandError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`, false);
    }
    return resolved.session;
  }
}
