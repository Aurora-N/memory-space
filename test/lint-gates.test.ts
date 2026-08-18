import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("architecture lint accepts application dependencies through ports", () => {
  withFixture((root) => {
    write(root, "src/domain/value.ts", "export interface Value { id: string }\n");
    write(
      root,
      "src/ports/store.ts",
      'import type { Value } from "../domain/value.ts";\nexport interface Store { get(): Value }\n'
    );
    write(
      root,
      "src/application/service.ts",
      'import type { Store } from "../ports/store.ts";\nexport type Service = Store;\n'
    );

    const result = runGate("scripts/architecture-lint.mjs", root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("architecture lint rejects inward dependency violations and cycles", () => {
  withFixture((root) => {
    write(
      root,
      "src/domain/value.ts",
      'import type { Service } from "../application/service.ts";\nexport type Value = Service;\n'
    );
    write(
      root,
      "src/application/service.ts",
      'import type { Value } from "../domain/value.ts";\nexport type Service = Value;\n'
    );
    write(root, "src/adapters/sqlite/store.ts", "export class SqliteStore {}\n");
    write(
      root,
      "src/cli/main.ts",
      'void import("../adapters/sqlite/store.ts");\n'
    );

    const result = runGate("scripts/architecture-lint.mjs", root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /domain code must not import application code/);
    assert.match(result.stderr, /only composition roots may import the SQLite implementation/);
    assert.match(result.stderr, /Import cycle/);
  });
});

test("comment lint accepts documented ports and explained exceptional paths", () => {
  withFixture((root) => {
    write(
      root,
      "src/ports/store.ts",
      [
        "/** Source-of-truth persistence contract. */",
        "export interface Store { close(): void }",
        "try { throw new Error(); } catch {",
        "  // Best-effort cleanup must not hide the original failure.",
        "}",
        "// TODO(issue-42): replace the test adapter after the migration",
        ""
      ].join("\n")
    );

    const result = runGate("scripts/comment-lint.mjs", root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("comment lint rejects undocumented contracts and unexplained suppressions", () => {
  withFixture((root) => {
    write(
      root,
      "src/ports/store.ts",
      [
        "export interface Store { close(): void }",
        "try { throw new Error(); } catch {}",
        "// @ts-expect-error",
        "// biome-ignore lint/suspicious/noExplicitAny",
        "// TODO fix later",
        ""
      ].join("\n")
    );
    write(
      root,
      "src/index.ts",
      'export { createService } from "./application/service.ts";\n'
    );
    write(
      root,
      "src/application/service.ts",
      [
        "export function createService() { return {}; }",
        "// 中文注释",
        ""
      ].join("\n")
    );

    const result = runGate("scripts/comment-lint.mjs", root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires JSDoc/);
    assert.match(result.stderr, /empty catch requires a comment/);
    assert.match(result.stderr, /TypeScript suppression requires a useful reason/);
    assert.match(result.stderr, /Biome suppression requires a reason/);
    assert.match(result.stderr, /TODO must use/);
    assert.match(result.stderr, /public API 'createService' requires JSDoc/);
    assert.match(result.stderr, /code comments must use English/);
  });
});

function runGate(script: string, root: string) {
  return spawnSync(process.execPath, [resolve(repositoryRoot, script), "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memory-space-lint-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
