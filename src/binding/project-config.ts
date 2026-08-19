/** Effective implicit-recall strategy for one project binding. */
export type ImplicitRecallMode = "off" | "exact" | "lexical";
/** Origin of the effective recall configuration. */
export type ImplicitRecallConfigSource = "explicit" | "default" | "invalid";
/** Effective implicit-remember strategy for one project binding. */
export type ImplicitRememberMode = "off" | "conservative";
/** Origin of the effective implicit-remember configuration. */
export type ImplicitRememberConfigSource = "explicit" | "default" | "invalid";

/** Validated recall configuration; invalid input always resolves fail-closed to off. */
export interface ImplicitRecallConfiguration {
  configuredMode?: ImplicitRecallMode;
  effectiveMode: ImplicitRecallMode;
  source: ImplicitRecallConfigSource;
  error?: string;
}

const modes = new Set<ImplicitRecallMode>(["off", "exact", "lexical"]);
const rememberModes = new Set<ImplicitRememberMode>(["off", "conservative"]);

/** Validated remember configuration; missing or invalid input never enables writes. */
export interface ImplicitRememberConfiguration {
  configuredMode?: ImplicitRememberMode;
  effectiveMode: ImplicitRememberMode;
  source: ImplicitRememberConfigSource;
  error?: string;
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
