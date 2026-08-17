import type { Memory } from "../domain/types.ts";
import type { MemoryHistoryRecord } from "../ports/store.ts";
import {
  hasEffectiveExplicitPromotion,
  isBoundedLocalWorkingState
} from "./core-admission-policy.ts";

export interface HandoffProjection {
  goal?: string;
  completed: string[];
  activeTasks: string[];
  decisions: string[];
  blockers: string[];
  openQuestions: string[];
  nextSteps: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function nonEmptyStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

const directlyProjectedWorkingStateTypes = new Set(["task", "blocker", "question"]);

export function isHandoffContinuationWorkingState(
  memory: Memory,
  history: readonly MemoryHistoryRecord[]
): boolean {
  return directlyProjectedWorkingStateTypes.has(memory.type)
    && memory.status === "active"
    && memory.tier === "core"
    && (
      !isBoundedLocalWorkingState(memory)
      || hasEffectiveExplicitPromotion(memory, history)
    );
}

export function isHandoffContinuationTask(
  memory: Memory,
  history: readonly MemoryHistoryRecord[]
): boolean {
  return memory.type === "task"
    && isHandoffContinuationWorkingState(memory, history);
}

export function handoffTaskValues(
  memory: Memory,
  history: readonly MemoryHistoryRecord[]
): { activeTask: string; nextSteps: string[] } | undefined {
  if (!isHandoffContinuationTask(memory, history)) return undefined;
  return {
    activeTask: memory.content,
    nextSteps: unique([
      memory.content,
      ...nonEmptyStrings(memory.data?.nextStep),
      ...nonEmptyStrings(memory.data?.nextSteps)
    ])
  };
}

export function buildHandoffProjection(input: {
  activeCore: readonly Memory[];
  completedTasks: readonly Memory[];
  historiesByMemoryId: ReadonlyMap<string, readonly MemoryHistoryRecord[]>;
}): HandoffProjection {
  const taskValues = input.activeCore
    .map((memory) => handoffTaskValues(
      memory,
      input.historiesByMemoryId.get(memory.id) ?? []
    ))
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
  return {
    goal: input.activeCore.filter((memory) => memory.type === "goal").at(-1)?.content,
    completed: unique(input.completedTasks.map((memory) => memory.content)),
    activeTasks: unique(taskValues.map((value) => value.activeTask)),
    decisions: unique(input.activeCore
      .filter((memory) => memory.type === "decision")
      .map((memory) => memory.content)),
    blockers: unique(input.activeCore
      .filter((memory) => memory.type === "blocker"
        && isHandoffContinuationWorkingState(
          memory,
          input.historiesByMemoryId.get(memory.id) ?? []
        ))
      .map((memory) => memory.content)),
    openQuestions: unique(input.activeCore
      .filter((memory) => memory.type === "question"
        && isHandoffContinuationWorkingState(
          memory,
          input.historiesByMemoryId.get(memory.id) ?? []
        ))
      .map((memory) => memory.content)),
    nextSteps: unique(taskValues.flatMap((value) => value.nextSteps))
  };
}
