import { WASHINGTON_BBOX, type AppMode, type BBox } from '@crimetracker/shared';

/**
 * Worker configuration.
 *
 * Workers have no `process.env`; values arrive on the `Env` binding from `wrangler.jsonc`
 * vars (non-secret) and `wrangler secret` (secrets). The shape mirrors the Node server's
 * config so the same code reads it.
 */
export interface Env {
  readonly TRACKER: DurableObjectNamespace;
  readonly ASSETS: Fetcher;

  readonly MODE?: string;
  readonly SIM_INTERVAL_SECONDS?: string;
  readonly SIM_SEED?: string;
  readonly SIM_BACKFILL?: string;
  readonly SIM_BACKFILL_HOURS?: string;
  readonly RETENTION_HOURS?: string;

  readonly SOURCES?: string;
  readonly FEED_URL?: string;
  readonly FEED_NAME?: string;
  readonly FEED_POLL_SECONDS?: string;
  readonly FEED_ITEMS_PATH?: string;
  readonly FEED_MAP_ID?: string;
  readonly FEED_MAP_TIMESTAMP?: string;
  readonly FEED_MAP_TYPE?: string;
  readonly FEED_MAP_DESCRIPTION?: string;
  readonly FEED_MAP_LOCATION?: string;
  readonly FEED_MAP_LAT?: string;
  readonly FEED_MAP_LON?: string;

  readonly PATTERN_WINDOW_MINUTES?: string;
  readonly PATTERN_EPS_KM?: string;
  readonly PATTERN_MIN_POINTS?: string;

  /** Secret. Never reaches the browser. */
  readonly AI_API_KEY?: string;
  readonly AI_PROVIDER?: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
}

export interface FeedFieldMap {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly description: string;
  readonly location: string;
  readonly lat: string;
  readonly lon: string;
}

export interface WorkerConfig {
  readonly mode: AppMode;
  /** Catalogued real feeds to run, by id. */
  readonly sources: readonly string[];
  readonly region: BBox;
  readonly retentionHours: number;
  readonly simulation: {
    readonly intervalSeconds: number;
    readonly seed: string | null;
    readonly backfill: number;
    readonly backfillHours: number;
  };
  readonly feed: {
    readonly enabled: boolean;
    readonly url: string;
    readonly name: string;
    readonly pollSeconds: number;
    readonly itemsPath: string;
    readonly map: FeedFieldMap;
  };
  readonly patterns: {
    readonly windowMinutes: number;
    readonly epsKm: number;
    readonly minPoints: number;
  };
  readonly ai: {
    readonly provider: 'heuristic' | 'openai-compatible';
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
  };
}

const str = (value: string | undefined, fallback = ''): string =>
  value === undefined || value.trim() === '' ? fallback : value.trim();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(str(value));
  return Number.isFinite(parsed) && str(value) !== '' ? parsed : fallback;
};

export function loadWorkerConfig(env: Env): WorkerConfig {
  const feedUrl = str(env.FEED_URL);
  const aiProvider = str(env.AI_PROVIDER, 'heuristic').toLowerCase();

  return {
    mode: str(env.MODE, 'simulation').toLowerCase() === 'live' ? 'live' : 'simulation',
    sources: str(env.SOURCES)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
    region: WASHINGTON_BBOX,
    retentionHours: num(env.RETENTION_HOURS, 168),
    simulation: {
      intervalSeconds: Math.max(1, num(env.SIM_INTERVAL_SECONDS, 20)),
      seed: str(env.SIM_SEED) || null,
      backfill: Math.max(0, num(env.SIM_BACKFILL, 2400)),
      backfillHours: Math.max(1, num(env.SIM_BACKFILL_HOURS, 12)),
    },
    feed: {
      enabled: feedUrl.length > 0,
      url: feedUrl,
      name: str(env.FEED_NAME, 'Public Safety Feed'),
      pollSeconds: Math.max(15, num(env.FEED_POLL_SECONDS, 60)),
      itemsPath: str(env.FEED_ITEMS_PATH),
      map: {
        id: str(env.FEED_MAP_ID, 'id'),
        timestamp: str(env.FEED_MAP_TIMESTAMP, 'timestamp'),
        type: str(env.FEED_MAP_TYPE, 'type'),
        description: str(env.FEED_MAP_DESCRIPTION, 'description'),
        location: str(env.FEED_MAP_LOCATION, 'address'),
        lat: str(env.FEED_MAP_LAT, 'latitude'),
        lon: str(env.FEED_MAP_LON, 'longitude'),
      },
    },
    patterns: {
      windowMinutes: num(env.PATTERN_WINDOW_MINUTES, 45),
      epsKm: num(env.PATTERN_EPS_KM, 0.9),
      minPoints: Math.max(3, num(env.PATTERN_MIN_POINTS, 5)),
    },
    ai: {
      provider: aiProvider === 'openai-compatible' ? 'openai-compatible' : 'heuristic',
      baseUrl: str(env.AI_BASE_URL),
      model: str(env.AI_MODEL),
      apiKey: str(env.AI_API_KEY),
    },
  };
}

/** The only configuration the browser is allowed to see. Contains no secrets. */
export function publicWorkerConfig(config: WorkerConfig) {
  return {
    mode: config.mode,
    region: config.region,
    patterns: config.patterns,
    aiProvider: config.ai.provider,
    feedConfigured: config.feed.enabled || config.sources.length > 0,
    sources: config.sources,
    audioConfigured: false,
    runtime: 'cloudflare-worker' as const,
  };
}

/**
 * Whether simulated history should be primed right now.
 *
 * Extracted so the rule is testable on its own: backfilling thousands of invented
 * records into a LIVE deployment is precisely what the mode indicator exists to prevent,
 * and the guard is easy to break by reordering the mode assignment around it.
 */
export function shouldPrimeSimulation(
  mode: AppMode,
  alreadyPrimed: boolean,
  backfillCount: number,
): boolean {
  if (mode !== 'simulation') return false;
  if (alreadyPrimed) return false;
  return backfillCount > 0;
}
