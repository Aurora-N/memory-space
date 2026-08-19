import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemorySpace } from "../application/memory-space.ts";
import { SpaceResolver, type SpaceResolutionInput } from "../binding/space-resolver.ts";
import { MemorySpaceError, NotFoundError } from "../domain/errors.ts";
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
    if (request.method !== "GET" || !url.pathname.startsWith("/inspector/api/")) return false;
    try {
      const binding = await spaceResolver.resolve(options.runtime);
      const space = await options.memorySpace.getSpace(binding.spaceId);
      if (url.pathname === "/inspector/api/binding") {
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
      }
      if (url.pathname === "/inspector/api/sessions") {
        sendJson(response, 200, await options.memorySpace.listSessions(space.id));
        return true;
      }
      const match = url.pathname.match(/^\/inspector\/api\/sessions\/([^/]+)\/events$/u);
      if (!match) return false;
      const sessionId = decodeURIComponent(match[1]);
      const session = await options.memorySpace.getSession(sessionId);
      if (session.spaceId !== space.id) throw new NotFoundError("Session", sessionId);
      sendJson(response, 200, await options.memorySpace.listEvents(session.id));
    } catch (error) {
      const known = error instanceof MemorySpaceError;
      sendJson(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "Internal server error"
        }
      });
      if (!known) console.error(error);
    }
    return true;
  };
}
