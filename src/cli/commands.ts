import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { P7ImplicitRecallReport } from "../../eval/p7-implicit-recall.ts";
import type { P8ImplicitRememberReport } from "../../eval/p8-implicit-remember.ts";
import {
  formatStageB1Comparison,
  type StageB1ComparisonReport,
} from "../../eval/quality/comparison.ts";
import {
  formatStageB3CoreHandoffComparison,
  type StageB3CoreHandoffComparisonReport,
} from "../../eval/quality/core-handoff-comparison.ts";
import {
  formatStageB2ExtractionComparison,
  type StageB2ExtractionComparisonReport,
} from "../../eval/quality/extraction-comparison.ts";
import { formatMemoryQualityReport } from "../../eval/quality/report.ts";
import type { MemoryQualityReport } from "../../eval/quality/types.ts";
import type { CrossSessionEvalReport } from "../../eval/support/cross-session-runner.ts";
import {
  ProjectExtractionRulesInvalidError,
  readProjectExtractionRules,
} from "../binding/extraction-rules.ts";
import type {
  ImplicitRecallConfiguration,
  ImplicitRememberConfiguration,
} from "../binding/project-config.ts";
import type { Space } from "../domain/types.ts";
import {
  readLocalProjectBinding,
  removeLocalProjectBinding,
  resolveOptionalBinding,
  writeBindingAtomically,
} from "./binding.ts";
import { configureClaudeCodeProject } from "./claude-code-config.ts";
import { configureCodexProject } from "./codex-config.ts";
import { CliError } from "./errors.ts";
import { type LocalMemorySpaceClientPort, MEMORY_MCP_TOOLS } from "./local-client.ts";
import { detectProviderConfigs } from "./provider-config.ts";

export interface CommandContext {
  cwd: string;
  home: string;
  client: LocalMemorySpaceClientPort;
  write(line: string): void;
  writeBinding?: typeof writeBindingAtomically;
}

export interface InitOptions {
  cwd?: string;
  name?: string;
  spaceId?: string;
}

export interface InspectOptions {
  cwd?: string;
  noOpen?: boolean;
}

export async function runConfigureCodex(
  options: { cwd?: string; dryRun?: boolean; endpoint?: string },
  context: Pick<CommandContext, "cwd" | "home" | "write">,
  installationRoot?: string
): Promise<void> {
  const result = await configureCodexProject({
    cwd: options.cwd ?? context.cwd,
    dryRun: options.dryRun,
    installationRoot,
    home: context.home,
    endpoint: options.endpoint,
  });
  const verb = result.dryRun ? "would be" : "was";
  context.write(result.dryRun ? "Codex configuration dry run" : "Codex configuration complete");
  context.write(`Project: ${result.cwd}`);
  context.write(`Hooks:   ${verb} ${result.hooks.change} (${result.hooks.path})`);
  context.write(`MCP:     ${verb} ${result.mcp.change} (${result.mcp.path})`);
  if (result.dryRun) {
    context.write("No files were changed.");
  } else {
    context.write("Restart Codex, then verify /hooks and /mcp.");
    context.write(`Doctor: memory-space doctor ${result.cwd}`);
  }
}

export async function runConfigureClaudeCode(
  options: { cwd?: string; dryRun?: boolean; endpoint?: string },
  context: Pick<CommandContext, "cwd" | "home" | "write">,
  installationRoot?: string
): Promise<void> {
  const result = await configureClaudeCodeProject({
    cwd: options.cwd ?? context.cwd,
    dryRun: options.dryRun,
    installationRoot,
    home: context.home,
    endpoint: options.endpoint,
  });
  const verb = result.dryRun ? "would be" : "was";
  context.write(
    result.dryRun ? "Claude Code configuration dry run" : "Claude Code configuration complete"
  );
  context.write(`Project: ${result.cwd}`);
  context.write(`Hooks:   ${verb} ${result.hooks.change} (${result.hooks.path})`);
  context.write(`MCP:     ${verb} ${result.mcp.change} (${result.mcp.path})`);
  if (result.dryRun) {
    context.write("No files were changed.");
  } else {
    context.write("Restart Claude Code, then verify /hooks and /mcp.");
    context.write(`Doctor: memory-space doctor ${result.cwd}`);
  }
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "error";
  message: string;
  remediation?: string;
}

