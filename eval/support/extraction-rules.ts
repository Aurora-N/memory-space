import {
  CompositeMemoryExtractor,
  DeclarativeRuleExtractor,
  type DeclarativeExtractionRule,
} from "../../src/adapters/declarative-rule-extractor.ts";
import { RuleBasedExtractor } from "../../src/adapters/rule-based-extractor.ts";
import type { MemoryExtractor } from "../../src/ports/extractor.ts";

const valuePlaceholder = "$" + "{value}";

/**
 * Preserves the frozen database fixture through explicit eval configuration
 * without making that project vocabulary part of the production defaults.
 */
export const databaseEvaluationRule: DeclarativeExtractionRule = {
  id: "eval.project.database",
  family: "knowledge",
  type: "decision",
  key: "project.database",
  match: {
    kind: "prefix",
    prefixes: ["数据库已确定使用", "数据库确定使用", "数据库已使用", "数据库使用"],
    value: "identifier",
    caseSensitive: false,
  },
  contentTemplate: `数据库使用 ${valuePlaceholder}`,
  coreCandidate: true,
  confidence: 0.98,
  importance: 0.9,
  promoteReason: "Stable project-wide database decision",
};

/** Creates the frozen eval extractor with project vocabulary injected explicitly. */
export function createEvaluationExtractor(): MemoryExtractor {
  return new CompositeMemoryExtractor([
    new RuleBasedExtractor(),
    new DeclarativeRuleExtractor([databaseEvaluationRule]),
  ]);
}
