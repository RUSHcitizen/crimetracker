import type { APIRoute } from 'astro';
import { endpoint, json, upstream, type UpstreamEnv } from '../../lib/server/upstream';

export const prerender = false;

/**
 * Two-line element sets from CelesTrak.
 *
 * SOURCE      CelesTrak GP data (Dr T.S. Kelso), which republishes the public
 *             Space-Track catalogue.
 * CADENCE     CelesTrak regenerates these several times a day.
 * TTL         30 minutes at the edge. TLE epochs are hours old at best, so a fresher fetch
 *             buys nothing and only burns the upstream's goodwill.
 * LIMITATIONS SGP4 error grows away from the element set's epoch. The client shows the age
 *             of every element set it propagates.
 */

const ALLOWED_GROUPS = new Set([
  'stations',
  'visual',
  'active',
  'science',
  'geo',
  'gps-ops',
  'weather',
  'starlink',
  'last-30-days',
]);

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: UpstreamEnv } }).runtime?.env;
  const group = url.searchParams.get('group') ?? 'stations';

  // Allow-list rather than passthrough: this route must not become an open proxy.
  if (!ALLOWED_GROUPS.has(group)) {
    return json({ ok: false, data: null, source: 'CelesTrak', error: `unknown group "${group}"`, fetchedAt: new Date().toISOString() }, 60, 400);
  }

  const target = `${endpoint(env, 'CELESTRAK_GP_URL')}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const result = await upstream(
    'CelesTrak GP',
    target,
    async (r) => {
      const text = await r.text();
      // CelesTrak answers rate limits with a 200 and a plain-text apology.
      if (!/^1 \d{5}/m.test(text)) throw new Error('CelesTrak returned no element sets (rate limited?)');
      return text;
    },
    1800,
    'text/plain',
  );

  return json(
    {
      ...result,
      group,
      attribution: 'CelesTrak (celestrak.org) — republished from the public US Space Force catalogue',
      limitations: 'SGP4 mean elements. Accuracy degrades with time since epoch; deep-space objects (period ≥ 225 min) are not propagated by this app.',
    },
    1800,
    result.ok ? 200 : 502,
  );
};
