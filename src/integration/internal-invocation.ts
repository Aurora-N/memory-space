/** Trusted environment name used only to prevent recursive internal lifecycle entry. */
export const memorySpaceInternalInvocationEnvironment = "MEMORY_SPACE_INTERNAL_INVOCATION";
/** Marker value assigned to isolated semantic child processes. */
export const semanticExtractionInternalInvocation = "semantic-extraction";

/** Prevents a semantic child process from re-entering Memory Space lifecycle hooks. */
export function isSemanticExtractionChild(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (
    environment[memorySpaceInternalInvocationEnvironment] === semanticExtractionInternalInvocation
  );
}
