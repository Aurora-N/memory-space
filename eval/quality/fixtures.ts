import { readFile } from "node:fs/promises";
import {
  extractionFixtureSchema,
  handoffFixtureSchema,
  longHorizonFixtureSchema,
  retrievalFixtureSchema,
  supersessionFixtureSchema,
  type QualityFixtureBundle
} from "./types.ts";

async function jsonFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

export async function loadQualityFixtures(): Promise<QualityFixtureBundle> {
  const [extraction, retrieval, supersession, handoff, longHorizon] = await Promise.all([
    jsonFixture("extraction.json"),
    jsonFixture("retrieval.json"),
    jsonFixture("supersession.json"),
    jsonFixture("handoff.json"),
    jsonFixture("long-horizon.json")
  ]);
  return {
    extraction: extractionFixtureSchema.parse(extraction),
    retrieval: retrievalFixtureSchema.parse(retrieval),
    supersession: supersessionFixtureSchema.parse(supersession),
    handoff: handoffFixtureSchema.parse(handoff),
    longHorizon: longHorizonFixtureSchema.parse(longHorizon)
  };
}
