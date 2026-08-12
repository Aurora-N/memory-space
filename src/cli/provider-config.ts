import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ProviderConfigState {
  provider: "codex" | "claude-code";
  state: "detected" | "partial" | "not-configured" | "ambiguous";
  message: string;
}

async function hasMarker(path: string, markers: readonly string[]): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return false;
    const content = await readFile(path, "utf8");
    return markers.some((marker) => content.includes(marker));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
}

async function matchingCount(paths: string[], markers: readonly string[]): Promise<number> {
  return (await Promise.all(paths.map((path) => hasMarker(path, markers))))
    .filter(Boolean).length;
}

export async function detectProviderConfigs(
  cwd: string,
  home: string
): Promise<ProviderConfigState[]> {
  const codexHooks = await matchingCount([
    join(cwd, ".codex", "hooks.json"),
    join(home, ".codex", "hooks.json")
  ], ["codex:hook", "/providers/codex/lifecycle"]);
  const codexMcp = await matchingCount([
    join(cwd, ".codex", "config.toml"),
    join(home, ".codex", "config.toml")
  ], ["mcp_servers.memory_space", "memory_space"]);
  const claudeHooks = await matchingCount([
    join(cwd, ".claude", "settings.json"),
    join(home, ".claude", "settings.json")
  ], ["claude-code:hook", "/providers/claude-code/lifecycle"]);
  const claudeMcp = await matchingCount([
    join(cwd, ".mcp.json")
  ], ["memory_space", "/mcp"]);

  return [
    providerState("codex", codexHooks, codexMcp),
    providerState("claude-code", claudeHooks, claudeMcp)
  ];
}

function providerState(
  provider: ProviderConfigState["provider"],
  hookCount: number,
  mcpCount: number
): ProviderConfigState {
  const label = provider === "codex" ? "Codex" : "Claude Code";
  if (hookCount > 1 || mcpCount > 1) {
    return {
      provider,
      state: "ambiguous",
      message: `${label} Memory Space configuration appears in multiple active scopes.`
    };
  }
  if (hookCount === 1 && mcpCount === 1) {
    return {
      provider,
      state: "detected",
      message: `${label} lifecycle and MCP configuration detected.`
    };
  }
  if (hookCount === 1 || mcpCount === 1) {
    return {
      provider,
      state: "partial",
      message: `${label} Memory Space configuration is partial.`
    };
  }
  return {
    provider,
    state: "not-configured",
    message: `${label} Memory Space configuration not detected.`
  };
}
