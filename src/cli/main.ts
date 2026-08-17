#!/usr/bin/env -S node --experimental-strip-types

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { CrossSessionEvalReport } from "../../eval/support/cross-session-runner.ts";
import type { MemoryQualityReport } from "../../eval/quality/types.ts";
import type { StageB1ComparisonReport } from "../../eval/quality/comparison.ts";
import type {
  StageB2ExtractionComparisonReport
} from "../../eval/quality/extraction-comparison.ts";
import type {
  StageB3CoreHandoffComparisonReport
} from "../../eval/quality/core-handoff-comparison.ts";
import {
  runDoctor,
  runEval,
  runInit,
  runQualityComparison,
  runQualityCoreHandoffComparison,
  runQualityExtractionComparison,
  runQualityEval,
  runStatus
} from "./commands.ts";
import { asCliError, CliError } from "./errors.ts";
import {
  DEFAULT_DAEMON_ENDPOINT,
  LocalMemorySpaceClient,
  type LocalMemorySpaceClientPort
} from "./local-client.ts";

type ValueOption = "cwd" | "name" | "space-id" | "endpoint";
type BooleanOption =
  | "json"
  | "compare-stage-a"
  | "compare-stage-a-extraction"
  | "compare-stage-b2-core-handoff";

interface ParsedOptions {
  cwd?: string;
  name?: string;
  spaceId?: string;
  endpoint?: string;
  json?: boolean;
  compareStageA?: boolean;
  compareStageAExtraction?: boolean;
  compareStageB2CoreHandoff?: boolean;
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
  writeBinding?: (cwd: string, spaceId: string) => Promise<string>;
}

const usage = `memory-space local product CLI

Usage:
  memory-space init [--cwd <path>] [--name <name>] [--space-id <id>] [--endpoint <url>]
  memory-space doctor [--cwd <path>] [--endpoint <url>] [--json]
  memory-space status [--cwd <path>] [--endpoint <url>] [--json]
  memory-space eval cross-session [--json]
  memory-space eval quality [--json] [--compare-stage-a | --compare-stage-a-extraction | --compare-stage-b2-core-handoff]

Development invocation:
  pnpm memory-space <command>`;

function parseOptions(
  args: string[],
  allowedValues: readonly ValueOption[],
  allowedBooleans: readonly BooleanOption[]
): ParsedOptions {
  const result: ParsedOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new CliError("USAGE_ERROR", `Unexpected argument: ${argument}`, {
        exitCode: 2,
        remediation: "Run memory-space --help."
      });
    }
    const name = argument.slice(2) as ValueOption | BooleanOption;
    if (allowedBooleans.includes(name as BooleanOption)) {
      if (name === "compare-stage-a") result.compareStageA = true;
      else if (name === "compare-stage-a-extraction") result.compareStageAExtraction = true;
      else if (name === "compare-stage-b2-core-handoff") result.compareStageB2CoreHandoff = true;
      else result.json = true;
      continue;
    }
    if (!allowedValues.includes(name as ValueOption)) {
      throw new CliError("USAGE_ERROR", `Unknown option: ${argument}`, {
        exitCode: 2,
        remediation: "Run memory-space --help."
      });
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError("USAGE_ERROR", `${argument} requires a value.`, { exitCode: 2 });
    }
    index += 1;
    if (name === "space-id") result.spaceId = value;
    else if (name === "cwd") result.cwd = value;
    else if (name === "name") result.name = value;
    else result.endpoint = value;
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

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {}
): Promise<number> {
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
      if (target !== "cross-session" && target !== "quality") {
        throw new CliError("USAGE_ERROR", "eval requires the cross-session or quality target.", {
          exitCode: 2,
          remediation: "Run: memory-space eval cross-session or memory-space eval quality"
        });
      }
      const options = parseOptions(
        argv.slice(2),
        [],
        target === "quality"
          ? ["json", "compare-stage-a", "compare-stage-a-extraction", "compare-stage-b2-core-handoff"]
          : ["json"]
      );
      const comparisonModes = [
        options.compareStageA,
        options.compareStageAExtraction,
        options.compareStageB2CoreHandoff
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
            dependencies.qualityCoreHandoffComparisonRunner
              ?? defaultQualityCoreHandoffComparisonRunner
          )
        : options.compareStageAExtraction
          ? await runQualityExtractionComparison(
            options,
            write,
            dependencies.qualityExtractionComparisonRunner
              ?? defaultQualityExtractionComparisonRunner
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

    const allowedValues: ValueOption[] = command === "init"
      ? ["cwd", "name", "space-id", "endpoint"]
      : ["cwd", "endpoint"];
    const options = parseOptions(
      argv.slice(1),
      allowedValues,
      command === "doctor" || command === "status" ? ["json"] : []
    );
    const endpoint = options.endpoint
      ?? environment.MEMORY_SPACE_URL
      ?? DEFAULT_DAEMON_ENDPOINT;
    const client = (dependencies.clientFactory ?? ((value) =>
      new LocalMemorySpaceClient({ endpoint: value })))(endpoint);
    const context = { cwd, home, client, write, writeBinding: dependencies.writeBinding };

    if (command === "init") {
      await runInit(options, context);
      return 0;
    }
    if (command === "doctor") return await runDoctor(options, context);
    if (command === "status") {
      await runStatus(options, context);
      return 0;
    }
    throw new CliError("USAGE_ERROR", `Unknown command: ${command}`, {
      exitCode: 2,
      remediation: "Run memory-space --help."
    });
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