export interface StatusReport {
  daemon: "ok";
  space: { id: string; name: string };
  binding: { source: "explicit" | "config"; configPath?: string };
  implicitRecall: ImplicitRecallConfiguration;
  implicitRemember: ImplicitRememberConfiguration;
  latestCheckpoint?: { id: string };
  latestHandoff?: {
    id: string;
    sessionId: string;
    createdAt: string;
    goal?: string;
    nextSteps: string[];
  };
}

function required(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "") {
    throw new CliError("VALIDATION_ERROR", `${label} must be a non-empty string.`);
  }
  return normalized;
}

export async function runInit(options: InitOptions, context: CommandContext): Promise<void> {
  const cwd = resolve(options.cwd ?? context.cwd);
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", "Initialization target must be an existing directory.", {
      remediation: "Create the project directory before running memory-space init.",
      cause: error,
    });
  }
  const requestedSpaceId = required(options.spaceId, "--space-id");
  const requestedName = required(options.name, "--name") ?? basename(cwd);
  const localBinding = await readLocalProjectBinding(cwd);

  if (localBinding) {
    if (requestedSpaceId !== undefined && requestedSpaceId !== localBinding.spaceId) {
      throw new CliError(
        "BINDING_CONFLICT",
        `Project is already bound to Space ${localBinding.spaceId}; it was not rebound.`,
        { remediation: "Use the existing Space or update the binding explicitly after review." }
      );
    }
    await context.client.health();
    const space = await context.client.getSpace(localBinding.spaceId);
    context.write("Memory Space already initialized");
    context.write(`Space:   ${space.name} (${space.id})`);
    context.write(`Binding: ${localBinding.configPath ?? localBinding.source}`);
    context.write(`Implicit Recall: ${localBinding.implicitRecall?.effectiveMode ?? "off"}`);
    context.write(`Implicit Remember: ${localBinding.implicitRemember?.effectiveMode ?? "off"}`);
    providerNextSteps(context.write);
    return;
  }

  const inheritedBinding = await resolveOptionalBinding(cwd);
  if (
    inheritedBinding &&
    (requestedSpaceId === undefined || requestedSpaceId === inheritedBinding.spaceId)
  ) {
    await context.client.health();
    const space = await context.client.getSpace(inheritedBinding.spaceId);
    context.write("Memory Space already initialized (inherited binding)");
    context.write(`Space:   ${space.name} (${space.id})`);
    context.write(`Binding: ${inheritedBinding.configPath ?? inheritedBinding.source}`);
    context.write(`Implicit Recall: ${inheritedBinding.implicitRecall?.effectiveMode ?? "off"}`);
    context.write(
      `Implicit Remember: ${inheritedBinding.implicitRemember?.effectiveMode ?? "off"}`
    );
    providerNextSteps(context.write);
    return;
  }

  await context.client.health();
  let space: Space;
  if (requestedSpaceId) {
    try {
      space = await context.client.getSpace(requestedSpaceId);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "SPACE_NOT_FOUND") throw error;
      space = await context.client.createSpace({ id: requestedSpaceId, name: requestedName });
    }
  } else {
    space = await context.client.createSpace({ name: requestedName });
  }
  let configPath: string;
  try {
    configPath = await (context.writeBinding ?? writeBindingAtomically)(cwd, space.id);
  } catch (error) {
    if (
      error instanceof CliError &&
      (error.code === "BINDING_WRITE_FAILED" || error.code === "BINDING_CONFLICT")
    ) {
      throw new CliError(
        error.code,
        `Space ${space.id} exists, but the project binding could not be written safely.`,
        { remediation: error.remediation, cause: error }
      );
    }
    throw error;
  }
  context.write("Memory Space initialized");
  context.write(`Space:   ${space.name} (${space.id})`);
  context.write(`Binding: ${configPath}`);
  context.write("Implicit Recall: exact");
  context.write("Implicit Remember: conservative");
  providerNextSteps(context.write);
}

