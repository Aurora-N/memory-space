import type { MemorySpace } from "../application/memory-space.ts";
import { SpaceResolver } from "../binding/space-resolver.ts";
import { NotFoundError } from "../domain/errors.ts";
import type { Session, Space } from "../domain/types.ts";
import { commandError } from "./errors.ts";

/** Per-request resolution inputs; Session identity takes precedence over binding fields. */
export interface MCPRequestContext {
  cwd?: string;
  sessionId?: string;
  explicitSpaceId?: string;
}

/** Trusted process-level MCP context that cannot provide Session identity. */
export type MCPRuntimeContext = Omit<MCPRequestContext, "sessionId">;

/** Authoritative Space and optional Session selected for one MCP request. */
export interface ResolvedMCPRequestContext {
  space: Space;
  session?: Session;
}

/** Resolves Session identity before cwd binding and translates stable MCP errors. */
export class MCPRequestContextResolver {
  readonly memorySpace: MemorySpace;
  readonly spaceResolver: SpaceResolver;
  readonly cwd: string;
  readonly explicitSpaceId?: string;

  constructor(options: {
    memorySpace: MemorySpace;
    spaceResolver?: SpaceResolver;
    cwd?: string;
    explicitSpaceId?: string;
  }) {
    this.memorySpace = options.memorySpace;
    this.spaceResolver = options.spaceResolver ?? new SpaceResolver();
    this.cwd = options.cwd ?? process.cwd();
    this.explicitSpaceId = options.explicitSpaceId;
  }

  async resolve(context: MCPRequestContext): Promise<ResolvedMCPRequestContext> {
    if (context.sessionId !== undefined) {
      let session: Session;
      try {
        session = await this.memorySpace.getSession(context.sessionId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw commandError("SESSION_NOT_FOUND", `Session not found: ${context.sessionId}`, false, error);
        }
        throw error;
      }
      try {
        return { session, space: await this.memorySpace.getSpace(session.spaceId) };
      } catch (error) {
        throw commandError(
          "MEMORY_SERVICE_UNAVAILABLE",
          "Memory service unavailable",
          true,
          error
        );
      }
    }

    const binding = await this.spaceResolver.resolve({
      cwd: context.cwd ?? this.cwd,
      explicitSpaceId: context.explicitSpaceId ?? this.explicitSpaceId
    });
    try {
      return { space: await this.memorySpace.getSpace(binding.spaceId) };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw commandError(
          "SPACE_NOT_BOUND",
          "Memory Space binding does not reference an available Space",
          false,
          error
        );
      }
      throw error;
    }
  }
}
