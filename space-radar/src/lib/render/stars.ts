import { DEG } from '../astro/constants';
import { raDecToEcliptic } from '../sim/world';
import type { Vec3 } from '../astro/vec';

/**
 * The background sky.
 *
 * Two separate things live here, and the app never confuses them:
 *
 *  - `BRIGHT_STARS` are real: twenty catalogue stars with their published right ascension,
 *    declination and visual magnitude. They exist so that direction means something — when
 *    the app says Voyager 1 is heading into Ophiuchus, you can see Ophiuchus.
 *  - `generateBackdrop` is decoration: procedurally scattered faint points with no
 *    astronomical content whatsoever. It is never labelled, never searchable and never
 *    presented as data.
 */

export interface BrightStar {
  name: string;
  /** Hours and degrees, J2000. */
  raDeg: number;
  decDeg: number;
  /** Apparent visual magnitude. */
  mag: number;
  /** Rough distance in light years, for the deep-space scale readout. */
  lightYears: number;
  note?: string;
}

const hms = (h: number, m: number): number => (h + m / 60) * 15;
const dms = (d: number, m: number): number => Math.sign(d || 1) * (Math.abs(d) + m / 60);

export const BRIGHT_STARS: readonly BrightStar[] = [
  { name: 'SIRIUS', raDeg: hms(6, 45), decDeg: dms(-16, 43), mag: -1.46, lightYears: 8.6, note: 'Brightest star in the night sky' },
  { name: 'CANOPUS', raDeg: hms(6, 24), decDeg: dms(-52, 42), mag: -0.74, lightYears: 310 },
  { name: 'ALPHA CENTAURI', raDeg: hms(14, 40), decDeg: dms(-60, 50), mag: -0.27, lightYears: 4.4, note: 'Nearest star system to the Sun' },
  { name: 'ARCTURUS', raDeg: hms(14, 16), decDeg: dms(19, 11), mag: -0.05, lightYears: 37 },
  { name: 'VEGA', raDeg: hms(18, 37), decDeg: dms(38, 47), mag: 0.03, lightYears: 25 },
  { name: 'CAPELLA', raDeg: hms(5, 17), decDeg: dms(46, 0), mag: 0.08, lightYears: 43 },
  { name: 'RIGEL', raDeg: hms(5, 15), decDeg: dms(-8, 12), mag: 0.13, lightYears: 860 },
  { name: 'PROCYON', raDeg: hms(7, 39), decDeg: dms(5, 13), mag: 0.34, lightYears: 11.5 },
  { name: 'ACHERNAR', raDeg: hms(1, 38), decDeg: dms(-57, 14), mag: 0.46, lightYears: 139 },
  { name: 'BETELGEUSE', raDeg: hms(5, 55), decDeg: dms(7, 24), mag: 0.5, lightYears: 550, note: 'Red supergiant; will end as a supernova' },
  { name: 'ALTAIR', raDeg: hms(19, 51), decDeg: dms(8, 52), mag: 0.77, lightYears: 16.7 },
  { name: 'ALDEBARAN', raDeg: hms(4, 36), decDeg: dms(16, 31), mag: 0.85, lightYears: 65 },
  { name: 'ANTARES', raDeg: hms(16, 29), decDeg: dms(-26, 26), mag: 1.09, lightYears: 550 },
  { name: 'SPICA', raDeg: hms(13, 25), decDeg: dms(-11, 10), mag: 1.04, lightYears: 250 },
  { name: 'POLLUX', raDeg: hms(7, 45), decDeg: dms(28, 2), mag: 1.14, lightYears: 34 },
  { name: 'FOMALHAUT', raDeg: hms(22, 58), decDeg: dms(-29, 37), mag: 1.16, lightYears: 25 },
  { name: 'DENEB', raDeg: hms(20, 41), decDeg: dms(45, 17), mag: 1.25, lightYears: 2600 },
  { name: 'POLARIS', raDeg: hms(2, 32), decDeg: dms(89, 16), mag: 1.98, lightYears: 433, note: 'The current north pole star' },
  { name: 'PROXIMA CENTAURI', raDeg: hms(14, 30), decDeg: dms(-62, 41), mag: 11.13, lightYears: 4.24, note: 'Closest known star to the Sun' },
  { name: "BARNARD'S STAR", raDeg: hms(17, 58), decDeg: dms(4, 42), mag: 9.51, lightYears: 5.96, note: 'Largest proper motion of any known star' },
];

/** Unit direction, ecliptic frame, for each catalogue star. */
export function brightStarDirections(): { star: BrightStar; dir: Vec3 }[] {
  return BRIGHT_STARS.map((star) => ({ star, dir: raDecToEcliptic(star.raDeg, star.decDeg) }));
}

/**
 * Decorative backdrop points on a unit sphere.
 * Not a star catalogue. Uniform on the sphere via the inverse-CDF for declination.
 */
export function generateBackdrop(count: number, seed = 0xbeef): Float32Array {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = rnd() * 2 - 1;
    const r = Math.sqrt(1 - z * z);
    const phi = rnd() * Math.PI * 2;
    out[i * 3] = r * Math.cos(phi);
    out[i * 3 + 1] = r * Math.sin(phi);
    out[i * 3 + 2] = z;
  }
  return out;
}

/** Brightness 0–1 from visual magnitude, for point size and alpha. */
export const magnitudeToBrightness = (mag: number): number =>
  Math.min(1, Math.max(0.12, Math.pow(2.512, -mag / 2.8) * 0.55));

export const constellationHint = (raDeg: number, decDeg: number): string => {
  // A coarse lookup used only for flavour text in object panels, so it is deliberately
  // rough: it names the region of sky, not a precise IAU constellation boundary.
  const ra = ((raDeg % 360) + 360) % 360;
  const bands: [number, number, string][] = [
    [0, 30, 'Pisces'], [30, 60, 'Aries'], [60, 90, 'Taurus'], [90, 120, 'Gemini'],
    [120, 150, 'Cancer'], [150, 180, 'Leo'], [180, 210, 'Virgo'], [210, 240, 'Libra'],
    [240, 260, 'Scorpius'], [260, 280, 'Ophiuchus'], [280, 300, 'Sagittarius'],
    [300, 320, 'Capricornus'], [320, 340, 'Aquarius'], [340, 360, 'Pisces'],
  ];
  const band = bands.find(([lo, hi]) => ra >= lo && ra < hi);
  const region = band ? band[2] : 'the ecliptic';
  if (decDeg > 60) return 'the far northern sky';
  if (decDeg < -60) return 'the far southern sky';
  return `the direction of ${region}`;
};

export const DEG_PER_HOUR = 15 * DEG;