export async function runInspect(
  options: InspectOptions,
  context: CommandContext,
  openBrowser: (url: string) => Promise<void>
): Promise<void> {
  const cwd = resolve(options.cwd ?? context.cwd);
  const binding = await resolveOptionalBinding(cwd);
  if (!binding) {
    throw new CliError("BINDING_NOT_FOUND", "Inspector target has no effective binding.", {
      remediation: "Run memory-space init for this project before opening the Inspector.",
    });
  }
  const runtime = await context.client.getInspectorBinding();
  if (resolve(runtime.cwd) !== cwd || runtime.space.id !== binding.spaceId) {
    throw new CliError(
      "DAEMON_REQUEST_FAILED",
      "The running daemon is attached to a different project or Space.",
      {
        remediation: "Restart pnpm start with MEMORY_SPACE_CWD set to this project.",
      }
    );
  }
  await context.client.checkInspector();
  const url = `${context.client.endpoint}/inspector/`;
  if (!options.noOpen) await openBrowser(url);
  context.write("");
  context.write("Memory Space Inspector ready");
  context.write(`Project:  ${cwd}`);
  context.write(`Space:    ${runtime.space.name} (${runtime.space.id})`);
  context.write(`Inspector: ${url}`);
  if (options.noOpen) context.write("Browser:  not opened (--no-open)");
  context.write("Close:    press Ctrl+C in the pnpm start terminal");
  context.write("Unbind:   memory-space unbind");
}

export async function runUnbind(
  options: { cwd?: string; spaceId?: string },
  context: Pick<CommandContext, "cwd" | "write">
): Promise<void> {
  const cwd = resolve(options.cwd ?? context.cwd);
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", "Unbind target must be an existing directory.", {
      cause: error,
    });
  }
  const expectedSpaceId = required(options.spaceId, "--space-id");
  const result = await removeLocalProjectBinding(cwd, expectedSpaceId);
  if (result.removed) {
    context.write("Local Memory Space binding removed");
    context.write(`Project: ${cwd}`);
    context.write(`Space:   ${result.local?.spaceId}`);
    context.write("Memory data and the Space were preserved.");
    if (result.inherited) {
      context.write(
        `Effective binding now inherits Space ${result.inherited.spaceId} from ${result.inherited.configPath}.`
      );
    } else {
      context.write("Project is now unbound.");
    }
    return;
  }
  if (result.inherited) {
    context.write("No local binding to remove; ancestor binding was preserved.");
    context.write(`Effective Space: ${result.inherited.spaceId}`);
    context.write(`Binding:         ${result.inherited.configPath}`);
  } else {
    context.write("Project is already unbound; no Memory data was changed.");
  }
}

function providerNextSteps(write: (line: string) => void): void {
  write("");
  write("Provider next steps (global configuration was not modified):");
  write("Codex:       docs/guides/CODEX_INTEGRATION.md and examples/codex/");
  write("Claude Code: docs/guides/CLAUDE_CODE_INTEGRATION.md and examples/claude-code/");
}

function check(
  id: string,
  status: DoctorCheck["status"],
  message: string,
  remediation?: string
): DoctorCheck {
  return { id, status, message, remediation };
}

