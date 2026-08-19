import { createHash } from "node:crypto";
import type { MemoryCandidate } from "../domain/types.ts";
import { normalizeLexicalText } from "./lexical-retrieval.ts";

/** Produces the frozen P8 v1 candidate/evidence identity used by durable receipts. */
export function memoryCandidateFingerprint(sessionId: string, candidate: MemoryCandidate): string {
  const fields = [
    "p8:v1",
    sessionId,
    candidate.family,
    candidate.type,
    normalizeLexicalText(candidate.key ?? ""),
    normalizeLexicalText(candidate.content),
    [...new Set(candidate.sourceEventIds)].sort().join(","),
  ];
  return createHash("sha256").update(fields.join("\0")).digest("hex");
}
