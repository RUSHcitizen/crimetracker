import { DurableObject } from 'cloudflare:workers';
import {
  buildPollUrl,
  CAMERA_USE_NOTICE,
  detectPatterns,
  findCatalogSource,
  IncidentRepository,
  extractRecords,
  incidentQuerySchema,
  INCIDENT_TYPE_META,
  mapRecord,
  mapWsdotCameras,
  parseOpenMhzSpec,
  parseTimestamp,
  normalizeIncident,
  type Incident,
  type IncidentQuery,
  type PatternCluster,
  type CameraDirectory,
  type CatalogSource,
  type RawIncident,
  type ServerFrame,
  type SnapshotFrame,
  type SourceDescriptor,
  type SourceStatus,
  type Stats,
} from '@crimetracker/shared';
import {
  loadWorkerConfig,
  publicWorkerConfig,
  type Env,
  type WorkerConfig,
} from './config.js';
import { migrate } from './driver.js';
import { BriefService, createBriefGenerator } from './brief.js';

/** How often the alarm fires. Feed polling is driven from it. */
const TICK_MS = 2_000;
const SNAPSHOT_SIZE = 2500;

/** What survives eviction. */
interface PersistedMeta {
  readonly accepted: number;
  readonly rejected: number;
}

interface SourceRuntime {
  readonly descriptor: SourceDescriptor;
  state: SourceStatus['state'];
  ingested: number;
  rejected: number;
  lastEventAt: string | null;
  message: string | null;
  /** Epoch ms of the next due poll, for feed sources. */
  nextPollAt: number;
  /**
   * Whether the alarm loop may poll this source as a feed.
   *
   * False for anything that is not a catalogued feed or the generic configured one.
   * Without this, a registered source with no catalogue entry falls through to
   * `config.feed.url` and is polled against an endpoint that has nothing to do with it.
   */
  pollable: boolean;
  /** Catalogue entry, when this source is a catalogued real feed. */
  catalog?: CatalogSource;
  /** Newest accepted record time, for incremental polling. */
  watermark?: string | null;
}

/**
 * The tracker, as a single Durable Object.
 *
 * On Cloudflare there is no long-lived process, so the pieces the Node server gets for
 * free are provided differently:
 *
 *   - **state** lives in the object's embedded SQLite, through the same `IncidentRepository`
 *     the Node server uses (both speak the `SqlDriver` seam);
 *   - **the clock** is a Durable Object alarm rather than `setInterval`, so the simulation
 *     and feed polling survive the object being evicted between requests;
 *   - **realtime** uses WebSocket hibernation, so connected clients cost nothing while
 *     idle and the object can be evicted without dropping them.
 *
 * One object instance owns all of this, which keeps ordering and the incident store
 * consistent — exactly the guarantee the Node single-process server had.
 */
export class TrackerRoom extends DurableObject<Env> {
  readonly #repo: IncidentRepository;
  readonly #config: WorkerConfig;
  #patterns: PatternCluster[] = [];
  #sources = new Map<string, SourceRuntime>();
  #accepted = 0;
  #rejected = 0;
  #booted = false;
  /** Per-instance: the purge runs once per live object, not once per deployment. */
  #purged = false;
  #seenFeedIds = new Set<string>();
  #cameras: CameraDirectory | null = null;
  #camerasAtMs = 0;
  #camerasMessage: string | null = null;
  /** True only when a refresh failed, not merely when records were filtered out. */
  #camerasFailed = false;
  readonly #briefs: BriefService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#config = loadWorkerConfig(env);
    this.#repo = new IncidentRepository(migrate(ctx.storage.sql));
    this.#briefs = new BriefService(createBriefGenerator(this.#config));

