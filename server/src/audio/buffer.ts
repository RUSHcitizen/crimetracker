import { randomUUID } from '@crimetracker/shared';
import type { AudioSegment } from './types.js';

/**
 * Accumulates bytes from a stream and emits fixed-duration segments.
 *
 * Duration is estimated from an assumed constant bitrate — adequate for segmenting a
 * broadcast stream into transcription-sized chunks, and it keeps the pipeline free of a
 * native audio dependency. A production deployment would decode properly and cut on
 * silence.
 */
export class RollingAudioBuffer {
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  #startedAt: number;

  constructor(
    private readonly segmentSeconds: number,
    private readonly bytesPerSecond: number,
    private readonly mimeType: string,
    /** Hard ceiling so a stalled consumer cannot exhaust memory. */
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {
    this.#startedAt = Date.now();
  }

  get pendingBytes(): number {
    return this.#bytes;
  }

  /** Push bytes in; returns a segment once enough audio has accumulated. */
  push(chunk: Uint8Array): AudioSegment | null {
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;

    if (this.#bytes > this.maxBytes) {
      // Drop the oldest audio rather than grow without bound.
      while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
        const dropped = this.#chunks.shift();
        this.#bytes -= dropped?.byteLength ?? 0;
      }
    }

    const target = this.segmentSeconds * this.bytesPerSecond;
    if (this.#bytes < target) return null;
    return this.flush();
  }

  /** Emit whatever has accumulated, even if short of a full segment. */
  flush(): AudioSegment | null {
    if (this.#bytes === 0) return null;
    const merged = new Uint8Array(this.#bytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const segment: AudioSegment = {
      id: randomUUID(),
      bytes: merged,
      mimeType: this.mimeType,
      startedAt: new Date(this.#startedAt).toISOString(),
      durationSeconds: Math.round((this.#bytes / this.bytesPerSecond) * 10) / 10,
    };
    this.#chunks.length = 0;
    this.#bytes = 0;
    this.#startedAt = Date.now();
    return segment;
  }
}
