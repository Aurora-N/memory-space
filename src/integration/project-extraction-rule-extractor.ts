import { DeclarativeRuleExtractor } from "../adapters/declarative-rule-extractor.ts";
import {
  type ProjectExtractionRulesResult,
  readProjectExtractionRules,
} from "../binding/extraction-rules.ts";
import {
  type SpaceBinding,
  type SpaceResolutionInput,
  SpaceResolver,
} from "../binding/space-resolver.ts";
import type { MemoryCandidate, SessionEvent } from "../domain/types.ts";
import type { ExtractionContext, MemoryExtractor } from "../ports/extractor.ts";
import { SpaceNotBoundError } from "./errors.ts";

interface ProjectRuleSpaceResolver {
  resolve(input: SpaceResolutionInput): Promise<SpaceBinding>;
}

/** Loads additive project rules only when the daemon binding matches the Session Space. */
export class ProjectExtractionRuleExtractor implements MemoryExtractor {
  readonly cwd: string;
  readonly explicitSpaceId?: string;
  readonly spaceResolver: ProjectRuleSpaceResolver;
  readonly loadRules: (binding: SpaceBinding) => Promise<ProjectExtractionRulesResult>;

  constructor(options: {
    cwd: string;
    explicitSpaceId?: string;
    spaceResolver?: ProjectRuleSpaceResolver;
    loadRules?: (binding: SpaceBinding) => Promise<ProjectExtractionRulesResult>;
  }) {
    this.cwd = options.cwd;
    this.explicitSpaceId = options.explicitSpaceId;
    this.spaceResolver = options.spaceResolver ?? new SpaceResolver();
    this.loadRules = options.loadRules ?? readProjectExtractionRules;
  }

  async extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]> {
    if (this.explicitSpaceId !== undefined) return [];
    let binding: SpaceBinding;
    try {
      binding = await this.spaceResolver.resolve({ cwd: this.cwd });
    } catch (error) {
      if (error instanceof SpaceNotBoundError) return [];
      throw error;
    }
    if (binding.spaceId !== context.session.spaceId) return [];
    const configured = await this.loadRules(binding);
    if (configured.status === "absent" || configured.rules.length === 0) return [];
    return new DeclarativeRuleExtractor(configured.rules).extract(events, context);
  }
}
