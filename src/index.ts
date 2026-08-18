export { MemorySpace } from "./application/memory-space.ts";
export { createDefaultMemorySpace } from "./composition.ts";
export type { DefaultMemorySpaceOptions } from "./composition.ts";
export type {
  AppendEventInput,
  BootstrapResult,
  BrowseMemoriesInput,
  BrowseMemoriesResult,
  CheckpointInput,
  ContextResult,
  CreateSessionInput,
  CreateSpaceInput,
  MemoryOverviewResult,
  ProviderSessionInput,
  RememberInput,
  SessionProjectBindingInput
} from "./application/memory-space.ts";
export { RuleBasedExtractor, NoopExtractor } from "./adapters/rule-based-extractor.ts";
export { ClaudeAdapter } from "./adapters/providers/claude-code/adapter.ts";
export {
  claudeCodeUnavailableOutput,
  claudeCodePromptContextOutput,
  claudeCodeWarningOutput,
  renderClaudeCodeBootstrap
} from "./adapters/providers/claude-code/bootstrap-renderer.ts";
export type {
  ClaudeCodeBootstrapOutput,
  ClaudeCodeHookOutput
} from "./adapters/providers/claude-code/bootstrap-renderer.ts";
export { invokeClaudeCodeLifecycleHook } from "./adapters/providers/claude-code/hook-client.ts";
export type {
  InvokeClaudeCodeLifecycleHookOptions
} from "./adapters/providers/claude-code/hook-client.ts";
export { ClaudeCodeLifecycleIntegration } from "./adapters/providers/claude-code/integration.ts";
export type {
  ClaudeCodeLifecycleIntegrationOptions,
  ClaudeCodeLifecycleResponse,
  ClaudeCodeLifecycleRuntimeContext
} from "./adapters/providers/claude-code/integration.ts";
export { CodexAdapter } from "./adapters/providers/codex/adapter.ts";
export {
  codexUnavailableOutput,
  codexPromptContextOutput,
  codexWarningOutput,
  renderCodexBootstrap
} from "./adapters/providers/codex/bootstrap-renderer.ts";
export type {
  CodexBootstrapOutput,
  CodexHookOutput
} from "./adapters/providers/codex/bootstrap-renderer.ts";
export { invokeCodexLifecycleHook } from "./adapters/providers/codex/hook-client.ts";
export type { InvokeCodexLifecycleHookOptions } from "./adapters/providers/codex/hook-client.ts";
export { CodexLifecycleIntegration } from "./adapters/providers/codex/integration.ts";
export type {
  CodexLifecycleIntegrationOptions,
  CodexLifecycleResponse,
  CodexLifecycleRuntimeContext
} from "./adapters/providers/codex/integration.ts";
export { SqliteMemoryStore } from "./adapters/sqlite/sqlite-store.ts";
export { NoopCache } from "./ports/cache.ts";
export type { CachePort } from "./ports/cache.ts";
export type { MemoryExtractor, ExtractionContext } from "./ports/extractor.ts";
export type {
  SessionProjectBinding,
  SessionProjectBindingSource
} from "./ports/session-binding.ts";
export type { MemoryStore, MemoryFilters, MemoryHistoryRecord } from "./ports/store.ts";
export type { TranscriptReader, TranscriptReadOptions, TranscriptChunk } from "./ports/transcript-reader.ts";
export { SpaceResolver } from "./binding/space-resolver.ts";
export type { SpaceBinding, SpaceResolutionInput } from "./binding/space-resolver.ts";
export { resolveImplicitRecallConfiguration } from "./binding/project-config.ts";
export type {
  ImplicitRecallConfiguration,
  ImplicitRecallConfigSource,
  ImplicitRecallMode
} from "./binding/project-config.ts";
export { ProviderSessionResolver } from "./integration/provider-session-resolver.ts";
export type { ProviderSessionResolutionInput } from "./integration/provider-session-resolver.ts";
export { CheckpointPolicy } from "./integration/checkpoint-policy.ts";
export type { CheckpointCoordinator, CheckpointPolicyResult } from "./integration/checkpoint-policy.ts";
export { LifecycleHandler } from "./integration/lifecycle-handler.ts";
export type {
  LifecycleContext,
  LifecycleDiagnostic,
  LifecycleResult,
  LifecycleWarning
} from "./integration/lifecycle-handler.ts";
export {
  exactPromptControl,
  extractExactKeyCandidates,
  implicitRecallDefaults,
  ImplicitRecallService,
  renderImplicitRecallContext
} from "./integration/implicit-recall.ts";
export type {
  ImplicitRecallDebugItem,
  ImplicitRecallInput,
  ImplicitRecallOptions,
  ImplicitRecallReason,
  ImplicitRecallResult,
  ImplicitRecallServicePort
} from "./integration/implicit-recall.ts";
export {
  promptMemoryDirective,
  promptMemoryDisabledContext
} from "./integration/prompt-memory-directive.ts";
export type { PromptMemoryDirective } from "./integration/prompt-memory-directive.ts";
export {
  ProviderSessionNotFoundError,
  SpaceBindingConflictError,
  SpaceBindingInvalidError,
  SpaceNotBoundError
} from "./integration/errors.ts";
export { validateProviderLifecycleEvent } from "./provider/types.ts";
export type {
  CheckpointTrigger,
  ProviderAdapter,
  ProviderAssistantTurnEvent,
  ProviderBootstrapOutput,
  ProviderBootstrapRenderInput,
  ProviderCapability,
  ProviderEventBase,
  ProviderLifecycleEvent,
  ProviderPreCompactEvent,
  ProviderSessionEndEvent,
  ProviderSessionStartEvent,
  ProviderUserPromptEvent,
  TranscriptRef
} from "./provider/types.ts";
export { createMemoryMcpServer, createMemoryMcpServerForGateway } from "./mcp/server.ts";
export type { CreateMemoryMcpServerOptions } from "./mcp/server.ts";
export { MemoryMcpGateway } from "./mcp/tools.ts";
export type {
  MemoryBootstrapToolInput,
  MemoryCheckpointToolInput,
  MemoryContextToolInput,
  MemoryPromoteToolInput,
  MemoryRememberToolInput,
  MemorySearchToolInput
} from "./mcp/tools.ts";
export { MCPRequestContextResolver } from "./mcp/request-context.ts";
export type {
  MCPRequestContext,
  MCPRuntimeContext,
  ResolvedMCPRequestContext
} from "./mcp/request-context.ts";
export { MemoryMcpCommandError, toMemoryMcpError } from "./mcp/errors.ts";
export type { MemoryMcpError, MemoryMcpErrorCode } from "./mcp/errors.ts";
export { createMemorySpaceDaemon, isLoopbackHost, startServer } from "./daemon.ts";
export type { MemorySpaceDaemon, MemorySpaceDaemonOptions } from "./daemon.ts";
export * from "./domain/types.ts";
export { MemorySpaceError, NotFoundError, ValidationError, ConflictError } from "./domain/errors.ts";
