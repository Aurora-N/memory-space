/** Effective implicit-recall strategy for one project binding. */
export type ImplicitRecallMode = "off" | "exact" | "lexical";
/** Origin of the effective recall configuration. */
export type ImplicitRecallConfigSource = "explicit" | "default" | "invalid";
/** Effective implicit-remember strategy for one project binding. */
export type ImplicitRememberMode = "off" | "conservative";
/** Origin of the effective implicit-remember configuration. */
export type ImplicitRememberConfigSource = "explicit" | "default" | "invalid";
/** Effective semantic-extraction strategy for one project binding. */
export type SemanticExtractionMode = "off" | "grounded";
/** Origin of the effective semantic configuration. */
export type SemanticExtractionConfigSource = "explicit" | "default" | "invalid";
/** User-selected semantic capability class; selection never implies trust. */
export type SemanticModelBackend = "external" | "local" | "host-agent";

/** External OpenAI-compatible endpoint configuration without embedded credentials. */
export interface ExternalSemanticModelConfiguration {
  backend: "external";
  adapter: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}

/** Loopback-only Ollama configuration; model installation remains operator-owned. */
export interface LocalSemanticModelConfiguration {
  backend: "local";
  adapter: "ollama";
  model: string;
  baseUrl?: string;
}

/** Reviewed coding-agent capability selection, including current-provider resolution. */
export interface HostAgentSemanticModelConfiguration {
  backend: "host-agent";
  provider: "auto" | "claude-code" | "codex";
}

/** Strict backend-specific configuration accepted by the semantic resolver. */
export type SemanticModelConfiguration =
  | ExternalSemanticModelConfiguration
  | LocalSemanticModelConfiguration
  | HostAgentSemanticModelConfiguration;

/** Validated recall configuration; invalid input always resolves fail-closed to off. */
export interface ImplicitRecallConfiguration {
  configuredMode?: ImplicitRecallMode;
  effectiveMode: ImplicitRecallMode;
  source: ImplicitRecallConfigSource;
  error?: string;
}

const modes = new Set<ImplicitRecallMode>(["off", "exact", "lexical"]);
const rememberModes = new Set<ImplicitRememberMode>(["off", "conservative"]);
const semanticModes = new Set<SemanticExtractionMode>(["off", "grounded"]);
const semanticFields = new Set(["mode", "model", "timeoutMs"]);
const externalModelFields = new Set(["backend", "adapter", "baseUrl", "model", "apiKeyEnv"]);
const localModelFields = new Set(["backend", "adapter", "model", "baseUrl"]);
const hostModelFields = new Set(["backend", "provider"]);

/** Shared timeout and loopback defaults for semantic extraction configuration. */
export const semanticExtractionDefaults = Object.freeze({
  timeoutMs: 8_000,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 30_000,
  ollamaBaseUrl: "http://127.0.0.1:11434",
});

/** Validated remember configuration; missing or invalid input never enables writes. */
export interface ImplicitRememberConfiguration {
  configuredMode?: ImplicitRememberMode;
  effectiveMode: ImplicitRememberMode;
  source: ImplicitRememberConfigSource;
  error?: string;
}

/** Validated P9 configuration; missing or invalid input never calls a model. */
export interface SemanticExtractionConfiguration {
  configuredMode?: SemanticExtractionMode;
  effectiveMode: SemanticExtractionMode;
  source: SemanticExtractionConfigSource;
  model?: SemanticModelConfiguration;
  timeoutMs: number;
  error?: string;
}

function configObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): string | undefined {
  const field = Object.keys(input).find((key) => !allowed.has(key));
  return field ? `${label}.${field} is not supported` : undefined;
}

function configString(value: unknown, maximum = 500): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maximum) {
    return undefined;
  }
  return value.trim();
}

