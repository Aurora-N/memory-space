export { MemorySpace } from "./application/memory-space.ts";
export { createDefaultMemorySpace } from "./composition.ts";
export type { DefaultMemorySpaceOptions } from "./composition.ts";
export type {
  AppendEventInput,
  BootstrapResult,
  CheckpointInput,
  ContextResult,
  CreateSessionInput,
  CreateSpaceInput,
  ProviderSessionInput,
  RememberInput
} from "./application/memory-space.ts";
export { RuleBasedExtractor, NoopExtractor } from "./adapters/rule-based-extractor.ts";
export { SqliteMemoryStore } from "./adapters/sqlite/sqlite-store.ts";
export { NoopCache } from "./ports/cache.ts";
export type { CachePort } from "./ports/cache.ts";
export type { MemoryExtractor, ExtractionContext } from "./ports/extractor.ts";
export type { MemoryStore, MemoryFilters, MemoryHistoryRecord } from "./ports/store.ts";
export type { TranscriptReader, TranscriptReadOptions, TranscriptChunk } from "./ports/transcript-reader.ts";
export { SpaceResolver } from "./binding/space-resolver.ts";
export type { SpaceBinding, SpaceResolutionInput } from "./binding/space-resolver.ts";
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
export { createMemoryMcpServer } from "./mcp/server.ts";
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
export type { MCPRequestContext, ResolvedMCPRequestContext } from "./mcp/request-context.ts";
export { MemoryMcpCommandError, toMemoryMcpError } from "./mcp/errors.ts";
export type { MemoryMcpError, MemoryMcpErrorCode } from "./mcp/errors.ts";
export * from "./domain/types.ts";
export { MemorySpaceError, NotFoundError, ValidationError, ConflictError } from "./domain/errors.ts";
