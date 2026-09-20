/**
 * Optional public-audio pipeline.
 *
 *   PUBLIC AUDIO → AUDIO BUFFER → SPEECH-TO-TEXT → TRANSCRIPT → INCIDENT EXTRACTION
 *
 * Scope, deliberately narrow: this only ever handles audio that is already lawfully and
 * publicly accessible over plain HTTP(S), and only when the operator has explicitly
 * acknowledged that. There is no support for encrypted streams, credentialed endpoints,
 * or anything access-controlled, and no code path that could add one.
 *
 * Where a source offers structured incident data, that is always preferred over audio.
 */

export interface AudioSegment {
  readonly id: string;
  /** Raw bytes of one segment, in whatever container the stream serves. */
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly startedAt: string;
  readonly durationSeconds: number;
}

export interface TranscriptionResult {
  readonly text: string;
  /** 0–1, when the provider reports one. */
  readonly confidence: number;
  readonly providerId: string;
  readonly durationMs: number;
}

/** Provider-agnostic speech-to-text. */
export interface SpeechToText {
  readonly id: string;
  readonly label: string;
  /** Returns `null` when the segment produced no usable speech. */
  transcribe(segment: AudioSegment): Promise<TranscriptionResult | null>;
}
