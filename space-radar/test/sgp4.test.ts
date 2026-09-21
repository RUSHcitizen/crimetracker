import { describe, expect, it } from 'vitest';
import { parseTle, parseTleText, sgp4, sgp4Init, temeStateToEcliptic } from '../src/lib/astro/sgp4';
import { length, sub } from '../src/lib/astro/vec';
import { RAD } from '../src/lib/astro/constants';

// The canonical SGP4 verification object from Spacetrack Report #3 / Vallado's test suite.
const VANGUARD = {
  l1: '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753',
  l2: '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667',
};

const ISS = {
  l1: '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  l2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
};

describe('TLE parsing', () => {
  it('reads every field of a real TLE', () => {
    const f = parseTle(VANGUARD.l1, VANGUARD.l2)!;
    expect(f).not.toBeNull();
    expect(f.noradId).toBe(5);
    expect(f.eccentricity).toBeCloseTo(0.1859667, 7);
    expect(f.inclination * RAD).toBeCloseTo(34.2682, 4);
    expect(f.raan * RAD).toBeCloseTo(348.7242, 4);
    expect(f.argPerigee * RAD).toBeCloseTo(331.7664, 4);
    expect(f.meanAnomaly * RAD).toBeCloseTo(19.3264, 4);
    // Day 179.785 of 2000 is 2000-06-27 ~18:50 UTC.
    expect(f.epochJd).toBeCloseTo(2451723.28495062, 5);
    // bstar field '28098-4' means 0.28098e-4
    expect(f.bstar).toBeCloseTo(0.28098e-4, 10);
  });

  it('rejects malformed input instead of returning garbage', () => {
    expect(parseTle('nonsense', 'also nonsense')).toBeNull();
    expect(parseTle(VANGUARD.l2, VANGUARD.l1)).toBeNull();
    expect(parseTle(VANGUARD.l1, VANGUARD.l2.replace('0.', 'xx'))).not.toBeNull();
  });

  it('splits a 3LE blob and keeps the names', () => {
    const blob = `ISS (ZARYA)\n${ISS.l1}\n${ISS.l2}\nVANGUARD 1\n${VANGUARD.l1}\n${VANGUARD.l2}\n`;
    const tles = parseTleText(blob);
    expect(tles).toHaveLength(2);
    expect(tles[0]!.name).toBe('ISS (ZARYA)');
    expect(tles[1]!.name).toBe('VANGUARD 1');
  });
});

describe('SGP4 propagation', () => {
  it('matches the published Vanguard verification vectors', () => {
    const sat = sgp4Init('VANGUARD 1', parseTle(VANGUARD.l1, VANGUARD.l2)!);
    expect(sat.deepSpace).toBe(false);

    const at0 = sgp4(sat, 0)!;
    expect(at0.position[0]).toBeCloseTo(7022.46529266, 2);
    expect(at0.position[1]).toBeCloseTo(-1400.08296755, 2);
    expect(at0.position[2]).toBeCloseTo(0.03995155, 2);
    expect(at0.velocity[0]).toBeCloseTo(1.893841015, 5);
    expect(at0.velocity[1]).toBeCloseTo(6.405893759, 5);
    expect(at0.velocity[2]).toBeCloseTo(4.53480725, 5);

    const at360 = sgp4(sat, 360)!;
    expect(at360.position[0]).toBeCloseTo(-7154.03120202, 1);
    expect(at360.position[1]).toBeCloseTo(-3783.17682504, 1);
    expect(at360.position[2]).toBeCloseTo(-3536.19412294, 1);
    expect(at360.velocity[0]).toBeCloseTo(4.741887409, 4);
    expect(at360.velocity[1]).toBeCloseTo(-4.151817765, 4);
    expect(at360.velocity[2]).toBeCloseTo(-2.093935425, 4);

    const at1440 = sgp4(sat, 1440)!;
    expect(at1440.position[0]).toBeCloseTo(-938.55923943, 1);
    expect(at1440.position[1]).toBeCloseTo(-6268.18748831, 1);
    expect(at1440.position[2]).toBeCloseTo(-4294.02924751, 1);
  });

  it('keeps the ISS in a plausible low Earth orbit for a day', () => {
    const sat = sgp4Init('ISS (ZARYA)', parseTle(ISS.l1, ISS.l2)!);
    expect(sat.periodMinutes).toBeCloseTo(91.6, 0);

    let minAlt = Infinity;
    let maxAlt = -Infinity;
    let maxSpeed = 0;
    for (let m = 0; m < 1440; m += 1) {
      const s = sgp4(sat, m)!;
      expect(s).not.toBeNull();
      const alt = length(s.position) - 6378.137;
      minAlt = Math.min(minAlt, alt);
      maxAlt = Math.max(maxAlt, alt);
      maxSpeed = Math.max(maxSpeed, length(s.velocity));
    }
    expect(minAlt).toBeGreaterThan(320);
    expect(maxAlt).toBeLessThan(370);
    expect(maxSpeed).toBeGreaterThan(7.6);
    expect(maxSpeed).toBeLessThan(7.8);
  });

  it('returns to the same place after one nodal period', () => {
    const sat = sgp4Init('ISS (ZARYA)', parseTle(ISS.l1, ISS.l2)!);
    const a = sgp4(sat, 0)!;
    const b = sgp4(sat, sat.periodMinutes)!;
    // Not identical — J2 precesses the node and drag lowers the orbit — but close.
    expect(length(sub(a.position, b.position))).toBeLessThan(60);
  });

  it('refuses deep-space objects rather than propagating them wrongly', () => {
    // A geostationary TLE: 1.0027 rev/day, period ~1436 min.
    const geo1 = '1 99999U 20001A   24001.00000000  .00000000  00000-0  00000-0 0  9995';
    const geo2 = '2 99999   0.0200  95.0000 0002000 250.0000 110.0000  1.00270000    10';
    const sat = sgp4Init('GEO TEST', parseTle(geo1, geo2)!);
    expect(sat.deepSpace).toBe(true);
    expect(sat.periodMinutes).toBeGreaterThan(1400);
    expect(sgp4(sat, 100)).toBeNull();
  });

  it('rotates TEME into the ecliptic frame without changing the magnitude', () => {
    const sat = sgp4Init('ISS (ZARYA)', parseTle(ISS.l1, ISS.l2)!);
    const teme = sgp4(sat, 42)!;
    const ecl = temeStateToEcliptic(teme);
    expect(length(ecl.position)).toBeCloseTo(length(teme.position), 6);
    expect(length(ecl.velocity)).toBeCloseTo(length(teme.velocity), 9);
    // A 51.6 deg orbit must leave the ecliptic plane substantially.
    expect(Math.abs(ecl.position[2])).toBeGreaterThan(100);
  });
});
