import type { TranscriptRef } from "../provider/types.ts";

export interface TranscriptReadOptions {
  cursor?: string;
  limit?: number;
}

export interface TranscriptChunk {
  content: string;
  cursor?: string;
  occurredAt?: string;
}

export interface TranscriptReader {
  supports(provider: string): boolean;
  read(ref: TranscriptRef, options?: TranscriptReadOptions): Promise<TranscriptChunk[]>;
}
