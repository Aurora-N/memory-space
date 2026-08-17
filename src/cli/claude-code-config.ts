import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.ts";
import { DEFAULT_DAEMON_ENDPOINT, validateDaemonEndpoint } from "./local-client.ts";

const MAX_CONFIG_BYTES = 1024 * 1024;
const DEFAULT_INSTALLATION_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type Change = "created" | "updated" | "unchanged";

interface ConfigFile {
  exists: boolean;
  raw: string;
  mode: number;
}

interface PlannedFile {
  path: string;
  before: ConfigFile;
  content: string;
  change: Change;
}

export interface ConfigureClaudeCodeResult {
  cwd: string;
  dryRun: boolean;
  hooks: { path: string; change: Change };
  mcp: { path: string; change: Change };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function canonicalHookCommand(installationRoot: string): string {
  return `pnpm --dir ${shellQuote(installationRoot)} --silent claude-code:hook`;
}

function canonicalHooks(command: string): Record<string, unknown[]> {
  const handler = (): object => ({ type: "command", command, timeout: 8 });
  return {
    SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [handler()] }],
    UserPromptSubmit: [{ hooks: [handler()] }],
    Stop: [{ hooks: [handler()] }],
    PreCompact: [{ matcher: "manual|auto", hooks: [handler()] }],
    SessionEnd: [{ hooks: [handler()] }]
  };
}

function collectCommands(value: unknown, commands: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectCommands(item, commands);
  } else if (isRecord(value)) {
    if (typeof value.command === "string") commands.push(value.command);
    for (const item of Object.values(value)) collectCommands(item, commands);
  }
  return commands;
}

function isMemorySpaceClaudeCommand(command: string): boolean {
  return command.includes("claude-code:hook")
    || command.includes("/providers/claude-code/lifecycle");
}

function hasMemorySpaceHook(value: unknown): boolean {
  return collectCommands(value).some(isMemorySpaceClaudeCommand);
}

function hasMemorySpaceMcp(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.mcpServers)
    && isRecord(value.mcpServers.memory_space);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function equivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function readConfig(path: string): Promise<ConfigFile> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CliError(
        "PROVIDER_CONFIG_INVALID",
        `Refusing to modify non-regular provider configuration: ${path}`
      );
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new CliError(
        "PROVIDER_CONFIG_INVALID",
        `Provider configuration is too large to merge safely: ${path}`
      );
    }
    return { exists: true, raw: await readFile(path, "utf8"), mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, raw: "", mode: 0o600 };
    }
    if (error instanceof CliError) throw error;
    throw new CliError("PROVIDER_CONFIG_INVALID", `Provider configuration could not be read: ${path}`, {
      cause: error
    });
  }
}

function parseJsonObject(path: string, before: ConfigFile): Record<string, unknown> {
  if (!before.exists || before.raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(before.raw);
    if (!isRecord(parsed)) throw new Error("root is not an object");
    return parsed;
  } catch (error) {
    throw new CliError(
      "PROVIDER_CONFIG_INVALID",
      `Claude Code configuration is not valid JSON: ${path}`,
      { remediation: "Repair the file manually; it was preserved.", cause: error }
    );
  }
}

async function readActiveScope(path: string): Promise<Record<string, unknown> | undefined> {
  const file = await readConfig(path);
  return file.exists ? parseJsonObject(path, file) : undefined;
}

async function assertNoOtherActiveScope(cwd: string, home: string | undefined): Promise<void> {
  const localSettingsPath = join(cwd, ".claude", "settings.local.json");
  const localSettings = await readActiveScope(localSettingsPath);
  if (localSettings !== undefined && hasMemorySpaceHook(localSettings.hooks)) {
    throw new CliError(
      "PROVIDER_CONFIG_CONFLICT",
      "Project-local Claude Code Memory Space hooks are already active in settings.local.json.",
      { remediation: "Keep one canonical active hook scope; no provider configuration was changed." }
    );
  }
  if (home === undefined) return;

  const resolvedHome = resolve(home);
  const [userSettings, globalConfig] = await Promise.all([
    readActiveScope(join(resolvedHome, ".claude", "settings.json")),
    readActiveScope(join(resolvedHome, ".claude.json"))
  ]);
  const userHookConfigured = userSettings !== undefined && hasMemorySpaceHook(userSettings.hooks);
  const userMcpConfigured = globalConfig !== undefined && hasMemorySpaceMcp(globalConfig);
  const currentProjectMcpConfigured = globalConfig !== undefined
    && isRecord(globalConfig.projects)
    && Object.entries(globalConfig.projects).some(([projectPath, config]) => (
      isAbsolute(projectPath) && resolve(projectPath) === cwd && hasMemorySpaceMcp(config)
    ));
  if (userHookConfigured || userMcpConfigured || currentProjectMcpConfigured) {
    throw new CliError(
      "PROVIDER_CONFIG_CONFLICT",
      "Another active Claude Code Memory Space configuration scope already covers this project.",
      {
        remediation: "Use the existing scope or remove it before creating project files. No project files were changed."
      }
    );
  }
}

