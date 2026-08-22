#!/usr/bin/env -S node --experimental-strip-types

import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { P7ImplicitRecallReport } from "../../eval/p7-implicit-recall.ts";
import type { P8ImplicitRememberReport } from "../../eval/p8-implicit-remember.ts";
import type { P9SemanticExtractionReport } from "../../eval/p9-semantic-extraction.ts";
import type { P9RealSemanticQualityReport } from "../../eval/p9-real-semantic-quality.ts";
import type { StageB1ComparisonReport } from "../../eval/quality/comparison.ts";
import type { StageB3CoreHandoffComparisonReport } from "../../eval/quality/core-handoff-comparison.ts";
import type { StageB2ExtractionComparisonReport } from "../../eval/quality/extraction-comparison.ts";
import type { MemoryQualityReport } from "../../eval/quality/types.ts";
import type { CrossSessionEvalReport } from "../../eval/support/cross-session-runner.ts";
import {
  runConfigureClaudeCode,
  runConfigureCodex,
  runDoctor,
  runEval,
  runInit,
  runInspect,
  runP7ImplicitRecallEvalCommand,
  runP8ImplicitRememberEvalCommand,
  runP9RealSemanticQualityEvalCommand,
  runP9SemanticExtractionEvalCommand,
  runQualityComparison,
  runQualityCoreHandoffComparison,
  runQualityEval,
  runQualityExtractionComparison,
  runSemanticSetup,
  runStatus,
  runUnbind,
} from "./commands.ts";
import { asCliError, CliError } from "./errors.ts";
import {
  DEFAULT_DAEMON_ENDPOINT,
  LocalMemorySpaceClient,
  type LocalMemorySpaceClientPort,
} from "./local-client.ts";
import { openLocalBrowser } from "./open-browser.ts";

type ValueOption =
  | "cwd"
  | "name"
  | "space-id"
  | "endpoint"
  | "backend"
  | "provider"
  | "adapter"
  | "base-url"
  | "model"
  | "api-key-env"
  | "timeout-ms";
type BooleanOption =
  | "json"
  | "no-open"
  | "dry-run"
  | "off"
  | "compare-stage-a"
  | "compare-stage-a-extraction"
  | "compare-stage-b2-core-handoff";

interface ParsedOptions {
  cwd?: string;
  name?: string;
  spaceId?: string;
  endpoint?: string;
  json?: boolean;
  noOpen?: boolean;
  dryRun?: boolean;
  compareStageA?: boolean;
  compareStageAExtraction?: boolean;
  compareStageB2CoreHandoff?: boolean;
  backend?: string;
  provider?: string;
  adapter?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: string;
  off?: boolean;
}

export interface CliDependencies {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  clientFactory?: (endpoint: string) => LocalMemorySpaceClientPort;
  evalRunner?: () => Promise<CrossSessionEvalReport>;
  qualityEvalRunner?: () => Promise<MemoryQualityReport>;
  qualityComparisonRunner?: () => Promise<StageB1ComparisonReport>;
  qualityExtractionComparisonRunner?: () => Promise<StageB2ExtractionComparisonReport>;
  qualityCoreHandoffComparisonRunner?: () => Promise<StageB3CoreHandoffComparisonReport>;
  p7ImplicitRecallEvalRunner?: () => Promise<P7ImplicitRecallReport>;
  p8ImplicitRememberEvalRunner?: () => Promise<P8ImplicitRememberReport>;
  p9SemanticExtractionEvalRunner?: () => Promise<P9SemanticExtractionReport>;
  p9RealSemanticQualityEvalRunner?: () => Promise<P9RealSemanticQualityReport>;
  writeBinding?: (cwd: string, spaceId: string) => Promise<string>;
  openBrowser?: (url: string) => Promise<void>;
  installationRoot?: string;
}

