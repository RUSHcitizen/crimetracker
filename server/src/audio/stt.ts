import { sanitizeMultiline, TEXT_LIMITS } from '@crimetracker/shared';
import type { AudioSegment, SpeechToText, TranscriptionResult } from './types.js';

/** Default provider: accepts audio, produces nothing. Keeps the pipeline wired but inert. */
export class NullSpeechToText implements SpeechToText {
  readonly id = 'null-stt';
  readonly label = 'Disabled (no speech-to-text configured)';

  async transcribe(): Promise<TranscriptionResult | null> {
    return null;
  }
}

export interface WhisperHttpOptions {
  /** OpenAI-compatible base URL exposing `/audio/transcriptions`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Speech-to-text against any OpenAI-compatible `/audio/transcriptions` endpoint —
 * OpenAI itself, or a locally hosted Whisper server. The key stays server-side.
 */
export class WhisperHttpSpeechToText implements SpeechToText {
  readonly id: string;
  readonly label: string;
  readonly #options: WhisperHttpOptions;
  readonly #fetch: typeof fetch;

  constructor(options: WhisperHttpOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.id = `whisper-http:${options.model}`;
    this.label = `${options.model} via OpenAI-compatible transcription API`;
  }

  async transcribe(segment: AudioSegment): Promise<TranscriptionResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 60_000);
    const started = Date.now();
    try {
      const form = new FormData();
      form.append('model', this.#options.model);
      form.append(
        'file',
        new Blob([segment.bytes as unknown as ArrayBuffer], { type: segment.mimeType }),
        `segment-${segment.id}.${extensionFor(segment.mimeType)}`,
      );

      const response = await this.#fetch(
        `${this.#options.baseUrl.replace(/\/$/, '')}/audio/transcriptions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {},
          body: form,
        },
      );
      if (!response.ok) return null;

      const payload = (await response.json()) as { text?: unknown };
      const text = sanitizeMultiline(payload.text, TEXT_LIMITS.transcript);
      if (!text) return null;

      return {
        text,
        // The endpoint does not report a confidence; treat transcription as uncertain.
        confidence: 0.6,
        providerId: this.id,
        durationMs: Date.now() - started,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('aac')) return 'aac';
  return 'bin';
}
