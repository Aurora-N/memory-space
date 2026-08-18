import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ProjectExtractionRules,
  parseProjectExtractionRules,
} from "../adapters/declarative-rule-extractor.ts";
import { MemorySpaceError } from "../domain/errors.ts";
import type { SpaceBinding } from "./space-resolver.ts";

const MAX_EXTRACTION_RULES_BYTES = 64 * 1024;

/** Result of locating and validating the optional project extraction rule file. */
export type ProjectExtractionRulesResult =
  | { status: "absent"; path?: string; rules: [] }
  | { status: "configured"; path: string; rules: ProjectExtractionRules["rules"] };

/** Indicates that an explicitly present project extraction rule file is unusable. */
export class ProjectExtractionRulesInvalidError extends MemorySpaceError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string, cause?: unknown) {
    super("Invalid project extraction rules", {
      code: "EXTRACTION_RULES_INVALID",
      status: 422,
      cause,
    });
    this.path = path;
    this.reason = reason;
  }
}

/** Returns the rule file colocated with the effective project binding. */
export function extractionRulesPath(binding: SpaceBinding): string | undefined {
  return binding.configPath
    ? join(dirname(binding.configPath), "extraction-rules.json")
    : undefined;
}

/** Reads and validates optional project extraction rules without following symlinks. */
export async function readProjectExtractionRules(
  binding: SpaceBinding
): Promise<ProjectExtractionRulesResult> {
  const path = extractionRulesPath(binding);
  if (!path) return { status: "absent", rules: [] };
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "absent", path, rules: [] };
    }
    if (code === "ELOOP") {
      throw new ProjectExtractionRulesInvalidError(
        path,
        "file must be a regular non-symlink file",
        error
      );
    }
    throw new ProjectExtractionRulesInvalidError(path, "file could not be inspected", error);
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new ProjectExtractionRulesInvalidError(path, "file must be a regular non-symlink file");
    }
    if (metadata.size > MAX_EXTRACTION_RULES_BYTES) {
      throw new ProjectExtractionRulesInvalidError(
        path,
        `file exceeds ${MAX_EXTRACTION_RULES_BYTES} bytes`
      );
    }
    const raw = await file.readFile("utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_EXTRACTION_RULES_BYTES) {
      throw new ProjectExtractionRulesInvalidError(
        path,
        `file exceeds ${MAX_EXTRACTION_RULES_BYTES} bytes`
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new ProjectExtractionRulesInvalidError(path, "file is not valid JSON", error);
    }
    try {
      const parsed = parseProjectExtractionRules(value);
      return { status: "configured", path, rules: parsed.rules };
    } catch (error) {
      if (error instanceof ProjectExtractionRulesInvalidError) throw error;
      throw new ProjectExtractionRulesInvalidError(
        path,
        error instanceof Error ? error.message : "rule schema is invalid",
        error
      );
    }
  } catch (error) {
    if (error instanceof ProjectExtractionRulesInvalidError) throw error;
    throw new ProjectExtractionRulesInvalidError(path, "file could not be read", error);
  } finally {
    await file.close();
  }
}
