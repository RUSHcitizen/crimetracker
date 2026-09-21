import type { APIRoute } from 'astro';
import { endpoint, json, upstream, type UpstreamEnv } from '../../lib/server/upstream';

export const prerender = false;

/**
 * State vectors for deep-space spacecraft, from JPL Horizons.
 *
 * SOURCE      NASA/JPL Horizons on-line ephemeris system. No key required.
 * CADENCE     Horizons serves from mission-supplied trajectory files; for the interstellar
 *             probes these change rarely, so a 12-hour cache is conservative.
 * TTL         12 hours.
 * WHY         The built-in catalogue models Voyager and friends as a direction and a speed,
 *             which is what their public mission pages publish. When this route succeeds,
 *             the client replaces that approximation with a real heliocentric state vector
 *             and flips the object's provenance tier from `catalog` to `live`.
 *
 * Only the bodies in TARGETS can be requested — this must not become an open proxy, and
 * Horizons is a shared public resource.
 */
const TARGETS: Record<string, { id: string; name: string }> = {
  'voyager-1': { id: '-31', name: 'Voyager 1' },
  'voyager-2': { id: '-32', name: 'Voyager 2' },
  'pioneer-10': { id: '-23', name: 'Pioneer 10' },
  'pioneer-11': { id: '-24', name: 'Pioneer 11' },
  'new-horizons': { id: '-98', name: 'New Horizons' },
  'parker-solar-probe': { id: '-96', name: 'Parker Solar Probe' },
  jwst: { id: '-170', name: 'James Webb Space Telescope' },
};

/**
 * Horizons returns a fixed-format text block between $$SOE and $$EOE. Each record is three
 * lines: the epoch, then X/Y/Z, then VX/VY/VZ, in km and km/s.
 */
function parseVectors(text: string): { jd: number; position: [number, number, number]; velocity: [number, number, number] } | null {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) return null;

  const block = text.slice(start + 5, end).trim();
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  const jd = Number.parseFloat(lines[0]!.split('=')[0]!.trim());
  const num = (line: string, key: string): number | null => {
    const m = line.match(new RegExp(`${key}\\s*=\\s*(-?[\\d.]+E?[+-]?\\d*)`, 'i'));
    return m ? Number.parseFloat(m[1]!) : null;
  };

  const x = num(lines[1]!, 'X');
  const y = num(lines[1]!, 'Y');
  const z = num(lines[1]!, 'Z');
  const vx = num(lines[2]!, 'VX');
  const vy = num(lines[2]!, 'VY');
  const vz = num(lines[2]!, 'VZ');

  if ([jd, x, y, z, vx, vy, vz].some((v) => v === null || !Number.isFinite(v))) return null;
  return { jd, position: [x!, y!, z!], velocity: [vx!, vy!, vz!] };
}

export const GET: APIRoute = async ({ url, locals }) => {
  const env = (locals as { runtime?: { env?: UpstreamEnv } }).runtime?.env;
  const key = url.searchParams.get('target') ?? '';
  const target = TARGETS[key];

  if (!target) {
    return json(
      {
        ok: false,
        data: null,
        source: 'JPL Horizons',
        fetchedAt: new Date().toISOString(),
        error: `unknown target "${key}"`,
        available: Object.keys(TARGETS),
      },
      60,
      400,
    );
  }

  // One record at today's date, heliocentric (centre 500@10 is the Sun), ecliptic frame.
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const stop = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    format: 'text',
    COMMAND: `'${target.id}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: "'500@10'",
    REF_PLANE: 'ECLIPTIC',
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: "'1 d'",
    VEC_TABLE: '2',
    OUT_UNITS: 'KM-S',
  });

  const result = await upstream(
    'JPL Horizons',
    `${endpoint(env, 'HORIZONS_URL')}?${params}`,
    async (r) => {
      const text = await r.text();
      const vectors = parseVectors(text);
      if (!vectors) throw new Error('Horizons response contained no vector block');
      return { target: key, name: target.name, horizonsId: target.id, ...vectors };
    },
    43200,
    'text/plain',
  );

  return json(
    {
      ...result,
      attribution: 'NASA/JPL Horizons on-line ephemeris system (ssd.jpl.nasa.gov/horizons)',
      frame: 'Heliocentric, J2000 ecliptic, km and km/s',
      limitations:
        'A single state vector. This app then propagates it on a two-body conic, which is excellent for an escaping probe far from any planet and poor near one.',
    },
    43200,
    result.ok ? 200 : 502,
  );
};
