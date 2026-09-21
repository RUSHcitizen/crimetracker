import { DEG, GM, RADIUS } from './constants';
import { centuriesSinceJ2000 } from './time';
import { cross, length, normalize, scale, type Vec3 } from './vec';
import type { State } from './kepler';

/**
 * Lunar position.
 *
 * SOURCE
 *   Jean Meeus, *Astronomical Algorithms* (2nd ed.), chapter 47 — the ELP-2000/82
 *   truncation. The principal periodic terms in longitude, latitude and distance are
 *   carried here.
 *
 * ACCURACY
 *   Roughly 10 arcseconds in longitude and a few kilometres in distance for dates near
 *   the present, which is far finer than anything this app draws. The full table has ~60
 *   more terms; the ones kept below are those with amplitudes that survive at the scale a
 *   phone screen can resolve.
 */

// [D, M, M', F, Σl (1e-6 deg), Σr (1e-3 km)]
const LR: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
];

// [D, M, M', F, Σb (1e-6 deg)]
const B: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
];

/** Geocentric lunar position in the J2000 ecliptic frame, km. */
export function moonGeocentric(jd: number): Vec3 {
  const t = centuriesSinceJ2000(jd);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;

  // Mean elements (Meeus 47.1–47.5), degrees.
  const Lp =
    218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000;
  const D = 297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000;
  const Mp =
    134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000;
  const F = 93.272095 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000;

  // Eccentricity correction for the Earth's orbit: terms in M are scaled by E, terms in
  // 2M by E². Without this the Moon drifts by arcminutes across a century.
  const E = 1 - 0.002516 * t - 0.0000074 * t2;

  const dR = D * DEG;
  const mR = M * DEG;
  const mpR = Mp * DEG;
  const fR = F * DEG;

  let sumL = 0;
  let sumR = 0;
  for (const [d, m, mp, f, cl, cr] of LR) {
    const arg = d * dR + m * mR + mp * mpR + f * fR;
    const ecc = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sumL += cl * ecc * Math.sin(arg);
    sumR += cr * ecc * Math.cos(arg);
  }

  let sumB = 0;
  for (const [d, m, mp, f, cb] of B) {
    const arg = d * dR + m * mR + mp * mpR + f * fR;
    const ecc = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sumB += cb * ecc * Math.sin(arg);
  }

  const lambda = (Lp + sumL / 1e6) * DEG;
  const beta = (sumB / 1e6) * DEG;
  const delta = 385000.56 + sumR / 1000; // km

  const cb = Math.cos(beta);
  return [delta * cb * Math.cos(lambda), delta * cb * Math.sin(lambda), delta * Math.sin(beta)];
}

/**
 * Geocentric lunar state. Velocity is a central finite difference of the series rather
 * than an analytic derivative — a minute either side is well inside the series' own error
 * and keeps this readable.
 */
export function moonState(jd: number): State {
  const h = 1 / 1440; // one minute, in days
  const before = moonGeocentric(jd - h);
  const after = moonGeocentric(jd + h);
  const dt = 2 * h * 86400;
  return {
    position: moonGeocentric(jd),
    velocity: [
      (after[0] - before[0]) / dt,
      (after[1] - before[1]) / dt,
      (after[2] - before[2]) / dt,
    ],
  };
}

/**
 * Illuminated fraction of the lunar disc as seen from Earth, 0–1, and the phase angle.
 * Derived from the Sun–Moon geometry the ephemerides already give us, not tabulated.
 */
export function moonPhase(moonGeo: Vec3, sunGeo: Vec3): { illuminated: number; angle: number } {
  const toSun = normalize(scale(sunGeo, 1));
  const toMoon = normalize(moonGeo);
  const cosElong = toSun[0] * toMoon[0] + toSun[1] * toMoon[1] + toSun[2] * toMoon[2];
  const elongation = Math.acos(Math.min(1, Math.max(-1, cosElong)));

  const rSun = length(sunGeo);
  const rMoon = length(moonGeo);
  const phaseAngle = Math.atan2(
    rSun * Math.sin(elongation),
    rMoon - rSun * Math.cos(elongation),
  );

  // Signed so the UI can tell waxing from waning: the sign of the ecliptic-z component of
  // (moon × sun) flips either side of new moon.
  const waxing = cross(toMoon, toSun)[2] < 0;
  return {
    illuminated: (1 + Math.cos(phaseAngle)) / 2,
    angle: waxing ? phaseAngle : -phaseAngle,
  };
}

export const MOON_MU = GM.moon;
export const MOON_RADIUS = RADIUS.moon;
