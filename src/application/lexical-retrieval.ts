import type { Memory } from "../domain/types.ts";

const COMPACT_QUERY_MAX_TOKENS = 3;

export const lexicalRetrievalWeights = Object.freeze({
  exactKey: 120,
  exactContentPhrase: 100,
  contentToken: 12,
  keyToken: 8,
  dataToken: 4,
  typeToken: 2,
  coverage: 10,
  canonicalKey: 2
});

export interface LexicalRetrievalMatch {
  score: number;
  relevant: boolean;
  rawQueryTokenCount: number;
  matchedQueryTokens: number;
  keyContentMatchedTokens: string[];
  metadataMatchedTokens: string[];
  missingKeyContentQueryTokens: string[];
  contentMatches: number;
  keyMatches: number;
  typeMatches: number;
  dataMatches: number;
  exactContentPhrase: boolean;
  exactKey: boolean;
  canonicalSlotConflict: boolean;
  coverage: number;
}

export function normalizeLexicalText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function lexicalTokens(value: string): string[] {
  const normalized = normalizeLexicalText(value);
  const tokens = normalized.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(tokens.flatMap((token) => {
    if (!/^[\p{Script=Han}]+$/u.test(token) || token.length < 2) return [token];
    return Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2));
  }))];
}

function intersection(rawQueryTokens: readonly string[], fieldTokens: Set<string>): string[] {
  return rawQueryTokens.filter((token) => fieldTokens.has(token));
}

/**
 * A compact compound query is treated as conjunctive when it nearly identifies
 * an active keyed slot but includes an unmatched term. That unmatched term may
 * be a stale/conflicting value, so the caller must abstain rather than fall back
 * to weaker topic-only results. This rule depends on query shape and canonical
 * slot evidence, not a domain- or language-specific token vocabulary.
 */
function canonicalSlotConflict(
  memory: Memory,
  rawQueryTokens: readonly string[],
  keyContentMatchedTokens: ReadonlySet<string>,
  exactKey: boolean,
  exactContentPhrase: boolean,
): boolean {
  if (
    !memory.key
    || exactKey
    || exactContentPhrase
    || rawQueryTokens.length < 2
    || rawQueryTokens.length > COMPACT_QUERY_MAX_TOKENS
    || keyContentMatchedTokens.size === 0
    || keyContentMatchedTokens.size === rawQueryTokens.length
  ) return false;

  return keyContentMatchedTokens.size * 3 >= rawQueryTokens.length * 2;
}

export function scoreLexicalMemory(query: string, memory: Memory): LexicalRetrievalMatch {
  const normalizedQuery = normalizeLexicalText(query);
  const rawQueryTokens = lexicalTokens(query);
  const content = normalizeLexicalText(memory.content);
  const key = normalizeLexicalText(memory.key ?? "");
  const contentMatches = intersection(rawQueryTokens, new Set(lexicalTokens(memory.content)));
  const keyMatches = intersection(rawQueryTokens, new Set(lexicalTokens(memory.key ?? "")));
  const typeMatches = intersection(rawQueryTokens, new Set(lexicalTokens(memory.type)));
  const dataMatches = intersection(
    rawQueryTokens,
    new Set(lexicalTokens(JSON.stringify(memory.data ?? {})))
  );
  const keyContentEvidence = new Set([
    ...contentMatches,
    ...keyMatches
  ]);
  const metadataEvidence = new Set([
    ...typeMatches,
    ...dataMatches
  ]);
  const keyContentMatchedTokens = rawQueryTokens.filter((token) => keyContentEvidence.has(token));
  const metadataMatchedTokens = rawQueryTokens.filter((token) => metadataEvidence.has(token));
  const matchedTokens = new Set([
    ...keyContentMatchedTokens,
    ...metadataMatchedTokens
  ]);
  const missingKeyContentQueryTokens = rawQueryTokens.filter(
    (token) => !keyContentEvidence.has(token)
  );
  const exactContentPhrase = normalizedQuery.length > 0 && content.includes(normalizedQuery);
  const exactKey = normalizedQuery.length > 0 && key === normalizedQuery;
  const coverage = rawQueryTokens.length === 0 ? 0 : matchedTokens.size / rawQueryTokens.length;
  const hasKeyOrContentEvidence = keyContentMatchedTokens.length > 0;
  const hasCanonicalSlotConflict = canonicalSlotConflict(
    memory,
    rawQueryTokens,
    new Set(keyContentMatchedTokens),
    exactKey,
    exactContentPhrase
  );

  // Type/data-only overlap is diagnostic evidence, but not enough to expose a
  // Memory for a genuine multi-token raw query. Content and key fields establish
  // provider-neutral relevance; exact phrase/key evidence always qualifies.
  const hasFieldEvidence = hasKeyOrContentEvidence
    || (rawQueryTokens.length === 1 && (typeMatches.length > 0 || dataMatches.length > 0));
  const relevant = exactContentPhrase
    || exactKey
    || hasFieldEvidence;
  const weights = lexicalRetrievalWeights;
  const score = relevant ? (
    (exactKey ? weights.exactKey : 0)
    + (exactContentPhrase ? weights.exactContentPhrase : 0)
    + contentMatches.length * weights.contentToken
    + keyMatches.length * weights.keyToken
    + dataMatches.length * weights.dataToken
    + typeMatches.length * weights.typeToken
    + coverage * weights.coverage
    + (memory.key ? weights.canonicalKey : 0)
  ) : 0;

  return {
    score,
    relevant,
    rawQueryTokenCount: rawQueryTokens.length,
    matchedQueryTokens: matchedTokens.size,
    keyContentMatchedTokens,
    metadataMatchedTokens,
    missingKeyContentQueryTokens,
    contentMatches: contentMatches.length,
    keyMatches: keyMatches.length,
    typeMatches: typeMatches.length,
    dataMatches: dataMatches.length,
    exactContentPhrase,
    exactKey,
    canonicalSlotConflict: hasCanonicalSlotConflict,
    coverage
  };
}

export function compareLexicalResults(
  left: { memory: Memory; score: number },
  right: { memory: Memory; score: number }
): number {
  return right.score - left.score
    || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
    || left.memory.id.localeCompare(right.memory.id);
}
