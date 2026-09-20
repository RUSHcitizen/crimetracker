import {
  extractRecords,
  mapRecord,
  type FeedFieldMap,
  type RawIncident,
  type SourceDescriptor,
} from '@crimetracker/shared';
import { assertPublicUrl } from './policy.js';
import { SourceStatusTracker, type DataSource, type SourceContext } from './types.js';

export interface PublicFeedOptions {
  readonly id?: string;
  readonly name: string;
  readonly url: string;
  readonly pollSeconds: number;
  /** Dot-path to the array of records, or '' when the body *is* the array/FeatureCollection. */
  readonly itemsPath: string;
  readonly map: FeedFieldMap;
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * A generic adapter for publicly accessible structured incident feeds.
 *
 * It is configuration-driven on purpose: connecting a new open-data endpoint means
 * setting `FEED_URL` plus a handful of field paths, not writing a new provider class.
 * Structured data is always preferred over deriving information from audio.
 *
 * Responses are treated as hostile input — every record goes through the same normalizer
 * and schema validation as anything else, and nothing is trusted because it arrived over
 * HTTPS.
 */
export class PublicSafetyFeedSource implements DataSource {
  readonly descriptor: SourceDescriptor;
  readonly #tracker: SourceStatusTracker;
  readonly #options: PublicFeedOptions;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #seen = new Set<string>();

  constructor(options: PublicFeedOptions) {
    // Throws at construction if the URL is not a public https endpoint.
    const url = assertPublicUrl(options.url);
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.descriptor = {
      id: options.id ?? 'public-feed',
      name: options.name,
      kind: 'public-feed',
      note: `Structured public-safety records polled from ${url.host}.`,
      url: url.toString(),
    };
    this.#tracker = new SourceStatusTracker(this.descriptor, true);
  }

  status() {
    return this.#tracker.snapshot();
  }

  async start(ctx: SourceContext): Promise<void> {
    this.#stopped = false;
    this.#tracker.setState('connecting', 'Contacting feed');
    ctx.setState('connecting', 'Contacting feed');
    await this.#poll(ctx);
    this.#schedule(ctx);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#tracker.setState('stopped', null);
  }

  #schedule(ctx: SourceContext): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#poll(ctx).finally(() => this.#schedule(ctx));
    }, this.#options.pollSeconds * 1000);
    this.#timer.unref?.();
  }

  async #poll(ctx: SourceContext): Promise<void> {
    if (this.#stopped) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 20_000);
    try {
      const response = await this.#fetch(this.#options.url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
          'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
        },
      });

      if (response.status === 429) {
        // Back off rather than hammering. We never attempt to work around a rate limit.
        this.#tracker.setState('degraded', 'Rate limited by upstream — backing off');
        ctx.setState('degraded', 'Rate limited by upstream — backing off');
        return;
      }
      if (!response.ok) {
        this.#tracker.setState('error', `HTTP ${response.status}`);
        ctx.setState('error', `HTTP ${response.status}`);
        return;
      }

      const body: unknown = await response.json();
      const records = extractRecords(body, this.#options.itemsPath);
      const raws: RawIncident[] = [];

      for (const record of records) {
        const raw = mapRecord(record, this.#options.map);
        if (!raw) {
          this.#tracker.recordRejection();
          continue;
        }
        // De-duplicate across polls — most feeds re-serve a rolling window.
        const key = raw.externalId ?? JSON.stringify([raw.timestamp, raw.description]);
        if (this.#seen.has(key)) continue;
        this.#seen.add(key);
        raws.push(raw);
      }

      // Bound the dedup set so a long-running poller cannot grow without limit.
      if (this.#seen.size > 20_000) {
        this.#seen = new Set([...this.#seen].slice(-10_000));
      }

      if (raws.length > 0) {
        ctx.emitMany(raws);
        this.#tracker.recordEvent(raws.length);
      }
      this.#tracker.setState('online', `${records.length} records in last poll`);
      ctx.setState('online', `${records.length} records in last poll`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.#tracker.setState('error', message);
      ctx.setState('error', message);
      ctx.log('warn', `feed poll failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
