import type { APIRoute } from 'astro';
import { endpoint, json, upstream, type UpstreamEnv } from '../../lib/server/upstream';

export const prerender = false;

/**
 * Upcoming close approaches to Earth, from JPL's CAD service.
 *
 * SOURCE      NASA/JPL Solar System Dynamics — Close Approach Data API. No key required.
 * CADENCE     Recomputed as orbits are refined; daily is generous.
 * TTL         6 hours.
 * LIMITATIONS These are JPL's own integrated solutions, and are far more accurate than the
 *             two-body model this app uses to draw the orbits. The app shows them as
 *             published numbers rather than deriving them itself, and says so.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: UpstreamEnv } }).runtime?.env;

  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 60)));
  const maxDistAu = Math.min(0.5, Math.max(0.0005, Number(url.searchParams.get('dist') ?? 0.05)));

  const params = new URLSearchParams({
    'date-min': 'now',
    'date-max': `+${days}`,
    'dist-max': String(maxDistAu),
    sort: 'dist',
    'diameter': 'true',
    limit: '60',
  });

  const result = await upstream(
    'JPL CAD',
    `${endpoint(env, 'SBDB_CAD_URL')}?${params}`,
    async (r) => {
      const body = (await r.json()) as { fields?: string[]; data?: string[][] };
      if (!body.fields || !body.data) return [];
      const idx = (name: string) => body.fields!.indexOf(name);
      const iDes = idx('des');
      const iCd = idx('cd');
      const iDist = idx('dist');
      const iVrel = idx('v_rel');
      const iH = idx('h');
      const iDiameter = idx('diameter');
      const iFullname = idx('fullname');

      return body.data.map((row) => ({
        designation: row[iDes] ?? '',
        fullName: (iFullname >= 0 ? row[iFullname] : null)?.trim() || (row[iDes] ?? ''),
        // CAD dates look like "2026-Oct-04 13:22"; keep the raw form and a parsed one.
        closeApproach: row[iCd] ?? '',
        distanceAu: Number(row[iDist] ?? NaN),
        relativeVelocityKmS: Number(row[iVrel] ?? NaN),
        absoluteMagnitude: iH >= 0 ? Number(row[iH]) : null,
        diameterKm: iDiameter >= 0 && row[iDiameter] ? Number(row[iDiameter]) : null,
      }));
    },
    21600,
  );

  return json(
    {
      ...result,
      attribution: 'NASA/JPL Solar System Dynamics — Close Approach Data (ssd-api.jpl.nasa.gov)',
      limitations:
        "These distances come from JPL's numerically integrated orbits, not from this app's two-body model. Where the two disagree, JPL is right.",
    },
    21600,
    result.ok ? 200 : 502,
  );
};
