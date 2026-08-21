import type {
  SemanticExtractionModel,
  SemanticExtractionModelInput,
} from "../../ports/semantic-extraction-model.ts";
import { SemanticExtractionModelError } from "../../ports/semantic-extraction-model.ts";
import { fetchBoundedJson } from "./http.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** OpenAI-compatible structured JSON transport; output remains untrusted. */
export class OpenAiCompatibleSemanticExtractionModel implements SemanticExtractionModel {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;

  constructor(options: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    timeoutMs: number;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetch = options.fetch;
  }

  async extract(input: SemanticExtractionModelInput): Promise<unknown> {
    const response = await fetchBoundedJson({
      url: `${this.baseUrl}/chat/completions`,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      body: {
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.instruction },
          { role: "user", content: JSON.stringify({ schemaVersion: 1, events: input.events }) },
        ],
      },
    });
    const root = object(response);
    const choices = root?.choices;
    const first = Array.isArray(choices) ? object(choices[0]) : undefined;
    const message = object(first?.message);
    const content = message?.content;
    if (typeof content !== "string") throw new SemanticExtractionModelError("invalid_output");
    try {
      return JSON.parse(content);
    } catch {
      throw new SemanticExtractionModelError("invalid_json");
    }
  }
}
