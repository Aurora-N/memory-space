import { SemanticExtractionModelError } from "../../ports/semantic-extraction-model.ts";

export const semanticHttpLimits = Object.freeze({
  maxResponseBytes: 1_000_000,
});

/** Executes one bounded JSON request without retries or credential disclosure. */
export async function fetchBoundedJson(input: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetch?: typeof fetch;
}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await (input.fetch ?? fetch)(input.url, {
      method: input.method ?? "POST",
      headers: {
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...input.headers,
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SemanticExtractionModelError(
        response.status === 404 ? "model_not_found" : "http_error"
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > semanticHttpLimits.maxResponseBytes
    ) {
      throw new SemanticExtractionModelError("response_too_large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new SemanticExtractionModelError("empty_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > semanticHttpLimits.maxResponseBytes) {
        await reader.cancel();
        throw new SemanticExtractionModelError("response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new SemanticExtractionModelError("invalid_json");
    }
  } catch (error) {
    if (error instanceof SemanticExtractionModelError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SemanticExtractionModelError("timeout");
    }
    throw new SemanticExtractionModelError("network_error");
  } finally {
    clearTimeout(timer);
  }
}