export async function runDoctor(
  options: { cwd?: string; json?: boolean },
  context: CommandContext
): Promise<number> {
  const cwd = resolve(options.cwd ?? context.cwd);
  const checks: DoctorCheck[] = [
    check("daemon-endpoint", "ok", `Loopback endpoint accepted: ${context.client.endpoint}`),
  ];

  let daemonReachable = false;
  try {
    await context.client.health();
    daemonReachable = true;
    checks.push(check("daemon", "ok", "Daemon reachable."));
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(
      check(
        "daemon",
        "error",
        "Daemon unavailable.",
        value?.remediation ?? "Start it with: pnpm start"
      )
    );
  }

  let binding: Awaited<ReturnType<typeof resolveOptionalBinding>>;
  try {
    binding = await resolveOptionalBinding(cwd);
    if (binding) {
      checks.push(check("binding", "ok", `Binding valid for Space ${binding.spaceId}.`));
      checks.push(
        check(
          "binding-source",
          "ok",
          `Nearest binding source: ${binding.configPath ?? binding.source}.`
        )
      );
    } else {
      checks.push(
        check(
          "binding",
          "error",
          "No project binding found.",
          "Run memory-space init from the project directory."
        )
      );
      checks.push(check("binding-source", "error", "Nearest binding source unavailable."));
    }
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(check("binding", "error", "Project binding is malformed.", value?.remediation));
    checks.push(check("binding-source", "error", "Nearest binding source unavailable."));
  }

  if (binding && daemonReachable) {
    try {
      const space = await context.client.getSpace(binding.spaceId);
      checks.push(check("space", "ok", `Bound Space exists: ${space.name} (${space.id}).`));
    } catch (error) {
      const missing = error instanceof CliError && error.code === "SPACE_NOT_FOUND";
      checks.push(
        check(
          "space",
          "error",
          missing
            ? `Bound Space does not exist: ${binding.spaceId}.`
            : "Bound Space could not be verified because the daemon request failed.",
          missing
            ? "Review the binding before creating or selecting a replacement Space."
            : "Inspect daemon health/logs and retry memory-space doctor."
        )
      );
    }
  } else {
    checks.push(check("space", "error", "Bound Space could not be verified."));
  }

  if (binding?.implicitRecall?.source === "invalid") {
    checks.push(
      check(
        "implicit-recall",
        "error",
        `${binding.implicitRecall.error}; effective mode is off.`,
        `Repair implicitRecall.mode in ${binding.configPath ?? ".memory-space/config.json"}.`
      )
    );
  } else if (binding?.implicitRecall) {
    checks.push(
      check(
        "implicit-recall",
        "ok",
        `Effective mode: ${binding.implicitRecall.effectiveMode} (${binding.implicitRecall.source}).`
      )
    );
  } else {
    checks.push(
      check(
        "implicit-recall",
        "error",
        "No matching project binding can authorize implicit recall; effective mode is off."
      )
    );
  }

  if (binding?.implicitRemember?.source === "invalid") {
    checks.push(
      check(
        "implicit-remember",
        "error",
        `${binding.implicitRemember.error}; effective mode is off.`,
        `Repair implicitRemember.mode in ${binding.configPath ?? ".memory-space/config.json"}.`
      )
    );
  } else if (binding?.implicitRemember) {
    checks.push(
      check(
        "implicit-remember",
        binding.implicitRemember.effectiveMode === "off" ? "warn" : "ok",
        binding.implicitRemember.source === "default"
          ? "Effective mode: off (default; project has not opted in)."
          : `Effective mode: ${binding.implicitRemember.effectiveMode} (explicit).`
      )
    );
  } else {
    checks.push(
      check(
        "implicit-remember",
        "error",
        "No matching project binding can authorize implicit remember; effective mode is off."
      )
    );
  }

  if (binding) {
    try {
      const rules = await readProjectExtractionRules(binding);
      checks.push(
        check(
          "extraction-rules",
          "ok",
          rules.status === "configured"
            ? `Configured project extraction rules: ${rules.rules.length} enabled.`
            : "No project extraction rule file; built-in rules remain active."
        )
      );
    } catch (error) {
      const invalid = error instanceof ProjectExtractionRulesInvalidError ? error : undefined;
      checks.push(
        check(
          "extraction-rules",
          "error",
          invalid?.reason ?? "Project extraction rules could not be validated.",
          `Repair ${invalid?.path ?? ".memory-space/extraction-rules.json"}; configured rules were not applied.`
        )
      );
    }
  } else {
    checks.push(
      check(
        "extraction-rules",
        "error",
        "Project extraction rules cannot be resolved without a valid binding."
      )
    );
  }

  try {
    const tools = await context.client.listMcpTools();
    if (JSON.stringify(tools) === JSON.stringify([...MEMORY_MCP_TOOLS])) {
      checks.push(check("mcp", "ok", "MCP reachable; exact six tools discovered."));
    } else {
      checks.push(
        check(
          "mcp",
          "error",
          `MCP tool mismatch: discovered ${tools.length}, expected 6.`,
          "Use the shared Memory Space daemon without provider-specific aliases."
        )
      );
    }
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(check("mcp", "error", "MCP endpoint unavailable.", value?.remediation));
  }

  for (const provider of await detectProviderConfigs(cwd, context.home)) {
    const id = provider.provider === "codex" ? "codex" : "claude-code";
    checks.push(
      check(
        id,
        provider.state === "detected" ? "ok" : "warn",
        provider.message,
        provider.state === "detected"
          ? undefined
          : provider.provider === "codex"
            ? "See docs/guides/CODEX_INTEGRATION.md."
            : "See docs/guides/CLAUDE_CODE_INTEGRATION.md."
      )
    );
  }
  checks.push(
    check(
      "claude-real-mcp-waiver",
      "warn",
      "Claude real model-driven MCP remains externally blocked / waived for progression.",
      "Use first-party Anthropic authentication or a gateway that preserves MCP tool names."
    )
  );

  if (options.json) {
    context.write(JSON.stringify({ checks }, null, 2));
  } else {
    for (const item of checks) {
      context.write(`${item.id.padEnd(24)} ${item.status.toUpperCase().padEnd(5)} ${item.message}`);
      if (item.remediation) context.write(`${"".padEnd(30)} ${item.remediation}`);
    }
  }
  return checks.some((item) => item.status === "error") ? 1 : 0;
}

