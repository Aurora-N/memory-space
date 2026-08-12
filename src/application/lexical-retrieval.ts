import type { Memory } from "../domain/types.ts";

const BROAD_QUERY_TOKENS = new Set([
  "current",
  "database",
  "memory",
  "project",
  "storage"
]);

const CANONICAL_WORKING_TYPES = new Set([
  "blocker",
  "constraint",
  "convention",
  "decision",
  "goal",
  "instruction",
  "progress",
  "question",
  "roadmap",
  "rule",
  "task"
]);

export const lexicalRetrievalWeights = Object.freeze({
  exactKey: 120,
  exactContentPhrase: 100,
  contentToken: 12,
  keyToken: 8,
  dataToken: 4,
  typeToken: 2,
  coverage: 10,
  canonicalKey: 2,
  canonicalType: 1
});

export interface LexicalRetrievalMatch {
  score: number;
  relevant: boolean;
  queryTokenCount: number;
  matchedQueryTokens: number;
  contentMatches: number;
  keyMatches: number;
  typeMatches: number;
  dataMatches: number;
  exactContentPhrase: boolean;
  exactKey: boolean;
  canonicalType: boolean;
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

function intersection(queryTokens: readonly string[], fieldTokens: Set<string>): string[] {
  return queryTokens.filter((token) => fieldTokens.has(token));
}

/**
 * Broad structural/domain nouns are useful when they are the whole query, but
 * must not override a conflicting discriminating term in a mixed query.
 */
function discriminatingTokens(tokens: readonly string[]): string[] {
  const discriminating = tokens.filter((token) => !BROAD_QUERY_TOKENS.has(token));
  return discriminating.length > 0 ? discriminating : [...tokens];
}

export function scoreLexicalMemory(query: string, memory: Memory): LexicalRetrievalMatch {
  const normalizedQuery = normalizeLexicalText(query);
  const queryTokens = discriminatingTokens(lexicalTokens(query));
  const content = normalizeLexicalText(memory.content);
  const key = normalizeLexicalText(memory.key ?? "");
  const contentMatches = intersection(queryTokens, new Set(lexicalTokens(memory.content)));
  const keyMatches = intersection(queryTokens, new Set(lexicalTokens(memory.key ?? "")));
  const typeMatches = intersection(queryTokens, new Set(lexicalTokens(memory.type)));
  const dataMatches = intersection(
    queryTokens,
    new Set(lexicalTokens(JSON.stringify(memory.data ?? {})))
  );
  const matchedTokens = new Set([
    ...contentMatches,
    ...keyMatches,
    ...typeMatches,
    ...dataMatches
  ]);
  const exactContentPhrase = normalizedQuery.length > 0 && content.includes(normalizedQuery);
  const exactKey = normalizedQuery.length > 0 && key === normalizedQuery;
  const canonicalType = CANONICAL_WORKING_TYPES.has(normalizeLexicalText(memory.type));
  const coverage = queryTokens.length === 0 ? 0 : matchedTokens.size / queryTokens.length;

  // Type/data-only overlap is diagnostic evidence, but not enough to expose a
  // Memory for a multi-token query. Content and semantic key fields establish
  // provider-neutral relevance; exact phrase/key evidence always qualifies.
  const relevant = exactContentPhrase
    || exactKey
    || contentMatches.length > 0
    || keyMatches.length > 0
    || (queryTokens.length === 1 && (typeMatches.length > 0 || dataMatches.length > 0));
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
    + (canonicalType ? weights.canonicalType : 0)
  ) : 0;

  return {
    score,
    relevant,
    queryTokenCount: queryTokens.length,
    matchedQueryTokens: matchedTokens.size,
    contentMatches: contentMatches.length,
    keyMatches: keyMatches.length,
    typeMatches: typeMatches.length,
    dataMatches: dataMatches.length,
    exactContentPhrase,
    exactKey,
    canonicalType,
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
