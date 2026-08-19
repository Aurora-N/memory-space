import { isTransientExtractionEvidence } from "./extraction-policy.ts";
import type { Memory, MemoryCandidate, SessionEvent } from "../domain/types.ts";

/** Stable reasons a P8 candidate cannot be written implicitly. */
export type ImplicitRememberRejectionReason =
  | "low_confidence"
  | "missing_user_evidence"
  | "transient_evidence"
  | "operation_not_allowed"
  | "existing_core_memory";

/** Pure conservative P8 admission decision. */
export type ImplicitRememberAdmissionDecision =
  | { accepted: true }
  | { accepted: false; reason: ImplicitRememberRejectionReason };

/** Enforces P8 user evidence, durability, operation, confidence, and Core protection. */
export function decideImplicitRememberAdmission(input: {
  candidate: MemoryCandidate;
  eventsById: ReadonlyMap<string, SessionEvent>;
  existing?: Memory;
}): ImplicitRememberAdmissionDecision {
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
