import type { MemoryCandidate, Session, SessionEvent } from "../domain/types.ts";

export interface ExtractionContext {
  session: Session;
  checkpointId: string;
}

export interface MemoryExtractor {
  extract(events: SessionEvent[], context: ExtractionContext): Promise<MemoryCandidate[]>;
}
