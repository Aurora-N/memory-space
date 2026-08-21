import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  memorySpaceInternalInvocationEnvironment,
  semanticExtractionInternalInvocation,
} from "../../integration/internal-invocation.ts";
import type {
  SemanticExtractionModel,
  SemanticExtractionModelInput,
} from "../../ports/semantic-extraction-model.ts";
import { SemanticExtractionModelError } from "../../ports/semantic-extraction-model.ts";

const outputSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    candidates: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          family: { enum: ["knowledge", "state"] },
          type: {
            enum: [
              "fact",
              "decision",
              "constraint",
              "convention",
              "goal",
              "task",
              "progress",
              "blocker",
              "question",
            ],
          },
          content: { type: "string" },
          assertion: { enum: ["direct", "uncertain", "hypothetical"] },
          durability: { enum: ["durable", "interaction_local"] },
          evidence: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                eventId: { type: "string" },
                quote: { type: "string" },
              },
              required: ["eventId", "quote"],
            },
          },
          durabilityReason: { type: "string" },
        },
        required: ["family", "type", "content", "assertion", "durability", "evidence"],
      },
    },
  },
  required: ["schemaVersion", "candidates"],
});

const hostInstruction = [
  "Perform only semantic extraction over the supplied events.",
  "Do not inspect files, invoke tools, or use knowledge outside the supplied events.",
  "Every evidence quote MUST be copied verbatim from one user event.",
  "Candidate content MUST be copied verbatim as one contiguous substring of an evidence quote.",
  "Never summarize, paraphrase, normalize punctuation, or combine separated text.",
  "If exact copying cannot express the durable fact, return no candidate.",
].join("\n");

/** Hard byte bounds for captured Claude child stdout and stderr. */
export const claudeCodeHostLimits = Object.freeze({
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 64_000,
});

const inheritedEnvironmentNames = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
]);

function semanticChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    [memorySpaceInternalInvocationEnvironment]: semanticExtractionInternalInvocation,
  };
  for (const [name, value] of Object.entries(source)) {
    if (
      value !== undefined &&
      (inheritedEnvironmentNames.has(name) ||
        name.startsWith("ANTHROPIC_") ||
        name.startsWith("CLAUDE_CODE_"))
    ) {
      environment[name] = value;
    }
  }
  return environment;
}

/** Sanitized bounded result from one isolated host-agent child process. */
export interface HostProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injectable one-shot process boundary used for deterministic adapter tests. */
export interface HostProcessRunner {
  run(input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }): Promise<HostProcessResult>;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number, maximum: number): number {
  const next = current + chunk.byteLength;
  if (next > maximum) throw new SemanticExtractionModelError("response_too_large");
  chunks.push(chunk);
  return next;
}

/** Bounded one-shot process execution used only by reviewed host semantic adapters. */
export class DefaultHostProcessRunner implements HostProcessRunner {
  async run(input: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }): Promise<HostProcessResult> {
    return await new Promise<HostProcessResult>((resolve, reject) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;
      const finish = (result: HostProcessResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(error);
      };
      child.stdout.on("data", (value: Buffer) => {
        try {
          stdoutBytes = appendBounded(
            stdout,
            value,
            stdoutBytes,
            claudeCodeHostLimits.maxStdoutBytes
          );
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on("data", (value: Buffer) => {
        try {
          stderrBytes = appendBounded(
            stderr,
            value,
            stderrBytes,
            claudeCodeHostLimits.maxStderrBytes
          );
        } catch (error) {
          fail(error);
        }
      });
      child.once("error", (error) => fail(error));
      child.once("close", (code) =>
        finish({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        })
      );
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        finish({
          code: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut: true,
        });
        const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        forceKill.unref();
      }, input.timeoutMs);
    });
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function processFailure(result: HostProcessResult): SemanticExtractionModelError {
  if (result.timedOut) return new SemanticExtractionModelError("timeout");
  const sanitized = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/usage limit|rate limit|quota|credit balance/u.test(sanitized)) {
    return new SemanticExtractionModelError("usage_limit");
  }
  if (/not authenticated|authentication|login required|api key/u.test(sanitized)) {
    return new SemanticExtractionModelError("not_authenticated");
  }
  return new SemanticExtractionModelError("host_process_failed");
}

/** Reviewed Claude Code one-shot adapter with hooks, MCP, settings, and tools disabled. */
export class ClaudeCodeHostSemanticExtractionModel implements SemanticExtractionModel {
  readonly timeoutMs: number;
  readonly runner: HostProcessRunner;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: {
    timeoutMs: number;
    runner?: HostProcessRunner;
    command?: string;
    env?: NodeJS.ProcessEnv;
  }) {
    this.timeoutMs = options.timeoutMs;
    this.runner = options.runner ?? new DefaultHostProcessRunner();
    this.command = options.command ?? "claude";
    this.env = options.env ?? process.env;
  }

  async extract(input: SemanticExtractionModelInput): Promise<unknown> {
    const cwd = await mkdtemp(join(tmpdir(), "memory-space-semantic-child-"));
    try {
      const result = await this.runner.run({
        command: this.command,
        cwd,
        timeoutMs: this.timeoutMs,
        env: semanticChildEnvironment(this.env),
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          outputSchema,
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--setting-sources",
          "",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--system-prompt",
          `${input.instruction}\n${hostInstruction}`,
          JSON.stringify({ schemaVersion: input.schemaVersion, events: input.events }),
        ],
      });
      if (result.code !== 0 || result.timedOut) throw processFailure(result);
      let envelope: unknown;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw new SemanticExtractionModelError("invalid_json");
      }
      const root = object(envelope);
      if (root?.is_error === true) throw processFailure(result);
      const structured = root?.structured_output;
      if (!object(structured)) throw new SemanticExtractionModelError("invalid_output");
      return structured;
    } catch (error) {
      if (error instanceof SemanticExtractionModelError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SemanticExtractionModelError("cli_not_found");
      }
      throw new SemanticExtractionModelError("host_process_failed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
