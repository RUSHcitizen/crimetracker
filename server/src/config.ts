import { WASHINGTON_BBOX, type BBox } from '@crimetracker/shared';

/**
 * All configuration comes from the environment. Nothing here is ever sent to the browser
 * except the small, explicitly-built `publicConfig` object.
 */

/**
 * Readers bound to a specific environment object.
 *
 * `loadConfig` takes the environment as a parameter, so these must read from it rather
 * than reaching for `process.env` directly — otherwise a caller supplying an environment
 * (a test, or an embedder) is silently ignored.
 */
function readers(env: NodeJS.ProcessEnv) {
  const str = (key: string, fallback = ''): string => {
    const value = env[key];
    return value === undefined || value === '' ? fallback : value.trim();
  };

  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const bool = (key: string, fallback = false): boolean => {
    const raw = str(key);
    if (!raw) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  };

  const list = (key: string, fallback: string[] = []): string[] => {
    const raw = str(key);
    if (!raw) return fallback;
    return raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  };

  return { str, num, bool, list };
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

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly corsOrigins: string[];
  readonly databasePath: string;
  readonly retentionHours: number;
  readonly mode: 'live' | 'simulation';
  readonly region: BBox;
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
  readonly ai: {
    readonly provider: 'heuristic' | 'openai-compatible';
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey: string;
    readonly timeoutMs: number;
  };
  readonly audio: {
    readonly enabled: boolean;
    readonly url: string;
    readonly acknowledged: boolean;
    readonly segmentSeconds: number;
    readonly stt: {
      readonly provider: 'null' | 'whisper-http';
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey: string;
    };
  };
  readonly patterns: {
    readonly windowMinutes: number;
    readonly epsKm: number;
    readonly minPoints: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { str, num, bool, list } = readers(env);

  const aiProviderRaw = str('AI_PROVIDER', 'heuristic').toLowerCase();
  const aiProvider = aiProviderRaw === 'openai-compatible' ? 'openai-compatible' : 'heuristic';
  const sttRaw = str('STT_PROVIDER', 'null').toLowerCase();

  const audioUrl = str('PUBLIC_AUDIO_URL');
  const audioAck = bool('PUBLIC_AUDIO_ACK');

  const feedUrl = str('FEED_URL');

  return {
    port: num('PORT', 8787),
    host: str('HOST', '127.0.0.1'),
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173', 'http://127.0.0.1:5173']),
    databasePath: str('DATABASE_PATH', './data/crimetracker.db'),
    retentionHours: num('RETENTION_HOURS', 168),
    mode: str('MODE', 'simulation').toLowerCase() === 'live' ? 'live' : 'simulation',
    region: WASHINGTON_BBOX,
    simulation: {
      intervalSeconds: Math.max(0.5, num('SIM_INTERVAL_SECONDS', 20)),
      seed: str('SIM_SEED') || null,
      backfill: Math.max(0, num('SIM_BACKFILL', 2400)),
      backfillHours: Math.max(1, num('SIM_BACKFILL_HOURS', 12)),
    },
    feed: {
      enabled: feedUrl.length > 0,
      url: feedUrl,
      name: str('FEED_NAME', 'Public Safety Feed'),
      pollSeconds: Math.max(15, num('FEED_POLL_SECONDS', 60)),
      itemsPath: str('FEED_ITEMS_PATH'),
      map: {
        id: str('FEED_MAP_ID', 'id'),
        timestamp: str('FEED_MAP_TIMESTAMP', 'timestamp'),
        type: str('FEED_MAP_TYPE', 'type'),
        description: str('FEED_MAP_DESCRIPTION', 'description'),
        location: str('FEED_MAP_LOCATION', 'address'),
        lat: str('FEED_MAP_LAT', 'latitude'),
        lon: str('FEED_MAP_LON', 'longitude'),
      },
    },
    ai: {
      provider: aiProvider,
      baseUrl: str('AI_BASE_URL'),
      model: str('AI_MODEL'),
      apiKey: str('AI_API_KEY'),
      timeoutMs: num('AI_TIMEOUT_MS', 15000),
    },
    audio: {
      // Both a stream URL *and* an explicit acknowledgement are required. The
      // acknowledgement exists so nobody points this at a feed by accident.
      enabled: audioUrl.length > 0 && audioAck,
      url: audioUrl,
      acknowledged: audioAck,
      segmentSeconds: Math.max(5, num('PUBLIC_AUDIO_SEGMENT_SECONDS', 30)),
      stt: {
        provider: sttRaw === 'whisper-http' ? 'whisper-http' : 'null',
        baseUrl: str('STT_BASE_URL'),
        model: str('STT_MODEL', 'whisper-1'),
        apiKey: str('STT_API_KEY'),
      },
    },
    patterns: {
      windowMinutes: num('PATTERN_WINDOW_MINUTES', 45),
      epsKm: num('PATTERN_EPS_KM', 0.9),
      minPoints: Math.max(3, num('PATTERN_MIN_POINTS', 5)),
    },
  };
}

/** The only configuration the browser is allowed to see. Contains no secrets. */
export function publicConfig(config: Config) {
  return {
    mode: config.mode,
    region: config.region,
    patterns: config.patterns,
    aiProvider: config.ai.provider,
    // Booleans only — never URLs or keys.
    feedConfigured: config.feed.enabled,
    audioConfigured: config.audio.enabled,
  };
}
