import { OllamaSemanticExtractionModel } from "../adapters/semantic-models/ollama.ts";
import { OpenAiCompatibleSemanticExtractionModel } from "../adapters/semantic-models/openai-compatible.ts";
import { ClaudeCodeHostSemanticExtractionModel } from "../adapters/semantic-models/claude-code-host.ts";
import {
  semanticExtractionDefaults,
  type SemanticModelConfiguration,
} from "../binding/project-config.ts";
import type {
  SemanticModelResolution,
  SemanticModelResolutionContext,
  SemanticModelResolver,
} from "../ports/semantic-extraction-model.ts";

/** Capability-gated provider-specific factory; unsupported providers must not fallback. */
export interface HostAgentSemanticModelFactory {
  resolve(
    provider: "claude-code" | "codex",
    context: SemanticModelResolutionContext
  ): Promise<SemanticModelResolution>;
}

/** Resolves only host-agent providers with a completed real isolation capability gate. */
export class ReviewedHostAgentSemanticModelFactory implements HostAgentSemanticModelFactory {
  readonly env: NodeJS.ProcessEnv;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.env = options.env ?? process.env;
  }

  async resolve(
    provider: "claude-code" | "codex",
    context: SemanticModelResolutionContext
  ): Promise<SemanticModelResolution> {
    if (provider === "codex") {
      return {
        available: false,
        backend: "host-agent",
        provider,
        reason: "capability_unsupported",
      };
    }
    return {
      available: true,
      backend: "host-agent",
      provider,
      adapter: "claude-code-cli",
      model: new ClaudeCodeHostSemanticExtractionModel({
        timeoutMs: context.timeoutMs,
        env: this.env,
      }),
    };
  }
}

/** Selects exactly the configured backend; failures never trigger another backend. */
export class DefaultSemanticModelResolver
  implements SemanticModelResolver<SemanticModelConfiguration>
{
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly hostAgent?: HostAgentSemanticModelFactory;

  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      fetch?: typeof fetch;
      hostAgent?: HostAgentSemanticModelFactory;
    } = {}
  ) {
    this.env = options.env ?? process.env;
    this.fetch = options.fetch;
    this.hostAgent = options.hostAgent;
  }

  async resolve(
    config: SemanticModelConfiguration,
    context: SemanticModelResolutionContext
  ): Promise<SemanticModelResolution> {
    if (config.backend === "external") {
      const apiKey = config.apiKeyEnv ? this.env[config.apiKeyEnv] : undefined;
      if (config.apiKeyEnv && !apiKey) {
        return {
          available: false,
          backend: "external",
          adapter: config.adapter,
          reason: "missing_credential",
        };
      }
      return {
        available: true,
        backend: "external",
        adapter: config.adapter,
        model: new OpenAiCompatibleSemanticExtractionModel({
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey,
          timeoutMs: context.timeoutMs,
          fetch: this.fetch,
        }),
      };
    }
    if (config.backend === "local") {
      return {
        available: true,
        backend: "local",
        adapter: config.adapter,
        model: new OllamaSemanticExtractionModel({
          baseUrl: config.baseUrl ?? semanticExtractionDefaults.ollamaBaseUrl,
          model: config.model,
          timeoutMs: context.timeoutMs,
          fetch: this.fetch,
        }),
      };
    }
    const provider = config.provider === "auto" ? context.sessionProvider : config.provider;
    if (provider !== "claude-code" && provider !== "codex") {
      return {
        available: false,
        backend: "host-agent",
        provider: config.provider,
        reason: "provider_unavailable",
      };
    }
    if (!this.hostAgent) {
      return {
        available: false,
        backend: "host-agent",
        provider,
        reason: "capability_unsupported",
      };
    }
    return this.hostAgent.resolve(provider, context);
  }
}
