import type { RawIncident, SourceDescriptor } from '@crimetracker/shared';
import { RollingAudioBuffer } from '../audio/buffer.js';
import type { SpeechToText } from '../audio/types.js';
import type { IncidentExtractor } from '../extraction/types.js';
import { assertAudioAcknowledged, assertPublicUrl } from './policy.js';
import { SourceStatusTracker, type DataSource, type SourceContext } from './types.js';

export interface PublicAudioSourceOptions {
  readonly id?: string;
  readonly name: string;
  /** A publicly accessible HTTP(S) audio stream. */
  readonly url: string;
  readonly acknowledged: boolean;
  readonly segmentSeconds: number;
  readonly stt: SpeechToText;
  readonly extractor: IncidentExtractor;
  /** Coverage area label, used only as a hint; never turned into a coordinate. */
  readonly areaHint?: string | null;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Optional pipeline: public audio → buffer → speech-to-text → extraction → incident.
 *
 * Off by default. Requires both a stream URL and `PUBLIC_AUDIO_ACK=1`, and the URL is
 * checked by `policy.ts` (public http(s) only, no credentials). Incidents produced this
 * way never carry coordinates — a transcript cannot establish a position — so they are
 * stored with an approximate, text-only location.
 */
export class PublicAudioSource implements DataSource {
  readonly descriptor: SourceDescriptor;
  readonly #tracker: SourceStatusTracker;
  readonly #options: PublicAudioSourceOptions;
  readonly #fetch: typeof fetch;
  #controller: AbortController | null = null;
  #stopped = false;

  constructor(options: PublicAudioSourceOptions) {
    assertAudioAcknowledged(options.acknowledged);
    const url = assertPublicUrl(options.url);
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.descriptor = {
      id: options.id ?? 'public-audio',
      name: options.name,
      kind: 'audio',
      note: `Publicly accessible audio from ${url.host}, transcribed and parsed locally.`,
      url: url.toString(),
    };
    this.#tracker = new SourceStatusTracker(this.descriptor, true);
  }

  status() {
    return this.#tracker.snapshot();
  }

  async start(ctx: SourceContext): Promise<void> {
    this.#stopped = false;
    void this.#run(ctx);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#controller?.abort();
    this.#tracker.setState('stopped', null);
  }

  async #run(ctx: SourceContext): Promise<void> {
    let backoffMs = 2000;
    while (!this.#stopped && !ctx.signal.aborted) {
      try {
        this.#tracker.setState('connecting', 'Opening audio stream');
        ctx.setState('connecting', 'Opening audio stream');
        await this.#consume(ctx);
        backoffMs = 2000;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.#tracker.setState('error', message);
        ctx.setState('error', message);
        ctx.log('warn', `audio stream error: ${message}`);
      }
      if (this.#stopped || ctx.signal.aborted) break;
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  async #consume(ctx: SourceContext): Promise<void> {
    this.#controller = new AbortController();
    const abort = () => this.#controller?.abort();
    ctx.signal.addEventListener('abort', abort, { once: true });

    try {
      const response = await this.#fetch(this.#options.url, {
        signal: this.#controller.signal,
        headers: { 'user-agent': 'CrimeTracker/0.1 (public incident visualization)' },
      });
      if (!response.ok || !response.body) {
        throw new Error(`stream returned HTTP ${response.status}`);
      }

      const mimeType = response.headers.get('content-type') ?? 'audio/mpeg';
      // 128 kbps is the common default for public broadcast streams.
      const buffer = new RollingAudioBuffer(this.#options.segmentSeconds, 16_000, mimeType);
      this.#tracker.setState('online', 'Streaming');
      ctx.setState('online', 'Streaming');

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (this.#stopped) break;
        const segment = buffer.push(chunk);
        if (!segment) continue;
        // Transcription must not stall stream consumption.
        void this.#processSegment(ctx, segment).catch((error: unknown) => {
          ctx.log('warn', `segment processing failed: ${String(error)}`);
        });
      }
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  }

  async #processSegment(
    ctx: SourceContext,
    segment: { id: string; bytes: Uint8Array; mimeType: string; startedAt: string; durationSeconds: number },
  ): Promise<void> {
    const transcription = await this.#options.stt.transcribe(segment);
    if (!transcription) {
      this.#tracker.recordRejection();
      return;
    }

    const extraction = await this.#options.extractor.extract({
      transcript: transcription.text,
      receivedAt: segment.startedAt,
      areaHint: this.#options.areaHint ?? null,
    });

    const raw: RawIncident = {
      externalId: segment.id,
      timestamp: segment.startedAt,
      // These come from a model reading a transcript, so they are flagged as inference.
      incidentType: extraction.incidentType ?? undefined,
      severity: extraction.severity ?? undefined,
      description: extraction.description ?? transcription.text.slice(0, 280),
      locationLabel: extraction.locationLabel ?? undefined,
      locationPrecision: extraction.locationPrecision ?? 'unknown',
      area: extraction.area ?? this.#options.areaHint ?? undefined,
      // A transcript never establishes a position. Never invent one.
      coordinates: null,
      confidence: Math.min(transcription.confidence, extraction.confidence || 0.3),
      transcript: transcription.text,
      status: 'extracting',
      tags: ['audio-derived'],
      provenance: {
        transcript: { origin: 'source', note: transcription.providerId },
        ...(extraction.incidentType
          ? { incidentType: { origin: 'ai-inferred' as const, confidence: extraction.confidence, note: extraction.extractorId } }
          : {}),
        ...(extraction.severity
          ? { severity: { origin: 'ai-inferred' as const, confidence: extraction.confidence, note: extraction.extractorId } }
          : {}),
        ...(extraction.description
          ? { description: { origin: 'ai-inferred' as const, confidence: extraction.confidence, note: extraction.extractorId } }
          : {}),
        ...(extraction.locationLabel
          ? { location: { origin: 'ai-inferred' as const, confidence: extraction.confidence, note: extraction.extractorId } }
          : {}),
      },
      raw: {
        audioSegmentId: segment.id,
        durationSeconds: segment.durationSeconds,
        sttProvider: transcription.providerId,
        extractor: extraction.extractorId,
        extractionNotes: extraction.notes,
      },
    };

    ctx.emit(raw);
    this.#tracker.recordEvent();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
