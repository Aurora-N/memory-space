import type {
  AppendEventInput,
  BootstrapResult,
  MemorySpace
} from "../application/memory-space.ts";
import { MemorySpaceError, ValidationError } from "../domain/errors.ts";
import type { Session, SessionEvent } from "../domain/types.ts";
import type {
  ProviderLifecycleEvent,
  ProviderSessionStartEvent
} from "../provider/types.ts";
import { validateProviderLifecycleEvent } from "../provider/types.ts";
import type { SpaceBinding, SpaceResolutionInput } from "../binding/space-resolver.ts";
import type { CheckpointCoordinator, CheckpointPolicyResult } from "./checkpoint-policy.ts";
import type { ProviderSessionResolutionInput } from "./provider-session-resolver.ts";

interface LifecycleMemorySpace {
  getSession(id: string): Promise<Session>;
  appendEvent(input: AppendEventInput): Promise<SessionEvent>;
  bootstrap(spaceId: string): Promise<BootstrapResult>;
}

interface LifecycleSpaceResolver {
  resolve(input: SpaceResolutionInput): Promise<SpaceBinding>;
}

interface LifecycleSessionResolver {
  resolve(input: ProviderSessionResolutionInput): Promise<Session>;
  find(provider: string, externalSessionId: string): Promise<Session>;
}

export interface LifecycleContext {
  sessionId?: string;
  cwd?: string;
  explicitSpaceId?: string;
  agentId?: string;
}

export type LifecycleResult =
  | { status: "ok"; type: "session_start"; session: Session; bootstrap: BootstrapResult }
  | { status: "ok"; type: "user_prompt" | "assistant_turn"; session: Session; event: SessionEvent }
  | { status: "ok"; type: "pre_compact" | "session_end"; session: Session; checkpoint: CheckpointPolicyResult };

export interface LifecycleWarning {
  status: "warning";
  nonBlocking: true;
  type?: ProviderLifecycleEvent["type"];
  sessionId?: string;
  error: { code: string; message: string };
}

export interface LifecycleDiagnostic {
  event?: ProviderLifecycleEvent;
  error: unknown;
  warning: LifecycleWarning;
}

export class LifecycleHandler {
  readonly memorySpace: LifecycleMemorySpace;
  readonly spaceResolver: LifecycleSpaceResolver;
  readonly sessionResolver: LifecycleSessionResolver;
  readonly checkpointPolicy: CheckpointCoordinator;
  readonly onWarning?: (diagnostic: LifecycleDiagnostic) => void;

  constructor(options: {
    memorySpace: MemorySpace | LifecycleMemorySpace;
    spaceResolver: LifecycleSpaceResolver;
    sessionResolver: LifecycleSessionResolver;
    checkpointPolicy: CheckpointCoordinator;
    onWarning?: (diagnostic: LifecycleDiagnostic) => void;
  }) {
    this.memorySpace = options.memorySpace;
    this.spaceResolver = options.spaceResolver;
    this.sessionResolver = options.sessionResolver;
    this.checkpointPolicy = options.checkpointPolicy;
    this.onWarning = options.onWarning;
  }

  async handle(value: unknown, context: LifecycleContext = {}): Promise<LifecycleResult> {
    const event = validateProviderLifecycleEvent(value);
    if (event.type === "session_start") return this.#start(event, context);
    const session = await this.#resolveExistingSession(event, context.sessionId);
    if (event.type === "user_prompt" || event.type === "assistant_turn") {
      const persisted = await this.memorySpace.appendEvent({
        sessionId: session.id,
        type: "message",
        payload: {
          role: event.type === "user_prompt" ? "user" : "assistant",
          content: event.content,
          contentMode: "full",
          ...(event.transcriptRef ? { transcriptRef: event.transcriptRef } : {})
        },
        createdAt: event.occurredAt
      });
      return { status: "ok", type: event.type, session, event: persisted };
    }
    const checkpoint = await this.checkpointPolicy.checkpointIfNeeded({
      sessionId: session.id, trigger: event.type
    });
    return { status: "ok", type: event.type, session, checkpoint };
  }

  async handleFailOpen(value: unknown, context: LifecycleContext = {}): Promise<LifecycleResult | LifecycleWarning> {
    let event: ProviderLifecycleEvent | undefined;
    try {
      event = validateProviderLifecycleEvent(value);
      return await this.handle(event, context);
    } catch (error) {
      const known = error instanceof MemorySpaceError;
      const warning: LifecycleWarning = {
        status: "warning",
        nonBlocking: true,
        type: event?.type,
        sessionId: context.sessionId,
        error: {
          code: known ? error.code : "MEMORY_SERVICE_UNAVAILABLE",
          message: known ? error.message : "Memory service unavailable"
        }
      };
      try {
        this.onWarning?.({ event, error, warning });
      } catch {
        // Diagnostics are non-authoritative and must not break fail-open lifecycle behavior.
      }
      return warning;
    }
  }

  async #start(event: ProviderSessionStartEvent, context: LifecycleContext): Promise<LifecycleResult> {
    const binding = await this.spaceResolver.resolve({
      cwd: event.cwd ?? context.cwd,
      explicitSpaceId: context.explicitSpaceId
    });
    const session = await this.sessionResolver.resolve({
      provider: event.provider,
      externalSessionId: event.externalSessionId,
      spaceId: binding.spaceId,
      agentId: context.agentId
    });
    const bootstrap = await this.memorySpace.bootstrap(session.spaceId);
    return { status: "ok", type: "session_start", session, bootstrap };
  }

  async #resolveExistingSession(event: ProviderLifecycleEvent, sessionId?: string): Promise<Session> {
    const session = sessionId
      ? await this.memorySpace.getSession(sessionId)
      : event.externalSessionId
        ? await this.sessionResolver.find(event.provider, event.externalSessionId)
        : undefined;
    if (!session) {
      throw new ValidationError("Provider lifecycle event requires externalSessionId or internal sessionId");
    }
    if (session.provider !== event.provider) {
      throw new ValidationError("Provider lifecycle event does not match Session.provider");
    }
    if (event.externalSessionId !== undefined && event.externalSessionId !== session.externalSessionId) {
      throw new ValidationError("Provider lifecycle event does not match Session.externalSessionId");
    }
    if (event.transcriptRef?.provider !== undefined && event.transcriptRef.provider !== session.provider) {
      throw new ValidationError("transcriptRef.provider does not match Session.provider");
    }
    if (event.transcriptRef?.externalSessionId !== undefined
      && event.transcriptRef.externalSessionId !== session.externalSessionId) {
      throw new ValidationError("transcriptRef.externalSessionId does not match Session.externalSessionId");
    }
    return session;
  }
}
