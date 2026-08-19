import type { MemoryCandidate, Session, SessionEvent } from "../domain/types.ts";
import type { SessionProjectBinding } from "./session-binding.ts";

/** Provider-neutral reason one persisted event range is being extracted. */
export type ExtractionTrigger = "checkpoint" | "implicit_remember";

/** Stable operation context supplied to deterministic memory extractors. */
export interface ExtractionContext {
  session: Session;
  trigger: ExtractionTrigger;
  operationId: string;
  checkpointId?: string;
  projectBinding?: SessionProjectBinding;
}

/** Converts persisted session events into candidate durable memories. */
export interface MemoryExtractor {
  /** Returns candidates deterministically in extraction order for the supplied event order. */
  extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]>;
}
