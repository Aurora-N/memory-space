import type { TranscriptRef } from "../provider/types.ts";

/** Provider transcript pagination options. */
export interface TranscriptReadOptions {
  cursor?: string;
  /** Maximum chunks requested from the provider; adapters may return fewer. */
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
  /** Reports whether this reader can interpret references for the provider name. */
  supports(provider: string): boolean;
  /** Returns chunks in provider transcript order without leaking provider storage shapes. */
  read(ref: TranscriptRef, options?: TranscriptReadOptions): Promise<TranscriptChunk[]>;
}
