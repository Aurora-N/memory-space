import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemorySpace } from "../application/memory-space.ts";
import { SpaceResolver, type SpaceResolutionInput } from "../binding/space-resolver.ts";
import { sendJson } from "./server.ts";

export interface InspectorRequestHandlerOptions {
  memorySpace: MemorySpace;
  spaceResolver?: SpaceResolver;
  runtime: SpaceResolutionInput;
}

export function createInspectorRequestHandler(options: InspectorRequestHandlerOptions) {
  const spaceResolver = options.spaceResolver ?? new SpaceResolver();
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://memory-space.local");
    if (request.method !== "GET" || url.pathname !== "/inspector/api/binding") return false;
    const binding = await spaceResolver.resolve(options.runtime);
    const space = await options.memorySpace.getSpace(binding.spaceId);
    sendJson(response, 200, {
      space,
      binding,
      cwd: options.runtime.cwd,
      capabilities: {
        readOnly: true,
        localOnly: true,
        multiSpaceManagement: false
      }
    });
    return true;
  };
}
