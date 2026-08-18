import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { ValidationError } from "../domain/errors.ts";
import { SpaceBindingInvalidError, SpaceNotBoundError } from "../integration/errors.ts";
import {
  resolveImplicitRecallConfiguration,
  type ImplicitRecallConfiguration
} from "./project-config.ts";

/** Inputs for explicit or nearest-ancestor Space binding resolution. */
export interface SpaceResolutionInput {
  cwd?: string;
  explicitSpaceId?: string;
}

/** Exact binding selected by explicit ID or nearest ancestor precedence. */
export interface SpaceBinding {
  spaceId: string;
  source: "explicit" | "config";
  configPath?: string;
  implicitRecall?: ImplicitRecallConfiguration;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/** Resolves Space bindings using cwd-to-ancestor precedence without inferring Git identity. */
export class SpaceResolver {
  async resolve(input: SpaceResolutionInput): Promise<SpaceBinding> {
    if (input.explicitSpaceId !== undefined) {
      return { spaceId: requiredString(input.explicitSpaceId, "explicitSpaceId"), source: "explicit" };
    }
    const cwd = resolve(requiredString(input.cwd, "cwd"));

    let directory = cwd;
    const root = parse(directory).root;
    while (true) {
      const configPath = join(directory, ".memory-space", "config.json");
      try {
        const raw = await readFile(configPath, "utf8");
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (error) {
          throw new SpaceBindingInvalidError(configPath, error);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new SpaceBindingInvalidError(configPath);
        }
        const config = value as Record<string, unknown>;
        if (config.version !== 1 || typeof config.spaceId !== "string" || config.spaceId.trim() === "") {
          throw new SpaceBindingInvalidError(configPath);
        }
        return {
          spaceId: config.spaceId.trim(),
          source: "config",
          configPath,
          implicitRecall: resolveImplicitRecallConfiguration(config)
        };
      } catch (error) {
        if (error instanceof SpaceBindingInvalidError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new SpaceBindingInvalidError(configPath, error);
        }
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    throw new SpaceNotBoundError(cwd);
  }
}
