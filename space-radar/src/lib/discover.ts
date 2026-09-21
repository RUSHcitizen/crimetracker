import { AU_KM, C_KM_S } from './astro/constants';
import { periodDays } from './astro/kepler';
import { moonGeocentric, moonPhase } from './astro/moon';
import { distance, length, scale, sub } from './astro/vec';
import type { ResolvedObject } from './data/types';
import type { World } from './sim/world';
import { formatDistanceInline, formatDuration, formatSpeed } from './format';
import { constellationHint } from './render/stars';

/**
 * SURPRISE ME.
 *
 * Picks something worth looking at and says something true about it, measured from the
 * current state rather than written down in advance. Every line here is generated from
 * the same numbers the object panel shows, so a fact can never drift out of step with the
 * simulation — and pressing the button at a different time genuinely gives you a different
 * answer.
 */

export interface Discovery {
  objectId: string;
  headline: string;
  detail: string;
  /** How far out to frame the object when flying to it. */
  distanceKm?: number;
}

type Candidate = (world: World, jd: number, resolved: ResolvedObject[]) => Discovery | null;

/**
 * How often each candidate should come up, relative to the others.
 *
 * Not uniform: "this demo satellite is not real" is a point worth making, but it is a poor
 * thing to land on the first time somebody presses the button. Weighting keeps the
 * marquee discoveries near the front without ever making the order predictable.
 */
const WEIGHTS = [5, 4, 4, 4, 4, 4, 3, 4, 1, 3, 3];

