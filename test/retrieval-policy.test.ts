import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLexicalResults,
  lexicalRetrievalWeights,
  scoreLexicalMemory
} from "../src/application/lexical-retrieval.ts";
import type { Memory } from "../src/domain/types.ts";
import { createDefaultMemorySpace } from "../src/index.ts";

function memory(input: Partial<Memory> = {}): Memory {
  return {
    id: "memory-a",
    spaceId: "space-a",
    family: "knowledge",
    type: "decision",
    key: "project.database",
    content: "Production database is PostgreSQL.",
    data: { owner: "platform" },
    tier: "indexed",
    status: "active",
    importance: 0.5,
    confidence: 1,
    version: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...input
  };
}

test("field-aware lexical scorer centralizes exact, key, content, type, and data evidence", () => {
  assert.deepEqual(lexicalRetrievalWeights, {
    exactKey: 120,
    exactContentPhrase: 100,
    contentToken: 12,
    keyToken: 8,
    dataToken: 4,
    typeToken: 2,
    coverage: 10,
    canonicalKey: 2,
    canonicalType: 1
  });
  const exactKey = scoreLexicalMemory("project.database", memory());
  assert.equal(exactKey.exactKey, true);
  assert.equal(exactKey.relevant, true);
  assert.ok(exactKey.score >= lexicalRetrievalWeights.exactKey);

  const exactContent = scoreLexicalMemory("database is PostgreSQL", memory());
  assert.equal(exactContent.exactContentPhrase, true);
  assert.equal(exactContent.contentMatches, 2);

  const type = scoreLexicalMemory("decision", memory());
  assert.equal(type.typeMatches, 1);
  assert.equal(type.relevant, true);

  const data = scoreLexicalMemory("platform", memory());
  assert.equal(data.dataMatches, 1);
  assert.equal(data.relevant, true);
});

test("mixed broad key terms require the discriminating content value", () => {
  const current = memory();
  const matching = scoreLexicalMemory("project database PostgreSQL", current);
  const conflicting = scoreLexicalMemory("project database SQLite", current);
  assert.equal(matching.relevant, true);
  assert.equal(matching.contentMatches, 1);
  assert.equal(conflicting.relevant, false);
  assert.equal(conflicting.score, 0);
});

test("lexical result ties retain updatedAt then id deterministic order", () => {
  const older = memory({ id: "memory-z", updatedAt: "2026-08-12T00:00:00.000Z" });
  const newerA = memory({ id: "memory-a", updatedAt: "2026-08-12T01:00:00.000Z" });
  const newerB = memory({ id: "memory-b", updatedAt: "2026-08-12T01:00:00.000Z" });
  const results = [older, newerB, newerA].map((value) => ({ memory: value, score: 12 }));
  results.sort(compareLexicalResults);
  assert.deepEqual(results.map((result) => result.memory.id), ["memory-a", "memory-b", "memory-z"]);
});

test("MemorySpace search applies field relevance, abstention, filters, and limit", async () => {
  const memorySpace = createDefaultMemorySpace();
  try {
    const space = await memorySpace.createSpace({ name: "Stage B1 retrieval policy" });
    const database = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      key: "project.database",
      content: "Production database is PostgreSQL."
    });
    const rateLimit = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      content: "Rate limit enforcement uses a Redis token bucket."
    });
    const bucketDistractor = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      content: "Asset uploads use a storage bucket."
    });
    const resolved = await memorySpace.remember({
      spaceId: space.id,
      family: "state",
      type: "blocker",
      content: "Migration script fails on empty databases."
    });
    await memorySpace.setMemoryStatus(resolved.id, "resolved");

    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "Production database is PostgreSQL"
    }))[0]?.memory.id, database.id, "exact content phrase");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "project.database"
    }))[0]?.memory.id, database.id, "exact key");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "PostgreSQL"
    }))[0]?.memory.id, database.id, "short one-token query");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "database"
    }))[0]?.memory.id, database.id, "partial key query");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "project database PostgreSQL"
    }))[0]?.memory.id, database.id, "mixed key and discriminating content");

    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "project database SQLite"
    }), [], "obsolete/conflicting value must abstain");
    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "completely absent evidence"
    }), [], "empty result abstention");

    const bucket = await memorySpace.search({
      spaceId: space.id,
      query: "storage bucket throttling"
    });
    assert.equal(bucket[0]?.memory.id, rateLimit.id, "canonical state type wins equal evidence");
    assert.equal(bucket[1]?.memory.id, bucketDistractor.id, "same-token distractor remains visible");

    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "Migration script fails on empty databases"
    })).length, 0, "default active status filter");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "Migration script fails on empty databases",
      statuses: ["resolved"],
      families: ["state"],
      types: ["blocker"],
      tiers: ["indexed"]
    }))[0]?.memory.id, resolved.id, "status/family/type/tier filters");

    const limited = await memorySpace.search({
      spaceId: space.id,
      query: "bucket",
      limit: 1
    });
    assert.equal(limited.length, 1, "limit is applied after relevance filtering/ranking");
    assert.equal(limited[0]?.memory.id, rateLimit.id);
  } finally {
    await memorySpace.close();
  }
});
