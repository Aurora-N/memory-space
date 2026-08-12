import type {
  CountedRatio,
  ExtractionMetric,
  NegativeRetrievalAggregate,
  RetrievalAggregate,
  RetrievalAtKMetric,
  RetrievalQueryResult
} from "./types.ts";

export function ratio(
  numerator: number,
  denominator: number,
  zeroDenominatorValue: number
): number {
  return denominator === 0 ? zeroDenominatorValue : numerator / denominator;
}

export function countedRatio(
  numerator: number,
  denominator: number,
  zeroDenominatorValue: number
): CountedRatio {
  return { numerator, denominator, value: ratio(numerator, denominator, zeroDenominatorValue) };
}

export function extractionMetric(tp: number, fp: number, fn: number): ExtractionMetric {
  return {
    tp,
    fp,
    fn,
    precision: ratio(tp, tp + fp, 1),
    recall: ratio(tp, tp + fn, 1)
  };
}

export function retrievalAtK(
  relevantKeys: readonly string[],
  returnedKeys: readonly string[],
  k: number
): RetrievalAtKMetric {
  const relevant = new Set(relevantKeys);
  if (relevant.size === 0) {
    throw new Error("Retrieval P@K/R@K requires at least one relevant Memory");
  }
  if (!Number.isInteger(k) || k < 1) throw new Error("Retrieval K must be a positive integer");
  const topK = returnedKeys.slice(0, k);
  const hits = new Set(topK.filter((key) => relevant.has(key))).size;
  return {
    k,
    hits,
    precision: ratio(hits, k, 1),
    recall: hits / relevant.size
  };
}

export function eligibleRetrievalKs(
  requestedKs: readonly number[],
  eligibleCorpusSize: number
): number[] {
  return requestedKs.filter((k) => Number.isInteger(k) && k > 0 && k <= eligibleCorpusSize);
}

export function aggregateRetrieval(
  results: readonly RetrievalQueryResult[],
  ks: readonly number[]
): RetrievalAggregate[] {
  return ks.map((k) => {
    const metrics = results
      .filter((result) => result.classification === "positive")
      .flatMap((result) => result.atK.filter((item) => item.k === k));
    return {
      k,
      precision: ratio(
        metrics.reduce((sum, metric) => sum + metric.precision, 0),
        metrics.length,
        1
      ),
      recall: ratio(
        metrics.reduce((sum, metric) => sum + metric.recall, 0),
        metrics.length,
        1
      ),
      queryCount: metrics.length
    };
  });
}

export function aggregateNegativeRetrieval(
  results: readonly RetrievalQueryResult[]
): NegativeRetrievalAggregate {
  const queries = results
    .filter((result) => result.classification === "negative")
    .map((result) => ({
      id: result.id,
      query: result.query,
      eligibleCorpusSize: result.eligibleCorpusSize,
      returned: [...result.returned],
      returnedCount: result.returnedCount,
      abstained: result.returnedCount === 0
    }));
  const falsePositiveQueries = queries.filter((query) => !query.abstained).length;
  const abstainedQueries = queries.filter((query) => query.abstained).length;
  return {
    queryCount: queries.length,
    falsePositiveQueries,
    abstainedQueries,
    falsePositiveRate: ratio(falsePositiveQueries, queries.length, 0),
    abstentionRate: ratio(abstainedQueries, queries.length, 1),
    queries
  };
}

export function setCompleteness(
  expectedValues: readonly string[],
  observedValues: readonly string[]
): CountedRatio & { missing: string[]; unexpected: string[] } {
  const expected = new Set(expectedValues);
  const observed = new Set(observedValues);
  const found = [...expected].filter((value) => observed.has(value));
  return {
    ...countedRatio(found.length, expected.size, 1),
    missing: [...expected].filter((value) => !observed.has(value)).sort(),
    unexpected: [...observed].filter((value) => !expected.has(value)).sort()
  };
}

export function pollutionRate(
  allActiveCoreKeys: readonly string[],
  pollutedKeys: readonly string[]
): CountedRatio {
  return countedRatio(new Set(pollutedKeys).size, new Set(allActiveCoreKeys).size, 0);
}

export function staleRate(
  allActiveKeys: readonly string[],
  staleKeys: readonly string[]
): CountedRatio {
  return countedRatio(new Set(staleKeys).size, new Set(allActiveKeys).size, 0);
}

export function duplicateRate(avoidableDuplicates: number, durableMembers: number): CountedRatio {
  return countedRatio(avoidableDuplicates, durableMembers, 0);
}
