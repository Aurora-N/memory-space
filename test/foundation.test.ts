import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemorySpace, ValidationError } from "../src/index.ts";

test("Space, Session and explicit Indexed Memory persist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "memory-space-test-"));
  const databasePath = join(directory, "memory.db");
  try {
    const first = new MemorySpace({ databasePath });
    const space = await first.createSpace({ name: "Project A" });
    const session = await first.createSession({ spaceId: space.id, agentId: "codex" });
    const memory = await first.remember({
      spaceId: space.id, sourceSessionId: session.id,
      family: "knowledge", type: "decision", content: "Use SQLite for the MVP"
    });
    assert.equal(memory.tier, "indexed");
    assert.equal(memory.version, 1);
    assert.equal(memory.spaceId, space.id);
    await first.close();

    const reloaded = new MemorySpace({ databasePath });
    assert.equal((await reloaded.getMemory(memory.id)).content, "Use SQLite for the MVP");
    assert.equal((await reloaded.getSession(session.id)).spaceId, space.id);
    await reloaded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid Space and cross-Space Session references fail clearly", async () => {
  const memorySpace = new MemorySpace();
  await assert.rejects(
    memorySpace.createSession({ spaceId: "missing" }),
    /Space not found/
  );
  const one = await memorySpace.createSpace({ name: "one" });
  const two = await memorySpace.createSpace({ name: "two" });
  const session = await memorySpace.createSession({ spaceId: one.id });
  await assert.rejects(
    memorySpace.remember({
      spaceId: two.id, sourceSessionId: session.id,
      family: "knowledge", type: "fact", content: "wrong owner"
    }),
    (error: unknown) => error instanceof ValidationError && /must belong/.test(error.message)
  );
  await memorySpace.close();
});
