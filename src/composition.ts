import { RuleBasedExtractor } from "./adapters/rule-based-extractor.ts";
import { SqliteMemoryStore } from "./adapters/sqlite/sqlite-store.ts";
import { MemorySpace } from "./application/memory-space.ts";
import { NoopCache, type CachePort } from "./ports/cache.ts";
import type { MemoryExtractor } from "./ports/extractor.ts";

/** Infrastructure options owned by the default Memory Space composition root. */
export interface DefaultMemorySpaceOptions {
  databasePath?: string;
  extractor?: MemoryExtractor;
  cache?: CachePort;
  coreLimit?: number;
}

/** Creates one MemorySpace owner backed by SQLite and provider-neutral adapters. */
export function createDefaultMemorySpace(options: DefaultMemorySpaceOptions = {}): MemorySpace {
  return new MemorySpace({
    store: new SqliteMemoryStore(options.databasePath),
    extractor: options.extractor ?? new RuleBasedExtractor(),
    cache: options.cache ?? new NoopCache(),
    coreLimit: options.coreLimit
  });
}
