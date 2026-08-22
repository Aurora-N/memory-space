/** Bounded provider-neutral message supplied to one semantic extraction request. */
export interface SemanticExtractionModelEvent {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** Versioned bounded input accepted by every semantic model backend. */
export interface SemanticExtractionModelInput {
  schemaVersion: 1;
  instruction: string;
  events: SemanticExtractionModelEvent[];
}

/** Untrusted model capability that may only propose semantic extraction output. */
export interface SemanticExtractionModel {
  extract(input: SemanticExtractionModelInput): Promise<unknown>;
}

/** Sanitized model/backend execution failure shared by transport adapters. */
export class SemanticExtractionModelError extends Error {
  readonly code: string;

  constructor(code: string, message = "Semantic extraction model unavailable") {
    super(message);
    this.name = "SemanticExtractionModelError";
    this.code = code;
  }
}

/** Stable sanitized reason why an explicitly selected semantic backend cannot run. */
export type SemanticModelUnavailableReason =
  | "missing_credential"
  | "local_runtime_unreachable"
  | "model_not_found"
  | "cli_not_found"
  | "not_authenticated"
  | "usage_limit"
  | "capability_blocked"
  | "capability_unsupported"
  | "capability_unverified"
  | "provider_not_installed"
  | "provider_unavailable";

/** Trusted runtime context used only to resolve the explicitly configured backend. */
export interface SemanticModelResolutionContext {
  sessionProvider?: string;
  cwd?: string;
  timeoutMs: number;
}

/** One backend resolution result; unavailable results never trigger fallback. */
export type SemanticModelResolution =
  | {
      available: true;
      model: SemanticExtractionModel;
      backend: "external" | "local" | "host-agent";
      adapter: string;
      provider?: string;
    }
  | {
      available: false;
      backend?: "external" | "local" | "host-agent";
      adapter?: string;
      provider?: string;
      reason: SemanticModelUnavailableReason;
    };

/** Resolves exactly one user-selected semantic backend without fallback. */
export interface SemanticModelResolver<Configuration = unknown> {
  resolve(
    config: Configuration,
    context: SemanticModelResolutionContext
  ): Promise<SemanticModelResolution>;
}
