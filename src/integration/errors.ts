import { MemorySpaceError } from "../domain/errors.ts";

export class SpaceNotBoundError extends MemorySpaceError {
  constructor(cwd: string) {
    super(`No Memory Space binding found from: ${cwd}`, { code: "SPACE_NOT_BOUND", status: 404 });
  }
}

export class SpaceBindingInvalidError extends MemorySpaceError {
  constructor(path: string, cause?: unknown) {
    super(`Invalid Memory Space binding: ${path}`, { code: "SPACE_BINDING_INVALID", status: 422, cause });
  }
}

export class SpaceBindingConflictError extends MemorySpaceError {
  constructor(provider: string, externalSessionId: string, expectedSpaceId: string, actualSpaceId: string) {
    super(
      `Provider Session ${provider}:${externalSessionId} is bound to Space ${actualSpaceId}, not ${expectedSpaceId}`,
      { code: "SPACE_BINDING_CONFLICT", status: 409 }
    );
  }
}

export class ProviderSessionNotFoundError extends MemorySpaceError {
  constructor(provider: string, externalSessionId: string) {
    super(`Provider Session not found: ${provider}:${externalSessionId}`, {
      code: "SESSION_NOT_FOUND", status: 404
    });
  }
}
