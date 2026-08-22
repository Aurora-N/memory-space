import { isTransientExtractionEvidence } from "./extraction-policy.ts";
import type { MemoryCandidate, MemoryFamily, SessionEvent } from "../domain/types.ts";
import { normalizeLexicalText } from "./lexical-retrieval.ts";

export const semanticExtractionLimits = Object.freeze({
  maxInputChars: 12_000,
  maxCandidates: 8,
  maxEvidencePerCandidate: 3,
  maxQuoteChars: 500,
  maxContentChars: 1_000,
});

export type SemanticAssertion = "direct" | "uncertain" | "hypothetical";
export type SemanticDurability = "durable" | "interaction_local";
export type SemanticCandidateType =
  | "fact"
  | "decision"
  | "constraint"
  | "convention"
  | "goal"
  | "task"
  | "progress"
  | "blocker"
  | "question";

export interface SemanticEvidenceProposalV1 {
  eventId: string;
  quote: string;
}

export interface SemanticCandidateProposalV1 {
  family: "knowledge" | "state";
  type: SemanticCandidateType;
  content: string;
  assertion: SemanticAssertion;
  durability: SemanticDurability;
  evidence: SemanticEvidenceProposalV1[];
  durabilityReason?: string;
}

export interface SemanticExtractionResponseV1 {
  schemaVersion: 1;
  candidates: SemanticCandidateProposalV1[];
}

export type SemanticRejectionReason =
  | "semantic_model_invalid"
  | "unsupported_evidence"
  | "assistant_only_evidence"
  | "speculative_evidence"
  | "interaction_local_evidence"
  | "sensitive_evidence";

export type SemanticProposalDecision =
  | { accepted: true; candidate: MemoryCandidate }
  | { accepted: false; reason: SemanticRejectionReason; type?: string; sourceEventIds: string[] };

