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
    canonicalKey: 2
  });
  const exactKey = scoreLexicalMemory("project.database", memory());
  assert.equal(exactKey.exactKey, true);
  assert.equal(exactKey.relevant, true);
  assert.ok(exactKey.score >= lexicalRetrievalWeights.exactKey);

  const exactContent = scoreLexicalMemory("database is PostgreSQL", memory());
  assert.equal(exactContent.exactContentPhrase, true);
  assert.equal(exactContent.contentMatches, 3);

  const type = scoreLexicalMemory("decision", memory());
  assert.equal(type.typeMatches, 1);
  assert.equal(type.relevant, true);

  const data = scoreLexicalMemory("platform", memory());
  assert.equal(data.dataMatches, 1);
  assert.equal(data.relevant, true);
});

test("raw multi-token queries cannot collapse into one-token type/data relevance", () => {
  const current = memory();
  const matching = scoreLexicalMemory("project database PostgreSQL", current);
  const conflicting = scoreLexicalMemory("project database SQLite", current);
  assert.equal(matching.relevant, true);
  assert.equal(matching.rawQueryTokenCount, 3);
  assert.equal(matching.contentMatches, 2);
  assert.equal(conflicting.relevant, true, "topic evidence is scored before corpus abstention");
  assert.equal(conflicting.canonicalSlotConflict, true);
  assert.deepEqual(conflicting.keyContentMatchedTokens, ["project", "database"]);
  assert.deepEqual(conflicting.missingKeyContentQueryTokens, ["sqlite"]);

  const unrelatedDecision = scoreLexicalMemory("database decision", memory({
    key: undefined,
    content: "Authentication uses signed access tokens."
  }));
  assert.equal(unrelatedDecision.rawQueryTokenCount, 2);
  assert.equal(unrelatedDecision.typeMatches, 1);
  assert.equal(unrelatedDecision.relevant, false);

  assert.equal(scoreLexicalMemory("decision", current).relevant, true, "true one-token type");
  assert.equal(scoreLexicalMemory("platform", current).relevant, true, "true one-token data");
});

test("canonical conflict coverage excludes type and data metadata evidence", () => {
  const result = scoreLexicalMemory("database decision history", memory({
    content: "Production storage uses PostgreSQL.",
    data: { history: "not canonical slot evidence" }
  }));
  assert.deepEqual(result.keyContentMatchedTokens, ["database"]);
  assert.deepEqual(result.metadataMatchedTokens, ["decision", "history"]);
  assert.deepEqual(result.missingKeyContentQueryTokens, ["decision", "history"]);
  assert.equal(result.canonicalSlotConflict, false, "H6: metadata cannot manufacture 2/3 coverage");
});

test("canonicalKey is a ranking prior weaker than one content token", () => {
  const keyed = scoreLexicalMemory("project bucket", memory({
    key: "project.unrelated",
    content: "Canonical slot without requested content."
  }));
  const content = scoreLexicalMemory("project bucket", memory({
    key: undefined,
    type: "fact",
    content: "Bucket configuration detail."
  }));
  assert.equal(keyed.relevant, true);
  assert.equal(content.relevant, true);
  assert.ok(content.score > keyed.score);
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
    const api = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      key: "project.api.endpoint",
      content: "Public API endpoint is /v2/orders."
    });
    const apiDocs = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "fact",
      content: "API docs live in docs/openapi.md."
    });
    const databaseMigration = await memorySpace.remember({
      spaceId: space.id,
      family: "procedure",
      type: "workflow",
      content: "Migration helper lives in scripts/db/migrate.ts."
    });
    const chineseDatabase = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      key: "project.database.zh",
      content: "数据库使用 PostgreSQL"
    });
    const unrelatedDecision = await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      content: "Authentication uses signed access tokens."
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
    assert.ok((await memorySpace.search({
      spaceId: space.id,
      query: "PostgreSQL"
    })).some((item) => item.memory.id === database.id), "short one-token direct value query");
    assert.ok((await memorySpace.search({
      spaceId: space.id,
      query: "database"
    })).some((item) => item.memory.id === database.id), "partial key query");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "project database PostgreSQL"
    }))[0]?.memory.id, database.id, "mixed key and discriminating content");

    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "project database SQLite"
    }), [], "H1: obsolete/conflicting database value must abstain");
    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "project api v1"
    }), [], "H2: API v1 cannot expose the current keyed v2 slot");
    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "数据库 SQLite"
    }), [], "H3: Han topic overlap cannot expose a conflicting current value");
    const apiDocsResults = await memorySpace.search({
      spaceId: space.id,
      query: "project api docs"
    });
    assert.ok(
      apiDocsResults.some((item) => item.memory.id === apiDocs.id),
      "H4: API docs support elsewhere in the eligible corpus prevents false abstention"
    );
    const migrationResults = await memorySpace.search({
      spaceId: space.id,
      query: "project database migration"
    });
    assert.ok(
      migrationResults.some((item) => item.memory.id === databaseMigration.id),
      "H5: migration support elsewhere in the eligible corpus prevents false abstention"
    );
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "数据库 PostgreSQL"
    }))[0]?.memory.id, chineseDatabase.id, "Han current-value recall");
    const databaseDecision = await memorySpace.search({
      spaceId: space.id,
      query: "database decision"
    });
    assert.equal(databaseDecision[0]?.memory.id, database.id);
    assert.equal(databaseDecision.some((item) => item.memory.id === unrelatedDecision.id), false);
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "project.api.endpoint"
    }))[0]?.memory.id, api.id, "exact API key remains strong");
    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "v2 orders"
    }))[0]?.memory.id, api.id, "direct current API value");
    assert.deepEqual(await memorySpace.search({
      spaceId: space.id,
      query: "completely absent evidence"
    }), [], "empty result abstention");

    const bucket = await memorySpace.search({
      spaceId: space.id,
      query: "storage bucket throttling"
    });
    assert.equal(bucket[0]?.memory.id, bucketDistractor.id, "stronger lexical evidence ranks first");
    assert.equal(bucket[1]?.memory.id, rateLimit.id, "weaker lexical target remains recallable");

    assert.equal((await memorySpace.search({
      spaceId: space.id,
      query: "Migration script fails on empty databases",
      types: ["blocker"]
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
    assert.ok(
      [rateLimit.id, bucketDistractor.id].includes(limited[0]!.memory.id),
      "an equally relevant bucket Memory is retained before limit"
    );
  } finally {
    await memorySpace.close();
  }
});

test("strong exact support survives a separate canonical-slot conflict", async () => {
  const memorySpace = createDefaultMemorySpace();
  try {
    const space = await memorySpace.createSpace({ name: "Stage B1.1 exact support" });
    await memorySpace.remember({
      spaceId: space.id,
      family: "knowledge",
      type: "decision",
      key: "project.database",
      content: "Production database is PostgreSQL."
    });
    const exact = await memorySpace.remember({
      spaceId: space.id,
      family: "procedure",
      type: "workflow",
      content: "Project database migration"
    });

    const results = await memorySpace.search({
      spaceId: space.id,
      query: "project database migration"
    });
    assert.equal(results[0]?.memory.id, exact.id, "H7: exact content support survives conflict");
  } finally {
    await memorySpace.close();
  }
});
