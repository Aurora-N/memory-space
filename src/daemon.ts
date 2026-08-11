import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from "@modelcontextprotocol/node";
import type { MemorySpace } from "./application/memory-space.ts";
import { CodexLifecycleIntegration } from "./adapters/providers/codex/integration.ts";
import type { CodexLifecycleRuntimeContext } from "./adapters/providers/codex/integration.ts";
import { SpaceResolver } from "./binding/space-resolver.ts";
import {
  createDefaultMemorySpace,
  type DefaultMemorySpaceOptions
} from "./composition.ts";
import { createRequestHandler, readJsonBody, sendJson } from "./http/server.ts";
import { CheckpointPolicy } from "./integration/checkpoint-policy.ts";
import { LifecycleHandler } from "./integration/lifecycle-handler.ts";
import { ProviderSessionResolver } from "./integration/provider-session-resolver.ts";
import { createMemoryMcpServerForGateway } from "./mcp/server.ts";
import { MemoryMcpGateway } from "./mcp/tools.ts";
import type { MCPRuntimeContext } from "./mcp/request-context.ts";

export interface MemorySpaceDaemonOptions extends DefaultMemorySpaceOptions {
  host?: string;
  port?: number;
  mcpRuntime?: MCPRuntimeContext;
  codexRuntime?: CodexLifecycleRuntimeContext;
  memorySpaceFactory?: (options: DefaultMemorySpaceOptions) => MemorySpace;
  onMcpError?: (error: Error) => void;
}

export interface MemorySpaceDaemon {
  readonly server: Server;
  readonly memorySpace: MemorySpace;
  readonly lifecycleHandler: LifecycleHandler;
  readonly codexIntegration: CodexLifecycleIntegration;
  readonly mcpGateway: MemoryMcpGateway;
  readonly mcpHttpHandler: McpHttpHandler;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

function internalError(response: ServerResponse, error: unknown): void {
  console.error(error);
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" }
  }));
}

export function createMemorySpaceDaemon(
  options: MemorySpaceDaemonOptions = {}
): MemorySpaceDaemon {
  const host = options.host ?? process.env.MEMORY_SPACE_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.MEMORY_SPACE_PORT ?? 4310);
  const memorySpaceOptions: DefaultMemorySpaceOptions = {
    databasePath: options.databasePath ?? process.env.MEMORY_SPACE_DB ?? "./data/memory-space.db",
    extractor: options.extractor,
    cache: options.cache,
    coreLimit: options.coreLimit ?? Number(process.env.MEMORY_SPACE_CORE_LIMIT ?? 64)
  };
  const memorySpace = (options.memorySpaceFactory ?? createDefaultMemorySpace)(memorySpaceOptions);
  const spaceResolver = new SpaceResolver();
  const checkpointPolicy = new CheckpointPolicy(memorySpace);
  const lifecycleHandler = new LifecycleHandler({
    memorySpace,
    spaceResolver,
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy
  });
  const runtime: MCPRuntimeContext = {
    cwd: options.mcpRuntime?.cwd ?? process.env.MEMORY_SPACE_CWD ?? process.cwd(),
    explicitSpaceId: options.mcpRuntime?.explicitSpaceId ?? process.env.MEMORY_SPACE_SPACE_ID
  };
  const codexRuntime: CodexLifecycleRuntimeContext = {
    cwd: options.codexRuntime?.cwd ?? runtime.cwd,
    explicitSpaceId: options.codexRuntime?.explicitSpaceId ?? runtime.explicitSpaceId
  };
  const codexIntegration = new CodexLifecycleIntegration({
    lifecycleHandler,
    runtime: codexRuntime
  });
  const mcpGateway = new MemoryMcpGateway({
    memorySpace,
    spaceResolver,
    checkpointPolicy,
    ...runtime
  });
  const mcpHttpHandler = createMcpHandler(
    () => createMemoryMcpServerForGateway(mcpGateway),
    {
      legacy: "stateless",
      onerror: options.onMcpError ?? ((error) => console.error(error))
    }
  );
  const mcpNodeHandler = toNodeHandler(mcpHttpHandler, {
    onerror: options.onMcpError ?? ((error) => console.error(error))
  });
  const httpHandler = createRequestHandler(memorySpace);
  const validateLocalHost = localhostHostValidation();
  const validateLocalOrigin = localhostOriginValidation();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://memory-space.local");
    const protectedLocalRoute = url.pathname === "/mcp"
      || url.pathname === "/providers/codex/lifecycle";
    if (protectedLocalRoute
      && (!validateLocalHost(request, response) || !validateLocalOrigin(request, response))) return;
    if (url.pathname === "/mcp") {
      await mcpNodeHandler(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/providers/codex/lifecycle") {
      sendJson(response, 200, await codexIntegration.handleNative(await readJsonBody(request)));
      return;
    }
    await httpHandler(request, response);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => internalError(response, error));
  });
  let closePromise: Promise<void> | undefined;

  const listen = async (): Promise<AddressInfo> => {
    if (server.listening) return server.address() as AddressInfo;
    return await new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve(server.address() as AddressInfo);
      });
    });
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let firstError: unknown;
      try {
        await mcpHttpHandler.close();
      } catch (error) {
        firstError = error;
      }
      if (server.listening) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        await memorySpace.close();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError) throw firstError;
    })();
    return closePromise;
  };

  return {
    server,
    memorySpace,
    lifecycleHandler,
    codexIntegration,
    mcpGateway,
    mcpHttpHandler,
    listen,
    close
  };
}

export function startServer(options: MemorySpaceDaemonOptions = {}): MemorySpaceDaemon {
  const daemon = createMemorySpaceDaemon(options);
  const detachSignals = (): void => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  const shutdown = (): void => {
    void daemon.close().then(detachSignals).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      detachSignals();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void daemon.listen().then((address) => {
    console.log(`memory-space listening on http://${address.address}:${address.port}`);
    console.log(`memory-space MCP endpoint: http://${address.address}:${address.port}/mcp`);
    console.log(`memory-space Codex lifecycle endpoint: http://${address.address}:${address.port}/providers/codex/lifecycle`);
  }).catch(async (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
    await daemon.close().catch((closeError: unknown) => console.error(closeError));
    detachSignals();
  });
  return daemon;
}