    // Catalogued real agency feeds, selected by id.
    for (const id of this.#config.sources) {
      /*
       * Radio call ingestion is a Node-server adapter: it fetches audio clips and posts
       * them to a transcription service per call, which does not fit a Durable Object's
       * CPU and subrequest budget. Rather than silently dropping the source — leaving an
       * operator staring at a deployment that ingests nothing for no stated reason — it
       * is registered in an error state that says exactly where it does run.
       */
      if (parseOpenMhzSpec(id)) {
        const runtime = this.#registerSource({
          id,
          name: `OpenMHz ${id.slice('openmhz:'.length)}`,
          kind: 'audio',
          note:
            'Archived public radio calls. Not available on the Cloudflare deployment: ' +
            'transcribing call audio does not fit a Durable Object\u2019s CPU and ' +
            'subrequest budget. Run this source on the Node server instead.',
          url: null,
        });
        runtime.state = 'error';
        runtime.message = 'Radio ingestion runs on the Node server, not on Workers.';
        continue;
      }

      const entry = findCatalogSource(id);
      if (!entry) continue;
      // A publisher that issues an access key cannot be polled without one: registering
      // the source anyway would show it online in the HUD while it only ever 401s.
      if (entry.keyEnv && !this.#config.sourceKeys[entry.keyEnv]) continue;
      this.#registerSource(
        {
          id: entry.id,
          name: entry.name,
          kind: 'public-feed',
          note: `${entry.note} Source: ${entry.attribution}. Publication lag: ${entry.latency}.`,
          url: entry.url,
        },
        entry,
      );
    }

    if (this.#config.feed.enabled) {
      this.#registerSource({
        id: 'public-feed',
        name: this.#config.feed.name,
        kind: 'public-feed',
        note: `Structured public-safety records polled from ${safeHost(this.#config.feed.url)}.`,
        url: this.#config.feed.url,
      });
    }

    // Restore counters and mode across evictions.
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<PersistedMeta>('meta');
      if (saved) {
        this.#accepted = saved.accepted;
        this.#rejected = saved.rejected;
      }
      this.#booted = (await ctx.storage.get<boolean>('booted')) ?? false;
    });
  }

  /* ------------------------------- HTTP surface ------------------------------ */

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') return this.#handleUpgrade(request);

    await this.#ensureStarted();

    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/health':
        return json({
          status: 'ok',
          serverTime: new Date().toISOString(),
          incidents: this.#repo.countIncidents(),
          counters: { accepted: this.#accepted, rejected: this.#rejected },
          runtime: 'cloudflare-worker',
        });

      case 'GET /api/config':
        return json(publicWorkerConfig(this.#config));

      case 'GET /api/taxonomy':
        return json({ types: Object.values(INCIDENT_TYPE_META) });

      case 'GET /api/incidents':
        return this.#handleIncidents(url);

      case 'GET /api/search':
        return this.#handleSearch(url);

      case 'GET /api/stats':
        return json({ stats: this.#currentStats() });

      case 'GET /api/patterns':
        return json({
          patterns: this.#patterns,
          disclaimer:
            'Analytical inference over incidents already received. Not a prediction of future events.',
        });

      case 'GET /api/sources':
        return json({ sources: this.#sourceStatuses() });

      case 'GET /api/cameras':
        return this.#handleCameras();
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/incidents/')) {
      const rest = decodeURIComponent(url.pathname.slice('/api/incidents/'.length));
      const wantsBrief = rest.endsWith('/brief');
      const id = wantsBrief ? rest.slice(0, -'/brief'.length) : rest;
      if (!id || id.length > 120) return json({ error: 'invalid-id' }, 400);

      const incident = this.#repo.getIncident(id);
      if (!incident) return json({ error: 'not-found' }, 404);
      if (!wantsBrief) return json({ incident });

      return json({ brief: await this.#briefs.briefFor(incident), incidentId: incident.id });
    }

    return json({ error: 'not-found' }, 404);
  }

  #handleIncidents(url: URL): Response {
    const parsed = incidentQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return json({ error: 'invalid-query', issues: parsed.error.issues }, 400);
    const query = toQuery(parsed.data, 500);
    const incidents = this.#repo.queryIncidents(query);
    return json({ incidents, count: incidents.length, query });
  }

  #handleSearch(url: URL): Response {
    const parsed = incidentQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return json({ error: 'invalid-query', issues: parsed.error.issues }, 400);
    const query = toQuery(parsed.data, 60);
    const incidents = this.#repo.queryIncidents({ ...query, limit: Math.min(query.limit ?? 60, 200) });
    return json({ incidents, count: incidents.length });
  }


  /* --------------------------------- realtime -------------------------------- */

  #handleUpgrade(request: Request): Response {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Hibernation: the object may be evicted while sockets stay open.
    this.ctx.acceptWebSocket(server);

    void this.#ensureStarted().then(() => {
      const snapshot: SnapshotFrame = {
        type: 'snapshot',
        serverTime: new Date().toISOString(),
        incidents: this.#repo.queryIncidents({ limit: SNAPSHOT_SIZE }),
        patterns: this.#patterns,
        stats: this.#currentStats(),
        sources: this.#sourceStatuses(),
      };
      try {
        server.send(JSON.stringify(snapshot));
      } catch {
        // The client went away between accept and snapshot.
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Clients have nothing to say: every mutation goes through the REST API. */
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  #broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // Dropped sockets are cleaned up by the runtime.
      }
    }
  }

  /* ---------------------------------- clock ---------------------------------- */

  /** Start the alarm loop, and prime simulated history only if simulation is active. */
  async #ensureStarted(): Promise<void> {
    if (!this.#booted) {
      this.#booted = true;
      await this.ctx.storage.put('booted', true);
      this.runAnalysis();
    }

    /*
     * Durable Object storage outlives a deployment. Rows written by an earlier build —
     * above all the fabricated incidents the removed simulation engine backfilled —
     * survive a deploy that no longer contains the code that made them, and keep being
     * served as though they were real. Purging is idempotent and costs nothing once the
     * database is clean, so it runs on every start rather than behind a one-shot flag
     * that a fresh object would miss.
     */
    if (!this.#purged) {
      this.#purged = true;
      const purged = this.#repo.purgeUnservable();
      if (purged.incidents > 0 || purged.sources > 0) {
        console.warn(
          `purged ${purged.incidents} incident(s) and ${purged.sources} source(s) left by ` +
            'an earlier build; recomputing analysis',
        );
        this.runAnalysis();
        this.#broadcast({ type: 'stats', stats: this.#currentStats() });
      }
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }


  /**
   * The clock.
   *
   * The next alarm is scheduled in a `finally`, and that placement is the whole point: a
   * Durable Object's alarm chain is only as long as its last successful reschedule. With
   * the call at the end of the happy path, a single throw anywhere above it — one
   * malformed payload, one unexpected upstream shape — ends polling permanently and
   * silently, and the object goes on serving whatever it had already stored as though
   * nothing were wrong. Ingestion must not be one exception away from stopping forever.
   */
  override async alarm(): Promise<void> {
    try {
      const now = Date.now();

      for (const runtime of this.#sources.values()) {
        if (!runtime.pollable) continue;
        if (runtime.state === 'stopped' || now < runtime.nextPollAt) continue;
        runtime.nextPollAt = now + this.#config.feed.pollSeconds * 1000;
        // `#pollFeed` handles its own failures; this is belt and braces around the rest.
        await this.#pollFeed(runtime);
      }

      this.runAnalysis();
      await this.#persistMeta();
    } catch (error) {
      console.error('alarm tick failed', error);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  /* --------------------------------- ingestion ------------------------------- */

  #ingest(descriptor: SourceDescriptor, raws: readonly RawIncident[]): Incident[] {
    const runtime = this.#sources.get(descriptor.id);
    const accepted: Incident[] = [];

    for (const raw of raws) {
      const result = normalizeIncident(raw, { source: descriptor, region: this.#config.region });
      if (!result.ok) {
        this.#rejected += 1;
        if (runtime) runtime.rejected += 1;
        continue;
      }
      this.#repo.insertIncident(result.incident);
      accepted.push(result.incident);
      this.#accepted += 1;
    }

    if (accepted.length > 0 && runtime) {
      runtime.ingested += accepted.length;
      runtime.lastEventAt = new Date().toISOString();
      this.#broadcast({ type: 'incidents', incidents: accepted });
    }
    return accepted;
  }

  async #pollFeed(runtime: SourceRuntime): Promise<void> {
    const catalog = runtime.catalog;
    // A catalogued source speaks its publisher's dialect for "newest since X"; anything
    // else is the generic configured feed.
    const apiKey = catalog?.keyEnv ? this.#config.sourceKeys[catalog.keyEnv] ?? null : null;
    const url = catalog
      ? buildPollUrl(catalog, { since: runtime.watermark ?? null, limit: 200, apiKey })
      : this.#config.feed.url;

    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
          'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
        },
      });

      if (response.status === 401 || response.status === 403) {
        runtime.state = 'error';
        runtime.message = catalog?.keyEnv
          ? `Publisher rejected the access key — check ${catalog.keyEnv}`
          : `Publisher refused the request (HTTP ${response.status})`;
        return;
      }
      if (response.status === 429) {
        // Back off rather than hammering. Rate limits are never worked around.
        runtime.state = 'degraded';
        runtime.message = 'Rate limited by upstream — backing off';
        runtime.nextPollAt = Date.now() + this.#config.feed.pollSeconds * 3000;
        return;
      }
      if (!response.ok) {
        runtime.state = 'error';
        runtime.message = `HTTP ${response.status}`;
        return;
      }

      const body: unknown = await response.json();
      const raws: RawIncident[] = [];
      let newestMs = runtime.watermark ? Date.parse(runtime.watermark) : 0;

      for (const record of extractRecords(body, catalog ? '' : this.#config.feed.itemsPath)) {
        const raw = mapRecord(record, catalog ? catalog.map : this.#config.feed.map);
        if (!raw) {
          runtime.rejected += 1;
          continue;
        }
        const key = `${runtime.descriptor.id}:${
          raw.externalId ?? JSON.stringify([raw.timestamp, raw.description])
        }`;
        if (this.#seenFeedIds.has(key)) continue;
        this.#seenFeedIds.add(key);

        if (catalog) {
          const stamped = parseTimestamp(raw.timestamp);
          if (stamped) newestMs = Math.max(newestMs, Date.parse(stamped));
          // The publisher's own precision, never `exact`, never a guess.
          raws.push({
            ...raw,
            locationPrecision: catalog.precision,
            area: catalog.area,
            tags: [catalog.agency.toLowerCase(), catalog.adapter],
          });
        } else {
          raws.push(raw);
        }
      }

      if (catalog && newestMs > 0) runtime.watermark = new Date(newestMs).toISOString();
      if (this.#seenFeedIds.size > 20_000) {
        this.#seenFeedIds = new Set([...this.#seenFeedIds].slice(-10_000));
      }

      if (raws.length > 0) this.#ingest(runtime.descriptor, raws);
      runtime.state = 'online';
      runtime.message = null;
    } catch (error) {
      // A fetch error quotes the request URL, which for a keyed publisher carries the
      // access code, and this message is broadcast to every connected client.
      const detail = error instanceof Error ? error.message : 'unknown error';
      runtime.state = 'error';
      runtime.message = (apiKey ? detail.split(apiKey).join('REDACTED') : detail).slice(0, 160);
    }
  }

  /* --------------------------------- cameras --------------------------------- */

  /**
   * Public roadway cameras, cached in memory for the object's lifetime.
   *
   * Cameras are never incidents: nothing here is written to the store, clustered, or
   * analysed. The directory changes over months, so it is fetched rarely — and a failed
   * refresh serves the previous copy rather than emptying the overlay.
   */
  async #handleCameras(): Promise<Response> {
    if (!this.#config.cameras.enabled) {
      return json({
        configured: false,
        cameras: [],
        count: 0,
        reason:
          'No camera access code configured. Set the WSDOT_ACCESS_CODE secret to enable ' +
          'the public roadway-camera overlay.',
      });
    }

    const ttlMs = this.#config.cameras.refreshMinutes * 60_000;
    if (!this.#cameras || Date.now() - this.#camerasAtMs > ttlMs) {
      await this.#refreshCameras();
    }

    const directory = this.#cameras;
    if (!directory) {
      return json({
        configured: true,
        cameras: [],
        count: 0,
        message: this.#camerasMessage ?? 'Camera directory unavailable.',
      });
    }
    return json({
      configured: true,
      ...directory,
      count: directory.cameras.length,
      stale: this.#camerasFailed,
      message: this.#camerasMessage,
    });
  }

  async #refreshCameras(): Promise<void> {
    const code = this.#config.cameras.accessCode;
    const url = new URL(this.#config.cameras.url);
    url.searchParams.set('AccessCode', code);

    try {
      const response = await fetch(url.toString(), {
        headers: {
          accept: 'application/json',
          'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
        },
      });
      if (!response.ok) {
        this.#camerasFailed = true;
        this.#camerasMessage =
          response.status === 401 || response.status === 403
            ? `Camera directory rejected the access code (HTTP ${response.status}).`
            : `Camera directory returned HTTP ${response.status}.`;
        if (!this.#cameras) this.#camerasAtMs = Date.now();
        return;
      }

      const { cameras, rejected } = mapWsdotCameras(await response.json(), {
        region: this.#config.region,
        imageHosts: this.#config.cameras.imageHosts,
      });
      this.#cameras = {
        provider: 'WSDOT',
        attribution: 'Washington State Department of Transportation',
        docsUrl: 'https://wsdot.wa.gov/traffic/api/',
        notice: CAMERA_USE_NOTICE,
        fetchedAt: new Date().toISOString(),
        cameras,
      };
      this.#camerasAtMs = Date.now();
      this.#camerasFailed = false;
      this.#camerasMessage =
        rejected.total > 0
          ? `${rejected.total} camera record(s) not shown (${rejected.inactive} inactive, ` +
            `${rejected.position} without a usable position, ${rejected.imageHost} with an ` +
            'image host outside the allow-list).'
          : null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.#camerasFailed = true;
      this.#camerasMessage = `Camera directory fetch failed: ${
        code ? detail.split(code).join('REDACTED') : detail
      }`;
      if (!this.#cameras) this.#camerasAtMs = Date.now();
    }
  }

  /* --------------------------------- analysis -------------------------------- */

  runAnalysis(): void {
    const recent = this.#repo.queryIncidents({
      sinceMinutes: this.#config.patterns.windowMinutes + 15,
      limit: 6000,
    });
    this.#patterns = detectPatterns(recent, {
      epsKm: this.#config.patterns.epsKm,
      windowMinutes: this.#config.patterns.windowMinutes,
      minPoints: this.#config.patterns.minPoints,
    });
    this.#repo.recordClusters(this.#patterns);

    if (this.#config.retentionHours > 0) {
      this.#repo.deleteOlderThan(Date.now() - this.#config.retentionHours * 3_600_000);
    }

    this.#broadcast({ type: 'patterns', patterns: this.#patterns });
    this.#broadcast({ type: 'stats', stats: this.#currentStats() });
    this.#broadcast({ type: 'sources', sources: this.#sourceStatuses() });
  }

  #currentStats(): Stats {
    return this.#repo.computeStats(this.#patterns.length);
  }

  /* ---------------------------------- sources -------------------------------- */

  #registerSource(descriptor: SourceDescriptor, catalog?: CatalogSource): SourceRuntime {
    this.#repo.upsertSource(descriptor);
    const runtime: SourceRuntime = {
      descriptor,
      catalog,
      watermark: null,
      /*
       * `idle`, not `online`. A source that has never completed a poll has not
       * established anything, and reporting it as online is how a deployment ends up
       * showing "3/3 sources" beside "0 ingested" with nothing to explain the gap. The
       * first poll moves it to online, error or degraded, each of which says something.
       */
      state: 'idle',
      ingested: 0,
      rejected: 0,
      lastEventAt: null,
      message: null,
      nextPollAt: 0,
      // A catalogued feed polls its own endpoint; the generic feed polls the configured
      // one. Anything else has no endpoint of its own and must never be polled.
      pollable: Boolean(catalog) || descriptor.id === 'public-feed',
    };
    this.#sources.set(descriptor.id, runtime);
    return runtime;
  }

  #sourceStatuses(): SourceStatus[] {
    return [...this.#sources.values()].map((runtime) => ({
      id: runtime.descriptor.id,
      name: runtime.descriptor.name,
      kind: runtime.descriptor.kind,
      note: runtime.descriptor.note,
      state: runtime.state,
      enabled: runtime.state === 'online',
      lastEventAt: runtime.lastEventAt,
      eventsIngested: runtime.ingested,
      eventsRejected: runtime.rejected,
      message: runtime.message,
      url: runtime.descriptor.url ?? null,
    }));
  }

  async #persistMeta(): Promise<void> {
    const meta: PersistedMeta = { accepted: this.#accepted, rejected: this.#rejected };
    await this.ctx.storage.put('meta', meta);
  }
}

/* ---------------------------------- helpers --------------------------------- */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function toQuery(parsed: Record<string, unknown>, defaultLimit: number): IncidentQuery {
  const q = parsed as {
    types?: IncidentQuery['types'];
    sources?: string[];
    minSeverity?: number;
    sinceMinutes?: number;
    from?: string;
    to?: string;
    bbox?: [number, number, number, number];
    lat?: number;
    lon?: number;
    radiusKm?: number;
    q?: string;
    limit?: number;
    offset?: number;
  };
  return {
    ...(q.types ? { types: q.types } : {}),
    ...(q.sources ? { sources: q.sources } : {}),
    ...(q.minSeverity != null ? { minSeverity: q.minSeverity } : {}),
    ...(q.sinceMinutes != null ? { sinceMinutes: q.sinceMinutes } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.bbox ? { bbox: q.bbox } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.lat != null && q.lon != null && q.radiusKm != null
      ? { near: { lat: q.lat, lon: q.lon, radiusKm: q.radiusKm } }
      : {}),
    limit: q.limit ?? defaultLimit,
    offset: q.offset ?? 0,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured feed';
  }
}
