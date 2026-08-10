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

export class NotFoundError extends MemorySpaceError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, { code: "NOT_FOUND", status: 404 });
  }
}

export class ValidationError extends MemorySpaceError {
  constructor(message: string) {
    super(message, { code: "VALIDATION_ERROR", status: 422 });
  }
}

export class ConflictError extends MemorySpaceError {
  constructor(message: string, code = "CONFLICT") {
    super(message, { code, status: 409 });
  }
}
