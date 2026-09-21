/**
 * Upstream fetching for the Worker-side API routes.
 *
 * Three jobs, and nothing else:
 *   1. Keep credentials server-side. The browser only ever talks to this Worker.
 *   2. Cache at the edge, because these upstreams are slow and rate-limited and their data
 *      changes on the order of hours, not milliseconds.
 *   3. Fail in a way the client can render honestly — a named upstream, a reason, and a
 *      timestamp — rather than throwing and leaving the UI to guess.
 */

export interface UpstreamResult<T> {
  ok: boolean;
  data: T | null;
  /** Human-readable source attribution, shown in the UI. */
  source: string;
  /** When this app fetched it. */
  fetchedAt: string;
  /** Why it failed, when it did. */
  error?: string;
  /** True when served from the edge cache rather than the origin. */
  cached?: boolean;
}

export interface UpstreamEnv {
  HORIZONS_URL?: string;
  SBDB_CAD_URL?: string;
  CELESTRAK_GP_URL?: string;
  SWPC_BASE_URL?: string;
  /** Optional; api.nasa.gov falls back to DEMO_KEY, which is heavily rate-limited. */
  NASA_API_KEY?: string;
}

const DEFAULTS: Required<Omit<UpstreamEnv, 'NASA_API_KEY'>> = {
  HORIZONS_URL: 'https://ssd.jpl.nasa.gov/api/horizons.api',
  SBDB_CAD_URL: 'https://ssd-api.jpl.nasa.gov/cad.api',
  CELESTRAK_GP_URL: 'https://celestrak.org/NORAD/elements/gp.php',
  SWPC_BASE_URL: 'https://services.swpc.noaa.gov',
};

export function endpoint(env: UpstreamEnv | undefined, key: keyof typeof DEFAULTS): string {
  return env?.[key] ?? DEFAULTS[key];
}

const TIMEOUT_MS = 9_000;

/**
 * Fetch with an edge cache and a hard timeout.
 *
 * `caches.default` exists on Workers and not in Node, so the lookup is guarded — this same
 * code runs under `astro dev` where there is no edge cache at all.
 */
export async function cachedFetch(
  url: string,
  init: RequestInit & { ttlSeconds: number; accept?: string },
): Promise<{ response: Response; cached: boolean }> {
  const cacheKey = new Request(url, { method: 'GET' });
  // `caches.default` is a Workers extension and is not in the DOM lib's CacheStorage.
  const cache =
    typeof caches !== 'undefined' && 'default' in caches
      ? (caches as unknown as { default: Cache }).default
      : null;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return { response: hit, cached: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // Identify the client honestly; several of these services ask for it.
        'user-agent': 'SPACE-RADAR/0.1 (open-source solar system viewer)',
        accept: init.accept ?? 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (response.ok && cache) {
      const toCache = new Response(response.clone().body, response);
      toCache.headers.set('cache-control', `public, max-age=${init.ttlSeconds}`);
      // Do not await: the response should not wait on the cache write.
      void cache.put(cacheKey, toCache);
    }
    return { response, cached: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Wrap an upstream call into the envelope every /api route returns. */
export async function upstream<T>(
  source: string,
  url: string,
  parse: (r: Response) => Promise<T>,
  ttlSeconds: number,
  accept?: string,
): Promise<UpstreamResult<T>> {
  const fetchedAt = new Date().toISOString();
  try {
    const { response, cached } = await cachedFetch(url, { ttlSeconds, ...(accept ? { accept } : {}) });
    if (!response.ok) {
      return {
        ok: false,
        data: null,
        source,
        fetchedAt,
        error: `${source} returned HTTP ${response.status}`,
      };
    }
    return { ok: true, data: await parse(response), source, fetchedAt, cached };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `${source} did not respond within ${TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : 'unknown error';
    return { ok: false, data: null, source, fetchedAt, error: reason };
  }
}

export function json(body: unknown, ttlSeconds: number, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Let the browser and any CDN in front of this reuse the answer for a while, and
      // serve stale while revalidating so a slow upstream never blocks a load.
      'cache-control': `public, max-age=${Math.floor(ttlSeconds / 2)}, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 4}`,
    },
  });
}
