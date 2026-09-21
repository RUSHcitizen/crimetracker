import type { APIRoute } from 'astro';
import { endpoint, json, upstream, type UpstreamEnv } from '../../lib/server/upstream';

export const prerender = false;

/**
 * Current geomagnetic activity, from NOAA's Space Weather Prediction Center.
 *
 * SOURCE      NOAA SWPC planetary K-index, 1-minute product. No key required.
 * CADENCE     Updated every minute; the index itself is a 3-hour running estimate.
 * TTL         5 minutes.
 * WHY         It is the one genuinely live, changing number in the whole instrument, and it
 *             is the reason the status strip is not just decoration.
 */
export const GET: APIRoute = async ({ locals }) => {
  const env = (locals as { runtime?: { env?: UpstreamEnv } }).runtime?.env;
  const target = `${endpoint(env, 'SWPC_BASE_URL')}/json/planetary_k_index_1m.json`;

  const result = await upstream(
    'NOAA SWPC',
    target,
    async (r) => {
      const rows = (await r.json()) as { time_tag: string; kp_index: number; estimated_kp?: number }[];
      const last = rows[rows.length - 1];
      if (!last) throw new Error('SWPC returned an empty series');
      const kp = Number(last.estimated_kp ?? last.kp_index);
      return {
        timeTag: last.time_tag,
        kp,
        // NOAA's own G-scale thresholds.
        stormLevel: kp >= 9 ? 'G5' : kp >= 8 ? 'G4' : kp >= 7 ? 'G3' : kp >= 6 ? 'G2' : kp >= 5 ? 'G1' : 'QUIET',
        recent: rows.slice(-48).map((r2) => Number(r2.estimated_kp ?? r2.kp_index)),
      };
    },
    300,
  );

  return json(
    {
      ...result,
      attribution: 'NOAA Space Weather Prediction Center (services.swpc.noaa.gov)',
      limitations: 'Planetary K-index is a 3-hour global average estimated in near real time and revised later.',
    },
    300,
    result.ok ? 200 : 502,
  );
};
