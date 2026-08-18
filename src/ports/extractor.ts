import type { MemoryCandidate, Session, SessionEvent } from "../domain/types.ts";

/** Stable checkpoint context supplied to deterministic memory extractors. */
export interface ExtractionContext {
  session: Session;
  checkpointId: string;
}

/** Converts persisted session events into candidate durable memories. */
export interface MemoryExtractor {
  /** Returns candidates deterministically in extraction order for the supplied event order. */
  extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]>;
}
