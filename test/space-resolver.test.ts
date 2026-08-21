import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readProjectBindingAtPath } from "../src/binding/space-resolver.ts";
import { SpaceBindingInvalidError, SpaceNotBoundError, SpaceResolver } from "../src/index.ts";

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
    assert.deepEqual(
      await Promise.all([
        resolver.resolve({ cwd: root }),
        resolver.resolve({ cwd: webSrc }),
        resolver.resolve({ cwd: api }),
      ]).then((values) => values.map((value) => value.spaceId)),
      ["space-root", "space-web", "space-api"]
    );
    assert.deepEqual(await resolver.resolve({ cwd: webSrc, explicitSpaceId: "space-explicit" }), {
      spaceId: "space-explicit",
      source: "explicit",
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
      (error: unknown) =>
        error instanceof SpaceBindingInvalidError && error.code === "SPACE_BINDING_INVALID"
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
      source: "default",
    });
    assert.deepEqual((await resolver.resolve({ cwd: root })).implicitRemember, {
      effectiveMode: "off",
      source: "default",
    });
    assert.deepEqual((await resolver.resolve({ cwd: root })).semanticExtraction, {
      effectiveMode: "off",
      source: "default",
      timeoutMs: 8000,
    });

    for (const mode of ["off", "exact", "lexical"] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-explicit",
          implicitRecall: { mode },
        })
      );
      assert.deepEqual((await resolver.resolve({ cwd: root })).implicitRecall, {
        configuredMode: mode,
        effectiveMode: mode,
        source: "explicit",
      });
    }

    for (const implicitRecall of [{ mode: "unknown" }, [], { mode: 123 }]) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-still-valid",
          implicitRecall,
        })
      );
      const binding = await resolver.resolve({ cwd: root });
      assert.equal(binding.spaceId, "space-still-valid");
      assert.equal(binding.implicitRecall?.effectiveMode, "off");
      assert.equal(binding.implicitRecall?.source, "invalid");
      assert.match(binding.implicitRecall?.error ?? "", /implicitRecall/u);
    }

    for (const mode of ["off", "conservative"] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-remember",
          implicitRemember: { mode },
        })
      );
      assert.deepEqual((await resolver.resolve({ cwd: root })).implicitRemember, {
        configuredMode: mode,
        effectiveMode: mode,
        source: "explicit",
      });
    }

    for (const implicitRemember of [{ mode: "semantic" }, [], { mode: 123 }]) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-still-valid",
          implicitRemember,
        })
      );
      const binding = await resolver.resolve({ cwd: root });
      assert.equal(binding.spaceId, "space-still-valid");
      assert.equal(binding.implicitRemember?.effectiveMode, "off");
      assert.equal(binding.implicitRemember?.source, "invalid");
      assert.match(binding.implicitRemember?.error ?? "", /implicitRemember/u);
    }

    const validSemanticConfigurations = [
      {
        model: {
          backend: "external",
          adapter: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          model: "fixture",
          apiKeyEnv: "SEMANTIC_API_KEY",
        },
      },
      {
        model: {
          backend: "local",
          adapter: "ollama",
          model: "qwen3:4b",
          baseUrl: "http://127.0.0.1:11434",
        },
      },
      { model: { backend: "host-agent", provider: "auto" } },
    ] as const;
    for (const semantic of validSemanticConfigurations) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-semantic",
          implicitRecall: { mode: "lexical" },
          implicitRemember: { mode: "conservative" },
          semanticExtraction: { mode: "grounded", ...semantic },
        })
      );
      const binding = await resolver.resolve({ cwd: root });
      assert.equal(binding.semanticExtraction?.effectiveMode, "grounded");
      assert.equal(binding.semanticExtraction?.source, "explicit");
      assert.equal(binding.implicitRecall?.effectiveMode, "lexical");
      assert.equal(binding.implicitRemember?.effectiveMode, "conservative");
    }

    const invalidSemanticConfigurations = [
      [],
      { mode: "auto" },
      { mode: "grounded", timeoutMs: -1, model: validSemanticConfigurations[0].model },
      {
        mode: "grounded",
        model: {
          backend: "external",
          adapter: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          model: "fixture",
          apiKey: "raw-secret",
        },
      },
      {
        mode: "grounded",
        model: {
          backend: "local",
          adapter: "ollama",
          model: "fixture",
          baseUrl: "https://remote.example.test",
        },
      },
      {
        mode: "grounded",
        model: {
          backend: "external",
          adapter: "openai-compatible",
          baseUrl: "https://models.example.test/v1",
          model: "fixture",
          provider: "claude-code",
        },
      },
      {
        mode: "grounded",
        model: {
          backend: "external",
          adapter: "openai-compatible",
          baseUrl: "https://user:secret@models.example.test/v1",
          model: "fixture",
        },
      },
      {
        mode: "grounded",
        model: {
          backend: "external",
          adapter: "openai-compatible",
          baseUrl: "https://models.example.test/v1?api_key=secret",
          model: "fixture",
        },
      },
    ];
    for (const semanticExtraction of invalidSemanticConfigurations) {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          spaceId: "space-semantic-invalid",
          implicitRecall: { mode: "lexical" },
          implicitRemember: { mode: "conservative" },
          semanticExtraction,
        })
      );
      const binding = await resolver.resolve({ cwd: root });
      assert.equal(binding.spaceId, "space-semantic-invalid");
      assert.equal(binding.semanticExtraction?.effectiveMode, "off");
      assert.equal(binding.semanticExtraction?.source, "invalid");
      assert.equal(binding.implicitRecall?.effectiveMode, "lexical");
      assert.equal(binding.implicitRemember?.effectiveMode, "conservative");
      assert.doesNotMatch(binding.semanticExtraction?.error ?? "", /raw-secret/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact project binding reads do not search ancestors or follow symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-space-exact-binding-"));
  try {
    const project = join(root, "project");
    const bindingDirectory = join(project, ".memory-space");
    const configPath = join(bindingDirectory, "config.json");
    mkdirSync(bindingDirectory, { recursive: true });
    bind(root, "space-root");

    assert.equal(await readProjectBindingAtPath(configPath), undefined);

    writeFileSync(configPath, JSON.stringify({ version: 1, spaceId: "space-project" }));
    assert.equal((await readProjectBindingAtPath(configPath))?.spaceId, "space-project");

    rmSync(configPath);
    const target = join(root, "shared-config.json");
    writeFileSync(target, JSON.stringify({ version: 1, spaceId: "space-project" }));
    symlinkSync(target, configPath);
    await assert.rejects(
      readProjectBindingAtPath(configPath),
      (error: unknown) => error instanceof SpaceBindingInvalidError
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