function planHooks(path: string, before: ConfigFile, command: string): PlannedFile {
  const root = parseJsonObject(path, before);
  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    throw new CliError("PROVIDER_CONFIG_INVALID", `Claude Code hooks field is not an object: ${path}`, {
      remediation: "Repair the file manually; it was preserved."
    });
  }
  const hooks = isRecord(root.hooks) ? { ...root.hooks } : {};
  const canonical = canonicalHooks(command);
  for (const [event, definitions] of Object.entries(canonical)) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new CliError(
        "PROVIDER_CONFIG_INVALID",
        `Claude Code ${event} hooks are not an array: ${path}`,
        { remediation: "Repair the file manually; it was preserved." }
      );
    }
    const existingDefinitions = existing as unknown[] | undefined ?? [];
    const memoryDefinitions = existingDefinitions.filter(hasMemorySpaceHook);
    if (memoryDefinitions.length > 0) {
      const memoryCommands = collectCommands(memoryDefinitions);
      const exact = memoryDefinitions.length === 1
        && memoryCommands.length === 1
        && memoryCommands[0] === command
        && equivalent(memoryDefinitions[0], definitions[0]);
      if (!exact) {
        throw new CliError(
          "PROVIDER_CONFIG_CONFLICT",
          `Claude Code ${event} already contains a different Memory Space hook: ${path}`,
          { remediation: "Review the existing hook; no provider configuration was changed." }
        );
      }
      continue;
    }
    hooks[event] = [...existingDefinitions, ...definitions];
  }
  const content = `${JSON.stringify({ ...root, hooks }, null, 2)}\n`;
  return {
    path,
    before,
    content,
    change: !before.exists ? "created" : before.raw === content ? "unchanged" : "updated"
  };
}

function planMcp(path: string, before: ConfigFile, mcpUrl: string): PlannedFile {
  const root = parseJsonObject(path, before);
  if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
    throw new CliError("PROVIDER_CONFIG_INVALID", `Claude Code mcpServers field is not an object: ${path}`, {
      remediation: "Repair the file manually; it was preserved."
    });
  }
  const mcpServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  const canonical = { type: "http", url: mcpUrl };
  if (mcpServers.memory_space !== undefined && !equivalent(mcpServers.memory_space, canonical)) {
    throw new CliError(
      "PROVIDER_CONFIG_CONFLICT",
      `Claude Code memory_space MCP configuration conflicts: ${path}`,
      { remediation: `Set the existing memory_space server to ${mcpUrl}; the file was preserved.` }
    );
  }
  mcpServers.memory_space = canonical;
  const content = `${JSON.stringify({ ...root, mcpServers }, null, 2)}\n`;
  return {
    path,
    before,
    content,
    change: !before.exists ? "created" : before.raw === content ? "unchanged" : "updated"
  };
}

async function writeAtomically(plan: PlannedFile): Promise<void> {
  if (plan.change === "unchanged") return;
  const directory = dirname(plan.path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.memory-space-config.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, plan.content, {
      encoding: "utf8", flag: "wx", mode: plan.before.mode
    });
    if (!plan.before.exists) {
      await link(temporaryPath, plan.path);
      return;
    }
    const current = await readFile(plan.path, "utf8");
    if (current !== plan.before.raw) {
      throw new CliError(
        "PROVIDER_CONFIG_CONFLICT",
        `Provider configuration changed during merge: ${plan.path}`,
        { remediation: "Retry after reviewing the concurrent edit." }
      );
    }
    await rename(temporaryPath, plan.path);
  } catch (error) {
    if (error instanceof CliError) throw error;
    const conflict = (error as NodeJS.ErrnoException).code === "EEXIST";
    throw new CliError(
      conflict ? "PROVIDER_CONFIG_CONFLICT" : "PROVIDER_CONFIG_WRITE_FAILED",
      conflict
        ? `Provider configuration appeared during merge: ${plan.path}`
        : `Provider configuration could not be written: ${plan.path}`,
      {
        remediation: conflict
          ? "Retry after reviewing the concurrent file."
          : "Check project filesystem permissions; existing files were preserved.",
        cause: error
      }
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function configureClaudeCodeProject(options: {
  cwd: string;
  dryRun?: boolean;
  installationRoot?: string;
  home?: string;
  endpoint?: string;
}): Promise<ConfigureClaudeCodeResult> {
  const cwd = resolve(options.cwd);
  try {
    if (!(await lstat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new CliError(
      "VALIDATION_ERROR",
      "Claude Code configuration target must be an existing directory.",
      { cause: error }
    );
  }
  await assertNoOtherActiveScope(cwd, options.home);
  const hooksPath = join(cwd, ".claude", "settings.json");
  const mcpPath = join(cwd, ".mcp.json");
  const [hooksBefore, mcpBefore] = await Promise.all([
    readConfig(hooksPath),
    readConfig(mcpPath)
  ]);
  const endpoint = validateDaemonEndpoint(options.endpoint ?? DEFAULT_DAEMON_ENDPOINT);
  const mcpUrl = new URL("mcp", endpoint).href;
  const hooks = planHooks(
    hooksPath,
    hooksBefore,
    canonicalHookCommand(resolve(options.installationRoot ?? DEFAULT_INSTALLATION_ROOT))
  );
  const mcp = planMcp(mcpPath, mcpBefore, mcpUrl);
  if (!options.dryRun) {
    await writeAtomically(hooks);
    await writeAtomically(mcp);
  }
  return {
    cwd,
    dryRun: options.dryRun ?? false,
    hooks: { path: hooks.path, change: hooks.change },
    mcp: { path: mcp.path, change: mcp.change }
  };
}
