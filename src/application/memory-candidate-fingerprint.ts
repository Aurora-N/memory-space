import { createHash } from "node:crypto";
import type { MemoryCandidate } from "../domain/types.ts";
import { normalizeLexicalText } from "./lexical-retrieval.ts";

/** Produces the P8 identity or a trusted P9 evidence-replay identity for the shared receipt table. */
export function memoryCandidateFingerprint(sessionId: string, candidate: MemoryCandidate): string {
  if (candidate.replayIdentity) {
    return createHash("sha256")
      .update(
        [
          "p9:evidence:v1",
          sessionId,
          candidate.family,
          candidate.type,
          candidate.replayIdentity,
        ].join("\0")
      )
      .digest("hex");
  }
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
