import { AU_KM, DEG, GM, MOON_MASS_FRACTION } from './constants';
import { positionFromElements, stateFromElements, wrap2Pi, type Elements, type State } from './kepler';
import { centuriesSinceJ2000 } from './time';
import { scale, sub, type Vec3 } from './vec';

/**
 * Planetary positions.
 *
 * SOURCE
 *   E. M. Standish, "Keplerian Elements for Approximate Positions of the Major Planets"
 *   (JPL Solar System Dynamics). Each planet gets six elements at J2000.0 plus six linear
 *   rates per Julian century.
 *
 * ACCURACY
 *   Better than ~10 arcminutes of heliocentric longitude for the inner planets over
 *   1800–2050, degrading for the outer planets and outside that window. Pluto is the
 *   worst of the set. This is a *real* ephemeris, not a fabricated one — but it is an
 *   approximation, and every planet reports that in its provenance record.
 *
 * WHY NOT AN API
 *   Because it must work offline, instantly, at 60 fps, for any instant the time scrubber
 *   can reach. A network ephemeris cannot do that. Positions computed here are marked
 *   `computed`, which the UI distinguishes from `live` network data.
 */

export type PlanetId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'pluto';

/**
 * [a (AU), e, I (deg), L (deg), longitude of perihelion (deg), longitude of node (deg)]
 * followed by the same six as rates per Julian century.
 *
 * `earth` is the Earth–Moon barycentre; `earthState()` below subtracts the Moon offset.
 */
interface StandishRow {
  readonly el: readonly [number, number, number, number, number, number];
  readonly rate: readonly [number, number, number, number, number, number];
}

const TABLE: Record<PlanetId, StandishRow> = {
  mercury: {
    el: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  },
  venus: {
    el: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  },
  earth: {
    el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  },
  mars: {
    el: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  },
  jupiter: {
    el: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  },
  saturn: {
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  },
  uranus: {
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  },
  neptune: {
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  },
  pluto: {
    el: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
    rate: [-0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
  },
};

export const PLANET_IDS = Object.keys(TABLE) as PlanetId[];

/** Osculating heliocentric elements for a planet at a Julian Date. */
export function planetElements(id: PlanetId, jd: number): Elements {
  const row = TABLE[id];
  const t = centuriesSinceJ2000(jd);

  const a = row.el[0] + row.rate[0] * t;
  const e = row.el[1] + row.rate[1] * t;
  const i = row.el[2] + row.rate[2] * t;
  const L = row.el[3] + row.rate[3] * t;
  const peri = row.el[4] + row.rate[4] * t;
  const node = row.el[5] + row.rate[5] * t;

  // Standish gives mean longitude and longitude of perihelion; Kepler wants mean anomaly
  // and argument of perihelion.
  return {
    a: a * AU_KM,
    e,
    i: i * DEG,
    om: node * DEG,
    w: wrap2Pi((peri - node) * DEG),
    m0: wrap2Pi((L - peri) * DEG),
    epoch: jd,
    mu: GM.sun,
  };
}

/**
 * Heliocentric position, km, J2000 ecliptic.
 *
 * For `earth` this is the Earth–Moon barycentre; use `earthState` for the planet itself.
 */
export function planetPosition(id: PlanetId, jd: number): Vec3 {
  return positionFromElements(planetElements(id, jd), jd);
}

export function planetState(id: PlanetId, jd: number): State {
  return stateFromElements(planetElements(id, jd), jd);
}

/**
 * The Earth proper: the barycentre displaced toward the far side of the Moon.
 *
 * Worth doing — the offset is ~4 670 km, more than a third of Earth's diameter, and it is
 * visible the moment you zoom in far enough to see the Moon's orbit.
 */
export function earthState(jd: number, moonGeocentric: Vec3): State {
  const bary = planetState('earth', jd);
  return {
    position: sub(bary.position, scale(moonGeocentric, MOON_MASS_FRACTION)),
    velocity: bary.velocity,
  };
}

/**
 * Per-planet axial tilt and rotation, used only to orient the rendered globes and to
 * place a ground point under a satellite. Values are IAU means, degrees and hours.
 */
export const SPIN: Record<PlanetId | 'sun' | 'moon', { tiltDeg: number; periodHours: number }> = {
  sun: { tiltDeg: 7.25, periodHours: 609.12 },
  mercury: { tiltDeg: 0.03, periodHours: 1407.6 },
  venus: { tiltDeg: 177.36, periodHours: -5832.5 },
  earth: { tiltDeg: 23.44, periodHours: 23.9345 },
  moon: { tiltDeg: 6.68, periodHours: 655.72 },
  mars: { tiltDeg: 25.19, periodHours: 24.6229 },
  jupiter: { tiltDeg: 3.13, periodHours: 9.925 },
  saturn: { tiltDeg: 26.73, periodHours: 10.656 },
  uranus: { tiltDeg: 97.77, periodHours: -17.24 },
  neptune: { tiltDeg: 28.32, periodHours: 16.11 },
  pluto: { tiltDeg: 122.53, periodHours: -153.29 },
};

/**
 * IAU north-pole orientation for each planet, in J2000 equatorial right ascension and
 * declination (degrees).
 *
 * Satellite elements are published relative to their planet's equator, not to the
 * ecliptic — Titan's inclination is 0.31°, not the 27.7° it works out to once Saturn's
 * tilt is folded in. Carrying the poles lets the catalogue quote the published numbers
 * and have the conversion done here, which is both less error-prone and easier to check
 * against a reference.
 */
export const POLE: Record<string, { raDeg: number; decDeg: number }> = {
  mercury: { raDeg: 281.01, decDeg: 61.42 },
  venus: { raDeg: 272.76, decDeg: 67.16 },
  earth: { raDeg: 0.0, decDeg: 90.0 },
  mars: { raDeg: 317.681, decDeg: 52.887 },
  jupiter: { raDeg: 268.057, decDeg: 64.495 },
  saturn: { raDeg: 40.589, decDeg: 83.537 },
  uranus: { raDeg: 257.311, decDeg: -15.175 },
  neptune: { raDeg: 299.36, decDeg: 43.46 },
  pluto: { raDeg: 132.993, decDeg: -6.163 },
};
