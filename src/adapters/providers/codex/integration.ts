import { MemorySpaceError } from "../../../domain/errors.ts";
import type {
  LifecycleHandler,
  LifecycleResult,
  LifecycleWarning
} from "../../../integration/lifecycle-handler.ts";
import type { ProviderLifecycleEvent } from "../../../provider/types.ts";
import { CodexAdapter } from "./adapter.ts";
import {
  codexPromptContextOutput,
  codexWarningOutput,
  type CodexHookOutput
} from "./bootstrap-renderer.ts";

/** Trusted project context supplied by the Codex hook runtime. */
export interface CodexLifecycleRuntimeContext {
  cwd?: string;
  explicitSpaceId?: string;
}

/** Native Codex lifecycle response with sanitized fail-open warnings. */
export type CodexLifecycleResponse =
  | { status: "ignored" }
  | {
    status: "ok";
    type: ProviderLifecycleEvent["type"];
    sessionId: string;
    checkpointStatus?: "completed" | "noop";
    output?: CodexHookOutput;
  }
  | {
    status: "warning";
    warning: LifecycleWarning;
    output: CodexHookOutput;
  };

/** Dependencies and optional diagnostics for Codex lifecycle orchestration. */
export interface CodexLifecycleIntegrationOptions {
  lifecycleHandler: LifecycleHandler;
  adapter?: CodexAdapter;
  runtime?: CodexLifecycleRuntimeContext;
  onWarning?: (warning: LifecycleWarning, error?: unknown) => void;
}

function warningFor(error: unknown, type?: ProviderLifecycleEvent["type"]): LifecycleWarning {
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
  if (code === "SPACE_NOT_BOUND") return "No trusted project Memory binding is available";
  if (code === "SPACE_BINDING_INVALID") return "The trusted project Memory binding is invalid";
  if (code === "SPACE_BINDING_CONFLICT" || code === "PROVIDER_SESSION_SPACE_CONFLICT") {
    return "The Codex session is already bound to a different project context";
  }
  if (code === "SESSION_NOT_FOUND") return "The Codex Memory Session is not initialized";
  if (code === "VALIDATION_ERROR") return "The Codex lifecycle payload is invalid";
  return "Memory lifecycle operation failed";
}

function warningResponse(warning: LifecycleWarning): CodexLifecycleResponse {
  const safeWarning: LifecycleWarning = {
    ...warning,
    error: { ...warning.error, message: providerSafeMessage(warning.error.code) }
  };
  return {
    status: "warning",
    warning: safeWarning,
    output: codexWarningOutput(safeWarning.error.code, safeWarning.error.message)
  };
}

function successfulResponse(
  result: LifecycleResult,
  adapter: CodexAdapter
): CodexLifecycleResponse {
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
  if (result.type === "user_prompt" && result.recall?.context) {
    return {
      status: "ok",
      type: result.type,
      sessionId: result.session.id,
      output: codexPromptContextOutput(result.recall.context)
    };
  }
  return { status: "ok", type: result.type, sessionId: result.session.id };
}

/** Translates native Codex payloads at the provider boundary and delegates lifecycle policy. */
export class CodexLifecycleIntegration {
  readonly lifecycleHandler: LifecycleHandler;
  readonly adapter: CodexAdapter;
  readonly runtime: CodexLifecycleRuntimeContext;
  readonly onWarning?: (warning: LifecycleWarning, error?: unknown) => void;

  constructor(options: CodexLifecycleIntegrationOptions) {
    this.lifecycleHandler = options.lifecycleHandler;
    this.adapter = options.adapter ?? new CodexAdapter();
    this.runtime = { ...options.runtime };
    this.onWarning = options.onWarning;
  }

  async handleNative(payload: unknown): Promise<CodexLifecycleResponse> {
    let event: ProviderLifecycleEvent | null;
    try {
      event = this.adapter.normalizeEvent(payload);
    } catch (error) {
      // Invalid provider payloads become non-blocking warnings at this boundary.
      const warning = warningFor(error);
      this.#report(warning, error);
      return warningResponse(warning);
    }
    if (!event) return { status: "ignored" };

    const result = await this.lifecycleHandler.handleFailOpen(event, {
      cwd: this.runtime.cwd,
      explicitSpaceId: this.runtime.explicitSpaceId,
      agentId: "codex"
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
