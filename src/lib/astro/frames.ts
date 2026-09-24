import { DEG, OBLIQUITY_J2000, RAD } from './constants';
import { wrap2Pi, type Elements } from './kepler';
import { cross, dot, normalize, rotateX, type Vec3 } from './vec';

/**
 * Reference-frame conversion for satellite orbits.
 *
 * Moon elements are published relative to their planet's equator (or its Laplace plane),
 * because that is the plane the orbits actually precess about. The rest of this app works
 * in the J2000 ecliptic. Converting at catalogue-build time means the data files can quote
 * the published numbers verbatim — an inclination of 0.31° for Titan, which is checkable
 * against any reference, rather than a pre-multiplied 27.7° that is not.
 */

/** Unit vector for a right ascension / declination, in the J2000 ecliptic frame. */
function poleToEcliptic(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const equatorial: Vec3 = [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
  return rotateX(equatorial, -OBLIQUITY_J2000);
}

/**
 * Orthonormal basis of a planet's equatorial plane, expressed in ecliptic coordinates.
 *
 * `z` is the planet's north pole. `x` points along the ascending node of the planet's
 * equator on the ecliptic, which is the direction satellite nodes are measured from.
 */
export function planetFrame(raDeg: number, decDeg: number): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = poleToEcliptic(raDeg, decDeg);
  // Node line = ecliptic north × pole. Degenerate only for a pole exactly on the ecliptic
  // pole, i.e. Earth, where any perpendicular will do.
  const raw = cross([0, 0, 1], z);
  const x = Math.hypot(raw[0], raw[1], raw[2]) < 1e-9 ? ([1, 0, 0] as Vec3) : normalize(raw);
  return { x, y: cross(z, x), z };
}

const apply = (f: { x: Vec3; y: Vec3; z: Vec3 }, v: Vec3): Vec3 => [
  f.x[0] * v[0] + f.y[0] * v[1] + f.z[0] * v[2],
  f.x[1] * v[0] + f.y[1] * v[1] + f.z[1] * v[2],
  f.x[2] * v[0] + f.y[2] * v[1] + f.z[2] * v[2],
];

/**
 * Re-express orbital elements given in a planet's equatorial frame as ecliptic elements.
 *
 * Done by rotating two directions that define the orbit — its angular-momentum normal and
 * its periapsis — and reading the new angles back off them. Rotating vectors rather than
 * composing Euler angles keeps retrograde and near-polar orbits (Triton, Phoebe, the
 * Jovian irregulars) correct, where angle formulae pick up sign ambiguities.
 */
export function equatorialElementsToEcliptic(
  el: { aKm: number; e: number; iDeg: number; nodeDeg: number; argPeriDeg: number; m0Deg: number },
  pole: { raDeg: number; decDeg: number },
  epoch: number,
  mu: number,
): Elements {
  const frame = planetFrame(pole.raDeg, pole.decDeg);
  const i = el.iDeg * DEG;
  const om = el.nodeDeg * DEG;
  const w = el.argPeriDeg * DEG;

  // Orbit normal in the planet's equatorial frame.
  const normalEq: Vec3 = [
    Math.sin(i) * Math.sin(om),
    -Math.sin(i) * Math.cos(om),
    Math.cos(i),
  ];

  // Periapsis direction: perifocal +x carried through the 3-1-3 rotation.
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const periEq: Vec3 = [
    cw * co - sw * ci * so,
    cw * so + sw * ci * co,
    sw * si,
  ];

  const normal = normalize(apply(frame, normalEq));
  const peri = normalize(apply(frame, periEq));

  const iEcl = Math.acos(Math.min(1, Math.max(-1, normal[2])));
  const omEcl = wrap2Pi(Math.atan2(normal[0], -normal[1]));

  // Argument of periapsis measured from the new ascending node, signed about the normal.
  const node: Vec3 = [Math.cos(omEcl), Math.sin(omEcl), 0];
  const inPlane = cross(normal, node);
  const wEcl = wrap2Pi(Math.atan2(dot(peri, inPlane), dot(peri, node)));

  return {
    a: el.aKm,
    e: el.e,
    i: iEcl,
    om: omEcl,
    w: wEcl,
    m0: el.m0Deg * DEG,
    epoch,
    mu,
  };
}

/** Inclination of a converted orbit, in degrees — handy for tests and readouts. */
export const inclinationDeg = (el: Elements): number => el.i * RAD;
