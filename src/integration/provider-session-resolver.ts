import type { MemorySpace } from "../application/memory-space.ts";
import { ValidationError } from "../domain/errors.ts";
import type { Session } from "../domain/types.ts";
import type { SessionProjectBindingInput } from "../application/memory-space.ts";
import { ProviderSessionNotFoundError } from "./errors.ts";

/** Provider identity and Space data used for Session resolution. */
export interface ProviderSessionResolutionInput {
  provider: string;
  externalSessionId?: string;
  spaceId: string;
  agentId?: string;
  projectBinding?: SessionProjectBindingInput;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

/** Resolves durable provider Sessions while freezing their original Space identity. */
export class ProviderSessionResolver {
  readonly memorySpace: MemorySpace;

  constructor(memorySpace: MemorySpace) {
    this.memorySpace = memorySpace;
  }

  async resolve(input: ProviderSessionResolutionInput): Promise<Session> {
    const provider = requiredString(input.provider, "provider");
    const spaceId = requiredString(input.spaceId, "spaceId");
    const externalSessionId = optionalString(input.externalSessionId, "externalSessionId");
    const agentId = optionalString(input.agentId, "agentId");
    await this.memorySpace.getSpace(spaceId);
    if (!externalSessionId) {
      return this.memorySpace.createSession({ spaceId, provider, agentId }, input.projectBinding);
    }

    return this.memorySpace.getOrCreateProviderSession(
      { spaceId, provider, externalSessionId, agentId },
      input.projectBinding
    );
  }

  async find(providerInput: string, externalSessionIdInput: string): Promise<Session> {
    const provider = requiredString(providerInput, "provider");
    const externalSessionId = requiredString(externalSessionIdInput, "externalSessionId");
    const session = await this.memorySpace.findProviderSession(provider, externalSessionId);
    if (!session) throw new ProviderSessionNotFoundError(provider, externalSessionId);
    return session;
  }

  async findOptional(
    providerInput: string,
    externalSessionIdInput: string
  ): Promise<Session | undefined> {
    const provider = requiredString(providerInput, "provider");
    const externalSessionId = requiredString(externalSessionIdInput, "externalSessionId");
    return this.memorySpace.findProviderSession(provider, externalSessionId);
  }
}
