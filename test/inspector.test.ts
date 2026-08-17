import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemorySpaceDaemon } from "../src/index.ts";

test("daemon serves the local read-only Inspector for its trusted bound Space", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-inspector-"));
  const inspectorDirectory = join(directory, "dist");
  mkdirSync(join(inspectorDirectory, "assets"), { recursive: true });
  writeFileSync(join(inspectorDirectory, "index.html"), "<!doctype html><title>Inspector fixture</title>");
  writeFileSync(join(inspectorDirectory, "assets", "app.css"), "body { color: #123; }");
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    mcpRuntime: { cwd: directory, explicitSpaceId: "trusted-inspector-space" },
    inspectorDirectory
  });
  try {
    await daemon.memorySpace.createSpace({
      id: "trusted-inspector-space", name: "Trusted Inspector Space"
    });
    await daemon.memorySpace.createSpace({ id: "other-space", name: "Unrelated Space" });
    const address = await daemon.listen() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const redirect = await fetch(`${baseUrl}/inspector`, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), "/inspector/");

    const page = await fetch(`${baseUrl}/inspector/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
    assert.match(await page.text(), /Inspector fixture/u);

    const asset = await fetch(`${baseUrl}/inspector/assets/app.css`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /^text\/css/u);
    const missingAsset = await fetch(`${baseUrl}/inspector/assets/missing.js`);
    assert.equal(missingAsset.status, 404);

    const binding = await fetch(`${baseUrl}/inspector/api/binding?spaceId=other-space`);
    assert.equal(binding.status, 200);
    const bindingBody = await binding.json() as {
      space: { id: string };
      binding: { spaceId: string; source: string };
      capabilities: { readOnly: boolean; localOnly: boolean };
    };
    assert.equal(bindingBody.space.id, "trusted-inspector-space");
    assert.equal(bindingBody.binding.spaceId, "trusted-inspector-space");
    assert.equal(bindingBody.binding.source, "explicit");
    assert.deepEqual(bindingBody.capabilities, {
      readOnly: true,
      localOnly: true,
      multiSpaceManagement: false
    });

    const rejectedOrigin = await fetch(`${baseUrl}/inspector/`, {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon reports an actionable response when the Inspector build is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-inspector-missing-"));
  const daemon = createMemorySpaceDaemon({
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    mcpRuntime: { cwd: directory, explicitSpaceId: "missing-build-space" },
    inspectorDirectory: join(directory, "missing")
  });
  try {
    const address = await daemon.listen() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/inspector/`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /pnpm inspector:build/u);
  } finally {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
