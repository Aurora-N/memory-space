import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { HandoffSnapshot, Space } from "../domain/types.ts";
import { CliError } from "./errors.ts";

export const DEFAULT_DAEMON_ENDPOINT = "http://127.0.0.1:4310";
export const MEMORY_MCP_TOOLS = [
  "memory_bootstrap",
  "memory_checkpoint",
  "memory_context",
  "memory_promote",
  "memory_remember",
  "memory_search"
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export interface LocalMemorySpaceClientPort {
  readonly endpoint: string;
  health(): Promise<void>;
  createSpace(input: { id?: string; name: string }): Promise<Space>;
  getSpace(spaceId: string): Promise<Space>;
  getLatestHandoff(spaceId: string): Promise<HandoffSnapshot | undefined>;
  listMcpTools(): Promise<string[]>;
  getDaemonIdentity(): Promise<DaemonIdentity>;
  getInspectorBinding(): Promise<InspectorBinding>;
  checkInspector(): Promise<void>;
}

export interface DaemonIdentity {
  cwd: string;
}

export interface InspectorBinding {
  space: Space;
  binding: { spaceId: string; source: "explicit" | "config"; configPath?: string };
  cwd: string;
}

export function validateDaemonEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CliError("DAEMON_ENDPOINT_INVALID", "Daemon endpoint is not a valid URL.", {
      remediation: `Use a loopback URL such as ${DEFAULT_DAEMON_ENDPOINT}.`,
      cause: error
    });
  }
  if (url.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || url.username !== ""
    || url.password !== ""
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search !== ""
    || url.hash !== "") {
    throw new CliError(
      "DAEMON_ENDPOINT_INVALID",
      "Daemon endpoint must be a credential-free loopback HTTP origin.",
      { remediation: `Use a URL such as ${DEFAULT_DAEMON_ENDPOINT}.` }
    );
  }
  url.pathname = "/";
  return url;
}

interface DaemonErrorBody {
  error?: { code?: unknown; message?: unknown };
}

export class LocalMemorySpaceClient implements LocalMemorySpaceClientPort {
  readonly endpoint: string;
  readonly #origin: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: {
    endpoint?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    this.#origin = validateDaemonEndpoint(options.endpoint ?? DEFAULT_DAEMON_ENDPOINT);
    this.endpoint = this.#origin.origin;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 3000;
  }

  async health(): Promise<void> {
    const result = await this.#request<{ status?: unknown }>("health");
    if (result.status !== "ok") {
      throw new CliError("DAEMON_REQUEST_FAILED", "Daemon health response is invalid.", {
        remediation: "Restart the Memory Space daemon."
      });
    }
  }

  createSpace(input: { id?: string; name: string }): Promise<Space> {
    return this.#request<Space>("spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  getSpace(spaceId: string): Promise<Space> {
    return this.#request<Space>(`spaces/${encodeURIComponent(spaceId)}`);
  }

  async getLatestHandoff(spaceId: string): Promise<HandoffSnapshot | undefined> {
    try {
      return await this.#request<HandoffSnapshot>(
        `spaces/${encodeURIComponent(spaceId)}/handoff/latest`
      );
    } catch (error) {
      if (error instanceof CliError && error.code === "SPACE_NOT_FOUND") return undefined;
      throw error;
    }
  }

  async listMcpTools(): Promise<string[]> {
    const client = new Client({ name: "memory-space-cli", version: "1.0.0" });
    try {
      const timedFetch: typeof fetch = (input, init) => {
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        const signal = init?.signal
          ? AbortSignal.any([init.signal, timeout])
          : timeout;
        return this.#fetch(input, { ...init, signal, redirect: "error" });
      };
      const transport = new StreamableHTTPClientTransport(
        new URL("mcp", this.#origin),
        { fetch: timedFetch }
      );
      await client.connect(transport);
      const result = await client.listTools();
      return result.tools.map((tool) => tool.name).sort();
    } catch (error) {
      throw new CliError("MCP_UNAVAILABLE", "MCP endpoint is unavailable.", {
        remediation: "Confirm the daemon is running and its /mcp endpoint is reachable.",
        cause: error
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async getDaemonIdentity(): Promise<DaemonIdentity> {
    const value = await this.#request<Partial<DaemonIdentity>>("daemon/identity");
    if (typeof value.cwd !== "string") {
      throw new CliError("DAEMON_REQUEST_FAILED", "Daemon identity response is invalid.", {
        remediation: "Restart the Memory Space daemon with the current CLI version."
      });
    }
    return value as DaemonIdentity;
  }

  getInspectorBinding(): Promise<InspectorBinding> {
    return this.#request<InspectorBinding>("inspector/api/binding");
  }

  async checkInspector(): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(new URL("inspector/", this.#origin), {
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      throw new CliError("INSPECTOR_UNAVAILABLE", "Memory Inspector is unavailable.", {
        remediation: "Build the Inspector assets and restart the daemon.",
        cause: error
      });
    }
    if (!response.ok) {
      throw new CliError("INSPECTOR_UNAVAILABLE", "Memory Inspector assets are unavailable.", {
        remediation: "From the source repository, run: pnpm inspector:build"
      });
    }
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#origin), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch (error) {
      throw new CliError("DAEMON_UNAVAILABLE", "Daemon unavailable.", {
        remediation: "Start it with: pnpm start",
        cause: error
      });
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch (error) {
      throw new CliError("DAEMON_REQUEST_FAILED", "Daemon returned an invalid response.", {
        remediation: "Restart the Memory Space daemon.",
        cause: error
      });
    }
    if (!response.ok) {
      const daemonError = (body as DaemonErrorBody).error;
      const daemonCode = typeof daemonError?.code === "string" ? daemonError.code : undefined;
      const message = typeof daemonError?.message === "string"
        ? daemonError.message
        : `Daemon request failed with status ${response.status}.`;
      if (response.status === 404 || daemonCode === "NOT_FOUND") {
        throw new CliError("SPACE_NOT_FOUND", message, {
          remediation: "Check the project binding or run memory-space init."
        });
      }
      if (daemonCode === "VALIDATION_ERROR") {
        throw new CliError("VALIDATION_ERROR", message);
      }
      throw new CliError("DAEMON_REQUEST_FAILED", message, {
        remediation: "Run memory-space doctor for diagnostics."
      });
    }
    return body as T;
  }
}
