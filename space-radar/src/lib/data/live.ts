import { RADIUS } from '../astro/constants';
import { parseTle, parseTleText, sgp4Init } from '../astro/sgp4';
import type { State } from '../astro/kepler';
import type { CloseApproach, Provenance, SpaceObject } from './types';

/**
 * Live data.
 *
 * Everything here is optional. The app is fully usable with the network unplugged — the
 * planets, the Moon and the Lagrange points are computed locally and the small-body orbits
 * are baked in. What this module adds is the stuff that genuinely cannot be computed:
 * where the satellites are right now, where JPL says the probes are, and what is about to
 * pass close to Earth.
 *
 * Every failure is reported rather than swallowed. `LiveStatus` is rendered in the DATA
 * panel so it is always visible which feeds are up and how old their answers are.
 */

export interface LiveEnvelope<T> {
  ok: boolean;
  data: T | null;
  source: string;
  fetchedAt: string;
  error?: string;
  cached?: boolean;
  attribution?: string;
  limitations?: string;
}

export interface FeedStatus {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fetchedAt?: string;
  attribution?: string;
  limitations?: string;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<LiveEnvelope<T>> {
  try {
    const init: RequestInit = signal ? { signal } : {};
    const res = await fetch(url, init);
    const body = (await res.json()) as LiveEnvelope<T>;
    return body;
  } catch (err) {
    return {
      ok: false,
      data: null,
      source: url,
      fetchedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'request failed',
    };
  }
}

const liveProvenance = (source: string, epoch: string, cadence: string, accuracy: string, limitations: string): Provenance => ({
  tier: 'live',
  source,
  epoch,
  cadence,
  accuracy,
  limitations,
});

// ---------------------------------------------------------------------------
// Satellites
// ---------------------------------------------------------------------------

/** How many satellites to actually put on screen. More than this and a phone suffers. */
const SATELLITE_BUDGET = 60;

/** Well-known objects that should survive the budget cut whatever else is in the group. */
const PRIORITY = [/ISS/i, /ZARYA/i, /TIANGONG/i, /CSS /i, /HUBBLE/i, /HST/i, /NOAA/i, /LANDSAT/i, /SENTINEL/i];

export async function fetchSatellites(
  group = 'stations',
  signal?: AbortSignal,
): Promise<{ objects: SpaceObject[]; status: FeedStatus }> {
  const env = await getJson<string>(`/api/tle?group=${encodeURIComponent(group)}`, signal);

  if (!env.ok || !env.data) {
    return {
      objects: [],
      status: {
        id: 'tle',
        label: 'ORBITAL ELEMENTS',
        ok: false,
        detail: env.error ?? 'unavailable',
        ...(env.attribution ? { attribution: env.attribution } : {}),
      },
    };
  }

  const records = parseTleText(env.data);
  const objects: SpaceObject[] = [];
  let deepSpaceSkipped = 0;
  let unparsed = 0;

  // Sort so the interesting things survive the budget.
  const ranked = records
    .map((r) => ({ r, score: PRIORITY.findIndex((p) => p.test(r.name)) }))
    .sort((a, b) => (a.score < 0 ? 99 : a.score) - (b.score < 0 ? 99 : b.score));

  for (const { r } of ranked) {
    if (objects.length >= SATELLITE_BUDGET) break;
    const fields = parseTle(r.line1, r.line2);
    if (!fields) {
      unparsed++;
      continue;
    }
    const sat = sgp4Init(r.name, fields);
    if (sat.deepSpace) {
      // Honest refusal: this build has no SDP4, so these are not drawn at all.
      deepSpaceSkipped++;
      continue;
    }

    const epochIso = new Date((sat.epochJd - 2440587.5) * 86400000).toISOString();
    const ageHours = (Date.now() - new Date(epochIso).getTime()) / 3600000;

    objects.push({
      id: `sat-${sat.noradId}`,
      name: r.name.toUpperCase(),
      subtitle: `NORAD ${sat.noradId} · TLE ${ageHours < 48 ? `${ageHours.toFixed(0)} h old` : `${(ageHours / 24).toFixed(1)} d old`}`,
      kind: 'satellite',
      parent: 'earth',
      radiusKm: 0.02,
      color: PRIORITY.some((p) => p.test(r.name)) ? '#9fd4ff' : '#6d8ba3',
      weight: PRIORITY.some((p) => p.test(r.name)) ? 0.75 : 0.22,
      provenance: liveProvenance(
        'CelesTrak GP — public US Space Force catalogue',
        epochIso,
        'CelesTrak regenerates element sets several times a day',
        'Kilometres near epoch, degrading roughly linearly with time since epoch.',
        `Propagated with SGP4 from mean elements ${ageHours.toFixed(0)} hours old. Not a precision ephemeris; do not use for conjunction analysis.`,
      ),
      ephemeris: { kind: 'tle', satellite: sat },
      tags: ['satellite', 'live'],
      status: 'TRACKED — LIVE ELEMENT SET',
      facts: [
        { label: 'Period', value: `${sat.periodMinutes.toFixed(1)} min` },
        { label: 'Inclination', value: `${((sat.inclination * 180) / Math.PI).toFixed(2)}°` },
        { label: 'Element set epoch', value: epochIso.slice(0, 16).replace('T', ' ') + 'Z' },
        { label: 'Revolution number', value: sat.revNumber.toLocaleString('en-US') },
      ],
    });
  }

  const notes: string[] = [`${objects.length} of ${records.length} propagated`];
  if (deepSpaceSkipped > 0) notes.push(`${deepSpaceSkipped} deep-space objects skipped (no SDP4)`);
  if (unparsed > 0) notes.push(`${unparsed} malformed`);

  return {
    objects,
    status: {
      id: 'tle',
      label: 'ORBITAL ELEMENTS',
      ok: true,
      detail: notes.join(' · '),
      fetchedAt: env.fetchedAt,
      ...(env.attribution ? { attribution: env.attribution } : {}),
      ...(env.limitations ? { limitations: env.limitations } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Deep-space probe vectors
// ---------------------------------------------------------------------------

export interface HorizonsVector {
  target: string;
  name: string;
  jd: number;
  position: [number, number, number];
  velocity: [number, number, number];
}

/**
 * Upgrade a probe from the built-in radiant approximation to a real JPL state vector.
 * Returns a patch the caller applies to the catalogue entry.
 */
export async function fetchProbeVector(
  targetId: string,
  signal?: AbortSignal,
): Promise<{ id: string; state: State; epoch: number; provenance: Provenance } | null> {
  const env = await getJson<HorizonsVector>(`/api/horizons?target=${encodeURIComponent(targetId)}`, signal);
  if (!env.ok || !env.data) return null;

  const { position, velocity, jd } = env.data;
  if (![...position, ...velocity, jd].every(Number.isFinite)) return null;

  return {
    id: targetId,
    state: { position, velocity },
    epoch: jd,
    provenance: liveProvenance(
      'NASA/JPL Horizons on-line ephemeris system',
      new Date((jd - 2440587.5) * 86400000).toISOString(),
      'Horizons serves mission-supplied trajectory files; these change rarely for the interstellar probes',
      'The state vector itself is JPL’s own solution and is accurate. This app then propagates it on a two-body conic.',
      'Two-body propagation away from the fetched epoch. Excellent for an escaping probe, poor near a planet.',
    ),
  };
}

// ---------------------------------------------------------------------------
// Close approaches
// ---------------------------------------------------------------------------

interface CadRow {
  designation: string;
  fullName: string;
  closeApproach: string;
  distanceAu: number;
  relativeVelocityKmS: number;
  absoluteMagnitude: number | null;
  diameterKm: number | null;
}

/** Estimated diameter range from absolute magnitude, for the common albedo range 0.05–0.25. */
function diameterFromMagnitude(h: number): [number, number] {
  const d = (albedo: number) => (1329 / Math.sqrt(albedo)) * Math.pow(10, -0.2 * h) * 1000;
  return [d(0.25), d(0.05)];
}

export async function fetchCloseApproaches(
  signal?: AbortSignal,
): Promise<{ approaches: CloseApproach[]; status: FeedStatus }> {
  const env = await getJson<CadRow[]>('/api/close-approaches?days=120&dist=0.05', signal);

  if (!env.ok || !env.data) {
    return {
      approaches: [],
      status: {
        id: 'cad',
        label: 'CLOSE APPROACHES',
        ok: false,
        detail: env.error ?? 'unavailable',
        ...(env.attribution ? { attribution: env.attribution } : {}),
      },
    };
  }

  const approaches: CloseApproach[] = env.data
    .map((row) => {
      const parsed = Date.parse(row.closeApproach.replace(/-/g, ' '));
      const jd = Number.isFinite(parsed) ? parsed / 86400000 + 2440587.5 : NaN;
      const out: CloseApproach = {
        designation: row.designation,
        fullName: row.fullName,
        jd,
        distAu: row.distanceAu,
        vRelKmS: row.relativeVelocityKmS,
      };
      if (row.diameterKm != null && Number.isFinite(row.diameterKm)) {
        out.diameterM = [row.diameterKm * 1000, row.diameterKm * 1000];
      } else if (row.absoluteMagnitude != null && Number.isFinite(row.absoluteMagnitude)) {
        out.diameterM = diameterFromMagnitude(row.absoluteMagnitude);
      }
      if (row.absoluteMagnitude != null) out.magnitude = row.absoluteMagnitude;
      return out;
    })
    .filter((a) => Number.isFinite(a.jd) && Number.isFinite(a.distAu))
    .sort((a, b) => a.jd - b.jd);

  return {
    approaches,
    status: {
      id: 'cad',
      label: 'CLOSE APPROACHES',
      ok: true,
      detail: `${approaches.length} within 0.05 AU over the next 120 days`,
      fetchedAt: env.fetchedAt,
      ...(env.attribution ? { attribution: env.attribution } : {}),
      ...(env.limitations ? { limitations: env.limitations } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Space weather
// ---------------------------------------------------------------------------

export interface SpaceWeather {
  timeTag: string;
  kp: number;
  stormLevel: string;
  recent: number[];
}

export async function fetchSpaceWeather(
  signal?: AbortSignal,
): Promise<{ weather: SpaceWeather | null; status: FeedStatus }> {
  const env = await getJson<SpaceWeather>('/api/space-weather', signal);
  return {
    weather: env.ok ? env.data : null,
    status: {
      id: 'swpc',
      label: 'GEOMAGNETIC',
      ok: env.ok,
      detail: env.ok && env.data ? `Kp ${env.data.kp.toFixed(2)} · ${env.data.stormLevel}` : (env.error ?? 'unavailable'),
      ...(env.fetchedAt ? { fetchedAt: env.fetchedAt } : {}),
      ...(env.attribution ? { attribution: env.attribution } : {}),
      ...(env.limitations ? { limitations: env.limitations } : {}),
    },
  };
}

/** Earth radius, re-exported so the live layer's altitude maths matches the catalogue's. */
export const EARTH_RADIUS_KM = RADIUS.earth;