function weightedShuffle(items: Candidate[]): Candidate[] {
  // Efraimidis-Spirakis: sort by u^(1/w), which samples without replacement in proportion
  // to the weights.
  return items
    .map((candidate, i) => ({ candidate, key: Math.pow(Math.random(), 1 / (WEIGHTS[i] ?? 3)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.candidate);
}

const byId = (resolved: ResolvedObject[], id: string) => resolved.find((r) => r.object.id === id);

const placed = (resolved: ResolvedObject[]) => resolved.filter((r) => !r.unplaced);

const CANDIDATES: Candidate[] = [
  // The farthest human-made object.
  (world, jd, resolved) => {
    const earth = byId(resolved, 'earth');
    if (!earth) return null;
    const craft = placed(resolved).filter((r) => r.object.kind === 'spacecraft');
    if (craft.length === 0) return null;
    const far = craft.reduce((a, b) =>
      distance(a.position, earth.position) > distance(b.position, earth.position) ? a : b,
    );
    const km = distance(far.position, earth.position);
    const delay = km / C_KM_S;
    return {
      objectId: far.object.id,
      headline: `You found ${far.object.name}.`,
      detail: `It is ${formatDistanceInline(km)} from Earth — farther than anything else this instrument is tracking. A command sent now arrives in ${formatDuration(delay / 86400)}, and the reply takes just as long to come back.`,
      distanceKm: 300_000,
    };
  },

  // The fastest thing on the board.
  (_world, _jd, resolved) => {
    const real = placed(resolved).filter((r) => r.object.provenance.tier !== 'simulated' && r.object.id !== 'sun');
    if (real.length === 0) return null;
    const fast = real.reduce((a, b) => (length(a.velocity) > length(b.velocity) ? a : b));
    const v = length(fast.velocity);
    return {
      objectId: fast.object.id,
      headline: `${fast.object.name} is moving at ${formatSpeed(v)}.`,
      detail: `That is ${((v / C_KM_S) * 100).toFixed(3)}% of the speed of light, or about ${Math.round(v * 3600).toLocaleString('en-US')} km/h. Everything in orbit trades distance for speed: the closer you fall toward the Sun, the faster you have to move to stay on a path at all.`,
    };
  },

  // An object on its way out of the Solar System for good.
  (_world, jd, resolved) => {
    const unbound = placed(resolved).filter(
      (r) => r.object.ephemeris.kind === 'elements' && r.object.ephemeris.elements.e >= 1,
    );
    if (unbound.length === 0) return null;
    const pick = unbound[Math.floor(Math.random() * unbound.length)]!;
    const el = pick.object.ephemeris.kind === 'elements' ? pick.object.ephemeris.elements : null;
    void jd;
    return {
      objectId: pick.object.id,
      headline: `${pick.object.name} is never coming back.`,
      detail: `Its orbit has an eccentricity of ${el ? el.e.toFixed(3) : '>1'} — an open curve, not a loop. It fell in from interstellar space, swung once around the Sun, and is now leaving at a speed the Sun can no longer take back. It is currently ${formatDistanceInline(length(pick.position))} out.`,
    };
  },

  // The Moon's phase, right now, in the simulation.
  (world, jd) => {
    const moonGeo = moonGeocentric(jd);
    const earth = world.state('earth', jd).position;
    const sunGeo = scale(earth, -1);
    const phase = moonPhase(moonGeo, sunGeo);
    const pct = phase.illuminated * 100;
    const name =
      pct < 2 ? 'a new moon — effectively invisible'
        : pct > 98 ? 'a full moon'
        : pct < 48 ? (phase.angle > 0 ? 'a waxing crescent' : 'a waning crescent')
        : pct < 52 ? 'a half moon, at first or last quarter'
        : (phase.angle > 0 ? 'a waxing gibbous' : 'a waning gibbous');
    return {
      objectId: 'moon',
      headline: `The Moon is ${pct.toFixed(1)}% lit right now.`,
      detail: `That makes it ${name}. It is ${formatDistanceInline(length(moonGeo))} away, and it is drifting outward by about 3.8 cm every year — which means total solar eclipses will eventually stop happening altogether.`,
      distanceKm: 12_000,
    };
  },

  // Whichever planet is closest to Earth at this instant — which is not the one people expect.
  (world, jd, resolved) => {
    const earth = byId(resolved, 'earth');
    if (!earth) return null;
    const planets = placed(resolved).filter((r) => r.object.kind === 'planet' && r.object.id !== 'earth');
    if (planets.length === 0) return null;
    const near = planets.reduce((a, b) =>
      distance(a.position, earth.position) < distance(b.position, earth.position) ? a : b,
    );
    const km = distance(near.position, earth.position);
    void world;
    void jd;
    return {
      objectId: near.object.id,
      headline: `${near.object.name} is our closest planetary neighbour today.`,
      detail: `It is ${formatDistanceInline(km)} away — ${formatDuration(km / C_KM_S / 86400)} at the speed of light. Scrub time forward a few months and a different planet takes the title; the answer changes constantly, which is why "the closest planet to Earth" has no single correct answer.`,
    };
  },

  // A small body with an interesting close approach in its future.
  (world, jd, resolved) => {
    const earth = byId(resolved, 'earth');
    const neo = byId(resolved, 'apophis');
    if (!earth || !neo || neo.unplaced) return null;

    // Measure the closest approach this model predicts over the next decade.
    let best = Infinity;
    let bestJd = jd;
    for (let t = jd; t < jd + 365.25 * 12; t += 1) {
      const d = distance(world.resolve(neo.object, t).position, world.state('earth', t).position);
      if (d < best) {
        best = d;
        bestJd = t;
      }
    }
    world.resolveAll(jd);
    const date = new Date((bestJd - 2440587.5) * 86400000).toISOString().slice(0, 10);
    return {
      objectId: 'apophis',
      headline: 'This asteroid makes an unusually close approach.',
      detail: `Apophis is 370 m across. On 13 April 2029 it passes about 31 600 km from Earth — inside the ring of geostationary satellites, and bright enough to see without a telescope. This app's own two-body model puts its closest pass near ${date} at ${formatDistanceInline(best)}, which shows you exactly how far a single unperturbed conic drifts from reality over years.`,
      distanceKm: 400_000,
    };
  },

  // Something with an extreme orbit.
  (_world, _jd, resolved) => {
    const candidates = placed(resolved).filter(
      (r) =>
        r.object.provenance.tier !== 'simulated' &&
        r.object.ephemeris.kind === 'elements' &&
        r.object.ephemeris.elements.e > 0.5 &&
        r.object.ephemeris.elements.e < 1,
    );
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)]!;
    const el = pick.object.ephemeris.kind === 'elements' ? pick.object.ephemeris.elements : null;
    if (!el) return null;
    const p = periodDays(el);
    return {
      objectId: pick.object.id,
      headline: `${pick.object.name} swings between two very different worlds.`,
      detail: `Its closest approach to the Sun is ${(el.a * (1 - el.e) / AU_KM).toFixed(3)} AU and its farthest is ${(el.a * (1 + el.e) / AU_KM).toFixed(2)} AU${p ? `, on a ${formatDuration(p)} loop` : ''}. At perihelion it is moving several times faster than at aphelion — that is Kepler's second law, and you can watch it happen by running time forward.`,
    };
  },

  // Direction: where an interstellar probe is actually headed.
  (_world, _jd, resolved) => {
    const probes = placed(resolved).filter((r) => r.object.ephemeris.kind === 'radiant');
    if (probes.length === 0) return null;
    const pick = probes[Math.floor(Math.random() * probes.length)]!;
    const eph = pick.object.ephemeris;
    if (eph.kind !== 'radiant') return null;
    return {
      objectId: pick.object.id,
      headline: `${pick.object.name} is aimed at ${constellationHint(eph.raDeg, eph.decDeg)}.`,
      detail: `It is travelling at ${eph.kmPerSec.toFixed(2)} km/s and is ${formatDistanceInline(length(pick.position))} from the Sun. At that speed it would take roughly ${Math.round((4.24 * 9.461e12) / (eph.kmPerSec * 3.156e7)).toLocaleString('en-US')} years to cover the distance to the nearest star — and it is not pointed at one.`,
      distanceKm: 300_000,
    };
  },

  // A reminder about what is real in here.
  (_world, _jd, resolved) => {
    const sim = resolved.filter((r) => r.object.provenance.tier === 'simulated');
    if (sim.length === 0) return null;
    const pick = sim[Math.floor(Math.random() * sim.length)]!;
    return {
      objectId: pick.object.id,
      headline: `${pick.object.name} does not exist.`,
      detail: `${pick.object.provenance.accuracy} It is here so the orbital shell has something in it when no live element set is available. Every panel in this app names its source — if the tier says SIMULATED, nothing in the sky matches it.`,
      distanceKm: 3_000,
    };
  },

  // Scale, which never stops being surprising.
  (_world, _jd, resolved) => {
    const jupiter = byId(resolved, 'jupiter');
    const sun = byId(resolved, 'sun');
    if (!jupiter || !sun) return null;
    return {
      objectId: 'jupiter',
      headline: 'Jupiter is not quite the centre of anything.',
      detail: `It holds more than twice the mass of every other planet combined, and its sphere of influence — the region where its gravity beats the Sun's — is ${formatDistanceInline(jupiter.object.soiKm ?? 48e6)} across. Turn on the GRAVITY layer to see those boundaries drawn where they actually fall.`,
      distanceKm: 900_000,
    };
  },

  // Where the light you are seeing came from.
  (_world, _jd, resolved) => {
    const outer = placed(resolved).filter((r) => r.object.kind === 'planet' && length(r.position) > 4 * AU_KM);
    if (outer.length === 0) return null;
    const pick = outer[Math.floor(Math.random() * outer.length)]!;
    const earth = byId(resolved, 'earth');
    if (!earth) return null;
    const km = distance(pick.position, earth.position);
    return {
      objectId: pick.object.id,
      headline: `You are looking at ${pick.object.name} as it was ${formatDuration(km / C_KM_S / 86400)} ago.`,
      detail: `Light from it takes that long to reach Earth, so no telescope anywhere can show you where it is now — only where it was. The marker in this app shows the computed present-time position, which is a different thing from what you would see through an eyepiece.`,
    };
  },
];

/** Pick a discovery, avoiding an immediate repeat. */
export function discover(world: World, jd: number, lastObjectId: string | null): Discovery | null {
  const resolved = world.resolveAll(jd);
  const order = weightedShuffle(CANDIDATES);

  let fallback: Discovery | null = null;
  for (const candidate of order) {
    let result: Discovery | null = null;
    try {
      result = candidate(world, jd, resolved);
    } catch {
      // A candidate that cannot be evaluated at this instant is skipped, not fatal.
      continue;
    }
    if (!result) continue;
    if (result.objectId !== lastObjectId) return result;
    fallback = result;
  }
  return fallback;
}

export { sub as discoverSub };
