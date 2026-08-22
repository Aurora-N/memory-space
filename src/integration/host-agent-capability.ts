import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const reviewedClaudeCodeVersion = "2.1.112";
const requiredClaudeCodeFlags = [
  "--json-schema",
  "--tools",
  "--strict-mcp-config",
  "--mcp-config",
  "--setting-sources",
  "--disable-slash-commands",
  "--no-session-persistence",
] as const;

export type HostAgentCapabilityStatus = "reviewed" | "unverified" | "unsupported" | "not_installed";

/** Sanitized, no-model-call capability result for one installed host CLI. */
export interface HostAgentCapabilityResult {
  provider: "claude-code" | "codex";
  status: HostAgentCapabilityStatus;
  version?: string;
  reason: string;
}

export type HostAgentCapabilityProbe = (
  provider: "claude-code" | "codex"
) => Promise<HostAgentCapabilityResult>;

function versionFrom(value: string): string | undefined {
  return value.match(/\b\d+\.\d+\.\d+\b/u)?.[0];
}

/** Checks version/help only; it never invokes a paid semantic model request. */
export const probeHostAgentCapability: HostAgentCapabilityProbe = async (provider) => {
  if (provider === "codex") {
    return {
      provider,
      status: "unsupported",
      reason: "No reviewed all-tools/MCP/hooks isolation contract exists.",
    };
  }
  try {
    const [versionResult, helpResult] = await Promise.all([
      execFileAsync("claude", ["--version"], { timeout: 2_000, maxBuffer: 64_000 }),
      execFileAsync("claude", ["--help"], { timeout: 2_000, maxBuffer: 512_000 }),
    ]);
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    const version = versionFrom(versionOutput);
    const missingFlags = requiredClaudeCodeFlags.filter((flag) => !help.includes(flag));
    if (missingFlags.length > 0) {
      return {
        provider,
        status: "unsupported",
        version,
        reason: `Required isolation flags are missing: ${missingFlags.join(", ")}.`,
      };
    }
    if (version !== reviewedClaudeCodeVersion) {
      return {
        provider,
        status: "unverified",
        version,
        reason: `Isolation was reviewed on Claude Code ${reviewedClaudeCodeVersion}; this runtime has not completed that gate.`,
      };
    }
    return {
      provider,
      status: "reviewed",
      version,
      reason: "Version and required isolation flags match the reviewed capability evidence.",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      provider,
      status: code === "ENOENT" ? "not_installed" : "unverified",
      reason:
        code === "ENOENT"
          ? "Claude Code CLI is not installed or not on PATH."
          : "Claude Code version/help capability probe failed.",
    };
  }
};
