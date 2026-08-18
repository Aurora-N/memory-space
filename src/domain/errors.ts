/** Base actionable error exposed by Memory Space application and delivery APIs. */
export class MemorySpaceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code?: string; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code ?? "MEMORY_SPACE_ERROR";
    this.status = options.status ?? 400;
  }
}

/** Indicates that a requested durable entity does not exist. */
export class NotFoundError extends MemorySpaceError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, { code: "NOT_FOUND", status: 404 });
  }
}

/** Indicates that untrusted or caller-provided input violates a contract. */
export class ValidationError extends MemorySpaceError {
  constructor(message: string) {
    super(message, { code: "VALIDATION_ERROR", status: 422 });
  }
}

/** Indicates that a valid request conflicts with existing durable state. */
export class ConflictError extends MemorySpaceError {
  constructor(message: string, code = "CONFLICT") {
    super(message, { code, status: 409 });
  }
}
