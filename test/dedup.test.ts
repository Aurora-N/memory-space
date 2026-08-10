import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError, createDefaultMemorySpace } from "../src/index.ts";

test("keyed Memory deduplicates equivalent values and preserves changed-value history", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "dedup" });
  const a = await memorySpace.createSession({ spaceId: space.id, agentId: "a" });
  const b = await memorySpace.createSession({ spaceId: space.id, agentId: "b" });
  const first = await memorySpace.remember({
    spaceId: space.id, sourceSessionId: a.id, family: "knowledge", type: "decision",
    key: "project.database", content: "PostgreSQL"
  });
  const repeated = await memorySpace.remember({
    spaceId: space.id, sourceSessionId: b.id, family: "knowledge", type: "decision",
    key: "project.database", content: "  postgresql  "
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.version, 1);
  assert.equal((await memorySpace.search({ spaceId: space.id, query: "", types: ["decision"] })).length, 1);

  const changed = await memorySpace.remember({
    spaceId: space.id, sourceSessionId: b.id, family: "knowledge", type: "decision",
    key: "project.database", content: "MySQL"
  });
  assert.equal(changed.id, first.id);
  assert.equal(changed.version, 2);
  const history = await memorySpace.getMemoryHistory(first.id);
  assert.deepEqual(history.map((entry) => entry.operation), ["create", "deduplicate", "update"]);
  assert.equal(history.at(-1)?.before?.content, "PostgreSQL");
  assert.equal(history.at(-1)?.after?.content, "MySQL");
  await memorySpace.close();
});

test("a stable Memory key cannot change family or type", async () => {
  const memorySpace = createDefaultMemorySpace();
  const space = await memorySpace.createSpace({ name: "key schema" });
  const original = await memorySpace.remember({
    spaceId: space.id, family: "knowledge", type: "decision",
    key: "project.database", content: "PostgreSQL"
  });
  await assert.rejects(
    memorySpace.remember({
      spaceId: space.id, family: "state", type: "task",
      key: "project.database", content: "Migrate database"
    }),
    (error: unknown) => error instanceof ConflictError && error.code === "MEMORY_KEY_SCHEMA_CONFLICT"
  );
  assert.deepEqual(await memorySpace.getMemory(original.id), original);
  await memorySpace.close();
});
