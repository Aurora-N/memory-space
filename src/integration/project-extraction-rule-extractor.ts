import { DeclarativeRuleExtractor } from "../adapters/declarative-rule-extractor.ts";
import {
  type ProjectExtractionRulesResult,
  readProjectExtractionRules,
} from "../binding/extraction-rules.ts";
import {
  readProjectBindingAtPath,
  type SpaceBinding,
  type SpaceResolutionInput,
  SpaceResolver,
} from "../binding/space-resolver.ts";
import type { MemoryCandidate, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import { SpaceBindingInvalidError, SpaceNotBoundError } from "./errors.ts";

interface ProjectRuleSpaceResolver {
  resolve(input: SpaceResolutionInput): Promise<SpaceBinding>;
}

type ProjectBindingReader = (configPath: string) => Promise<SpaceBinding | undefined>;

/** Loads additive project rules only when the daemon binding matches the Session Space. */
export class ProjectExtractionRuleExtractor implements MemoryExtractor {
  readonly cwd: string;
  readonly explicitSpaceId?: string;
  readonly spaceResolver: ProjectRuleSpaceResolver;
  readonly readBinding: ProjectBindingReader;
  readonly loadRules: (binding: SpaceBinding) => Promise<ProjectExtractionRulesResult>;

  constructor(options: {
    cwd: string;
    explicitSpaceId?: string;
    spaceResolver?: ProjectRuleSpaceResolver;
    readBinding?: ProjectBindingReader;
    loadRules?: (binding: SpaceBinding) => Promise<ProjectExtractionRulesResult>;
  }) {
    this.cwd = options.cwd;
    this.explicitSpaceId = options.explicitSpaceId;
    this.spaceResolver = options.spaceResolver ?? new SpaceResolver();
    this.readBinding = options.readBinding ?? readProjectBindingAtPath;
    this.loadRules = options.loadRules ?? readProjectExtractionRules;
  }

  async extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]> {
    let binding: SpaceBinding;
    if (context.projectBinding) {
      if (
        context.projectBinding.source === "explicit" ||
        context.projectBinding.spaceId !== context.session.spaceId ||
        !context.projectBinding.configPath
      ) {
        return [];
      }
      try {
        const currentBinding = await this.readBinding(context.projectBinding.configPath);
        if (!currentBinding || currentBinding.spaceId !== context.session.spaceId) return [];
        binding = currentBinding;
      } catch (error) {
        if (error instanceof SpaceBindingInvalidError) return [];
        throw error;
      }
    } else {
      if (this.explicitSpaceId !== undefined) return [];
      try {
        binding = await this.spaceResolver.resolve({ cwd: this.cwd });
      } catch (error) {
        if (error instanceof SpaceNotBoundError) return [];
        throw error;
      }
    }
    if (binding.spaceId !== context.session.spaceId) return [];
    const configured = await this.loadRules(binding);
    if (configured.status === "absent" || configured.rules.length === 0) return [];
    return new DeclarativeRuleExtractor(configured.rules).extract(events, context);
  }
}
