import { isTransientExtractionEvidence } from "./extraction-policy.ts";
import type { Memory, MemoryCandidate, SessionEvent } from "../domain/types.ts";
import { promptRememberDirective } from "./prompt-remember-directive.ts";

/** Stable reasons a P8 candidate cannot be written implicitly. */
export type ImplicitRememberRejectionReason =
  | "low_confidence"
  | "missing_user_evidence"
  | "transient_evidence"
  | "operation_not_allowed"
  | "existing_core_memory"
  | "secret_like_evidence"
  | "opted_out_evidence";

/** Pure conservative P8 admission decision. */
export type ImplicitRememberAdmissionDecision =
  | { accepted: true }
  | { accepted: false; reason: ImplicitRememberRejectionReason };

const secretKeyConcepts = new Set([
  "PASSWORD",
  "PASSWD",
  "API_KEY",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "PRIVATE_KEY",
  "CLIENT_SECRET",
  "AUTH_SECRET",
  "CREDENTIAL",
  "CREDENTIALS",
]);

function isSecretLikeKey(key: string | undefined): boolean {
  if (!key) return false;
  const tokens = key
    .toUpperCase()
    .split(/[_\-./:]+/u)
    .filter(Boolean);
  for (const concept of secretKeyConcepts) {
    const conceptTokens = concept.split("_");
    if (conceptTokens.length === 1 && tokens.includes(conceptTokens[0] ?? "")) return true;
    for (let index = 0; index <= tokens.length - conceptTokens.length; index += 1) {
      if (conceptTokens.every((token, offset) => tokens[index + offset] === token)) return true;
    }
  }
  return false;
}

/** Enforces P8 user evidence, durability, operation, confidence, and Core protection. */
export function decideImplicitRememberAdmission(input: {
  candidate: MemoryCandidate;
  eventsById: ReadonlyMap<string, SessionEvent>;
  sourceEventsById: ReadonlyMap<string, SessionEvent>;
  existing?: Memory;
}): ImplicitRememberAdmissionDecision {
  const sourceEvidence = input.candidate.sourceEventIds
    .map((id) => input.sourceEventsById.get(id))
    .filter((event): event is SessionEvent => event !== undefined);
  const sourceUserEvidence = sourceEvidence.filter(
    (event) => event.type === "message" && event.payload.role === "user"
  );
  if (
    sourceUserEvidence.some((event) => {
      const content = event.payload.content ?? event.payload.text;
      return typeof content === "string" && promptRememberDirective(content) === "disable_for_turn";
    })
  ) {
    return { accepted: false, reason: "opted_out_evidence" };
  }
  if (input.candidate.confidence < 0.85) {
    return { accepted: false, reason: "low_confidence" };
  }
  if (
    input.candidate.operation !== "create" &&
    input.candidate.operation !== "update" &&
    input.candidate.operation !== "ignore"
  ) {
    return { accepted: false, reason: "operation_not_allowed" };
  }
  if (isSecretLikeKey(input.candidate.key)) {
    return { accepted: false, reason: "secret_like_evidence" };
  }
  const evidence = input.candidate.sourceEventIds
    .map((id) => input.eventsById.get(id))
    .filter((event): event is SessionEvent => event !== undefined);
  const userEvidence = evidence.filter(
    (event) => event.type === "message" && event.payload.role === "user"
  );
  if (userEvidence.length === 0) {
    return { accepted: false, reason: "missing_user_evidence" };
  }
  if (
    isTransientExtractionEvidence(input.candidate.content) ||
    userEvidence.every((event) => {
      const content = event.payload.content ?? event.payload.text;
      return typeof content === "string" && isTransientExtractionEvidence(content);
    })
  ) {
    return { accepted: false, reason: "transient_evidence" };
  }
  if (input.existing?.tier === "core") {
    return { accepted: false, reason: "existing_core_memory" };
  }
  return { accepted: true };
}
