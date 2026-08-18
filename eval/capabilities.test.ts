import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDefaultMemorySpace } from "../src/index.ts";
import { createEvaluationExtractor } from "./support/extraction-rules.ts";

type Scenario =
  | { category: "extraction"; name: string; events: string[]; expected: { key: string; contains: string } }
  | { category: "dedup"; name: string; key: string; values: string[]; expected: { activeCount: number; version: number } }
  | { category: "recall"; name: string; memory: string; query: string; expected: { contains: string; tier: "indexed" } };

const scenarios = JSON.parse(readFileSync(
  new URL("./fixtures/memory-capabilities.json", import.meta.url), "utf8"
)) as Scenario[];

for (const scenario of scenarios) {
  test(`eval ${scenario.category}: ${scenario.name}`, async () => {
    const memorySpace = createDefaultMemorySpace({ extractor: createEvaluationExtractor() });
    const space = await memorySpace.createSpace({ name: scenario.name });
    try {
      if (scenario.category === "extraction") {
        const session = await memorySpace.createSession({ spaceId: space.id });
        let toEventId = "";
        for (const text of scenario.events) {
          toEventId = (await memorySpace.appendEvent({
            sessionId: session.id, type: "message", payload: { text }
          })).id;
        }
        await memorySpace.checkpoint({ sessionId: session.id, toEventId, idempotencyKey: scenario.name });
        const result = await memorySpace.search({ spaceId: space.id, query: scenario.expected.contains });
        assert.equal(result[0].memory.key, scenario.expected.key);
        assert.match(result[0].memory.content, new RegExp(scenario.expected.contains, "iu"));
      } else if (scenario.category === "dedup") {
        const sessions = await Promise.all([
          memorySpace.createSession({ spaceId: space.id }), memorySpace.createSession({ spaceId: space.id })
        ]);
        const results = [];
        for (const [index, content] of scenario.values.entries()) {
          results.push(await memorySpace.remember({
            spaceId: space.id, sourceSessionId: sessions[index % sessions.length].id,
            family: "knowledge", type: "decision", key: scenario.key, content
          }));
        }
        const active = await memorySpace.search({ spaceId: space.id, query: "", types: ["decision"] });
        assert.equal(active.length, scenario.expected.activeCount);
        assert.equal(results.at(-1)?.version, scenario.expected.version);
      } else {
        await memorySpace.remember({
          spaceId: space.id, family: "knowledge", type: "fact", content: scenario.memory
        });
        const result = await memorySpace.search({ spaceId: space.id, query: scenario.query });
        assert.match(result[0].memory.content, new RegExp(scenario.expected.contains.replaceAll(".", "\\."), "iu"));
        assert.equal(result[0].memory.tier, scenario.expected.tier);
      }
    } finally {
      await memorySpace.close();
    }
  });
}
