export { ClaudeAdapter } from "./adapters/providers/claude-code/adapter.ts";
export type {
  ClaudeCodeBootstrapOutput,
  ClaudeCodeHookOutput,
} from "./adapters/providers/claude-code/bootstrap-renderer.ts";
export {
  claudeCodePromptContextOutput,
  claudeCodeUnavailableOutput,
  claudeCodeWarningOutput,
  renderClaudeCodeBootstrap,
} from "./adapters/providers/claude-code/bootstrap-renderer.ts";
export type { InvokeClaudeCodeLifecycleHookOptions } from "./adapters/providers/claude-code/hook-client.ts";
export { invokeClaudeCodeLifecycleHook } from "./adapters/providers/claude-code/hook-client.ts";
export type {
  ClaudeCodeLifecycleIntegrationOptions,
  ClaudeCodeLifecycleResponse,
  ClaudeCodeLifecycleRuntimeContext,
} from "./adapters/providers/claude-code/integration.ts";
export { ClaudeCodeLifecycleIntegration } from "./adapters/providers/claude-code/integration.ts";
export { CodexAdapter } from "./adapters/providers/codex/adapter.ts";
export type {
  CodexBootstrapOutput,
  CodexHookOutput,
} from "./adapters/providers/codex/bootstrap-renderer.ts";
export {
  codexPromptContextOutput,
  codexUnavailableOutput,
  codexWarningOutput,
  renderCodexBootstrap,
} from "./adapters/providers/codex/bootstrap-renderer.ts";
export type { InvokeCodexLifecycleHookOptions } from "./adapters/providers/codex/hook-client.ts";
export { invokeCodexLifecycleHook } from "./adapters/providers/codex/hook-client.ts";
export type {
  CodexLifecycleIntegrationOptions,
  CodexLifecycleResponse,
  CodexLifecycleRuntimeContext,
} from "./adapters/providers/codex/integration.ts";
export { CodexLifecycleIntegration } from "./adapters/providers/codex/integration.ts";
export { NoopExtractor, RuleBasedExtractor } from "./adapters/rule-based-extractor.ts";
export { ScriptedSemanticExtractionModel } from "./adapters/semantic-models/fake.ts";
export { OllamaSemanticExtractionModel } from "./adapters/semantic-models/ollama.ts";
export { OpenAiCompatibleSemanticExtractionModel } from "./adapters/semantic-models/openai-compatible.ts";
export { SqliteMemoryStore } from "./adapters/sqlite/sqlite-store.ts";
export type {
  AppendEventInput,
  BootstrapResult,
  BrowseMemoriesInput,
  BrowseMemoriesResult,
  CheckpointInput,
  CommitImplicitCandidateInput,
  CommitImplicitCandidateResult,
  ContextResult,
  CreateSessionInput,
  CreateSpaceInput,
  MemoryOverviewResult,
  ProviderSessionInput,
  RememberInput,
  SessionProjectBindingInput,
} from "./application/memory-space.ts";
export { MemorySpace } from "./application/memory-space.ts";
export type {
  ImplicitRecallConfigSource,
  ImplicitRecallConfiguration,
  ImplicitRecallMode,
  ImplicitRememberConfigSource,
  ImplicitRememberConfiguration,
  ImplicitRememberMode,
  ExternalSemanticModelConfiguration,
  HostAgentSemanticModelConfiguration,
  LocalSemanticModelConfiguration,
  SemanticExtractionConfigSource,
  SemanticExtractionConfiguration,
  SemanticExtractionMode,
  SemanticModelBackend,
  SemanticModelConfiguration,
} from "./binding/project-config.ts";
export {
  resolveImplicitRecallConfiguration,
  resolveImplicitRememberConfiguration,
  resolveSemanticExtractionConfiguration,
  semanticExtractionDefaults,
} from "./binding/project-config.ts";
export type { SpaceBinding, SpaceResolutionInput } from "./binding/space-resolver.ts";
export { SpaceResolver } from "./binding/space-resolver.ts";
export type { DefaultMemorySpaceOptions } from "./composition.ts";
export { createDefaultMemorySpace } from "./composition.ts";
export type { MemorySpaceDaemon, MemorySpaceDaemonOptions } from "./daemon.ts";
export { createMemorySpaceDaemon, isLoopbackHost, startServer } from "./daemon.ts";
export {
  ConflictError,
  MemorySpaceError,
  NotFoundError,
  ValidationError,
} from "./domain/errors.ts";
export * from "./domain/types.ts";
export type {
  CheckpointCoordinator,
  CheckpointPolicyResult,
} from "./integration/checkpoint-policy.ts";
export { CheckpointPolicy } from "./integration/checkpoint-policy.ts";
export {
  ProviderSessionNotFoundError,
  SpaceBindingConflictError,
  SpaceBindingInvalidError,
  SpaceNotBoundError,
} from "./integration/errors.ts";
export type {
  ImplicitRecallDebugItem,
  ImplicitRecallInput,
  ImplicitRecallOptions,
  ImplicitRecallReason,
  ImplicitRecallResult,
  ImplicitRecallServicePort,
} from "./integration/implicit-recall.ts";
export {
  exactPromptControl,
  extractExactKeyCandidates,
  ImplicitRecallService,
  implicitRecallDefaults,
  renderImplicitRecallContext,
} from "./integration/implicit-recall.ts";
export type {
  ImplicitRememberCommittedItem,
  ImplicitRememberDisposition,
  ImplicitRememberInput,
  ImplicitRememberOptions,
  ImplicitRememberRejectedItem,
  ImplicitRememberResult,
  ImplicitRememberServicePort,
} from "./integration/implicit-remember.ts";
export {
  ImplicitRememberService,
  implicitRememberDefaults,
} from "./integration/implicit-remember.ts";
export {
  isSemanticExtractionChild,
  memorySpaceInternalInvocationEnvironment,
  semanticExtractionInternalInvocation,
} from "./integration/internal-invocation.ts";
export type {
  SemanticExtractionDiagnostic,
  SemanticExtractionDiagnosticSink,
  SemanticExtractionRejectedItem,
} from "./integration/semantic-memory-extractor.ts";
export {
  buildSemanticModelEvents,
  SemanticExtractionError,
  SemanticMemoryExtractor,
  semanticExtractionPromptV1,
} from "./integration/semantic-memory-extractor.ts";
export { ProjectSemanticExtractionConfigurationResolver } from "./integration/project-semantic-extraction-config.ts";
export type { HostAgentSemanticModelFactory } from "./integration/semantic-model-resolver.ts";
export {
  DefaultSemanticModelResolver,
  ReviewedHostAgentSemanticModelFactory,
} from "./integration/semantic-model-resolver.ts";
export {
  ClaudeCodeHostSemanticExtractionModel,
  claudeCodeHostLimits,
  DefaultHostProcessRunner,
} from "./adapters/semantic-models/claude-code-host.ts";
export type {
  HostProcessResult,
  HostProcessRunner,
} from "./adapters/semantic-models/claude-code-host.ts";
export type {
  SemanticExtractionModel,
  SemanticExtractionModelEvent,
  SemanticExtractionModelInput,
  SemanticModelResolution,
  SemanticModelResolutionContext,
  SemanticModelResolver,
  SemanticModelUnavailableReason,
} from "./ports/semantic-extraction-model.ts";
export { SemanticExtractionModelError } from "./ports/semantic-extraction-model.ts";
export type {
  LifecycleContext,
  LifecycleDiagnostic,
  LifecycleResult,
  LifecycleWarning,
} from "./integration/lifecycle-handler.ts";
export { LifecycleHandler } from "./integration/lifecycle-handler.ts";
export type { PromptMemoryDirective } from "./integration/prompt-memory-directive.ts";
export {
  promptMemoryDirective,
  promptMemoryDisabledContext,
} from "./integration/prompt-memory-directive.ts";
export type { PromptRememberDirective } from "./integration/prompt-remember-directive.ts";
export { promptRememberDirective } from "./integration/prompt-remember-directive.ts";
export type { ProviderSessionResolutionInput } from "./integration/provider-session-resolver.ts";
export { ProviderSessionResolver } from "./integration/provider-session-resolver.ts";
export type { MemoryMcpError, MemoryMcpErrorCode } from "./mcp/errors.ts";
export { MemoryMcpCommandError, toMemoryMcpError } from "./mcp/errors.ts";
export type {
  MCPRequestContext,
  MCPRuntimeContext,
  ResolvedMCPRequestContext,
} from "./mcp/request-context.ts";
export { MCPRequestContextResolver } from "./mcp/request-context.ts";
export type { CreateMemoryMcpServerOptions } from "./mcp/server.ts";
export { createMemoryMcpServer, createMemoryMcpServerForGateway } from "./mcp/server.ts";
export type {
  MemoryBootstrapToolInput,
  MemoryCheckpointToolInput,
  MemoryContextToolInput,
  MemoryPromoteToolInput,
  MemoryRememberToolInput,
  MemorySearchToolInput,
} from "./mcp/tools.ts";
export { MemoryMcpGateway } from "./mcp/tools.ts";
export type { CachePort } from "./ports/cache.ts";
export { NoopCache } from "./ports/cache.ts";
export type {
  ExtractionContext,
  ExtractionTrigger,
  MemoryExtractor,
} from "./ports/extractor.ts";
export type {
  SessionProjectBinding,
  SessionProjectBindingSource,
} from "./ports/session-binding.ts";
export type {
  MemoryCandidateCommitReceipt,
  MemoryFilters,
  MemoryHistoryRecord,
  MemoryStore,
} from "./ports/store.ts";
export type {
  TranscriptChunk,
  TranscriptReader,
  TranscriptReadOptions,
} from "./ports/transcript-reader.ts";
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
  TranscriptRef,
} from "./provider/types.ts";
export { validateProviderLifecycleEvent } from "./provider/types.ts";
