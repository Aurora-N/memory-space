import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  resolveImplicitRecallConfiguration,
  resolveImplicitRememberConfiguration,
} from "../binding/project-config.ts";
import { type SpaceBinding, SpaceResolver } from "../binding/space-resolver.ts";
import { SpaceBindingInvalidError, SpaceNotBoundError } from "../integration/errors.ts";
import { CliError } from "./errors.ts";

function invalidBinding(cause?: unknown): CliError {
  return new CliError("BINDING_INVALID", "Project Memory Space binding is invalid.", {
    remediation: "Repair .memory-space/config.json; the existing file was preserved.",
    cause,
  });
}

export async function readLocalProjectBinding(cwd: string): Promise<SpaceBinding | undefined> {
  const configPath = join(resolve(cwd), ".memory-space", "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalidBinding(error);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalidBinding(error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBinding();
  }
  const config = value as Record<string, unknown>;
  if (config.version !== 1 || typeof config.spaceId !== "string" || config.spaceId.trim() === "") {
    throw invalidBinding();
  }
  return {
    spaceId: config.spaceId.trim(),
    source: "config",
    configPath,
    implicitRecall: resolveImplicitRecallConfiguration(config),
    implicitRemember: resolveImplicitRememberConfiguration(config),
  };
}

export async function resolveOptionalBinding(cwd: string): Promise<SpaceBinding | undefined> {
  try {
    return await new SpaceResolver().resolve({ cwd: resolve(cwd) });
  } catch (error) {
    if (error instanceof SpaceNotBoundError) return undefined;
    if (error instanceof SpaceBindingInvalidError) {
      throw invalidBinding(error);
    }
    throw error;
  }
}

export async function writeBindingAtomically(cwd: string, spaceId: string): Promise<string> {
  const bindingDirectory = join(resolve(cwd), ".memory-space");
  const configPath = join(bindingDirectory, "config.json");
  const temporaryPath = join(bindingDirectory, `.config.${process.pid}.${randomUUID()}.tmp`);
  let linking = false;
  try {
    await mkdir(bindingDirectory, { recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          version: 1,
          spaceId,
          implicitRecall: { mode: "exact" },
          implicitRemember: { mode: "conservative" },
        },
        null,
        2
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    linking = true;
    await link(temporaryPath, configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const conflict = linking && code === "EEXIST";
    throw new CliError(
      conflict ? "BINDING_CONFLICT" : "BINDING_WRITE_FAILED",
      conflict
        ? "A project binding appeared during initialization; it was not overwritten."
        : "Space was created, but the project binding could not be written.",
      {
        remediation: conflict
          ? "Run memory-space init again to inspect the existing binding."
          : `Preserve the created Space and write ${configPath} after fixing filesystem permissions.`,
        cause: error,
      }
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return configPath;
}

export interface RemoveLocalBindingResult {
  removed: boolean;
  local?: SpaceBinding;
  inherited?: SpaceBinding;
}

/**
 * Removes only the exact binding owned by cwd. Ancestor bindings and Space data
 * are deliberately outside this operation's scope.
 */
export async function removeLocalProjectBinding(
  cwd: string,
  expectedSpaceId?: string
): Promise<RemoveLocalBindingResult> {
  const resolvedCwd = resolve(cwd);
  const local = await readLocalProjectBinding(resolvedCwd);
  if (!local) {
    return {
      removed: false,
      inherited: await resolveOptionalBinding(resolvedCwd),
    };
  }
  if (expectedSpaceId !== undefined && local.spaceId !== expectedSpaceId) {
    throw new CliError(
      "BINDING_CONFLICT",
      `Local project binding points to Space ${local.spaceId}; it was not removed.`,
      { remediation: `Retry with --space-id ${local.spaceId} after reviewing the binding.` }
    );
  }
  try {
    await unlink(local.configPath as string);
  } catch (error) {
    throw new CliError("BINDING_REMOVE_FAILED", "Local project binding could not be removed.", {
      remediation: `Check filesystem permissions for ${local.configPath}.`,
      cause: error,
    });
  }
  return {
    removed: true,
    local,
    inherited: await resolveOptionalBinding(resolvedCwd),
  };
}
