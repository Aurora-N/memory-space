import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import type {
  CrossSessionEvalReport
} from "../../eval/support/cross-session-runner.ts";
import type { Space } from "../domain/types.ts";
import { CliError } from "./errors.ts";
import { resolveOptionalBinding, writeBindingAtomically } from "./binding.ts";
import {
  MEMORY_MCP_TOOLS,
  type LocalMemorySpaceClientPort
} from "./local-client.ts";
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

export async function runInit(
  options: InitOptions,
  context: CommandContext
): Promise<void> {
  const cwd = resolve(options.cwd ?? context.cwd);
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", "Initialization target must be an existing directory.", {
      remediation: "Create the project directory before running memory-space init.",
      cause: error
    });
  }
  const requestedSpaceId = required(options.spaceId, "--space-id");
  const requestedName = required(options.name, "--name") ?? basename(cwd);
  const binding = await resolveOptionalBinding(cwd);

  if (binding) {
    if (requestedSpaceId !== undefined && requestedSpaceId !== binding.spaceId) {
      throw new CliError(
        "BINDING_CONFLICT",
        `Project is already bound to Space ${binding.spaceId}; it was not rebound.`,
        { remediation: "Use the existing Space or update the binding explicitly after review." }
      );
    }
    await context.client.health();
    const space = await context.client.getSpace(binding.spaceId);
    context.write("Memory Space already initialized");
    context.write(`Space:   ${space.name} (${space.id})`);
    context.write(`Binding: ${binding.configPath ?? binding.source}`);
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
    if (error instanceof CliError
      && (error.code === "BINDING_WRITE_FAILED" || error.code === "BINDING_CONFLICT")) {
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
  providerNextSteps(context.write);
}

function providerNextSteps(write: (line: string) => void): void {
  write("");
  write("Provider next steps (global configuration was not modified):");
  write("Codex:       docs/CODEX_INTEGRATION.md and examples/codex/");
  write("Claude Code: docs/CLAUDE_CODE_INTEGRATION.md and examples/claude-code/");
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
    check("daemon-endpoint", "ok", `Loopback endpoint accepted: ${context.client.endpoint}`)
  ];

  let daemonReachable = false;
  try {
    await context.client.health();
    daemonReachable = true;
    checks.push(check("daemon", "ok", "Daemon reachable."));
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(check(
      "daemon",
      "error",
      "Daemon unavailable.",
      value?.remediation ?? "Start it with: pnpm start"
    ));
  }

  let binding: Awaited<ReturnType<typeof resolveOptionalBinding>>;
  try {
    binding = await resolveOptionalBinding(cwd);
    if (binding) {
      checks.push(check("binding", "ok", `Binding valid for Space ${binding.spaceId}.`));
      checks.push(check(
        "binding-source",
        "ok",
        `Nearest binding source: ${binding.configPath ?? binding.source}.`
      ));
    } else {
      checks.push(check(
        "binding",
        "error",
        "No project binding found.",
        "Run memory-space init from the project directory."
      ));
      checks.push(check("binding-source", "error", "Nearest binding source unavailable."));
    }
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(check(
      "binding",
      "error",
      "Project binding is malformed.",
      value?.remediation
    ));
    checks.push(check("binding-source", "error", "Nearest binding source unavailable."));
  }

  if (binding && daemonReachable) {
    try {
      const space = await context.client.getSpace(binding.spaceId);
      checks.push(check("space", "ok", `Bound Space exists: ${space.name} (${space.id}).`));
    } catch (error) {
      const missing = error instanceof CliError && error.code === "SPACE_NOT_FOUND";
      checks.push(check(
        "space",
        "error",
        missing
          ? `Bound Space does not exist: ${binding.spaceId}.`
          : "Bound Space could not be verified because the daemon request failed.",
        missing
          ? "Review the binding before creating or selecting a replacement Space."
          : "Inspect daemon health/logs and retry memory-space doctor."
      ));
    }
  } else {
    checks.push(check("space", "error", "Bound Space could not be verified."));
  }

  try {
    const tools = await context.client.listMcpTools();
    if (JSON.stringify(tools) === JSON.stringify([...MEMORY_MCP_TOOLS])) {
      checks.push(check("mcp", "ok", "MCP reachable; exact six tools discovered."));
    } else {
      checks.push(check(
        "mcp",
        "error",
        `MCP tool mismatch: discovered ${tools.length}, expected 6.`,
        "Use the shared Memory Space daemon without provider-specific aliases."
      ));
    }
  } catch (error) {
    const value = error instanceof CliError ? error : undefined;
    checks.push(check(
      "mcp",
      "error",
      "MCP endpoint unavailable.",
      value?.remediation
    ));
  }

  for (const provider of await detectProviderConfigs(cwd, context.home)) {
    const id = provider.provider === "codex" ? "codex" : "claude-code";
    checks.push(check(
      id,
      provider.state === "detected" ? "ok" : "warn",
      provider.message,
      provider.state === "detected"
        ? undefined
        : provider.provider === "codex"
          ? "See docs/CODEX_INTEGRATION.md."
          : "See docs/CLAUDE_CODE_INTEGRATION.md."
    ));
  }
  checks.push(check(
    "claude-real-mcp-waiver",
    "warn",
    "Claude real model-driven MCP remains externally blocked / waived for progression.",
    "Use first-party Anthropic authentication or a gateway that preserves MCP tool names."
  ));

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
): Promise<void> {
  const cwd = resolve(options.cwd ?? context.cwd);
  const binding = await resolveOptionalBinding(cwd);
  if (!binding) {
    throw new CliError("BINDING_NOT_FOUND", "No project Memory Space binding found.", {
      remediation: "Run memory-space init from the project directory."
    });
  }
  await context.client.health();
  const space = await context.client.getSpace(binding.spaceId);
  const handoff = await context.client.getLatestHandoff(space.id);
  const report: StatusReport = {
    daemon: "ok",
    space: { id: space.id, name: space.name },
    binding: { source: binding.source, configPath: binding.configPath },
    latestCheckpoint: handoff ? { id: handoff.checkpointId } : undefined,
    latestHandoff: handoff ? {
      id: handoff.id,
      sessionId: handoff.sessionId,
      createdAt: handoff.createdAt,
      goal: handoff.goal,
      nextSteps: handoff.nextSteps
    } : undefined
  };
  if (options.json) {
    context.write(JSON.stringify(report, null, 2));
    return;
  }
  context.write("Memory Space status");
  context.write(`Daemon:           OK (${context.client.endpoint})`);
  context.write(`Space:            ${space.name} (${space.id})`);
  context.write(`Binding source:   ${binding.configPath ?? binding.source}`);
  context.write(`Latest checkpoint:${report.latestCheckpoint ? ` ${report.latestCheckpoint.id}` : " none"}`);
  context.write(`Latest Handoff:   ${report.latestHandoff ? report.latestHandoff.id : "none"}`);
  if (report.latestHandoff) {
    context.write(`Handoff Session:  ${report.latestHandoff.sessionId}`);
    context.write(`Handoff created:  ${report.latestHandoff.createdAt}`);
    context.write(`Next steps:       ${report.latestHandoff.nextSteps.join("; ") || "none"}`);
  }
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
