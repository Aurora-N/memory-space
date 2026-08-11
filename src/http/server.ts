import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MemorySpace,
  type AppendEventInput,
  type CreateSessionInput,
  type CreateSpaceInput,
  type RememberInput
} from "../application/memory-space.ts";
import { MemorySpaceError, NotFoundError, ValidationError } from "../domain/errors.ts";
import type { MemorySearchInput, MemoryStatus } from "../domain/types.ts";

type JsonObject = Record<string, unknown>;
type Params = Record<string, string>;

async function readBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new ValidationError("Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError("Request body must be a JSON object");
    }
    return value as JsonObject;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Request body must be valid JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function match(pathname: string, pattern: string): Params | undefined {
  const names: string[] = [];
  const expression = pattern.replace(/:([^/]+)/g, (_value, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  const values = pathname.match(new RegExp(`^${expression}$`));
  if (!values) return undefined;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(values[index + 1])]));
}

function csv(value: string | null): string[] | undefined {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function searchInput(spaceId: string, url: URL): MemorySearchInput {
  return {
    spaceId, query: url.searchParams.get("query") ?? "",
    families: csv(url.searchParams.get("families")) as MemorySearchInput["families"],
    types: csv(url.searchParams.get("types")),
    tiers: csv(url.searchParams.get("tiers")) as MemorySearchInput["tiers"],
    statuses: csv(url.searchParams.get("statuses")) as MemorySearchInput["statuses"],
    limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined
  };
}

export function createRequestHandler(memorySpace: MemorySpace) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://memory-space.local");
      const route = (method: string, pattern: string): Params | undefined =>
        request.method === method ? match(url.pathname, pattern) : undefined;
      let params: Params | undefined;
      let result: unknown;
      let status = 200;

      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok" });
      } else if (request.method === "POST" && url.pathname === "/spaces") {
        result = await memorySpace.createSpace(await readBody(request) as unknown as CreateSpaceInput);
        status = 201;
      } else if ((params = route("GET", "/spaces/:spaceId"))) {
        result = await memorySpace.getSpace(params.spaceId);
      } else if ((params = route("POST", "/spaces/:spaceId/sessions"))) {
        const body = await readBody(request);
        result = await memorySpace.createSession({ ...body, spaceId: params.spaceId } as unknown as CreateSessionInput);
        status = 201;
      } else if ((params = route("GET", "/sessions/:sessionId"))) {
        result = await memorySpace.getSession(params.sessionId);
      } else if ((params = route("POST", "/sessions/:sessionId/events"))) {
        const body = await readBody(request);
        result = await memorySpace.appendEvent({ ...body, sessionId: params.sessionId } as unknown as AppendEventInput);
        status = 201;
      } else if ((params = route("GET", "/sessions/:sessionId/events"))) {
        result = await memorySpace.listEvents(params.sessionId);
      } else if ((params = route("POST", "/spaces/:spaceId/memories"))) {
        const body = await readBody(request);
        result = await memorySpace.remember({ ...body, spaceId: params.spaceId } as unknown as RememberInput);
        status = 201;
      } else if ((params = route("GET", "/memories/:memoryId/history"))) {
        result = await memorySpace.getMemoryHistory(params.memoryId);
      } else if ((params = route("GET", "/memories/:memoryId"))) {
        result = await memorySpace.getMemory(params.memoryId);
      } else if ((params = route("POST", "/memories/:memoryId/promote"))) {
        const body = await readBody(request);
        if ("actor" in body) {
          throw new ValidationError("promotion actor is determined by the trusted adapter and cannot be provided");
        }
        result = await memorySpace.promote(params.memoryId, {
          actor: "agent", reason: body.reason as string | undefined
        });
      } else if ((params = route("POST", "/memories/:memoryId/demote"))) {
        result = await memorySpace.demote(params.memoryId, await readBody(request) as { reason?: string });
      } else if ((params = route("POST", "/memories/:memoryId/status"))) {
        const body = await readBody(request);
        result = await memorySpace.setMemoryStatus(
          params.memoryId, body.status as MemoryStatus, { reason: body.reason as string | undefined }
        );
      } else if ((params = route("GET", "/spaces/:spaceId/memories/search"))) {
        result = await memorySpace.search(searchInput(params.spaceId, url));
      } else if ((params = route("POST", "/spaces/:spaceId/memory-context"))) {
        const body = await readBody(request);
        result = await memorySpace.context({ ...body, spaceId: params.spaceId } as unknown as MemorySearchInput);
      } else if ((params = route("POST", "/sessions/:sessionId/checkpoints"))) {
        const body = await readBody(request);
        result = await memorySpace.checkpoint({
          sessionId: params.sessionId,
          toEventId: body.toEventId as string | undefined,
          idempotencyKey: body.idempotencyKey as string
        });
        status = 201;
      } else if ((params = route("GET", "/checkpoints/:checkpointId"))) {
        result = await memorySpace.getCheckpoint(params.checkpointId);
      } else if ((params = route("GET", "/spaces/:spaceId/handoff/latest"))) {
        result = await memorySpace.getLatestHandoff(params.spaceId);
      } else if ((params = route("GET", "/spaces/:spaceId/bootstrap"))) {
        result = await memorySpace.bootstrap(params.spaceId);
      } else {
        throw new NotFoundError("Route", `${request.method} ${url.pathname}`);
      }
      send(response, status, result);
    } catch (error) {
      const known = error instanceof MemorySpaceError;
      send(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "Internal server error"
        }
      });
      if (!known) console.error(error);
    }
  };
}
