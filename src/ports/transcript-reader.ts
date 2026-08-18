import type { TranscriptRef } from "../provider/types.ts";

/** Provider transcript pagination options. */
export interface TranscriptReadOptions {
  cursor?: string;
  limit?: number;
}

/** Provider-neutral transcript content returned by a reader adapter. */
export interface TranscriptChunk {
  content: string;
  cursor?: string;
  occurredAt?: string;
}

/** Reads provider transcripts without exposing provider-specific storage to the application layer. */
export interface TranscriptReader {
  supports(provider: string): boolean;
  read(ref: TranscriptRef, options?: TranscriptReadOptions): Promise<TranscriptChunk[]>;
}
