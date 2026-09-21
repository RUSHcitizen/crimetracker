import { AU_KM, DEG, GM, RADIUS } from '../astro/constants';
import { positionFromElements, type Elements } from '../astro/kepler';
import type { Vec3 } from '../astro/vec';
import { PROVENANCE } from './catalog';
import type { SpaceObject } from './types';

/**
 * Simulated populations.
 *
 * NOTHING IN THIS FILE IS A REAL OBJECT.
 *
 * The asteroid belt really does contain millions of bodies, and low Earth orbit really
 * does contain thousands. Shipping either as real data would mean either a huge download
 * or a pile of fabricated catalogue entries. Instead this generates populations whose
 * *statistics* match the published ones — the Kirkwood gaps are in the right places, the
 * Trojans sit at the right Lagrange points, the orbital shells are at the right altitudes
 * and inclinations — from a fixed seed, and labels every one of them `simulated`.
 *
 * Real objects come from the catalogue and from the live feeds. These are scenery, and
 * the UI says so wherever they appear.
 */

/** Deterministic PRNG so the same "sky" comes back on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rayleigh-distributed draw — the shape real eccentricity and inclination follow. */
const rayleigh = (rng: () => number, sigma: number): number =>
  sigma * Math.sqrt(-2 * Math.log(1 - rng()));

export interface ParticleCloud {
  id: string;
  label: string;
  /** Elements for each particle; positions are evaluated per frame. */
  elements: Elements[];
  color: string;
  /** Point size in pixels at the reference scale. */
  pointSize: number;
  note: string;
}

const KIRKWOOD_GAPS: ReadonlyArray<[number, number]> = [
  [2.502, 0.02], // 3:1
  [2.825, 0.015], // 5:2
  [2.958, 0.012], // 7:3
  [3.279, 0.02], // 2:1
];

function inKirkwoodGap(a: number): boolean {
  return KIRKWOOD_GAPS.some(([centre, halfWidth]) => Math.abs(a - centre) < halfWidth);
}

/** Main-belt scenery: a-distribution with the real resonance gaps carved out. */
export function makeMainBelt(count = 900, seed = 0x5eed): ParticleCloud {
  const rng = mulberry32(seed);
  const elements: Elements[] = [];
  let guard = 0;
  while (elements.length < count && guard++ < count * 20) {
    // Weighted toward the middle belt, where the real number density peaks.
    const a = 2.06 + Math.pow(rng(), 0.85) * 1.29;
    if (inKirkwoodGap(a)) continue;
    elements.push({
      a: a * AU_KM,
      e: Math.min(0.35, rayleigh(rng, 0.07)),
      i: Math.min(30 * DEG, rayleigh(rng, 8 * DEG)),
      om: rng() * Math.PI * 2,
      w: rng() * Math.PI * 2,
      m0: rng() * Math.PI * 2,
      epoch: 2451545.0,
      mu: GM.sun,
    });
  }
  return {
    id: 'main-belt',
    label: 'MAIN BELT',
    elements,
    color: '#6f6a62',
    pointSize: 1.6,
    note: 'Simulated population. Semi-major axis distribution and Kirkwood gaps follow the real belt; individual bodies are fictitious.',
  };
}

/** Jupiter's Trojan swarms, generated ±60° of Jupiter along its orbit. */
export function makeTrojans(count = 260, seed = 0x7203): ParticleCloud {
  const rng = mulberry32(seed);
  const elements: Elements[] = [];
  // Jupiter's mean longitude at J2000 from the Standish table.
  const jupiterL = 34.396 * DEG;
  for (let k = 0; k < count; k++) {
    const leading = k % 2 === 0;
    const libration = (rng() - 0.5) * 50 * DEG; // real swarms librate tens of degrees
    const lambda = jupiterL + (leading ? 60 * DEG : -60 * DEG) + libration;
    const om = rng() * Math.PI * 2;
    const w = rng() * Math.PI * 2;
    elements.push({
      a: (5.2 + (rng() - 0.5) * 0.28) * AU_KM,
      e: Math.min(0.25, rayleigh(rng, 0.06)),
      i: Math.min(40 * DEG, rayleigh(rng, 12 * DEG)),
      om,
      w,
      m0: lambda - om - w,
      epoch: 2451545.0,
      mu: GM.sun,
    });
  }
  return {
    id: 'trojans',
    label: 'JUPITER TROJANS',
    elements,
    color: '#7d6b52',
    pointSize: 1.8,
    note: 'Simulated population placed at the real L4/L5 libration points of Jupiter. Individual bodies are fictitious.',
  };
}

