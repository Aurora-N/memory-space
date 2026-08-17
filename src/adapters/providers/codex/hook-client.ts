import {
  codexUnavailableOutput,
  type CodexHookOutput
} from "./bootstrap-renderer.ts";

const defaultEndpoint = "http://127.0.0.1:4310/providers/codex/lifecycle";
const defaultTimeoutMs = 2_500;

export interface InvokeCodexLifecycleHookOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function timeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.min(value, 30_000)
    : defaultTimeoutMs;
}

function nativeHookEventName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).hook_event_name;
  return typeof value === "string" ? value : undefined;
}

function hookOutput(value: unknown, expectedEventName: string | undefined): CodexHookOutput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.continue !== true) return undefined;
  const result: CodexHookOutput = { continue: true };
  if (typeof input.systemMessage === "string") result.systemMessage = input.systemMessage;
  const specific = input.hookSpecificOutput;
  if (specific !== undefined) {
    if (!specific || typeof specific !== "object" || Array.isArray(specific)) return undefined;
    const fields = specific as Record<string, unknown>;
    if ((fields.hookEventName !== "SessionStart"
      && fields.hookEventName !== "UserPromptSubmit")
      || fields.hookEventName !== expectedEventName
      || typeof fields.additionalContext !== "string") return undefined;
    result.hookSpecificOutput = {
      hookEventName: fields.hookEventName,
      additionalContext: fields.additionalContext
    };
  }
  return result;
}

export async function invokeCodexLifecycleHook(
  payload: unknown,
  options: InvokeCodexLifecycleHookOptions = {}
): Promise<CodexHookOutput | undefined> {
  const endpoint = options.endpoint
    ?? process.env.MEMORY_SPACE_CODEX_HOOK_URL
    ?? defaultEndpoint;
  const timeoutMs = timeout(options.timeoutMs
    ?? Number(process.env.MEMORY_SPACE_HOOK_TIMEOUT_MS ?? defaultTimeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) return codexUnavailableOutput();
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return codexUnavailableOutput();
    }
    const result = body as Record<string, unknown>;
    if (result.status === "ignored") return undefined;
    if (result.status !== "ok" && result.status !== "warning") {
      return codexUnavailableOutput();
    }
    const output = hookOutput(result.output, nativeHookEventName(payload));
    if (result.output !== undefined && !output) return codexUnavailableOutput();
    return output;
  } catch {
    return codexUnavailableOutput();
  } finally {
    clearTimeout(timer);
  }
}
