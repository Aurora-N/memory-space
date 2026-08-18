import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { ClaudeCodeLifecycleRuntimeContext } from "./adapters/providers/claude-code/integration.ts";
import { ClaudeCodeLifecycleIntegration } from "./adapters/providers/claude-code/integration.ts";
import type { CodexLifecycleRuntimeContext } from "./adapters/providers/codex/integration.ts";
import { CodexLifecycleIntegration } from "./adapters/providers/codex/integration.ts";
import type { MemorySpace } from "./application/memory-space.ts";
import { SpaceResolver } from "./binding/space-resolver.ts";
import {
  createDefaultMemoryExtractor,
  createDefaultMemorySpace,
  type DefaultMemorySpaceOptions,
} from "./composition.ts";
import { MemorySpaceError, ValidationError } from "./domain/errors.ts";
import { createInspectorRequestHandler } from "./http/inspector.ts";
import { createInspectorStaticHandler } from "./http/inspector-static.ts";
import { createRequestHandler, readJsonBody, sendJson } from "./http/server.ts";
import { CheckpointPolicy } from "./integration/checkpoint-policy.ts";
import { ImplicitRecallService } from "./integration/implicit-recall.ts";
import { type LifecycleDiagnostic, LifecycleHandler } from "./integration/lifecycle-handler.ts";
import { ProjectExtractionRuleExtractor } from "./integration/project-extraction-rule-extractor.ts";
import { ProviderSessionResolver } from "./integration/provider-session-resolver.ts";
import type { MCPRuntimeContext } from "./mcp/request-context.ts";
import { createMemoryMcpServerForGateway } from "./mcp/server.ts";
import { MemoryMcpGateway } from "./mcp/tools.ts";

/** Runtime configuration for the loopback-only daemon composition root. */
export interface MemorySpaceDaemonOptions extends DefaultMemorySpaceOptions {
  host?: string;
  port?: number;
  mcpRuntime?: MCPRuntimeContext;
  codexRuntime?: CodexLifecycleRuntimeContext;
  claudeCodeRuntime?: ClaudeCodeLifecycleRuntimeContext;
  memorySpaceFactory?: (options: DefaultMemorySpaceOptions) => MemorySpace;
  onMcpError?: (error: Error) => void;
  onLifecycleDiagnostic?: (diagnostic: LifecycleDiagnostic) => void;
  inspectorDirectory?: string | false;
}

