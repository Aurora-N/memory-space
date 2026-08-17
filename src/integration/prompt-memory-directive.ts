import { normalizeLexicalText } from "../application/lexical-retrieval.ts";

export type PromptMemoryDirective = "allow" | "disable_for_prompt";

const disablePhrases = [
  "不要使用之前的记忆回答",
  "不要参考之前的 memory",
  "这次不要使用 memory space",
  "do not use previous memory",
  "answer without prior memory"
].map(normalizeLexicalText);

export const promptMemoryDisabledContext = [
  "The user disabled Memory Space reads for this turn.",
  "Do not use recalled Memory and do not call memory_search or memory_context."
].join(" ");

export function promptMemoryDirective(prompt: string): PromptMemoryDirective {
  const normalized = normalizeLexicalText(prompt);
  return disablePhrases.some((phrase) => normalized.includes(phrase))
    ? "disable_for_prompt"
    : "allow";
}
