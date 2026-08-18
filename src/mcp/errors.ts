import { MemorySpaceError } from "../domain/errors.ts";

/** Stable error codes exposed by the MCP tool contract. */
export type MemoryMcpErrorCode =
  | "SESSION_NOT_FOUND"
  | "SPACE_NOT_BOUND"
  | "SPACE_BINDING_CONFLICT"
  | "MEMORY_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "PROMOTION_REJECTED"
  | "CORE_CAPACITY_REACHED"
  | "MEMORY_SERVICE_UNAVAILABLE";

/** Structured error envelope returned by the MCP tool boundary. */
export interface MemoryMcpError {
  code: MemoryMcpErrorCode;
  message: string;
  retryable: boolean;
}

/** Internal exception carrying a stable MCP error envelope. */
export class MemoryMcpCommandError extends Error {
  readonly error: MemoryMcpError;

  constructor(error: MemoryMcpError, options: { cause?: unknown } = {}) {
    super(error.message, options);
    this.name = "MemoryMcpCommandError";
    this.error = error;
  }
}

/** Creates an actionable MCP command error with optional causal provenance. */
export function commandError(
  code: MemoryMcpErrorCode,
  message: string,
  retryable = false,
  cause?: unknown
): MemoryMcpCommandError {
  return new MemoryMcpCommandError({ code, message, retryable }, { cause });
}

/** Maps domain and unexpected failures to the stable MCP error contract. */
export function toMemoryMcpError(error: unknown): MemoryMcpError {
  if (error instanceof MemoryMcpCommandError) return error.error;
  if (error instanceof MemorySpaceError) {
    switch (error.code) {
      case "SESSION_NOT_FOUND":
        return { code: "SESSION_NOT_FOUND", message: error.message, retryable: false };
      case "SPACE_NOT_BOUND":
        return {
          code: "SPACE_NOT_BOUND",
          message: "No Memory Space binding is available for this request",
          retryable: false
        };
      case "SPACE_BINDING_CONFLICT":
      case "PROVIDER_SESSION_SPACE_CONFLICT":
        return { code: "SPACE_BINDING_CONFLICT", message: error.message, retryable: false };
      case "PROMOTION_REJECTED":
      case "MEMORY_NOT_ACTIVE":
        return { code: "PROMOTION_REJECTED", message: error.message, retryable: false };
      case "CORE_CAPACITY_REACHED":
        return { code: "CORE_CAPACITY_REACHED", message: error.message, retryable: false };
      case "SPACE_BINDING_INVALID":
        return {
          code: "VALIDATION_ERROR",
          message: "Memory Space binding is invalid",
          retryable: false
        };
      case "VALIDATION_ERROR":
      case "MEMORY_KEY_SCHEMA_CONFLICT":
      case "CONFLICT":
        return { code: "VALIDATION_ERROR", message: error.message, retryable: false };
    }
  }
  return {
    code: "MEMORY_SERVICE_UNAVAILABLE",
    message: "Memory service unavailable",
    retryable: true
  };
}