/** Owned daemon resources; close releases HTTP and MemorySpace exactly once. */
export interface MemorySpaceDaemon {
  readonly server: Server;
  readonly memorySpace: MemorySpace;
  readonly lifecycleHandler: LifecycleHandler;
  readonly codexIntegration: CodexLifecycleIntegration;
  readonly claudeCodeIntegration: ClaudeCodeLifecycleIntegration;
  readonly mcpGateway: MemoryMcpGateway;
  readonly mcpHttpHandler: McpHttpHandler;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function logLifecycleDiagnostic(diagnostic: LifecycleDiagnostic): void {
  console.warn(
    `[memory-space] ${diagnostic.warning.error.code}: ${diagnostic.warning.error.message}`
  );
}

/** Returns whether a host is one of the explicitly supported loopback names. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function internalError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const known = error instanceof MemorySpaceError;
  if (!known) console.error(error);
  sendJson(response, known ? error.status : 500, {
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "Internal server error",
    },
  });
}

/** Composes HTTP, MCP, lifecycle integrations, and Inspector around one MemorySpace. */
export function createMemorySpaceDaemon(options: MemorySpaceDaemonOptions = {}): MemorySpaceDaemon {
  const host = options.host ?? process.env.MEMORY_SPACE_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new ValidationError(
      "Memory Space daemon host must be a loopback address (127.0.0.1, ::1, or localhost)"
    );
  }
  const port = options.port ?? Number(process.env.MEMORY_SPACE_PORT ?? 4310);
  const runtimeCwd = options.mcpRuntime?.cwd ?? process.env.MEMORY_SPACE_CWD ?? process.cwd();
  const runtime: MCPRuntimeContext = {
    cwd: runtimeCwd,
    explicitSpaceId: options.mcpRuntime?.explicitSpaceId ?? process.env.MEMORY_SPACE_SPACE_ID,
  };
  const spaceResolver = new SpaceResolver();
  const memorySpaceOptions: DefaultMemorySpaceOptions = {
    databasePath: options.databasePath ?? process.env.MEMORY_SPACE_DB ?? "./data/memory-space.db",
    extractor:
      options.extractor ??
      createDefaultMemoryExtractor([
        new ProjectExtractionRuleExtractor({
          cwd: runtimeCwd,
          explicitSpaceId: runtime.explicitSpaceId,
          spaceResolver,
        }),
      ]),
    cache: options.cache,
    coreLimit: options.coreLimit ?? Number(process.env.MEMORY_SPACE_CORE_LIMIT ?? 64),
  };
  const memorySpace = (options.memorySpaceFactory ?? createDefaultMemorySpace)(memorySpaceOptions);
  const checkpointPolicy = new CheckpointPolicy(memorySpace);
  const lifecycleHandler = new LifecycleHandler({
    memorySpace,
    spaceResolver,
    sessionResolver: new ProviderSessionResolver(memorySpace),
    checkpointPolicy,
    implicitRecall: new ImplicitRecallService(memorySpace),
    onWarning: options.onLifecycleDiagnostic ?? logLifecycleDiagnostic,
  });
  const codexRuntime: CodexLifecycleRuntimeContext = {
    cwd: options.codexRuntime?.cwd ?? runtime.cwd,
    explicitSpaceId: options.codexRuntime?.explicitSpaceId ?? runtime.explicitSpaceId,
  };
  const codexIntegration = new CodexLifecycleIntegration({
    lifecycleHandler,
    runtime: codexRuntime,
  });
  const claudeCodeRuntime: ClaudeCodeLifecycleRuntimeContext = {
    cwd: options.claudeCodeRuntime?.cwd ?? runtime.cwd,
    explicitSpaceId: options.claudeCodeRuntime?.explicitSpaceId ?? runtime.explicitSpaceId,
  };
  const claudeCodeIntegration = new ClaudeCodeLifecycleIntegration({
    lifecycleHandler,
    runtime: claudeCodeRuntime,
  });
  const mcpGateway = new MemoryMcpGateway({
    memorySpace,
    spaceResolver,
    checkpointPolicy,
    ...runtime,
  });
  const mcpHttpHandler = createMcpHandler(() => createMemoryMcpServerForGateway(mcpGateway), {
    legacy: "stateless",
    onerror: options.onMcpError ?? ((error) => console.error(error)),
  });
  const mcpNodeHandler = toNodeHandler(mcpHttpHandler, {
    onerror: options.onMcpError ?? ((error) => console.error(error)),
  });
  const httpHandler = createRequestHandler(memorySpace);
  const inspectorHandler = createInspectorRequestHandler({
    memorySpace,
    spaceResolver,
    runtime,
  });
  const inspectorDirectory =
    options.inspectorDirectory ?? fileURLToPath(new URL("../apps/inspector/dist", import.meta.url));
  const inspectorStaticHandler = createInspectorStaticHandler(inspectorDirectory);
  const validateLocalHost = localhostHostValidation();
  const validateLocalOrigin = localhostOriginValidation();
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://memory-space.local");
    const healthRequest = request.method === "GET" && url.pathname === "/health";
    if (
      !healthRequest &&
      (!validateLocalHost(request, response) || !validateLocalOrigin(request, response))
    )
      return;
    if (url.pathname === "/mcp") {
      await mcpNodeHandler(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/daemon/identity") {
      sendJson(response, 200, {
        cwd: runtime.cwd,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/providers/codex/lifecycle") {
      sendJson(response, 200, await codexIntegration.handleNative(await readJsonBody(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/providers/claude-code/lifecycle") {
      sendJson(
        response,
        200,
        await claudeCodeIntegration.handleNative(await readJsonBody(request))
      );
      return;
    }
    if (await inspectorHandler(request, response)) return;
    if (await inspectorStaticHandler(request, response)) return;
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
            server.close((error) => (error ? reject(error) : resolve()));
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
    claudeCodeIntegration,
    mcpGateway,
    mcpHttpHandler,
    listen,
    close,
  };
}

/** Creates and begins listening with process signal cleanup attached. */
export function startServer(options: MemorySpaceDaemonOptions = {}): MemorySpaceDaemon {
  const daemon = createMemorySpaceDaemon(options);
  const detachSignals = (): void => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  const shutdown = (): void => {
    void daemon
      .close()
      .then(detachSignals)
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
        detachSignals();
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  void daemon
    .listen()
    .then((address) => {
      console.log(`memory-space listening on http://${address.address}:${address.port}`);
      console.log(`memory-space MCP endpoint: http://${address.address}:${address.port}/mcp`);
      console.log(
        `memory-space Codex lifecycle endpoint: http://${address.address}:${address.port}/providers/codex/lifecycle`
      );
      console.log(
        `memory-space Claude Code lifecycle endpoint: http://${address.address}:${address.port}/providers/claude-code/lifecycle`
      );
      console.log(`memory-space Inspector: http://${address.address}:${address.port}/inspector/`);
    })
    .catch(async (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      await daemon.close().catch((closeError: unknown) => console.error(closeError));
      detachSignals();
    });
  return daemon;
}
