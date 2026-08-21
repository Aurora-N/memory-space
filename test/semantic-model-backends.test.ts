import assert from "node:assert/strict";
import test from "node:test";
import { OllamaSemanticExtractionModel } from "../src/adapters/semantic-models/ollama.ts";
import {
  ClaudeCodeHostSemanticExtractionModel,
  type HostProcessRunner,
} from "../src/adapters/semantic-models/claude-code-host.ts";
import { OpenAiCompatibleSemanticExtractionModel } from "../src/adapters/semantic-models/openai-compatible.ts";
import { semanticHttpLimits } from "../src/adapters/semantic-models/http.ts";
import {
  DefaultSemanticModelResolver,
  ReviewedHostAgentSemanticModelFactory,
} from "../src/integration/semantic-model-resolver.ts";
import { SemanticExtractionModelError } from "../src/ports/semantic-extraction-model.ts";

const input = {
  schemaVersion: 1 as const,
  instruction: "return json",
  events: [{ id: "u1", role: "user" as const, content: "数据库目前使用 PostgreSQL。" }],
};

test("external adapter performs one bounded structured request without exposing credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ schemaVersion: 1, candidates: [] }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const model = new OpenAiCompatibleSemanticExtractionModel({
    baseUrl: "https://models.example.test/v1",
    model: "fixture",
    apiKey: "fixture-secret",
    timeoutMs: 1_000,
    fetch: fakeFetch,
  });
  assert.deepEqual(await model.extract(input), { schemaVersion: 1, candidates: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://models.example.test/v1/chat/completions");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer fixture-secret"
  );
  assert.doesNotMatch(JSON.stringify(await model.extract(input)), /fixture-secret/u);
});

test("external resolver reports missing credential without fallback or request", async () => {
  let calls = 0;
  const resolver = new DefaultSemanticModelResolver({
    env: {},
    fetch: async () => {
      calls += 1;
      throw new Error("must not request");
    },
  });
  const resolution = await resolver.resolve(
    {
      backend: "external",
      adapter: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      model: "fixture",
      apiKeyEnv: "MISSING_KEY",
    },
    { timeoutMs: 1_000 }
  );
  assert.deepEqual(resolution, {
    available: false,
    backend: "external",
    adapter: "openai-compatible",
    reason: "missing_credential",
  });
  assert.equal(calls, 0);
});

test("HTTP transport enforces timeout and response-size bounds", async () => {
  const timeoutModel = new OpenAiCompatibleSemanticExtractionModel({
    baseUrl: "https://models.example.test/v1",
    model: "fixture",
    timeoutMs: 5,
    fetch: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      }),
  });
  await assert.rejects(
    timeoutModel.extract(input),
    (error: unknown) => error instanceof SemanticExtractionModelError && error.code === "timeout"
  );

  const oversized = new OpenAiCompatibleSemanticExtractionModel({
    baseUrl: "https://models.example.test/v1",
    model: "fixture",
    timeoutMs: 1_000,
    fetch: async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(semanticHttpLimits.maxResponseBytes + 1) },
      }),
  });
  await assert.rejects(
    oversized.extract(input),
    (error: unknown) =>
      error instanceof SemanticExtractionModelError && error.code === "response_too_large"
  );
});

test("Ollama adapter uses one loopback request and reports model missing distinctly", async () => {
  const urls: string[] = [];
  const success = new OllamaSemanticExtractionModel({
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:4b",
    timeoutMs: 1_000,
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify({ schemaVersion: 1, candidates: [] }) },
        }),
        { status: 200 }
      );
    },
  });
  assert.deepEqual(await success.extract(input), { schemaVersion: 1, candidates: [] });
  assert.deepEqual(urls, ["http://127.0.0.1:11434/api/chat"]);

  const missing = new OllamaSemanticExtractionModel({
    baseUrl: "http://127.0.0.1:11434",
    model: "missing",
    timeoutMs: 1_000,
    fetch: async () => new Response("missing", { status: 404 }),
  });
  await assert.rejects(
    missing.extract(input),
    (error: unknown) =>
      error instanceof SemanticExtractionModelError && error.code === "model_not_found"
  );
});

test("host-agent auto uses only current Session provider and never falls back", async () => {
  const resolver = new DefaultSemanticModelResolver();
  assert.deepEqual(
    await resolver.resolve(
      { backend: "host-agent", provider: "auto" },
      { sessionProvider: "codex", timeoutMs: 1_000 }
    ),
    {
      available: false,
      backend: "host-agent",
      provider: "codex",
      reason: "capability_unsupported",
    }
  );
  assert.deepEqual(
    await resolver.resolve(
      { backend: "host-agent", provider: "auto" },
      { sessionProvider: "unknown", timeoutMs: 1_000 }
    ),
    {
      available: false,
      backend: "host-agent",
      provider: "auto",
      reason: "provider_unavailable",
    }
  );
});

test("Claude host adapter uses isolated one-shot flags and returns structured output", async () => {
  const calls: Parameters<HostProcessRunner["run"]>[0][] = [];
  const model = new ClaudeCodeHostSemanticExtractionModel({
    timeoutMs: 1_000,
    runner: {
      async run(options) {
        calls.push(options);
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "result",
            is_error: false,
            structured_output: { schemaVersion: 1, candidates: [] },
          }),
          stderr: "",
          timedOut: false,
        };
      },
    },
    env: { PATH: process.env.PATH, OPENAI_API_KEY: "must-not-inherit" },
  });
  assert.deepEqual(await model.extract(input), { schemaVersion: 1, candidates: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.env.MEMORY_SPACE_INTERNAL_INVOCATION, "semantic-extraction");
  assert.ok(calls[0]?.cwd.includes("memory-space-semantic-child-"));
  assert.ok(calls[0]?.args.includes("--no-session-persistence"));
  assert.ok(calls[0]?.args.includes("--strict-mcp-config"));
  const toolsIndex = calls[0]?.args.indexOf("--tools") ?? -1;
  assert.equal(calls[0]?.args[toolsIndex + 1], "");
  assert.equal(calls[0]?.env.OPENAI_API_KEY, undefined);
});

test("reviewed host resolver supports Claude only and keeps Codex unsupported", async () => {
  const factory = new ReviewedHostAgentSemanticModelFactory({ env: {} });
  const claude = await factory.resolve("claude-code", { timeoutMs: 1_000 });
  assert.equal(claude.available, true);
  if (claude.available) assert.equal(claude.adapter, "claude-code-cli");
  assert.deepEqual(await factory.resolve("codex", { timeoutMs: 1_000 }), {
    available: false,
    backend: "host-agent",
    provider: "codex",
    reason: "capability_unsupported",
  });
});

test("host process timeout completes even when the child has not closed", async () => {
  const model = new ClaudeCodeHostSemanticExtractionModel({
    timeoutMs: 5,
    runner: {
      async run() {
        return { code: null, stdout: "", stderr: "", timedOut: true };
      },
    },
  });
  await assert.rejects(
    model.extract(input),
    (error: unknown) => error instanceof SemanticExtractionModelError && error.code === "timeout"
  );
});