const responseFields = new Set(["schemaVersion", "candidates"]);
const candidateFields = new Set([
  "family",
  "type",
  "content",
  "assertion",
  "durability",
  "evidence",
  "durabilityReason",
]);
const evidenceFields = new Set(["eventId", "quote"]);
const families = new Set(["knowledge", "state"]);
const types = new Set<SemanticCandidateType>([
  "fact",
  "decision",
  "constraint",
  "convention",
  "goal",
  "task",
  "progress",
  "blocker",
  "question",
]);
const assertions = new Set<SemanticAssertion>(["direct", "uncertain", "hypothetical"]);
const durabilities = new Set<SemanticDurability>(["durable", "interaction_local"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function nonEmptyBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= maximum;
}

/** Parses the complete strict P9 v1 response; unknown fields fail closed. */
export function parseSemanticExtractionResponse(
  value: unknown
): SemanticExtractionResponseV1 | undefined {
  const response = object(value);
  if (
    !response ||
    !hasExactFields(response, responseFields) ||
    response.schemaVersion !== 1 ||
    !Array.isArray(response.candidates) ||
    response.candidates.length > semanticExtractionLimits.maxCandidates
  ) {
    return undefined;
  }
  const candidates: SemanticCandidateProposalV1[] = [];
  for (const rawCandidate of response.candidates) {
    const candidate = object(rawCandidate);
    if (
      !candidate ||
      !hasExactFields(candidate, candidateFields) ||
      !families.has(candidate.family as string) ||
      !types.has(candidate.type as SemanticCandidateType) ||
      !nonEmptyBoundedString(candidate.content, semanticExtractionLimits.maxContentChars) ||
      !assertions.has(candidate.assertion as SemanticAssertion) ||
      !durabilities.has(candidate.durability as SemanticDurability) ||
      !Array.isArray(candidate.evidence) ||
      candidate.evidence.length === 0 ||
      candidate.evidence.length > semanticExtractionLimits.maxEvidencePerCandidate ||
      (candidate.durabilityReason !== undefined &&
        !nonEmptyBoundedString(candidate.durabilityReason, 300))
    ) {
      return undefined;
    }
    const evidence: SemanticEvidenceProposalV1[] = [];
    for (const rawEvidence of candidate.evidence) {
      const item = object(rawEvidence);
      if (
        !item ||
        !hasExactFields(item, evidenceFields) ||
        !nonEmptyBoundedString(item.eventId, 200) ||
        !nonEmptyBoundedString(item.quote, semanticExtractionLimits.maxQuoteChars)
      ) {
        return undefined;
      }
      evidence.push({ eventId: item.eventId, quote: item.quote });
    }
    candidates.push({
      family: candidate.family as SemanticCandidateProposalV1["family"],
      type: candidate.type as SemanticCandidateType,
      content: candidate.content,
      assertion: candidate.assertion as SemanticAssertion,
      durability: candidate.durability as SemanticDurability,
      evidence,
      ...(candidate.durabilityReason === undefined
        ? {}
        : { durabilityReason: candidate.durabilityReason }),
    });
  }
  return { schemaVersion: 1, candidates };
}

function messageContent(event: SessionEvent | undefined): string | undefined {
  if (!event) return undefined;
  const content = event.payload.content ?? event.payload.text;
  return typeof content === "string" ? content : undefined;
}

const semanticEvidenceClauseBoundary = /[\n\r,，;；。.!！?？]/u;

function evidenceClause(value: string, content: string): string | undefined {
  const contentStart = value.indexOf(content);
  if (contentStart < 0) return undefined;
  const contentEnd = contentStart + content.length;
  let start = contentStart;
  while (start > 0 && !semanticEvidenceClauseBoundary.test(value[start - 1] ?? "")) start -= 1;
  let end = contentEnd;
  while (end < value.length && !semanticEvidenceClauseBoundary.test(value[end] ?? "")) end += 1;
  return normalizeLexicalText(value.slice(start, end));
}

function semanticReplayIdentity(
  proposal: SemanticCandidateProposalV1,
  sourceEventsById: ReadonlyMap<string, SessionEvent>
): string | undefined {
  const anchors = proposal.evidence.flatMap((evidence) => {
    const source = messageContent(sourceEventsById.get(evidence.eventId));
    if (!source) return [];
    const clause = evidenceClause(source, proposal.content);
    return clause ? [`${evidence.eventId}\0${clause}`] : [];
  });
  if (anchors.length === 0) return undefined;
  return [...new Set(anchors)].sort().join("\0");
}

const speculativePatterns = [
  /(?:我猜|猜测|可能|也许|大概|或许|恐怕)/u,
  /\b(?:maybe|might|could be|probably|possibly|i think .*maybe)\b/iu,
] as const;

const temporaryExperimentPatterns = [
  /(?:先|暂时|临时)(?:试试|尝试|使用|改用)/u,
  /\b(?:temporarily|for now|try .* first|experiment with)\b/iu,
] as const;

const sensitiveAssignmentPatterns = [
  /(?:password|passwd|密码)\s*(?:is|=|:|：|是|为)\s*\S+/iu,
  /(?:api[\s_-]*key|api\s*密钥|access[\s_-]*token|访问令牌|refresh[\s_-]*token|private[\s_-]*key|私钥|client[\s_-]*secret|credentials?|凭证)\s*(?:is|=|:|：|是|为)\s*\S+/iu,
] as const;

function isSpeculative(text: string): boolean {
  return speculativePatterns.some((pattern) => pattern.test(text));
}

function isInteractionLocal(text: string): boolean {
  return (
    isTransientExtractionEvidence(text) ||
    temporaryExperimentPatterns.some((pattern) => pattern.test(text))
  );
}

function isSensitiveValue(text: string): boolean {
  return sensitiveAssignmentPatterns.some((pattern) => pattern.test(text));
}

/** Proves one proposal against the allowed full persisted user evidence. */
export function validateSemanticProposal(input: {
  proposal: SemanticCandidateProposalV1;
  allowedEventIds: ReadonlySet<string>;
  sourceEventsById: ReadonlyMap<string, SessionEvent>;
}): SemanticProposalDecision {
  const sourceEventIds = [...new Set(input.proposal.evidence.map((item) => item.eventId))].sort();
  if (input.proposal.assertion !== "direct" || isSpeculative(input.proposal.content)) {
    return {
      accepted: false,
      reason: "speculative_evidence",
      type: input.proposal.type,
      sourceEventIds,
    };
  }
  if (input.proposal.durability !== "durable" || isInteractionLocal(input.proposal.content)) {
    return {
      accepted: false,
      reason: "interaction_local_evidence",
      type: input.proposal.type,
      sourceEventIds,
    };
  }

  const validatedQuotes: string[] = [];
  for (const evidence of input.proposal.evidence) {
    if (!input.allowedEventIds.has(evidence.eventId)) {
      return {
        accepted: false,
        reason: "unsupported_evidence",
        type: input.proposal.type,
        sourceEventIds,
      };
    }
    const event = input.sourceEventsById.get(evidence.eventId);
    if (event?.type !== "message") {
      return {
        accepted: false,
        reason: "unsupported_evidence",
        type: input.proposal.type,
        sourceEventIds,
      };
    }
    if (event.payload.role !== "user") {
      return {
        accepted: false,
        reason: "assistant_only_evidence",
        type: input.proposal.type,
        sourceEventIds,
      };
    }
    const content = messageContent(event);
    const quote = evidence.quote;
    if (!content || quote === "" || !content.includes(quote)) {
      return {
        accepted: false,
        reason: "unsupported_evidence",
        type: input.proposal.type,
        sourceEventIds,
      };
    }
    validatedQuotes.push(quote);
  }

  const groundedContent = input.proposal.content;
  if (!validatedQuotes.some((quote) => quote.includes(groundedContent))) {
    return {
      accepted: false,
      reason: "unsupported_evidence",
      type: input.proposal.type,
      sourceEventIds,
    };
  }
  if (
    isSpeculative(validatedQuotes.join("\n")) ||
    isSensitiveValue(groundedContent) ||
    validatedQuotes.some(isSensitiveValue)
  ) {
    return {
      accepted: false,
      reason:
        isSensitiveValue(groundedContent) || validatedQuotes.some(isSensitiveValue)
          ? "sensitive_evidence"
          : "speculative_evidence",
      type: input.proposal.type,
      sourceEventIds,
    };
  }
  if (validatedQuotes.every(isInteractionLocal)) {
    return {
      accepted: false,
      reason: "interaction_local_evidence",
      type: input.proposal.type,
      sourceEventIds,
    };
  }

  return {
    accepted: true,
    candidate: {
      family: input.proposal.family as MemoryFamily,
      type: input.proposal.type,
      content: groundedContent,
      confidence: 0.9,
      importance: 0.5,
      recommendedTier: "indexed",
      sourceEventIds,
      operation: "create",
      replayIdentity: semanticReplayIdentity(input.proposal, input.sourceEventsById),
    },
  };
}
