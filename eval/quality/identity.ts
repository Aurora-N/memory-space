import type { Memory } from "../../src/domain/types.ts";

export class LogicalMemoryIndex {
  readonly #runtimeByLogical = new Map<string, string>();
  readonly #currentLogicalByRuntime = new Map<string, string>();

  register(logicalKey: string, memory: Pick<Memory, "id">): void {
    const existingRuntimeId = this.#runtimeByLogical.get(logicalKey);
    if (existingRuntimeId !== undefined && existingRuntimeId !== memory.id) {
      throw new Error(`Logical Memory key ${logicalKey} mapped to multiple runtime IDs`);
    }
    this.#runtimeByLogical.set(logicalKey, memory.id);
    this.#currentLogicalByRuntime.set(memory.id, logicalKey);
  }

  runtimeId(logicalKey: string): string | undefined {
    return this.#runtimeByLogical.get(logicalKey);
  }

  logicalKey(runtimeId: string): string | undefined {
    return this.#currentLogicalByRuntime.get(runtimeId);
  }

  currentEntries(): Array<[string, string]> {
    return [...this.#currentLogicalByRuntime.entries()]
      .map(([runtimeId, logicalKey]) => [logicalKey, runtimeId] as [string, string])
      .sort(([left], [right]) => left.localeCompare(right));
  }
}
