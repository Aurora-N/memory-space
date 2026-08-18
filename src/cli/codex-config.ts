import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export interface ConfigureCodexResult {
  cwd: string;
  dryRun: boolean;
  hooks: { path: string; change: Change };
  mcp: { path: string; change: Change };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function canonicalHookCommand(installationRoot: string): string {
  return `pnpm --dir ${shellQuote(installationRoot)} --silent codex:hook`;
}

function canonicalHooks(command: string): Record<string, unknown[]> {
  const handler = (timeout: number, extra: Record<string, unknown> = {}): object => ({
    type: "command", command, timeout, ...extra
  });
  return {
    SessionStart: [{
      matcher: "startup|resume|clear|compact",
      hooks: [handler(5, {
        statusMessage: "Loading durable project memory",
        additionalContextLimit: 5000
      })]
    }],
    UserPromptSubmit: [{ hooks: [handler(5)] }],
    Stop: [{ hooks: [handler(5)] }],
    PreCompact: [{
      matcher: "manual|auto",
      hooks: [handler(5, { statusMessage: "Checkpointing durable project memory" })]
    }],
    SessionEnd: [{ matcher: "other", hooks: [handler(3)] }]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function isMemorySpaceCodexCommand(command: string): boolean {
  return command.includes("codex:hook")
    || command.includes("/providers/codex/lifecycle");
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

async function readSmallFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CONFIG_BYTES) {
      return undefined;
    }
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function assertNoUserScope(home: string | undefined): Promise<void> {
  if (home === undefined) return;
  const hooksPath = join(resolve(home), ".codex", "hooks.json");
  const mcpPath = join(resolve(home), ".codex", "config.toml");
  const [hooks, mcp] = await Promise.all([readSmallFile(hooksPath), readSmallFile(mcpPath)]);
  const hookConfigured = hooks !== undefined
    && (hooks.includes("codex:hook") || hooks.includes("/providers/codex/lifecycle"));
  const mcpConfigured = mcp?.split(/\r?\n/u).some((line) => (
      !line.trimStart().startsWith("#") && line.includes("memory_space")
    )) ?? false;
  if (hookConfigured || mcpConfigured) {
    throw new CliError(
      "PROVIDER_CONFIG_CONFLICT",
      "User-level Codex Memory Space configuration is already active.",
      {
        remediation: "Use the existing user scope or remove it before creating project-local configuration. No project files were changed."
      }
    );
  }
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
    return {
      exists: true,
      raw: await readFile(path, "utf8"),
      mode: metadata.mode & 0o777
    };
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

function planHooks(path: string, before: ConfigFile, command: string): PlannedFile {
  let root: Record<string, unknown>;
  if (!before.exists || before.raw.trim() === "") {
    root = {};
  } else {
    try {
      const parsed: unknown = JSON.parse(before.raw);
      if (!isRecord(parsed)) throw new Error("root is not an object");
      root = parsed;
    } catch (error) {
      throw new CliError(
        "PROVIDER_CONFIG_INVALID",
        `Codex hooks configuration is not valid JSON: ${path}`,
        { remediation: "Repair the file manually; it was preserved.", cause: error }
      );
    }
  }
  if (root.hooks !== undefined && !isRecord(root.hooks)) {
    throw new CliError("PROVIDER_CONFIG_INVALID", `Codex hooks field is not an object: ${path}`, {
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
        `Codex ${event} hooks are not an array: ${path}`,
        { remediation: "Repair the file manually; it was preserved." }
      );
    }
    const existingDefinitions = existing as unknown[] | undefined ?? [];
    const memoryDefinitions = existingDefinitions.filter((definition) => (
      collectCommands(definition).some(isMemorySpaceCodexCommand)
    ));
    if (memoryDefinitions.length > 0) {
      const memoryCommands = collectCommands(memoryDefinitions);
      const exact = memoryDefinitions.length === 1
        && memoryCommands.length === 1
        && memoryCommands[0] === command
        && equivalent(memoryDefinitions[0], definitions[0]);
      if (!exact) {
        throw new CliError(
          "PROVIDER_CONFIG_CONFLICT",
          `Codex ${event} already contains a different Memory Space hook: ${path}`,
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
  const activeLines = before.raw.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const sectionIndexes = activeLines
    .map((line, index) => /^\[mcp_servers\.memory_space\]\s*$/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  let content = before.raw;
  if (sectionIndexes.length > 1) {
    throw new CliError("PROVIDER_CONFIG_CONFLICT", `Codex MCP configuration is ambiguous: ${path}`, {
      remediation: "Keep one memory_space MCP section; the file was preserved."
    });
  }
  if (sectionIndexes.length === 1) {
    const [start] = sectionIndexes;
    if (start === undefined) throw new Error("Expected one memory_space MCP section");
    const section = activeLines.slice(start + 1).findIndex((line) => /^\[/u.test(line));
    const end = section < 0 ? activeLines.length : start + 1 + section;
    const urlLines = activeLines.slice(start + 1, end)
      .filter((line) => /^url\s*=/u.test(line));
    const parsedUrl = urlLines[0]?.match(/^url\s*=\s*(["'])(.*?)\1\s*$/u)?.[2];
    const exactUrl = urlLines.length === 1 && parsedUrl === mcpUrl;
    if (!exactUrl) {
      throw new CliError("PROVIDER_CONFIG_CONFLICT", `Codex memory_space MCP URL conflicts: ${path}`, {
        remediation: `Set the existing memory_space URL to ${mcpUrl}; the file was preserved.`
      });
    }
  } else {
    const activeMemorySpace = activeLines.some((line) => line.includes("memory_space"));
    if (activeMemorySpace) {
      throw new CliError("PROVIDER_CONFIG_CONFLICT", `Codex memory_space MCP shape is unsupported: ${path}`, {
        remediation: "Review the existing configuration; no provider configuration was changed."
      });
    }
    const separator = content === "" ? "" : content.endsWith("\n\n")
      ? "" : content.endsWith("\n") ? "\n" : "\n\n";
    content += `${separator}[mcp_servers.memory_space]\nurl = "${mcpUrl}"\n`;
  }
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

export async function configureCodexProject(options: {
  cwd: string;
  dryRun?: boolean;
  installationRoot?: string;
  home?: string;
  endpoint?: string;
}): Promise<ConfigureCodexResult> {
  const cwd = resolve(options.cwd);
  try {
    if (!(await lstat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new CliError("VALIDATION_ERROR", "Codex configuration target must be an existing directory.", {
      cause: error
    });
  }
  await assertNoUserScope(options.home);
  const codexDirectory = join(cwd, ".codex");
  const hooksPath = join(codexDirectory, "hooks.json");
  const mcpPath = join(codexDirectory, "config.toml");
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