const usage = `memory-space local product CLI

Usage:
  memory-space inspect [path] [--endpoint <url>] [--no-open]
  memory-space configure codex [path] [--endpoint <url>] [--dry-run]
  memory-space configure claude-code [path] [--endpoint <url>] [--dry-run]
  memory-space semantic setup [path] [--backend <host-agent|local|external> ... | --off] [--dry-run]
  memory-space init [path] [--name <name>] [--space-id <id>] [--endpoint <url>]
  memory-space unbind [path] [--space-id <expected-id>]
  memory-space doctor [path] [--endpoint <url>] [--json]
  memory-space status [path] [--endpoint <url>] [--json]
  memory-space eval cross-session [--json]
  memory-space eval implicit-recall [--json]
  memory-space eval implicit-remember [--json]
  memory-space eval semantic-extraction [--json]
  memory-space eval semantic-quality [--json]
  memory-space eval quality [--json] [--compare-stage-a | --compare-stage-a-extraction | --compare-stage-b2-core-handoff]

Development invocation:
  pnpm memory-space <command>`;

function parseOptions(
  args: string[],
  allowedValues: readonly ValueOption[],
  allowedBooleans: readonly BooleanOption[],
  allowPositionalCwd = false
): ParsedOptions {
  const result: ParsedOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      if (allowPositionalCwd && result.cwd === undefined) {
        result.cwd = argument;
        continue;
      }
      throw new CliError("USAGE_ERROR", `Unexpected argument: ${argument}`, {
        exitCode: 2,
        remediation: "Run memory-space --help.",
      });
    }
    const name = argument.slice(2) as ValueOption | BooleanOption;
    if (allowedBooleans.includes(name as BooleanOption)) {
      if (name === "compare-stage-a") result.compareStageA = true;
      else if (name === "compare-stage-a-extraction") result.compareStageAExtraction = true;
      else if (name === "compare-stage-b2-core-handoff") result.compareStageB2CoreHandoff = true;
      else if (name === "no-open") result.noOpen = true;
      else if (name === "dry-run") result.dryRun = true;
      else if (name === "off") result.off = true;
      else result.json = true;
      continue;
    }
    if (!allowedValues.includes(name as ValueOption)) {
      throw new CliError("USAGE_ERROR", `Unknown option: ${argument}`, {
        exitCode: 2,
        remediation: "Run memory-space --help.",
      });
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError("USAGE_ERROR", `${argument} requires a value.`, { exitCode: 2 });
    }
    index += 1;
    if (name === "space-id") result.spaceId = value;
    else if (name === "cwd") {
      if (result.cwd !== undefined) {
        throw new CliError("USAGE_ERROR", "Specify the project path only once.", { exitCode: 2 });
      }
      result.cwd = value;
    } else if (name === "name") result.name = value;
    else if (name === "endpoint") result.endpoint = value;
    else if (name === "backend") result.backend = value;
    else if (name === "provider") result.provider = value;
    else if (name === "adapter") result.adapter = value;
    else if (name === "base-url") result.baseUrl = value;
    else if (name === "model") result.model = value;
    else if (name === "api-key-env") result.apiKeyEnv = value;
    else result.timeoutMs = value;
  }
  return result;
}

async function defaultEvalRunner(): Promise<CrossSessionEvalReport> {
  const module = await import("../../eval/support/cross-session-runner.ts");
  return module.runCrossSessionEval();
}

async function defaultQualityEvalRunner(): Promise<MemoryQualityReport> {
  const module = await import("../../eval/quality/runner.ts");
  return module.runMemoryQualityEval();
}

async function defaultQualityComparisonRunner(): Promise<StageB1ComparisonReport> {
  const module = await import("../../eval/quality/comparison.ts");
  return module.runStageB1Comparison();
}

async function defaultQualityExtractionComparisonRunner(): Promise<StageB2ExtractionComparisonReport> {
  const module = await import("../../eval/quality/extraction-comparison.ts");
  return module.runStageB2ExtractionComparison();
}

async function defaultQualityCoreHandoffComparisonRunner(): Promise<StageB3CoreHandoffComparisonReport> {
  const module = await import("../../eval/quality/core-handoff-comparison.ts");
  return module.runStageB3CoreHandoffComparison();
}

