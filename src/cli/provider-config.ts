import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

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
    // Doctor detection is read-only; unreadable candidates are reported as not detected.
    return false;
  }
}

async function matchingCount(paths: string[], markers: readonly string[]): Promise<number> {
  return (await Promise.all(paths.map((path) => hasMarker(path, markers))))
    .filter(Boolean).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    // Malformed or unreadable optional provider files are not active configurations.
    return undefined;
  }
}

function hasMemorySpaceMcpServer(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.mcpServers)
    && isRecord(value.mcpServers.memory_space);
}

function hasClaudeHookCommand(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClaudeHookCommand);
  if (!isRecord(value)) return false;
  if (typeof value.command === "string"
    && (value.command.includes("claude-code:hook")
      || value.command.includes("/providers/claude-code/lifecycle"))) {
    return true;
  }
  return Object.values(value).some(hasClaudeHookCommand);
}

async function hasClaudeHooks(path: string): Promise<boolean> {
  const config = await readJsonObject(path);
  return config !== undefined && hasClaudeHookCommand(config.hooks);
}

async function claudeMcpCounts(cwd: string, home: string): Promise<number> {
  const resolvedCwd = resolve(cwd);
  const projectConfig = await readJsonObject(join(resolvedCwd, ".mcp.json"));
  const globalConfig = await readJsonObject(join(home, ".claude.json"));
  let count = hasMemorySpaceMcpServer(projectConfig) ? 1 : 0;

  if (!globalConfig) return count;
  if (hasMemorySpaceMcpServer(globalConfig)) count += 1;

  if (isRecord(globalConfig.projects)) {
    const currentProjectConfigured = Object.entries(globalConfig.projects).some(
      ([projectPath, config]) => isAbsolute(projectPath)
        && resolve(projectPath) === resolvedCwd
        && hasMemorySpaceMcpServer(config)
    );
    if (currentProjectConfigured) count += 1;
  }
  return count;
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
  const claudeHooks = (await Promise.all([
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json")
  ].map(hasClaudeHooks))).filter(Boolean).length;
  const claudeMcp = await claudeMcpCounts(cwd, home);

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
