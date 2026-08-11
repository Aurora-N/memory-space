import { MemorySpaceError } from "../../../domain/errors.ts";
import type {
  LifecycleHandler,
  LifecycleResult,
  LifecycleWarning
} from "../../../integration/lifecycle-handler.ts";
import type { ProviderLifecycleEvent } from "../../../provider/types.ts";
import { ClaudeAdapter } from "./adapter.ts";
import {
  claudeCodeWarningOutput,
  type ClaudeCodeHookOutput
} from "./bootstrap-renderer.ts";

export interface ClaudeCodeLifecycleRuntimeContext {
  cwd?: string;
  explicitSpaceId?: string;
}

export type ClaudeCodeLifecycleResponse =
  | { status: "ignored" }
  | {
    status: "ok";
    type: ProviderLifecycleEvent["type"];
    sessionId: string;
    checkpointStatus?: "completed" | "noop";
    output?: ClaudeCodeHookOutput;
  }
  | {
    status: "warning";
    warning: LifecycleWarning;
    output: ClaudeCodeHookOutput;
  };

export interface ClaudeCodeLifecycleIntegrationOptions {
  lifecycleHandler: LifecycleHandler;
  adapter?: ClaudeAdapter;
  runtime?: ClaudeCodeLifecycleRuntimeContext;
  onWarning?: (warning: LifecycleWarning, error?: unknown) => void;
}

function warningFor(
  error: unknown,
  type?: ProviderLifecycleEvent["type"]
): LifecycleWarning {
  const known = error instanceof MemorySpaceError;
  return {
    status: "warning",
    nonBlocking: true,
    type,
    error: {
      code: known ? error.code : "MEMORY_SERVICE_UNAVAILABLE",
      message: known ? error.message : "Memory service unavailable"
    }
  };
}

function providerSafeMessage(code: string): string {
  if (code === "MEMORY_SERVICE_UNAVAILABLE") return "Memory service unavailable";
  if (code === "SPACE_NOT_BOUND") {
    return "No trusted project Memory binding is available";
  }
  if (code === "SPACE_BINDING_INVALID") {
    return "The trusted project Memory binding is invalid";
  }
  if (code === "SPACE_BINDING_CONFLICT"
    || code === "PROVIDER_SESSION_SPACE_CONFLICT") {
    return "The Claude Code session is already bound to a different project context";
  }
  if (code === "SESSION_NOT_FOUND") {
    return "The Claude Code Memory Session is not initialized";
  }
  if (code === "VALIDATION_ERROR") {
    return "The Claude Code lifecycle payload is invalid";
  }
  return "Memory lifecycle operation failed";
}

function warningResponse(
  warning: LifecycleWarning
): ClaudeCodeLifecycleResponse {
  const safeWarning: LifecycleWarning = {
    ...warning,
    error: { ...warning.error, message: providerSafeMessage(warning.error.code) }
  };
  return {
    status: "warning",
    warning: safeWarning,
    output: claudeCodeWarningOutput(
      safeWarning.error.code,
      safeWarning.error.message
    )
  };
}

function successfulResponse(
  result: LifecycleResult,
  adapter: ClaudeAdapter
): ClaudeCodeLifecycleResponse {
  if (result.type === "session_start") {
    const rendered = adapter.renderBootstrap({
      sessionId: result.session.id,
      provider: adapter.name,
      context: result.bootstrap.context
    });
    return {
      status: "ok",
      type: result.type,
      sessionId: result.session.id,
      output: { continue: true, ...rendered.metadata }
    };
  }
  if (result.type === "pre_compact" || result.type === "session_end") {
    return {
      status: "ok",
      type: result.type,
      sessionId: result.session.id,
      checkpointStatus: result.checkpoint.status
    };
  }
  return { status: "ok", type: result.type, sessionId: result.session.id };
}

export class ClaudeCodeLifecycleIntegration {
  readonly lifecycleHandler: LifecycleHandler;
  readonly adapter: ClaudeAdapter;
  readonly runtime: ClaudeCodeLifecycleRuntimeContext;
  readonly onWarning?: (warning: LifecycleWarning, error?: unknown) => void;

  constructor(options: ClaudeCodeLifecycleIntegrationOptions) {
    this.lifecycleHandler = options.lifecycleHandler;
    this.adapter = options.adapter ?? new ClaudeAdapter();
    this.runtime = { ...options.runtime };
    this.onWarning = options.onWarning;
  }

  async handleNative(payload: unknown): Promise<ClaudeCodeLifecycleResponse> {
    let event: ProviderLifecycleEvent | null;
    try {
      event = this.adapter.normalizeEvent(payload);
    } catch (error) {
      const warning = warningFor(error);
      this.#report(warning, error);
      return warningResponse(warning);
    }
    if (!event) return { status: "ignored" };

    const result = await this.lifecycleHandler.handleFailOpen(event, {
      cwd: this.runtime.cwd,
      explicitSpaceId: this.runtime.explicitSpaceId,
      agentId: "claude-code"
    });
    if (result.status === "warning") {
      this.#report(result);
      return warningResponse(result);
    }
    return successfulResponse(result, this.adapter);
  }

  #report(warning: LifecycleWarning, error?: unknown): void {
    try {
      this.onWarning?.(warning, error);
    } catch {
      // Diagnostics are best effort and cannot make a provider hook fail closed.
    }
  }
}
