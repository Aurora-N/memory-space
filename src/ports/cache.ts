/** Best-effort derived-state cache boundary. Cache failures must not affect source-of-truth data. */
export interface CachePort {
  /** Returns derived state or undefined on a cache miss. */
  get<T>(key: string): Promise<T | undefined>;
  /** Stores derived state with an optional time-to-live measured in seconds. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /** Invalidates derived state; callers treat failures as best effort. */
  delete(key: string): Promise<void>;
}

/** Cache implementation for deployments that do not configure a derived-state cache. */
export class NoopCache implements CachePort {
  async get<T>(_key: string): Promise<T | undefined> {
    return undefined;
  }

  async set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {
    // Intentionally discard derived state when caching is disabled.
  }

  async delete(_key: string): Promise<void> {
    // There is no derived state to invalidate.
  }
}
