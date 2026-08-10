import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError, MemorySpace } from "../src/index.ts";

test("promotion and demotion control deterministic Core bootstrap", async () => {
  const memorySpace = new MemorySpace();
  const space = await memorySpace.createSpace({ name: "bootstrap" });
  const goal = await memorySpace.remember({
    spaceId: space.id, family: "state", type: "goal",
    key: "project.goal.primary", content: "Ship reliable cross-session handoff"
  });
  const detail = await memorySpace.remember({
    spaceId: space.id, family: "knowledge", type: "fact", content: "Local module detail"
  });
  assert.doesNotMatch((await memorySpace.bootstrap(space.id)).context, /Ship reliable/);

  const promoted = await memorySpace.promote(goal.id, { actor: "agent", reason: "Primary project goal" });
  assert.equal(promoted.tier, "core");
  const first = await memorySpace.bootstrap(space.id);
  const second = await memorySpace.bootstrap(space.id);
  assert.equal(first.context, second.context);
  assert.match(first.context, /## Goal\n- \[.*\] \(project.goal.primary\) Ship reliable/);
  assert.doesNotMatch(first.context, /Local module detail/);

  await memorySpace.demote(goal.id, { reason: "No longer default context" });
  assert.doesNotMatch((await memorySpace.bootstrap(space.id)).context, /Ship reliable/);
  assert.equal((await memorySpace.getMemory(goal.id)).tier, "indexed");
  assert.equal((await memorySpace.getMemory(detail.id)).tier, "indexed");
  await memorySpace.close();
});

test("inactive Core Memory is automatically demoted and Core capacity is deterministic", async () => {
  const memorySpace = new MemorySpace({ coreLimit: 1 });
  const space = await memorySpace.createSpace({ name: "capacity" });
  const first = await memorySpace.remember({
    spaceId: space.id, family: "state", type: "goal", content: "Goal one"
  });
  const second = await memorySpace.remember({
    spaceId: space.id, family: "state", type: "goal", content: "Goal two"
  });
  await memorySpace.promote(first.id, { actor: "user" });
  await assert.rejects(
    memorySpace.promote(second.id, { actor: "user" }),
    (error: unknown) => error instanceof ConflictError && error.code === "CORE_CAPACITY_REACHED"
  );
  const archived = await memorySpace.setMemoryStatus(first.id, "archived");
  assert.equal(archived.tier, "indexed");
  assert.doesNotMatch((await memorySpace.bootstrap(space.id)).context, /Goal one/);
  await memorySpace.close();
});