/** Kuiper belt, with the plutino spike at the 3:2 resonance. */
export function makeKuiperBelt(count = 520, seed = 0xc01d): ParticleCloud {
  const rng = mulberry32(seed);
  const elements: Elements[] = [];
  for (let k = 0; k < count; k++) {
    // About a quarter of known KBOs are plutinos at a ≈ 39.4 AU.
    const plutino = rng() < 0.24;
    const a = plutino ? 39.4 + (rng() - 0.5) * 0.9 : 42 + rng() * 6.5;
    elements.push({
      a: a * AU_KM,
      e: plutino ? 0.12 + rayleigh(rng, 0.08) : Math.min(0.3, rayleigh(rng, 0.06)),
      i: Math.min(35 * DEG, rayleigh(rng, plutino ? 10 * DEG : 5 * DEG)),
      om: rng() * Math.PI * 2,
      w: rng() * Math.PI * 2,
      m0: rng() * Math.PI * 2,
      epoch: 2451545.0,
      mu: GM.sun,
    });
  }
  return {
    id: 'kuiper',
    label: 'KUIPER BELT',
    elements,
    color: '#54606b',
    pointSize: 1.6,
    note: 'Simulated population. The plutino concentration at the 3:2 resonance with Neptune is real; individual bodies are fictitious.',
  };
}

export function cloudPositions(cloud: ParticleCloud, jd: number, out: Float32Array, scale: number): void {
  for (let k = 0; k < cloud.elements.length; k++) {
    const p = positionFromElements(cloud.elements[k]!, jd) as Vec3;
    out[k * 3] = p[0] * scale;
    out[k * 3 + 1] = p[1] * scale;
    out[k * 3 + 2] = p[2] * scale;
  }
}

// ---------------------------------------------------------------------------
// Demonstration orbital shells around the Earth
// ---------------------------------------------------------------------------

/**
 * Representative Earth orbits.
 *
 * Real satellites need real TLEs, which this build fetches from CelesTrak at runtime. When
 * that is unavailable, these stand in: each one sits in a shell that genuinely exists
 * (the ISS inclination, the sun-synchronous band, the GNSS and geostationary altitudes),
 * so the orbital mechanics you watch are right even though the objects are not real.
 */
const SHELLS: ReadonlyArray<{
  label: string; altKm: number; incDeg: number; count: number; color: string; note: string;
}> = [
  { label: 'LEO / CREWED BAND', altKm: 420, incDeg: 51.6, count: 5, color: '#7fb2d9', note: 'The inclination and altitude the International Space Station uses.' },
  { label: 'LEO / SUN-SYNCHRONOUS', altKm: 705, incDeg: 98.2, count: 6, color: '#6f9f8a', note: 'The retrograde band Earth-observation satellites use to cross the equator at a fixed local time.' },
  { label: 'LEO / BROADBAND SHELL', altKm: 550, incDeg: 53.0, count: 8, color: '#5f7d99', note: 'The altitude and inclination large broadband constellations occupy.' },
  { label: 'MEO / NAVIGATION', altKm: 20_200, incDeg: 55.0, count: 6, color: '#a58f6a', note: 'The GNSS altitude, where a 12-hour orbit gives global coverage from 24 satellites.' },
];

export function makeDemoSatellites(seed = 0x0b17): SpaceObject[] {
  const rng = mulberry32(seed);
  const out: SpaceObject[] = [];
  let n = 0;
  for (const shell of SHELLS) {
    for (let k = 0; k < shell.count; k++) {
      n++;
      const a = RADIUS.earth + shell.altKm;
      const periodMin = (2 * Math.PI * Math.sqrt((a * a * a) / GM.earth)) / 60;
      out.push({
        id: `demo-sat-${String(n).padStart(2, '0')}`,
        name: `DEMO ORBIT ${String(n).padStart(2, '0')}`,
        subtitle: shell.label,
        kind: 'satellite',
        parent: 'earth',
        radiusKm: 0.01,
        color: shell.color,
        weight: 0.25,
        provenance: {
          ...PROVENANCE.simulated,
          source: 'Generated by SPACE RADAR. Not a real satellite.',
          accuracy: `The shell is real: ${shell.altKm} km altitude, ${shell.incDeg}° inclination, ${periodMin.toFixed(1)} min period. The object in it is not.`,
          limitations: shell.note + ' Real satellites appear on this layer when a live element set is available.',
        },
        ephemeris: {
          kind: 'elements',
          elements: {
            a,
            e: 0.0012 * rng(),
            i: shell.incDeg * DEG,
            om: ((k / shell.count) * 360 + rng() * 25) * DEG,
            w: rng() * Math.PI * 2,
            m0: rng() * Math.PI * 2,
            epoch: 2451545.0,
            mu: GM.earth,
          },
        },
        tags: ['satellite', 'demo', 'simulated'],
        status: 'SIMULATED — NOT A REAL OBJECT',
        facts: [
          { label: 'Altitude', value: `${shell.altKm.toLocaleString('en-US')} km` },
          { label: 'Inclination', value: `${shell.incDeg}°` },
          { label: 'Orbital period', value: `${periodMin.toFixed(1)} min` },
        ],
      });
    }
  }
  return out;
}
