import { normalizeLexicalText } from "./lexical-retrieval.ts";

const allowedCandidateRunPattern = /[A-Za-z0-9._:/-]+/gu;

/** Returns whether one complete token has P7/P8 stable-key distinctiveness. */
export function isDistinctiveStableKey(value: string): boolean {
  if (value.length < 3 || value.length > 128) return false;
  if (!/^[A-Za-z0-9]/u.test(value)) return false;
  return (
    /[_.:/-]/u.test(value) ||
    /\d/u.test(value) ||
    (value.length >= 3 && /[A-Z]/u.test(value) && !/[a-z]/u.test(value))
  );
}

/** Extracts complete distinctive stable-key runs in occurrence order. */
export function extractDistinctiveStableKeys(input: string, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(allowedCandidateRunPattern)) {
    const candidate = match[0];
    if (!isDistinctiveStableKey(candidate)) continue;
    const normalized = normalizeLexicalText(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(candidate);
    if (result.length === limit) break;
  }
  return result;
}