export async function runStatus(
  options: { cwd?: string; json?: boolean },
  context: CommandContext
): Promise<number> {
  const cwd = resolve(options.cwd ?? context.cwd);
  const binding = await resolveOptionalBinding(cwd);
  if (!binding) {
    throw new CliError("BINDING_NOT_FOUND", "No project Memory Space binding found.", {
      remediation: "Run memory-space init from the project directory.",
    });
  }
  await context.client.health();
  const space = await context.client.getSpace(binding.spaceId);
  const handoff = await context.client.getLatestHandoff(space.id);
  const report: StatusReport = {
    daemon: "ok",
    space: { id: space.id, name: space.name },
    binding: { source: binding.source, configPath: binding.configPath },
    implicitRecall: binding.implicitRecall ?? {
      effectiveMode: "off",
      source: "invalid",
      error: "No project disclosure configuration is available",
    },
    implicitRemember: binding.implicitRemember ?? {
      effectiveMode: "off",
      source: "invalid",
      error: "No project implicit-write configuration is available",
    },
    latestCheckpoint: handoff ? { id: handoff.checkpointId } : undefined,
    latestHandoff: handoff
      ? {
          id: handoff.id,
          sessionId: handoff.sessionId,
          createdAt: handoff.createdAt,
          goal: handoff.goal,
          nextSteps: handoff.nextSteps,
        }
      : undefined,
  };
  if (options.json) {
    context.write(JSON.stringify(report, null, 2));
    return report.implicitRecall.source === "invalid" ||
      report.implicitRemember.source === "invalid"
      ? 1
      : 0;
  }
  context.write("Memory Space status");
  context.write(`Daemon:           OK (${context.client.endpoint})`);
  context.write(`Space:            ${space.name} (${space.id})`);
  context.write(`Binding source:   ${binding.configPath ?? binding.source}`);
  context.write(
    `Implicit Recall:  ${
      report.implicitRecall.source === "invalid"
        ? `ERROR (${report.implicitRecall.error}; effective mode off)`
        : `${report.implicitRecall.effectiveMode} (${report.implicitRecall.source})`
    }`
  );
  context.write(
    `Implicit Remember:${
      report.implicitRemember.source === "invalid"
        ? ` ERROR (${report.implicitRemember.error}; effective mode off)`
        : ` ${report.implicitRemember.effectiveMode} (${report.implicitRemember.source})`
    }`
  );
  context.write(
    `Latest checkpoint:${report.latestCheckpoint ? ` ${report.latestCheckpoint.id}` : " none"}`
  );
  context.write(`Latest Handoff:   ${report.latestHandoff ? report.latestHandoff.id : "none"}`);
  if (report.latestHandoff) {
    context.write(`Handoff Session:  ${report.latestHandoff.sessionId}`);
    context.write(`Handoff created:  ${report.latestHandoff.createdAt}`);
    context.write(`Next steps:       ${report.latestHandoff.nextSteps.join("; ") || "none"}`);
  }
  return report.implicitRecall.source === "invalid" || report.implicitRemember.source === "invalid"
    ? 1
    : 0;
}

export async function runEval(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<CrossSessionEvalReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    write("Cross-session durable memory eval");
    write("");
    for (const item of report.checks) {
      write(`${item.label.padEnd(34)} ${item.status.toUpperCase()}`);
    }
    write("");
    write(`Claude real MCP (external gate)   ${report.claudeRealMcp.toUpperCase()}`);
    write(`Overall                            ${report.overall.toUpperCase()}`);
  }
  return report.overall === "pass" ? 0 : 1;
}

