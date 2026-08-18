import { MemorySpaceError } from "../domain/errors.ts";

/** Indicates that no project Space binding can be resolved. */
export class SpaceNotBoundError extends MemorySpaceError {
  constructor(cwd: string) {
    super(`No Memory Space binding found from: ${cwd}`, { code: "SPACE_NOT_BOUND", status: 404 });
  }
}

/** Indicates that a discovered binding is malformed or unusable. */
export class SpaceBindingInvalidError extends MemorySpaceError {
  constructor(path: string, cause?: unknown) {
    super(`Invalid Memory Space binding: ${path}`, { code: "SPACE_BINDING_INVALID", status: 422, cause });
  }
}

/** Indicates that trusted Session identity conflicts with project binding state. */
export class SpaceBindingConflictError extends MemorySpaceError {
  constructor(provider: string, externalSessionId: string, expectedSpaceId: string, actualSpaceId: string) {
    super(
      `Provider Session ${provider}:${externalSessionId} is bound to Space ${actualSpaceId}, not ${expectedSpaceId}`,
      { code: "SPACE_BINDING_CONFLICT", status: 409 }
    );
  }
}

/** Indicates that a provider identity does not map to a durable Session. */
export class ProviderSessionNotFoundError extends MemorySpaceError {
  constructor(provider: string, externalSessionId: string) {
    super(`Provider Session not found: ${provider}:${externalSessionId}`, {
      code: "SESSION_NOT_FOUND", status: 404
    });
  }
}
