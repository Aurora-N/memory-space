export type CliErrorCode =
  | "USAGE_ERROR"
  | "DAEMON_ENDPOINT_INVALID"
  | "DAEMON_UNAVAILABLE"
  | "DAEMON_REQUEST_FAILED"
  | "INSPECTOR_UNAVAILABLE"
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_CONFIG_CONFLICT"
  | "PROVIDER_CONFIG_WRITE_FAILED"
  | "SPACE_NOT_FOUND"
  | "BINDING_NOT_FOUND"
  | "BINDING_INVALID"
  | "BINDING_CONFLICT"
  | "BINDING_WRITE_FAILED"
  | "BINDING_REMOVE_FAILED"
  | "MCP_UNAVAILABLE"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly remediation?: string;

  constructor(
    code: CliErrorCode,
    message: string,
    options: { exitCode?: number; remediation?: string; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.remediation = options.remediation;
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    "INTERNAL_ERROR",
    "Unexpected internal error.",
    { remediation: "Rerun with the project checks and inspect daemon logs separately.", cause: error }
  );
}