export async function runP7ImplicitRecallEvalCommand(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<P7ImplicitRecallReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    write("P7 implicit prompt-time recall eval");
    write("");
    write(`Bare-Identifier Hit Rate          ${report.metrics.bareIdentifierHitRate.toFixed(6)}`);
    write(`Exact-Key Hit Rate                ${report.metrics.exactKeyHitRate.toFixed(6)}`);
    write(
      `Implicit Recall Precision@1       ${report.metrics.implicitRecallPrecisionAt1.toFixed(6)}`
    );
    write(`Negative Abstention Rate          ${report.metrics.negativeAbstentionRate.toFixed(6)}`);
    write(`Core Re-injection Rate            ${report.metrics.coreReinjectionRate.toFixed(6)}`);
    write(`Metadata Leakage Rate             ${report.metrics.metadataLeakageRate.toFixed(6)}`);
    write(`Opt-out Compliance Rate           ${report.metrics.optOutComplianceRate.toFixed(6)}`);
    write(`Budget Compliance Rate            ${report.metrics.budgetComplianceRate.toFixed(6)}`);
    write(
      `Cross-provider matrix             ${report.metrics.crossProviderMatrix.passed}/${report.metrics.crossProviderMatrix.total}`
    );
    write(`Hard correctness                  ${report.hardCorrectness.toUpperCase()}`);
  }
  return report.hardCorrectness === "pass" ? 0 : 1;
}

export async function runP8ImplicitRememberEvalCommand(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<P8ImplicitRememberReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    write("P8 implicit turn-time remember eval");
    write("");
    write(
      `Implicit Remember Precision       ${report.metrics.implicitRememberPrecision.toFixed(6)}`
    );
    write(`Implicit Core Write Rate         ${report.metrics.implicitCoreWriteRate.toFixed(6)}`);
    write(
      `Same-Evidence Duplicate Rate     ${report.metrics.sameEvidenceDuplicateRate.toFixed(6)}`
    );
    write(`Replay Duplicate Rate            ${report.metrics.replayDuplicateRate.toFixed(6)}`);
    write(
      `Assistant-Only Persistence Rate  ${report.metrics.assistantOnlyPersistenceRate.toFixed(6)}`
    );
    write(
      `Lifecycle Blocking Failure Rate  ${report.metrics.lifecycleBlockingFailureRate.toFixed(6)}`
    );
    write(
      `Explicit Opt-Out Violation Rate  ${report.metrics.explicitOptOutViolationRate.toFixed(6)}`
    );
    write(
      `Long-Assistant User Evidence     ${report.metrics.longAssistantUserEvidenceRetention.toUpperCase()}`
    );
    write(`Checkpoint Historical Replay     ${report.metrics.checkpointHistoricalReplayCount}`);
    write(
      `Secret-Like Persistence Rate     ${report.metrics.secretLikeAutoPersistenceRate.toFixed(6)}`
    );
    write(
      `Cross-Turn Opt-Out Violation     ${report.metrics.crossTurnOptOutViolationRate.toFixed(6)}`
    );
    write(`Hard correctness                 ${report.hardCorrectness.toUpperCase()}`);
  }
  return report.hardCorrectness === "pass" ? 0 : 1;
}

export async function runQualityEval(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<MemoryQualityReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatMemoryQualityReport(report)) write(line);
  }
  return report.correctness.overall === "pass" ? 0 : 1;
}

export async function runQualityComparison(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<StageB1ComparisonReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatStageB1Comparison(report)) write(line);
  }
  return report.acceptance.overall === "pass" ? 0 : 1;
}

export async function runQualityExtractionComparison(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<StageB2ExtractionComparisonReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatStageB2ExtractionComparison(report)) write(line);
  }
  return report.acceptance.overall === "pass" ? 0 : 1;
}

export async function runQualityCoreHandoffComparison(
  options: { json?: boolean },
  write: (line: string) => void,
  runner: () => Promise<StageB3CoreHandoffComparisonReport>
): Promise<number> {
  const report = await runner();
  if (options.json) {
    write(JSON.stringify(report, null, 2));
  } else {
    for (const line of formatStageB3CoreHandoffComparison(report)) write(line);
  }
  return report.acceptance.overall === "pass" ? 0 : 1;
}
