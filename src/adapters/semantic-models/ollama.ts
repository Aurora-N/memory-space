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

/** Ollama loopback transport with no model download or retry behavior. */
export class OllamaSemanticExtractionModel implements SemanticExtractionModel {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;

  constructor(options: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/$/u, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetch = options.fetch;
  }

  async extract(input: SemanticExtractionModelInput): Promise<unknown> {
    const response = await fetchBoundedJson({
      url: `${this.baseUrl}/api/chat`,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      body: {
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: input.instruction },
          { role: "user", content: JSON.stringify({ schemaVersion: 1, events: input.events }) },
        ],
      },
    });
    const content = object(object(response)?.message)?.content;
    if (typeof content !== "string") throw new SemanticExtractionModelError("invalid_output");
    try {
      return JSON.parse(content);
    } catch {
      throw new SemanticExtractionModelError("invalid_json");
    }
  }
}
