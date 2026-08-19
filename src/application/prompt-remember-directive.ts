/** Narrow deterministic user control for one implicit-remember turn. */
export type PromptRememberDirective = "allow" | "disable_for_turn";

const disablePatterns = [
  /不要记住这次内容/u,
  /不要把这次对话保存到记忆/u,
  /这次不要写入\s*Memory Space/iu,
  /\bDo not remember this turn\b/iu,
  /\bDo not save this conversation to memory\b/iu,
] as const;

/** Returns only explicit P8 write opt-outs; P7 recall directives remain independent. */
export function promptRememberDirective(prompt: string): PromptRememberDirective {
  return disablePatterns.some((pattern) => pattern.test(prompt)) ? "disable_for_turn" : "allow";
}