async function defaultP7ImplicitRecallEvalRunner(): Promise<P7ImplicitRecallReport> {
  const module = await import("../../eval/p7-implicit-recall.ts");
  return module.runP7ImplicitRecallEval();
}

async function defaultP8ImplicitRememberEvalRunner(): Promise<P8ImplicitRememberReport> {
  const module = await import("../../eval/p8-implicit-remember.ts");
  return module.runP8ImplicitRememberEval();
}

async function defaultP9SemanticExtractionEvalRunner(): Promise<P9SemanticExtractionReport> {
  const module = await import("../../eval/p9-semantic-extraction.ts");
  return module.runP9SemanticExtractionEval();
}

async function defaultP9RealSemanticQualityEvalRunner(): Promise<P9RealSemanticQualityReport> {
  const module = await import("../../eval/p9-real-semantic-quality.ts");
  return module.runConfiguredP9RealSemanticQualityEval();
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.stdout ?? ((line: string) => console.log(line));
  const writeError = dependencies.stderr ?? ((line: string) => console.error(line));
  const environment = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const home = dependencies.home ?? homedir();

  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      write(usage);
      return 0;
    }
    const command = argv[0];
    if (command === "eval") {
      const target = argv[1];
      if (
        target !== "cross-session" &&
        target !== "quality" &&
        target !== "implicit-recall" &&
        target !== "implicit-remember" &&
        target !== "semantic-extraction" &&
        target !== "semantic-quality"
      ) {
        throw new CliError(
          "USAGE_ERROR",
          "eval requires the cross-session, quality, implicit-recall, implicit-remember, semantic-extraction, or semantic-quality target.",
          {
            exitCode: 2,
            remediation:
              "Run: memory-space eval <cross-session|quality|implicit-recall|implicit-remember|semantic-extraction|semantic-quality>",
          }
        );
      }
      const options = parseOptions(
        argv.slice(2),
        [],
        target === "quality"
          ? [
              "json",
              "compare-stage-a",
              "compare-stage-a-extraction",
              "compare-stage-b2-core-handoff",
            ]
          : ["json"]
      );
      if (target === "implicit-recall") {
        return await runP7ImplicitRecallEvalCommand(
          options,
          write,
          dependencies.p7ImplicitRecallEvalRunner ?? defaultP7ImplicitRecallEvalRunner
        );
      }
      if (target === "implicit-remember") {
        return await runP8ImplicitRememberEvalCommand(
          options,
          write,
          dependencies.p8ImplicitRememberEvalRunner ?? defaultP8ImplicitRememberEvalRunner
        );
      }
      if (target === "semantic-extraction") {
        return await runP9SemanticExtractionEvalCommand(
          options,
          write,
          dependencies.p9SemanticExtractionEvalRunner ?? defaultP9SemanticExtractionEvalRunner
        );
      }
      if (target === "semantic-quality") {
        return await runP9RealSemanticQualityEvalCommand(
          options,
          write,
          dependencies.p9RealSemanticQualityEvalRunner ?? defaultP9RealSemanticQualityEvalRunner
        );
      }
      const comparisonModes = [
        options.compareStageA,
        options.compareStageAExtraction,
        options.compareStageB2CoreHandoff,
      ].filter(Boolean).length;
      if (comparisonModes > 1) {
        throw new CliError(
          "USAGE_ERROR",
          "Choose only one Stage A comparison mode or the B3 Core/Handoff comparison.",
          { exitCode: 2 }
        );
      }
      return target === "cross-session"
        ? await runEval(options, write, dependencies.evalRunner ?? defaultEvalRunner)
        : options.compareStageB2CoreHandoff
          ? await runQualityCoreHandoffComparison(
              options,
              write,
              dependencies.qualityCoreHandoffComparisonRunner ??
                defaultQualityCoreHandoffComparisonRunner
            )
          : options.compareStageAExtraction
            ? await runQualityExtractionComparison(
                options,
                write,
                dependencies.qualityExtractionComparisonRunner ??
                  defaultQualityExtractionComparisonRunner
              )
            : options.compareStageA
              ? await runQualityComparison(
                  options,
                  write,
                  dependencies.qualityComparisonRunner ?? defaultQualityComparisonRunner
                )
              : await runQualityEval(
                  options,
                  write,
                  dependencies.qualityEvalRunner ?? defaultQualityEvalRunner
                );
    }

    if (command === "unbind") {
      const options = parseOptions(argv.slice(1), ["cwd", "space-id"], [], true);
      await runUnbind(options, { cwd, write });
      return 0;
    }

    if (command === "configure") {
      const provider = argv[1];
      if (provider !== "codex" && provider !== "claude-code") {
        throw new CliError("USAGE_ERROR", "configure requires the codex or claude-code provider.", {
          exitCode: 2,
          remediation:
            "Run: memory-space configure <codex|claude-code> [path] [--endpoint <url>] [--dry-run]",
        });
      }
      const options = parseOptions(argv.slice(2), ["cwd", "endpoint"], ["dry-run"], true);
      options.endpoint ??= environment.MEMORY_SPACE_URL;
      const runner = provider === "codex" ? runConfigureCodex : runConfigureClaudeCode;
      await runner(options, { cwd, home, write }, dependencies.installationRoot);
      return 0;
    }

    if (command === "semantic") {
      if (argv[1] !== "setup") {
        throw new CliError("USAGE_ERROR", "semantic requires the setup subcommand.", {
          exitCode: 2,
          remediation: "Run: memory-space semantic setup [path] [backend options]",
        });
      }
      const options = parseOptions(
        argv.slice(2),
        ["cwd", "backend", "provider", "adapter", "base-url", "model", "api-key-env", "timeout-ms"],
        ["off", "dry-run"],
        true
      );
      await runSemanticSetup(options, { cwd, write });
      return 0;
    }

    const localCommands = new Set(["init", "inspect", "doctor", "status"]);
    if (!localCommands.has(command)) {
      throw new CliError("USAGE_ERROR", `Unknown command: ${command}`, {
        exitCode: 2,
        remediation: "Run memory-space --help.",
      });
    }

    const allowedValues: ValueOption[] =
      command === "init" ? ["cwd", "name", "space-id", "endpoint"] : ["cwd", "endpoint"];
    const options = parseOptions(
      argv.slice(1),
      allowedValues,
      command === "doctor" || command === "status"
        ? ["json"]
        : command === "inspect"
          ? ["no-open"]
          : [],
      true
    );
    const endpoint = options.endpoint ?? environment.MEMORY_SPACE_URL ?? DEFAULT_DAEMON_ENDPOINT;
    const client = (
      dependencies.clientFactory ?? ((value) => new LocalMemorySpaceClient({ endpoint: value }))
    )(endpoint);
    const context = { cwd, home, client, write, writeBinding: dependencies.writeBinding };

    if (command === "init") {
      await runInit(options, context);
      return 0;
    }
    if (command === "inspect") {
      const target = resolve(options.cwd ?? cwd);
      await client.health();
      const identity = await client.getDaemonIdentity();
      if (resolve(identity.cwd) !== target) {
        throw new CliError(
          "DAEMON_REQUEST_FAILED",
          "The running daemon is attached to a different project.",
          {
            remediation: "Restart pnpm start with MEMORY_SPACE_CWD set to this project.",
          }
        );
      }
      await runInspect(options, context, dependencies.openBrowser ?? openLocalBrowser);
      return 0;
    }
    if (command === "doctor") return await runDoctor(options, context);
    if (command === "status") {
      return await runStatus(options, context);
    }
    throw new CliError("USAGE_ERROR", `Unknown command: ${command}`, { exitCode: 2 });
  } catch (error) {
    const value = asCliError(error);
    writeError(`${value.code}: ${value.message}`);
    if (value.remediation) writeError(value.remediation);
    return value.exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