function parsedUrl(value: unknown, label: string): { value?: string; error?: string } {
  const raw = configString(value, 2_000);
  if (!raw) return { error: `${label} must be a non-empty URL` };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: `${label} must use http or https` };
    }
    if (url.username || url.password || url.search || url.hash) {
      return {
        error: `${label} must not contain credentials, query parameters, or fragments`,
      };
    }
    return { value: url.toString().replace(/\/$/u, "") };
  } catch {
    return { error: `${label} must be a valid URL` };
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseSemanticModel(value: unknown): {
  model?: SemanticModelConfiguration;
  error?: string;
} {
  const input = configObject(value);
  if (!input) return { error: "semanticExtraction.model must be an object" };
  if (input.backend === "external") {
    const fieldError = exactFields(input, externalModelFields, "semanticExtraction.model");
    if (fieldError) return { error: fieldError };
    if (input.adapter !== "openai-compatible") {
      return { error: "semanticExtraction.model.adapter must be openai-compatible" };
    }
    const endpoint = parsedUrl(input.baseUrl, "semanticExtraction.model.baseUrl");
    if (endpoint.error) return endpoint;
    const model = configString(input.model, 200);
    if (!model) return { error: "semanticExtraction.model.model must be a non-empty string" };
    const apiKeyEnv =
      input.apiKeyEnv === undefined ? undefined : configString(input.apiKeyEnv, 200);
    if (
      input.apiKeyEnv !== undefined &&
      (!apiKeyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv))
    ) {
      return {
        error: "semanticExtraction.model.apiKeyEnv must be an environment variable name",
      };
    }
    return {
      model: {
        backend: "external",
        adapter: "openai-compatible",
        baseUrl: endpoint.value ?? "",
        model,
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      },
    };
  }
  if (input.backend === "local") {
    const fieldError = exactFields(input, localModelFields, "semanticExtraction.model");
    if (fieldError) return { error: fieldError };
    if (input.adapter !== "ollama") {
      return { error: "semanticExtraction.model.adapter must be ollama" };
    }
    const model = configString(input.model, 200);
    if (!model) return { error: "semanticExtraction.model.model must be a non-empty string" };
    let baseUrl: string | undefined;
    if (input.baseUrl !== undefined) {
      const endpoint = parsedUrl(input.baseUrl, "semanticExtraction.model.baseUrl");
      if (endpoint.error) return endpoint;
      const url = new URL(endpoint.value ?? "");
      if (!isLoopbackHostname(url.hostname)) {
        return {
          error: "semanticExtraction local baseUrl must use a loopback hostname",
        };
      }
      baseUrl = endpoint.value;
    }
    return {
      model: {
        backend: "local",
        adapter: "ollama",
        model,
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
  }
  if (input.backend === "host-agent") {
    const fieldError = exactFields(input, hostModelFields, "semanticExtraction.model");
    if (fieldError) return { error: fieldError };
    if (
      input.provider !== "auto" &&
      input.provider !== "claude-code" &&
      input.provider !== "codex"
    ) {
      return {
        error: "semanticExtraction.model.provider must be auto, claude-code, or codex",
      };
    }
    return {
      model: {
        backend: "host-agent",
        provider: input.provider,
      },
    };
  }
  return {
    error: "semanticExtraction.model.backend must be external, local, or host-agent",
  };
}

/** Resolves untrusted binding configuration into a safe effective recall mode. */
export function resolveImplicitRecallConfiguration(
  config: Record<string, unknown>
): ImplicitRecallConfiguration {
  const value = config.implicitRecall;
  if (value === undefined) {
    return { effectiveMode: "exact", source: "default" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      effectiveMode: "off",
      source: "invalid",
      error: "implicitRecall must be an object",
    };
  }
  const mode = (value as Record<string, unknown>).mode;
  if (mode === undefined) {
    return { effectiveMode: "exact", source: "default" };
  }
  if (typeof mode !== "string" || !modes.has(mode as ImplicitRecallMode)) {
    return {
      effectiveMode: "off",
      source: "invalid",
      error: "implicitRecall.mode must be off, exact, or lexical",
    };
  }
  return {
    configuredMode: mode as ImplicitRecallMode,
    effectiveMode: mode as ImplicitRecallMode,
    source: "explicit",
  };
}

/** Resolves untrusted binding configuration into a fail-closed implicit-write mode. */
export function resolveImplicitRememberConfiguration(
  config: Record<string, unknown>
): ImplicitRememberConfiguration {
  const value = config.implicitRemember;
  if (value === undefined) {
    return { effectiveMode: "off", source: "default" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      effectiveMode: "off",
      source: "invalid",
      error: "implicitRemember must be an object",
    };
  }
  const mode = (value as Record<string, unknown>).mode;
  if (mode === undefined) {
    return { effectiveMode: "off", source: "default" };
  }
  if (typeof mode !== "string" || !rememberModes.has(mode as ImplicitRememberMode)) {
    return {
      effectiveMode: "off",
      source: "invalid",
      error: "implicitRemember.mode must be off or conservative",
    };
  }
  return {
    configuredMode: mode as ImplicitRememberMode,
    effectiveMode: mode as ImplicitRememberMode,
    source: "explicit",
  };
}

/** Resolves strict P9 mode/backend configuration without enabling implicit fallback. */
export function resolveSemanticExtractionConfiguration(
  config: Record<string, unknown>
): SemanticExtractionConfiguration {
  const value = config.semanticExtraction;
  if (value === undefined) {
    return {
      effectiveMode: "off",
      source: "default",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
    };
  }
  const input = configObject(value);
  if (!input) {
    return {
      effectiveMode: "off",
      source: "invalid",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
      error: "semanticExtraction must be an object",
    };
  }
  const fieldError = exactFields(input, semanticFields, "semanticExtraction");
  if (fieldError) {
    return {
      effectiveMode: "off",
      source: "invalid",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
      error: fieldError,
    };
  }
  const mode = input.mode;
  if (mode === undefined) {
    return {
      effectiveMode: "off",
      source: "default",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
    };
  }
  if (typeof mode !== "string" || !semanticModes.has(mode as SemanticExtractionMode)) {
    return {
      effectiveMode: "off",
      source: "invalid",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
      error: "semanticExtraction.mode must be off or grounded",
    };
  }
  const timeoutMs = input.timeoutMs ?? semanticExtractionDefaults.timeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < semanticExtractionDefaults.minimumTimeoutMs ||
    (timeoutMs as number) > semanticExtractionDefaults.maximumTimeoutMs
  ) {
    return {
      configuredMode: mode as SemanticExtractionMode,
      effectiveMode: "off",
      source: "invalid",
      timeoutMs: semanticExtractionDefaults.timeoutMs,
      error: `semanticExtraction.timeoutMs must be between ${semanticExtractionDefaults.minimumTimeoutMs} and ${semanticExtractionDefaults.maximumTimeoutMs}`,
    };
  }
  if (mode === "off") {
    if (input.model !== undefined) {
      return {
        configuredMode: "off",
        effectiveMode: "off",
        source: "invalid",
        timeoutMs: timeoutMs as number,
        error: "semanticExtraction.model is not allowed when mode is off",
      };
    }
    return {
      configuredMode: "off",
      effectiveMode: "off",
      source: "explicit",
      timeoutMs: timeoutMs as number,
    };
  }
  const parsed = parseSemanticModel(input.model);
  if (!parsed.model) {
    return {
      configuredMode: "grounded",
      effectiveMode: "off",
      source: "invalid",
      timeoutMs: timeoutMs as number,
      error: parsed.error ?? "semanticExtraction.model is invalid",
    };
  }
  return {
    configuredMode: "grounded",
    effectiveMode: "grounded",
    source: "explicit",
    model: parsed.model,
    timeoutMs: timeoutMs as number,
  };
}
