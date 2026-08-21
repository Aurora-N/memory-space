import { readProjectBindingAtPath, type SpaceBinding } from "../binding/space-resolver.ts";
import {
  semanticExtractionDefaults,
  type SemanticExtractionConfiguration,
} from "../binding/project-config.ts";
import type { ExtractionContext } from "../ports/extractor.ts";
import { SpaceBindingInvalidError } from "./errors.ts";
import type { SemanticExtractionConfigurationResolver } from "./semantic-memory-extractor.ts";

const offConfiguration: SemanticExtractionConfiguration = Object.freeze({
  effectiveMode: "off",
  source: "default",
  timeoutMs: semanticExtractionDefaults.timeoutMs,
});

type ProjectBindingReader = (path: string) => Promise<SpaceBinding | undefined>;

/** Resolves P9 configuration only from the Session's persisted project binding. */
export class ProjectSemanticExtractionConfigurationResolver
  implements SemanticExtractionConfigurationResolver
{
  readonly readBinding: ProjectBindingReader;

  constructor(readBinding: ProjectBindingReader = readProjectBindingAtPath) {
    this.readBinding = readBinding;
  }

  async resolve(context: ExtractionContext): Promise<SemanticExtractionConfiguration> {
    const binding = context.projectBinding;
    if (binding?.source !== "config" || !binding.configPath) {
      return offConfiguration;
    }
    let current: SpaceBinding | undefined;
    try {
      current = await this.readBinding(binding.configPath);
    } catch (error) {
      if (error instanceof SpaceBindingInvalidError) return offConfiguration;
      throw error;
    }
    if (!current || current.spaceId !== context.session.spaceId) return offConfiguration;
    return current.semanticExtraction ?? offConfiguration;
  }
}
