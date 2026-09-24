import { describe, expect, it } from 'vitest';
import { RAD } from '../src/lib/astro/constants';
import { equatorialElementsToEcliptic, planetFrame } from '../src/lib/astro/frames';
import { POLE } from '../src/lib/astro/planets';
import { GM } from '../src/lib/astro/constants';
import { length } from '../src/lib/astro/vec';

/**
 * The conversion is checked against a quantity with an independent published value: the
 * angle between each planet's IAU north pole and the ecliptic pole. A satellite orbiting
 * exactly in its planet's equatorial plane must come out at that inclination, whatever
 * its node.
 *
 * Note the convention. A planet's widely quoted "axial tilt" is measured against its own
 * orbit and, for the retrograde rotators, from the opposite pole: Uranus is quoted at
 * 97.77°, but the angle from its IAU north pole to the ecliptic pole — which is what an
 * ecliptic-frame inclination means — is 82.28°. Pluto is quoted at 122.53° to its orbit
 * and works out to 112.82° to the ecliptic, its 17.16° orbital inclination accounting for
 * the difference.
 */
const EQUATOR_TILT_TO_ECLIPTIC: Record<string, number> = {
  mars: 26.72,
  jupiter: 2.22,
  saturn: 28.05,
  uranus: 82.28,
  neptune: 28.03,
  pluto: 112.82,
};

const convert = (planet: string, iDeg: number, nodeDeg: number) =>
  equatorialElementsToEcliptic(
    { aKm: 400_000, e: 0.001, iDeg, nodeDeg, argPeriDeg: 0, m0Deg: 0 },
    POLE[planet]!,
    2451545,
    GM.jupiter,
  );

describe('planet equatorial frame', () => {
  it('is orthonormal for every planet', () => {
    for (const [name, pole] of Object.entries(POLE)) {
      const f = planetFrame(pole.raDeg, pole.decDeg);
      for (const v of [f.x, f.y, f.z]) expect(length(v), name).toBeCloseTo(1, 9);
      const dot = (a: readonly number[], b: readonly number[]) =>
        a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(f.x, f.y), name).toBeCloseTo(0, 9);
      expect(dot(f.y, f.z), name).toBeCloseTo(0, 9);
      expect(dot(f.x, f.z), name).toBeCloseTo(0, 9);
    }
  });

  it('puts an equatorial satellite at the planet’s tilt, for any node', () => {
    for (const [planet, tilt] of Object.entries(EQUATOR_TILT_TO_ECLIPTIC)) {
      for (const node of [0, 73, 180, 299]) {
        const el = convert(planet, 0, node);
        expect(el.i * RAD, `${planet} node=${node}`).toBeCloseTo(tilt, 1);
      }
    }
  });

  it('keeps a retrograde orbit retrograde', () => {
    // Triton: 156.9 deg about Neptune's equator is retrograde and must stay so.
    const triton = convert('neptune', 156.865, 0);
    expect(triton.i * RAD).toBeGreaterThan(90);
    // Phoebe: 175.2 deg about Saturn's equator.
    const phoebe = convert('saturn', 175.24, 40);
    expect(phoebe.i * RAD).toBeGreaterThan(90);
  });

  it('bounds the ecliptic inclination by tilt ± the orbit’s own inclination', () => {
    // A 30 deg orbit about Jupiter (tilt 2.22) must land between 27.8 and 32.3.
    for (const node of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const i = convert('jupiter', 30, node).i * RAD;
      expect(i).toBeGreaterThan(30 - 2.4);
      expect(i).toBeLessThan(30 + 2.4);
    }
  });

  it('leaves Earth-referenced orbits in the equatorial-to-ecliptic relation', () => {
    // Earth's pole is the equatorial pole by definition, so a 0 deg orbit comes out at
    // the obliquity, 23.44 deg.
    expect(convert('earth', 0, 0).i * RAD).toBeCloseTo(23.4393, 2);
  });
});
