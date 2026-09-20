import {
  buildPollUrl,
  extractRecords,
  mapRecord,
  parseTimestamp,
  type CatalogSource,
  type RawIncident,
  type SourceDescriptor,
} from '@crimetracker/shared';
import { assertPublicUrl } from './policy.js';
import { SourceStatusTracker, type DataSource, type SourceContext } from './types.js';

export interface CatalogFeedOptions {
  readonly source: CatalogSource;
  readonly pollSeconds: number;
  /** How many records to request per poll. */
  readonly pageSize?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Adapter for a catalogued real feed.
 *
 * Differs from the generic poller in three ways that matter for live data:
 *
 *  - it speaks each publisher's dialect for "newest first, since X", so a poll fetches
 *    only new records rather than re-downloading the dataset;
 *  - it stamps the publisher's real positional precision onto every record, so a feed
 *    that blurs coordinates to block level is never rendered as an exact point;
 *  - it carries the dataset's attribution and publication lag into the HUD, because
 *    "reported crime from last week" and "a call dispatched two minutes ago" should not
 *    look the same on a live map.
 */
export class CatalogFeedSource implements DataSource {
  readonly descriptor: SourceDescriptor;
  readonly #tracker: SourceStatusTracker;
  readonly #options: CatalogFeedOptions;
  readonly #catalog: CatalogSource;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #seen = new Set<string>();
  /** Newest record timestamp accepted so far, used for incremental polling. */
  #watermark: string | null = null;

  constructor(options: CatalogFeedOptions) {
    const url = assertPublicUrl(options.source.url);
    this.#options = options;
    this.#catalog = options.source;
    this.#fetch = options.fetchImpl ?? fetch;
    this.descriptor = {
      id: options.source.id,
      name: options.source.name,
      kind: 'public-feed',
      note: `${options.source.note} Source: ${options.source.attribution}. Publication lag: ${options.source.latency}.`,
      url: url.toString(),
    };
    this.#tracker = new SourceStatusTracker(this.descriptor, true);
  }

  status() {
    return this.#tracker.snapshot();
  }

  async start(ctx: SourceContext): Promise<void> {
    this.#stopped = false;
    this.#tracker.setState('connecting', `Contacting ${this.#catalog.agency}`);
    ctx.setState('connecting', `Contacting ${this.#catalog.agency}`);
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
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 25_000);

    try {
      const url = buildPollUrl(this.#catalog, {
        since: this.#watermark,
        limit: this.#options.pageSize ?? 200,
      });

      const response = await this.#fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
          'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
        },
      });

      if (response.status === 429) {
        // Back off. A published rate limit is a rule, not an obstacle.
        this.#tracker.setState('degraded', 'Rate limited by publisher — backing off');
        ctx.setState('degraded', 'Rate limited by publisher — backing off');
        return;
      }
      if (!response.ok) {
        this.#tracker.setState('error', `HTTP ${response.status}`);
        ctx.setState('error', `HTTP ${response.status}`);
        return;
      }

      const body: unknown = await response.json();
      const records = extractRecords(body, '');
      const raws: RawIncident[] = [];
      let newestMs = this.#watermark ? Date.parse(this.#watermark) : 0;

      for (const record of records) {
        const raw = mapRecord(record, this.#catalog.map);
        if (!raw) {
          this.#tracker.recordRejection();
          continue;
        }

        const key = raw.externalId ?? JSON.stringify([raw.timestamp, raw.description]);
        if (this.#seen.has(key)) continue;
        this.#seen.add(key);

        const stamped = parseTimestamp(raw.timestamp);
        if (stamped) newestMs = Math.max(newestMs, Date.parse(stamped));

        raws.push({
          ...raw,
          // The publisher's own precision, not a guess, and never `exact`.
          locationPrecision: this.#catalog.precision,
          area: this.#catalog.area,
          tags: [this.#catalog.agency.toLowerCase(), this.#catalog.adapter],
        });
      }

      if (newestMs > 0) this.#watermark = new Date(newestMs).toISOString();

      // Bound the dedup set so a long-running poller cannot grow without limit.
      if (this.#seen.size > 20_000) this.#seen = new Set([...this.#seen].slice(-10_000));

      if (raws.length > 0) {
        ctx.emitMany(raws);
        this.#tracker.recordEvent(raws.length);
      }

      const summary =
        records.length === 0
          ? 'No new records since last poll'
          : `${raws.length} new of ${records.length} returned`;
      this.#tracker.setState('online', summary);
      ctx.setState('online', summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.#tracker.setState('error', message);
      ctx.setState('error', message);
      ctx.log('warn', `${this.#catalog.id} poll failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
