import type {
  BindingResult,
  BootstrapResult,
  BrowseResult,
  HandoffSnapshot,
  Memory,
  MemoryFilters,
  MemoryHistoryRecord,
  OverviewResult,
  SearchResult,
  Session,
  SessionEvent
} from "./types";

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = await response.json() as ErrorBody;
    } catch {
      // Static serving errors may be plain text; the HTTP status remains useful.
    }
    throw new ApiError(
      response.status,
      body.error?.message ?? `Request failed with status ${response.status}`,
      body.error?.code
    );
  }
  return await response.json() as T;
}

function addFilters(params: URLSearchParams, filters: MemoryFilters): void {
  if (filters.families?.length) params.set("families", filters.families.join(","));
  if (filters.types?.length) params.set("types", filters.types.join(","));
  if (filters.tiers?.length) params.set("tiers", filters.tiers.join(","));
  if (filters.statuses?.length) params.set("statuses", filters.statuses.join(","));
}

export const inspectorApi = {
  binding: (): Promise<BindingResult> => request("/inspector/api/binding"),
  overview: (spaceId: string): Promise<OverviewResult> => (
    request(`/spaces/${encodeURIComponent(spaceId)}/overview`)
  ),
  bootstrap: (spaceId: string): Promise<BootstrapResult> => (
    request(`/spaces/${encodeURIComponent(spaceId)}/bootstrap`)
  ),
  handoff: async (spaceId: string): Promise<HandoffSnapshot | undefined> => {
    try {
      return await request(`/spaces/${encodeURIComponent(spaceId)}/handoff/latest`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  },
  browse: (
    spaceId: string,
    filters: MemoryFilters = {},
    limit = 50,
    cursor?: string
  ): Promise<BrowseResult> => {
    const params = new URLSearchParams({ limit: String(limit) });
    addFilters(params, filters);
    if (cursor) params.set("cursor", cursor);
    return request(`/spaces/${encodeURIComponent(spaceId)}/memories?${params}`);
  },
  search: (spaceId: string, query: string, filters: MemoryFilters = {}): Promise<SearchResult[]> => {
    const params = new URLSearchParams({ query, limit: "100" });
    addFilters(params, filters);
    return request(`/spaces/${encodeURIComponent(spaceId)}/memories/search?${params}`);
  },
  allMemories: async (spaceId: string, filters: MemoryFilters = {}): Promise<Memory[]> => {
    const memories: Memory[] = [];
    let cursor: string | undefined;
    do {
      const page = await inspectorApi.browse(spaceId, filters, 100, cursor);
      memories.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return memories;
  },
  memory: (memoryId: string): Promise<Memory> => request(`/memories/${encodeURIComponent(memoryId)}`),
  history: (memoryId: string): Promise<MemoryHistoryRecord[]> => (
    request(`/memories/${encodeURIComponent(memoryId)}/history`)
  ),
  session: (sessionId: string): Promise<Session> => request(`/sessions/${encodeURIComponent(sessionId)}`),
  sessions: (): Promise<Session[]> => request("/inspector/api/sessions"),
  sessionEvents: (sessionId: string): Promise<SessionEvent[]> => (
    request(`/inspector/api/sessions/${encodeURIComponent(sessionId)}/events`)
  )
};
