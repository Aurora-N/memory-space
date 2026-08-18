/** Canonical keys owned by built-in deterministic extraction. */
export const builtInMemoryKeys = Object.freeze({
  primaryGoal: "project.goal.primary",
  currentRoadmap: "project.roadmap.current",
  currentProgress: "project.progress.current",
  currentTask: "project.task.current",
});

/** Family/type schemas that configured extraction rules cannot redefine. */
export const builtInKeySchemas = new Map<string, string>([
  [builtInMemoryKeys.primaryGoal, "state:goal"],
  [builtInMemoryKeys.currentRoadmap, "state:roadmap"],
  [builtInMemoryKeys.currentProgress, "state:progress"],
  [builtInMemoryKeys.currentTask, "state:task"],
]);
