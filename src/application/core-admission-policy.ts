import type { Memory, MemoryCandidate } from "../domain/types.ts";
import type { MemoryHistoryRecord } from "../ports/store.ts";

export type CoreAdmissionReason =
  | "eligible"
  | "bounded-local"
  | "not-recommended"
  | "missing-promotion-reason"
  | "type-ineligible";

export interface CoreAdmissionDecision {
  tier: "core" | "indexed";
  reason: CoreAdmissionReason;
}

export type PromotionProvenance =
  | "AUTOMATIC"
  | "EXPLICIT_AGENT"
  | "EXPLICIT_USER"
  | "AMBIGUOUS_LEGACY";

export const PROMOTION_OPERATION = {
  automatic: "promote:automatic",
  explicitAgent: "promote:explicit-agent",
  explicitUser: "promote:explicit-user"
} as const;

const coreEligibleTypes = new Set([
  "goal",
  "roadmap",
  "progress",
  "task",
  "blocker",
  "decision",
  "constraint",
  "convention",
  "question",
  "rule",
  "instruction"
]);

const workingStateTypes = new Set(["task", "progress", "blocker", "question"]);

// These expressions describe a bounded operation scope, not a product-domain
// vocabulary. The object of the scope is deliberately limited to one execution
// unit (run/command/tool call/test/turn/response) in English or Chinese.
const englishBoundedScope = /\b(?:after|before|during|for|within|until)\s+(?:(?:only\s+)?(?:this|the\s+current)\s+)(?:single\s+)?(?:run|command|tool[\s-]?call|test|turn|response)\b|\b(?:this|the\s+current)\s+(?:run|command|tool[\s-]?call|test|turn|response)\s+(?:only|alone)\b/iu;
const chineseBoundedScope = /(?:本次|这次|此次|当前(?:这|这一)?轮|这(?:一)?轮)(?:运行|命令|工具调用|测试|对话|回复|响应)/u;

export function isCoreEligible(memory: Pick<Memory, "type" | "key">): boolean {
  return coreEligibleTypes.has(memory.type) || (memory.type === "fact" && Boolean(memory.key));
}

export function isBoundedLocalWorkingState(
  memory: Pick<Memory, "type" | "key" | "content">
): boolean {
  if (!workingStateTypes.has(memory.type)) return false;
  const evidence = `${memory.key ?? ""}\n${memory.content}`.normalize("NFKC").toLowerCase();
  return englishBoundedScope.test(evidence) || chineseBoundedScope.test(evidence);
}

export function decideCoreAdmission(
  candidate: Pick<MemoryCandidate, "type" | "key" | "content" | "recommendedTier" | "promoteReason">
): CoreAdmissionDecision {
  if (isBoundedLocalWorkingState(candidate)) {
    return { tier: "indexed", reason: "bounded-local" };
  }
  if (candidate.recommendedTier !== "core") {
    return { tier: "indexed", reason: "not-recommended" };
  }
  if (!candidate.promoteReason?.trim()) {
    return { tier: "indexed", reason: "missing-promotion-reason" };
  }
  if (!isCoreEligible(candidate)) {
    return { tier: "indexed", reason: "type-ineligible" };
  }
  return { tier: "core", reason: "eligible" };
}

export function promotionProvenanceFromOperation(operation: string): PromotionProvenance {
  switch (operation) {
    case PROMOTION_OPERATION.automatic:
      return "AUTOMATIC";
    case PROMOTION_OPERATION.explicitAgent:
      return "EXPLICIT_AGENT";
    case PROMOTION_OPERATION.explicitUser:
      return "EXPLICIT_USER";
    default:
      return "AMBIGUOUS_LEGACY";
  }
}

function isExplicitPromotion(operation: string): boolean {
  return operation === PROMOTION_OPERATION.explicitAgent
    || operation === PROMOTION_OPERATION.explicitUser;
}

/**
 * Returns whether the current semantic state still has a trusted explicit
 * continuation decision. History is immutable; later authoritative or
 * changed-state records invalidate, rather than rewrite, older intent.
 */
export function hasEffectiveExplicitPromotion(
  memory: Pick<Memory, "tier" | "status">,
  history: readonly MemoryHistoryRecord[]
): boolean {
  if (memory.tier !== "core" || memory.status !== "active") return false;
  let effective = false;
  for (const entry of history) {
    if (isExplicitPromotion(entry.operation)) {
      effective = entry.after?.tier === "core" && entry.after.status === "active";
      continue;
    }
    if (
      (entry.operation.startsWith("promote") && !isExplicitPromotion(entry.operation))
      || entry.operation === "update"
      || entry.operation === "supersede"
      || entry.operation.startsWith("demote")
      || (entry.operation === "status" && entry.after?.status !== "active")
    ) {
      effective = false;
    }
  }
  return effective;
}
