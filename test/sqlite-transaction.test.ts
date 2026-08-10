import assert from "node:assert/strict";
import test from "node:test";
import { SqliteMemoryStore } from "../src/index.ts";

class BeginFailingStore extends SqliteMemoryStore {
  failNextBegin = true;

  protected override beginTransaction(): void {
    if (this.failNextBegin) {
      this.failNextBegin = false;
      throw new Error("BEGIN acquisition failed");
    }
    super.beginTransaction();
  }
}

test("failed SQLite transaction acquisition releases the local barrier and preserves the original error", async () => {
  const store = new BeginFailingStore();
  await assert.rejects(store.transaction(async () => undefined), /BEGIN acquisition failed/u);

  const nextOperation = store.transaction(async () => "released");
  const outcome = await Promise.race([
    nextOperation,
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50))
  ]);
  assert.equal(outcome, "released");
  await store.close();
});
