import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SpaceBindingInvalidError,
  SpaceNotBoundError,
  SpaceResolver
} from "../src/index.ts";

function bind(directory: string, spaceId: string): void {
  const bindingDirectory = join(directory, ".memory-space");
  mkdirSync(bindingDirectory, { recursive: true });
  writeFileSync(join(bindingDirectory, "config.json"), JSON.stringify({ version: 1, spaceId }));
}

test("SpaceResolver implements explicit and nearest-ancestor binding semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-binding-"));
  try {
    const web = join(root, "apps", "web");
    const webSrc = join(web, "src", "pages");
    const api = join(root, "services", "api");
    mkdirSync(webSrc, { recursive: true });
    mkdirSync(api, { recursive: true });
    bind(root, "space-root");
    bind(web, "space-web");
    bind(api, "space-api");
    const resolver = new SpaceResolver();

    assert.equal((await resolver.resolve({ cwd: root })).spaceId, "space-root");
    assert.equal((await resolver.resolve({ cwd: join(root, "apps") })).spaceId, "space-root");
    const nearest = await resolver.resolve({ cwd: webSrc });
    assert.equal(nearest.spaceId, "space-web");
    assert.equal(nearest.configPath, join(web, ".memory-space", "config.json"));
    assert.deepEqual(await Promise.all([
      resolver.resolve({ cwd: root }), resolver.resolve({ cwd: webSrc }), resolver.resolve({ cwd: api })
    ]).then((values) => values.map((value) => value.spaceId)), ["space-root", "space-web", "space-api"]);
    assert.deepEqual(await resolver.resolve({ cwd: webSrc, explicitSpaceId: "space-explicit" }), {
      spaceId: "space-explicit", source: "explicit"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SpaceResolver rejects the nearest malformed binding instead of skipping it", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-malformed-binding-"));
  try {
    const nested = join(root, "nested");
    mkdirSync(join(nested, ".memory-space"), { recursive: true });
    bind(root, "space-root");
    writeFileSync(join(nested, ".memory-space", "config.json"), "{broken");
    await assert.rejects(
      new SpaceResolver().resolve({ cwd: nested }),
      (error: unknown) => error instanceof SpaceBindingInvalidError && error.code === "SPACE_BINDING_INVALID"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SpaceResolver reports a stable unbound result and never infers Git identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-unbound-"));
  try {
    mkdirSync(join(root, ".git"));
    await assert.rejects(
      new SpaceResolver().resolve({ cwd: root }),
      (error: unknown) => error instanceof SpaceNotBoundError && error.code === "SPACE_NOT_BOUND"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SpaceResolver keeps binding validity separate from implicit recall validity", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-recall-config-"));
  try {
    const path = join(root, ".memory-space", "config.json");
    mkdirSync(join(root, ".memory-space"));
    const resolver = new SpaceResolver();

    writeFileSync(path, JSON.stringify({ version: 1, spaceId: "space-default" }));
    assert.deepEqual((await resolver.resolve({ cwd: root })).implicitRecall, {
      effectiveMode: "exact",
      source: "default"
    });

    for (const mode of ["off", "exact", "lexical"] as const) {
      writeFileSync(path, JSON.stringify({
        version: 1,
        spaceId: "space-explicit",
        implicitRecall: { mode }
      }));
      assert.deepEqual((await resolver.resolve({ cwd: root })).implicitRecall, {
        configuredMode: mode,
        effectiveMode: mode,
        source: "explicit"
      });
    }

    for (const implicitRecall of [{ mode: "unknown" }, [], { mode: 123 }]) {
      writeFileSync(path, JSON.stringify({
        version: 1,
        spaceId: "space-still-valid",
        implicitRecall
      }));
      const binding = await resolver.resolve({ cwd: root });
      assert.equal(binding.spaceId, "space-still-valid");
      assert.equal(binding.implicitRecall?.effectiveMode, "off");
      assert.equal(binding.implicitRecall?.source, "invalid");
      assert.match(binding.implicitRecall?.error ?? "", /implicitRecall/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
