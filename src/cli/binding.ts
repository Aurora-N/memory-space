import { randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SpaceResolver, type SpaceBinding } from "../binding/space-resolver.ts";
import { SpaceBindingInvalidError, SpaceNotBoundError } from "../integration/errors.ts";
import { CliError } from "./errors.ts";

export async function resolveOptionalBinding(cwd: string): Promise<SpaceBinding | undefined> {
  try {
    return await new SpaceResolver().resolve({ cwd: resolve(cwd) });
  } catch (error) {
    if (error instanceof SpaceNotBoundError) return undefined;
    if (error instanceof SpaceBindingInvalidError) {
      throw new CliError("BINDING_INVALID", "Project Memory Space binding is invalid.", {
        remediation: "Repair .memory-space/config.json; the existing file was preserved.",
        cause: error
      });
    }
    throw error;
  }
}

export async function writeBindingAtomically(
  cwd: string,
  spaceId: string
): Promise<string> {
  const bindingDirectory = join(resolve(cwd), ".memory-space");
  const configPath = join(bindingDirectory, "config.json");
  const temporaryPath = join(bindingDirectory, `.config.${process.pid}.${randomUUID()}.tmp`);
  let linking = false;
  try {
    await mkdir(bindingDirectory, { recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, spaceId }, null, 2)}\n`,
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
        cause: error
      }
    );
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return configPath;
}
