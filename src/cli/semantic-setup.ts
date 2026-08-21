import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  resolveSemanticExtractionConfiguration,
  semanticExtractionDefaults,
} from "../binding/project-config.ts";
import { CliError } from "./errors.ts";

export type SemanticSetupOptions =
  | {
      cwd?: string;
      off: true;
      dryRun?: boolean;
    }
  | {
      cwd?: string;
      backend: "host-agent";
      provider: "auto" | "claude-code" | "codex";
      timeoutMs?: number;
      dryRun?: boolean;
    }
  | {
      cwd?: string;
      backend: "local";
      adapter: "ollama";
      model: string;
      baseUrl?: string;
      timeoutMs?: number;
      dryRun?: boolean;
    }
  | {
      cwd?: string;
      backend: "external";
      adapter: "openai-compatible";
      baseUrl: string;
      model: string;
      apiKeyEnv?: string;
      timeoutMs?: number;
      dryRun?: boolean;
    };

export interface SemanticSetupResult {
  path: string;
  dryRun: boolean;
  semanticExtraction: Record<string, unknown>;
}

function setupError(message: string, remediation?: string, cause?: unknown): CliError {
  return new CliError("PROVIDER_CONFIG_WRITE_FAILED", message, {
    remediation,
    cause,
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function semanticValue(options: SemanticSetupOptions): Record<string, unknown> {
  if ("off" in options) return { mode: "off" };
  const timeoutMs = options.timeoutMs ?? semanticExtractionDefaults.timeoutMs;
  if (options.backend === "host-agent") {
    return {
      mode: "grounded",
      timeoutMs,
      model: { backend: "host-agent", provider: options.provider },
    };
  }
  if (options.backend === "local") {
    return {
      mode: "grounded",
      timeoutMs,
      model: {
        backend: "local",
        adapter: options.adapter,
        model: options.model,
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      },
    };
  }
  return {
    mode: "grounded",
    timeoutMs,
    model: {
      backend: "external",
      adapter: options.adapter,
      baseUrl: options.baseUrl,
      model: options.model,
      ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    },
  };
}

/** Atomically updates only semanticExtraction in an existing exact project binding. */
export async function configureSemanticExtraction(
  options: SemanticSetupOptions,
  defaultCwd: string
): Promise<SemanticSetupResult> {
  if ("backend" in options && options.backend === "host-agent" && options.provider === "codex") {
    throw new CliError(
      "VALIDATION_ERROR",
      "Codex host semantic extraction is unsupported because the installed CLI cannot prove tool and MCP isolation.",
      {
        remediation:
          "Choose the reviewed Claude Code host backend, or configure a local/external semantic backend.",
      }
    );
  }
  const project = resolve(options.cwd ?? defaultCwd);
  const path = join(project, ".memory-space", "config.json");
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw setupError(
      "The project has no readable local Memory Space binding.",
      "Run memory-space init for this exact project before semantic setup.",
      error
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw setupError(
      "The project binding target must be a regular non-symlink file.",
      `Repair ${path} before semantic setup.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw setupError("The project binding is not valid JSON.", `Repair ${path}.`, error);
  }
  const current = object(parsed);
  if (
    current?.version !== 1 ||
    typeof current.spaceId !== "string" ||
    current.spaceId.trim() === ""
  ) {
    throw setupError("The project binding is invalid.", `Repair ${path}.`);
  }
  const semanticExtraction = semanticValue(options);
  const next = { ...current, semanticExtraction };
  const resolved = resolveSemanticExtractionConfiguration(next);
  if (resolved.source === "invalid") {
    throw setupError(resolved.error ?? "Semantic extraction configuration is invalid.");
  }
  if (options.dryRun) {
    return { path, dryRun: true, semanticExtraction };
  }
  const temporaryPath = join(
    project,
    ".memory-space",
    `.semantic-config.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    throw setupError(
      "Semantic extraction configuration could not be written atomically.",
      `Check filesystem permissions for ${path}.`,
      error
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { path, dryRun: false, semanticExtraction };
}

function answerChoice(value: string): "host-agent" | "local" | "external" | "off" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "host-agent") return "host-agent";
  if (normalized === "2" || normalized === "local") return "local";
  if (normalized === "3" || normalized === "external") return "external";
  if (normalized === "4" || normalized === "off") return "off";
  return undefined;
}

/** Prompts only in an interactive terminal; detection never selects a backend. */
export async function promptSemanticSetup(cwd: string): Promise<SemanticSetupOptions> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "USAGE_ERROR",
      "Semantic setup requires backend flags in a non-interactive terminal.",
      {
        exitCode: 2,
        remediation:
          "Use --backend host-agent|local|external with the required options, or use --off.",
      }
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Semantic memory extraction");
    console.log("");
    console.log("1. Use an installed coding agent");
    console.log("   No additional model API key; uses the selected coding-agent account/quota.");
    console.log("2. Use a local model");
    console.log("   No model API key; requires a supported local runtime/model.");
    console.log("3. Use an external model API");
    console.log("   Uses an OpenAI-compatible endpoint.");
    console.log("4. Disable semantic extraction");
    const choice = answerChoice(await prompt.question("Choose a model source: "));
    if (!choice)
      throw new CliError("USAGE_ERROR", "Unknown semantic model source.", { exitCode: 2 });
    if (choice === "off") return { cwd, off: true };
    if (choice === "host-agent") {
      const provider = (await prompt.question("Provider (auto, claude-code, codex): ")).trim();
      if (provider !== "auto" && provider !== "claude-code" && provider !== "codex") {
        throw new CliError("USAGE_ERROR", "Unknown host-agent provider.", { exitCode: 2 });
      }
      return { cwd, backend: "host-agent", provider };
    }
    if (choice === "local") {
      const model = (await prompt.question("Installed Ollama model: ")).trim();
      if (!model) throw new CliError("USAGE_ERROR", "A local model is required.", { exitCode: 2 });
      return { cwd, backend: "local", adapter: "ollama", model };
    }
    const baseUrl = (await prompt.question("OpenAI-compatible base URL: ")).trim();
    const model = (await prompt.question("Model: ")).trim();
    const apiKeyEnv = (await prompt.question("API key environment variable (optional): ")).trim();
    if (!baseUrl || !model) {
      throw new CliError("USAGE_ERROR", "External base URL and model are required.", {
        exitCode: 2,
      });
    }
    return {
      cwd,
      backend: "external",
      adapter: "openai-compatible",
      baseUrl,
      model,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    };
  } finally {
    prompt.close();
  }
}
