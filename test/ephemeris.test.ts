import { describe, expect, it } from 'vitest';
import { AU_KM, RAD } from '../src/lib/astro/constants';
import { dateToJd, precessionFromJ2000Deg } from '../src/lib/astro/time';
import { PLANET_IDS, planetPosition, planetState, earthState } from '../src/lib/astro/planets';
import { moonGeocentric, moonPhase } from '../src/lib/astro/moon';
import { length, sub } from '../src/lib/astro/vec';
import {
  elementsFromState,
  periodDays,
  propagateState,
  sampleOrbit,
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  stateFromElements,
} from '../src/lib/astro/kepler';

const jd = (iso: string) => dateToJd(new Date(iso));
const eclipticLongitudeDeg = (v: readonly [number, number, number]) =>
  ((Math.atan2(v[1], v[0]) * RAD) % 360 + 360) % 360;

describe('Kepler solver', () => {
  it('inverts M = E - e sin E across the eccentricity range', () => {
    for (const e of [0, 0.01, 0.2, 0.7, 0.9, 0.97]) {
      for (let m = -3; m <= 3; m += 0.37) {
        const E = solveKeplerElliptic(m, e);
        const recovered = E - e * Math.sin(E);
        // solveKeplerElliptic wraps M into (-pi, pi], so compare against the wrapped input.
        const wrapped = ((m + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        expect(recovered).toBeCloseTo(wrapped, 9);
      }
    }
  });

  it('inverts the hyperbolic form M = e sinh H - H', () => {
    for (const e of [1.05, 1.5, 3.7]) {
      for (const m of [-40, -5, -0.4, 0.4, 5, 40]) {
        const H = solveKeplerHyperbolic(m, e);
        expect(e * Math.sinh(H) - H).toBeCloseTo(m, 6);
      }
    }
  });
});

describe('planetary ephemeris (Standish tables)', () => {
  // The equinoxes are defined against the equinox of date; these ephemerides work in the
  // fixed J2000 frame. The two differ by ~0.37 deg in 2026, which is precession, not
  // error — so the expected J2000 longitude is the textbook value minus precession.
  it('puts Earth at the right heliocentric longitude at the September equinox', () => {
    const t = jd('2026-09-23T00:05:00Z');
    const lon = eclipticLongitudeDeg(planetPosition('earth', t));
    const expected = 360 - precessionFromJ2000Deg(t);
    expect(Math.abs(lon - expected)).toBeLessThan(0.05);
  });

  it('puts Earth at the right heliocentric longitude at the March equinox', () => {
    const t = jd('2026-03-20T14:46:00Z');
    const lon = eclipticLongitudeDeg(planetPosition('earth', t));
    const expected = 180 - precessionFromJ2000Deg(t);
    expect(Math.abs(lon - expected)).toBeLessThan(0.05);
  });

  it('reproduces published perihelion and aphelion distances', () => {
    const ranges: Record<string, [number, number]> = {
      mercury: [0.3075, 0.4667],
      venus: [0.7184, 0.7282],
      earth: [0.9833, 1.0167],
      mars: [1.3814, 1.666],
      jupiter: [4.95, 5.4589],
      saturn: [9.041, 10.124],
      uranus: [18.33, 20.11],
      neptune: [29.81, 30.33],
      pluto: [29.66, 49.31],
    };
    for (const id of PLANET_IDS) {
      let min = Infinity;
      let max = -Infinity;
      // Walk a full period (Pluto needs 250 years) in 5-day steps.
      const span = id === 'pluto' ? 250 : id === 'neptune' ? 165 : id === 'uranus' ? 85 : 30;
      for (let d = 0; d < span * 365.25; d += 5) {
        const r = length(planetPosition(id, 2451545 + d)) / AU_KM;
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
      const [lo, hi] = ranges[id]!;
      expect(min, `${id} perihelion`).toBeGreaterThan(lo * 0.99);
      expect(min, `${id} perihelion`).toBeLessThan(lo * 1.01);
      expect(max, `${id} aphelion`).toBeGreaterThan(hi * 0.99);
      expect(max, `${id} aphelion`).toBeLessThan(hi * 1.01);
    }
  });

  it('reproduces published minimum and maximum orbital speeds', () => {
    // Time-averaging speed over a short arc is not a mean orbital speed (Pluto spent the
    // 1990s near perihelion and reads ~6 km/s there against a 4.7 km/s mean), so assert
    // the extremes over a full revolution instead — those are unambiguous.
    const ranges: Record<string, [number, number]> = {
      mercury: [38.86, 58.98], venus: [34.78, 35.26], earth: [29.29, 30.29],
      mars: [21.97, 26.5], jupiter: [12.44, 13.72], saturn: [9.09, 10.18],
      uranus: [6.49, 7.11], neptune: [5.37, 5.5], pluto: [3.71, 6.1],
    };
    for (const id of PLANET_IDS) {
      const span = id === 'pluto' ? 250 : id === 'neptune' ? 165 : id === 'uranus' ? 85 : 30;
      let min = Infinity;
      let max = -Infinity;
      for (let d = 0; d < span * 365.25; d += 5) {
        const v = length(planetState(id, 2451545 + d).velocity);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      const [lo, hi] = ranges[id]!;
      expect(min, `${id} min speed`).toBeCloseTo(lo, 0);
      expect(max, `${id} max speed`).toBeCloseTo(hi, 0);
    }
  });
});

describe('lunar ephemeris (Meeus ch.47)', () => {
  it('stays inside the published perigee/apogee range', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let d = 0; d < 3650; d += 0.25) {
      const r = length(moonGeocentric(2451545 + d));
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    expect(min).toBeGreaterThan(356_000);
    expect(min).toBeLessThan(358_500);
    expect(max).toBeGreaterThan(404_500);
    expect(max).toBeLessThan(407_500);
  });

  it('has a mean distance near 385 000 km', () => {
    let sum = 0;
    let n = 0;
    for (let d = 0; d < 3650; d += 0.5) {
      sum += length(moonGeocentric(2451545 + d));
      n++;
    }
    expect(sum / n).toBeGreaterThan(383_000);
    expect(sum / n).toBeLessThan(387_000);
  });

  it('stays within the +/-5.3 deg ecliptic latitude bound', () => {
    let maxLat = 0;
    for (let d = 0; d < 7300; d += 0.25) {
      const p = moonGeocentric(2451545 + d);
      maxLat = Math.max(maxLat, Math.abs(Math.asin(p[2] / length(p)) * RAD));
    }
    expect(maxLat).toBeGreaterThan(4.9);
    expect(maxLat).toBeLessThan(5.4);
  });

  it('produces a synodic month of ~29.53 days', () => {
    // Count new moons (illuminated fraction minima) over 10 years.
    const newMoons: number[] = [];
    let prev = 1;
    let rising = false;
    for (let d = 0; d < 3650; d += 0.02) {
      const t = 2451545 + d;
      const moon = moonGeocentric(t);
      const earth = earthState(t, moon).position;
      const sunGeo = sub([0, 0, 0], earth);
      const f = moonPhase(moon, sunGeo).illuminated;
      if (f > prev && !rising) {
        newMoons.push(t);
        rising = true;
      } else if (f < prev) {
        rising = false;
      }
      prev = f;
    }
    expect(newMoons.length).toBeGreaterThan(120);
    const first = newMoons[0]!;
    const last = newMoons[newMoons.length - 1]!;
    const synodic = (last - first) / (newMoons.length - 1);
    expect(synodic).toBeCloseTo(29.5306, 1);
  });

  it('offsets the Earth from the barycentre by roughly 4 670 km', () => {
    const t = 2460000;
    const moon = moonGeocentric(t);
    const offset = length(sub(planetState('earth', t).position, earthState(t, moon).position));
    expect(offset).toBeGreaterThan(4200);
    expect(offset).toBeLessThan(5000);
  });
});

describe('element / state round-tripping', () => {
  it('recovers elements from a state vector', () => {
    for (const id of PLANET_IDS) {
      const t = 2460000.5;
      const s = planetState(id, t);
      const el = elementsFromState(s, 1.32712440018e11, t);
      const back = stateFromElements(el, t);
      expect(length(sub(back.position, s.position)) / length(s.position)).toBeLessThan(1e-9);
      expect(length(sub(back.velocity, s.velocity)) / length(s.velocity)).toBeLessThan(1e-9);
    }
  });

  it('propagates a circular LEO orbit back to its start after one period', () => {
    const mu = 3.986004418e5;
    const r = 6778;
    const v = Math.sqrt(mu / r);
    const state = { position: [r, 0, 0] as const, velocity: [0, v * Math.cos(0.9), v * Math.sin(0.9)] as const };
    const el = elementsFromState(state, mu, 2460000);
    const P = periodDays(el)!;
    expect(P * 1440).toBeCloseTo(92.6, 0); // ~92.6 minutes for a 400 km orbit
    const after = propagateState(state, mu, 2460000, 2460000 + P);
    expect(length(sub(after.position, state.position))).toBeLessThan(1e-3);
  });

  it('samples a closed orbit into a loop and an open orbit into an arc', () => {
    const mu = 1.32712440018e11;
    const closed = elementsFromState(planetState('mars', 2460000), mu, 2460000);
    const loop = sampleOrbit(closed, 64);
    expect(loop).toHaveLength(65);
    expect(length(sub(loop[0]!, loop[64]!))).toBeLessThan(1);

    const open = { a: -5e8, e: 3.2, i: 0.4, om: 1.1, w: 2.0, m0: 0.2, epoch: 2460000, mu };
    const arc = sampleOrbit(open, 64, 2460000);
    expect(arc).toHaveLength(65);
    expect(length(sub(arc[0]!, arc[64]!))).toBeGreaterThan(1e8);
    for (const p of arc) expect(Number.isFinite(length(p))).toBe(true);
  });
});
