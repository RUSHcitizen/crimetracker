import { DEG, TWO_PI } from './constants';
import { add, cross, dot, length, scale, sub, type Vec3 } from './vec';

/**
 * Classical two-body orbital mechanics.
 *
 * Everything that follows is an unperturbed conic about a single central mass. That is
 * exactly what the app claims: good to arcminutes over a human lifetime for planets, and
 * honest-but-approximate for anything whose real trajectory is shaped by close
 * encounters, drag, or thrust. Objects carry their own accuracy note; see lib/data.
 */

/** Osculating Keplerian elements in the J2000 ecliptic frame. */
export interface Elements {
  /** Semi-major axis, km. Negative for hyperbolic orbits. */
  a: number;
  /** Eccentricity. >= 1 means the orbit is open. */
  e: number;
  /** Inclination, radians. */
  i: number;
  /** Longitude of the ascending node, radians. */
  om: number;
  /** Argument of periapsis, radians. */
  w: number;
  /** Mean anomaly at `epoch`, radians. */
  m0: number;
  /** Julian Date the elements osculate to. */
  epoch: number;
  /** Gravitational parameter of the central body, km^3/s^2. */
  mu: number;
}

export interface State {
  position: Vec3;
  velocity: Vec3;
}

/** Wrap an angle into [0, 2π). */
export function wrap2Pi(x: number): number {
  const r = x % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

/** Wrap an angle into (−π, π] — the form the scrubber and readouts want. */
export function wrapPi(x: number): number {
  const r = wrap2Pi(x + Math.PI);
  return r - Math.PI;
}

/**
 * Solve Kepler's equation M = E − e·sin E for the eccentric anomaly.
 *
 * Newton-Raphson alone diverges for the high eccentricities real comets and some NEOs
 * reach (e ≳ 0.9), so each step is safeguarded against a bracket. The bracket is free:
 * E = M + e·sin E and |e·sin E| ≤ e, so E always lies in [M − e, M + e]. Any Newton step
 * that leaves the bracket is replaced by a bisection, which makes convergence guaranteed
 * rather than merely likely.
 */
export function solveKeplerElliptic(m: number, e: number): number {
  const mm = wrapPi(m);
  if (e < 1e-12) return mm;

  let lo = mm - e;
  let hi = mm + e;
  let E = mm + e * Math.sin(mm);

  for (let k = 0; k < 100; k++) {
    const f = E - e * Math.sin(E) - mm;
    // f is strictly increasing in E because 1 − e·cos E > 0 for e < 1.
    if (f > 0) hi = E;
    else lo = E;

    const fp = 1 - e * Math.cos(E);
    let next = fp > 1e-14 ? E - f / fp : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;

    if (Math.abs(next - E) < 1e-14) return next;
    E = next;
  }
  return E;
}

/**
 * Solve the hyperbolic analogue M = e·sinh H − H.
 *
 * Same safeguarding idea as the elliptic case. The function is odd in H and strictly
 * increasing, so we solve for |M| on [0, hi] with hi found by doubling, then restore the
 * sign. Voyager 1 is 60 years past its Jupiter encounter, which puts M in the thousands —
 * an unsafeguarded Newton step from a bad starter overflows there.
 */
export function solveKeplerHyperbolic(m: number, e: number): number {
  if (m === 0) return 0;
  const sign = m < 0 ? -1 : 1;
  const target = Math.abs(m);

  let lo = 0;
  let hi = 1;
  while (e * Math.sinh(hi) - hi < target) {
    hi *= 2;
    if (hi > 1e6) break; // sinh overflows long before this; give up gracefully
  }

  let H = Math.min(hi, Math.asinh(target / e) + 0.5);

  for (let k = 0; k < 200; k++) {
    const f = e * Math.sinh(H) - H - target;
    if (f > 0) hi = H;
    else lo = H;

    const fp = e * Math.cosh(H) - 1;
    let next = Number.isFinite(fp) && fp > 1e-14 ? H - f / fp : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;

    if (Math.abs(next - H) < 1e-13 * Math.max(1, Math.abs(H))) {
      H = next;
      break;
    }
    H = next;
  }
  return sign * H;
}

/** True anomaly and radius at a given time, for either conic type. */
function anomalyAt(el: Elements, jd: number): { nu: number; r: number } {
  const dt = (jd - el.epoch) * 86_400; // seconds

  if (el.e < 1) {
    const n = Math.sqrt(el.mu / (el.a * el.a * el.a));
    const m = el.m0 + n * dt;
    const E = solveKeplerElliptic(m, el.e);
    const nu =
      2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
    return { nu, r: el.a * (1 - el.e * Math.cos(E)) };
  }

  // Hyperbolic: `a` is negative, so |a|³ gives a real mean motion.
  const absA = Math.abs(el.a);
  const n = Math.sqrt(el.mu / (absA * absA * absA));
  const m = el.m0 + n * dt;
  const H = solveKeplerHyperbolic(m, el.e);
  const nu =
    2 * Math.atan2(Math.sqrt(el.e + 1) * Math.sinh(H / 2), Math.sqrt(el.e - 1) * Math.cosh(H / 2));
  return { nu, r: absA * (el.e * Math.cosh(H) - 1) };
}

/** Rotate a vector from the perifocal frame into the J2000 ecliptic frame. */
function perifocalToEcliptic(v: Vec3, i: number, om: number, w: number): Vec3 {
  const [x, y] = v;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(i);
  const si = Math.sin(i);

  // Standard 3-1-3 rotation, expanded rather than composed from matrices: this runs for
  // every object on every frame and for every point of every drawn orbit.
  return [
    x * (cw * co - sw * ci * so) - y * (sw * co + cw * ci * so),
    x * (cw * so + sw * ci * co) + y * (cw * ci * co - sw * so),
    x * (sw * si) + y * (cw * si),
  ];
}

/** Position and velocity at a Julian Date. */
export function stateFromElements(el: Elements, jd: number): State {
  const { nu, r } = anomalyAt(el, jd);
  const p = el.a * (1 - el.e * el.e); // semi-latus rectum; correct for both conics

  const posPf: Vec3 = [r * Math.cos(nu), r * Math.sin(nu), 0];
  const k = Math.sqrt(el.mu / p);
  const velPf: Vec3 = [-k * Math.sin(nu), k * (el.e + Math.cos(nu)), 0];

  return {
    position: perifocalToEcliptic(posPf, el.i, el.om, el.w),
    velocity: perifocalToEcliptic(velPf, el.i, el.om, el.w),
  };
}

/** Position only — skips the velocity rotation, which orbit drawing does not need. */
export function positionFromElements(el: Elements, jd: number): Vec3 {
  const { nu, r } = anomalyAt(el, jd);
  return perifocalToEcliptic([r * Math.cos(nu), r * Math.sin(nu), 0], el.i, el.om, el.w);
}

/**
 * Invert a state vector back to osculating elements.
 *
 * The sandbox needs this: the user nudges a velocity, and the new conic has to be derived
 * from the resulting state before it can be propagated or drawn.
 */
export function elementsFromState(state: State, mu: number, epoch: number): Elements {
  const { position: r, velocity: v } = state;
  const rMag = length(r);
  const vMag = length(v);

  const h = cross(r, v);
  const hMag = length(h);

  // Eccentricity vector, e = ((v² − μ/r)·r − (r·v)·v) / μ
  const rv = dot(r, v);
  const eVec = scale(sub(scale(r, vMag * vMag - mu / rMag), scale(v, rv)), 1 / mu);
  const e = length(eVec);

  const energy = (vMag * vMag) / 2 - mu / rMag;
  // Parabolic orbits have zero energy and infinite `a`. Nudge them just off parabolic so
  // downstream maths stays finite; the sandbox flags near-parabolic results anyway.
  const a = Math.abs(energy) < 1e-12 ? Number.POSITIVE_INFINITY : -mu / (2 * energy);

  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hMag)));

  const nVec: Vec3 = [-h[1], h[0], 0]; // node line = ẑ × h
  const nMag = length(nVec);

  let om = 0;
  let w = 0;
  let nu: number;

  if (nMag < 1e-10) {
    // Equatorial orbit: the node is undefined, so measure the periapsis from the x axis.
    om = 0;
    w = e > 1e-10 ? wrap2Pi(Math.atan2(eVec[1], eVec[0])) : 0;
    nu = wrap2Pi(Math.atan2(r[1], r[0]) - w);
  } else {
    om = wrap2Pi(Math.atan2(nVec[1], nVec[0]));
    if (e > 1e-10) {
      w = wrap2Pi(Math.acos(Math.min(1, Math.max(-1, dot(nVec, eVec) / (nMag * e)))));
      if (eVec[2] < 0) w = TWO_PI - w;
      nu = wrap2Pi(Math.acos(Math.min(1, Math.max(-1, dot(eVec, r) / (e * rMag)))));
      if (rv < 0) nu = TWO_PI - nu;
    } else {
      // Circular orbit: no periapsis, so use argument of latitude in place of ω + ν.
      w = 0;
      nu = wrap2Pi(Math.atan2(r[2] / Math.sin(i), (r[0] * nVec[0] + r[1] * nVec[1]) / nMag));
    }
  }

  // Back out the mean anomaly at epoch from the true anomaly.
  let m0: number;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    m0 = wrap2Pi(E - e * Math.sin(E));
  } else {
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    m0 = e * Math.sinh(H) - H;
  }

  return { a, e, i, om, w, m0, epoch, mu };
}

/** Orbital period in days, or null for an open orbit. */
export function periodDays(el: Elements): number | null {
  if (el.e >= 1 || !Number.isFinite(el.a) || el.a <= 0) return null;
  return (TWO_PI * Math.sqrt((el.a * el.a * el.a) / el.mu)) / 86_400;
}

export const periapsis = (el: Elements): number => el.a * (1 - el.e);
export const apoapsis = (el: Elements): number | null =>
  el.e >= 1 ? null : el.a * (1 + el.e);

/**
 * Sample a conic into a polyline for rendering.
 *
 * Sampled in eccentric (not true) anomaly so points bunch up near periapsis where the
 * curvature is, instead of wasting half the vertices on the slow far side of the orbit.
 * Open orbits get a bounded arc around the current time instead of a closed loop.
 */
export function sampleOrbit(el: Elements, segments: number, jd?: number): Vec3[] {
  const out: Vec3[] = [];

  if (el.e < 1) {
    for (let k = 0; k <= segments; k++) {
      const E = (k / segments) * TWO_PI;
      const nu =
        2 * Math.atan2(Math.sqrt(1 + el.e) * Math.sin(E / 2), Math.sqrt(1 - el.e) * Math.cos(E / 2));
      const r = el.a * (1 - el.e * Math.cos(E));
      out.push(perifocalToEcliptic([r * Math.cos(nu), r * Math.sin(nu), 0], el.i, el.om, el.w));
    }
    return out;
  }

  // Hyperbolic: walk H either side of the current value so the drawn arc stays centred on
  // where the object actually is.
  const absA = Math.abs(el.a);
  const n = Math.sqrt(el.mu / (absA * absA * absA));
  const mNow = el.m0 + n * ((jd ?? el.epoch) - el.epoch) * 86_400;
  const hNow = solveKeplerHyperbolic(mNow, el.e);
  const span = Math.max(2.2, Math.abs(hNow) * 1.6);

  for (let k = 0; k <= segments; k++) {
    const H = hNow - span + (2 * span * k) / segments;
    const nu =
      2 * Math.atan2(Math.sqrt(el.e + 1) * Math.sinh(H / 2), Math.sqrt(el.e - 1) * Math.cosh(H / 2));
    const r = absA * (el.e * Math.cosh(H) - 1);
    out.push(perifocalToEcliptic([r * Math.cos(nu), r * Math.sin(nu), 0], el.i, el.om, el.w));
  }
  return out;
}

/** Build elements from the degree-valued form catalogues publish. */
export function elementsFromDegrees(input: {
  aKm: number;
  e: number;
  iDeg: number;
  omDeg: number;
  wDeg: number;
  m0Deg: number;
  epoch: number;
  mu: number;
}): Elements {
  return {
    a: input.aKm,
    e: input.e,
    i: input.iDeg * DEG,
    om: input.omDeg * DEG,
    w: input.wDeg * DEG,
    m0: input.m0Deg * DEG,
    epoch: input.epoch,
    mu: input.mu,
  };
}

/** Propagate a state vector forward on its own osculating conic. */
export function propagateState(state: State, mu: number, fromJd: number, toJd: number): State {
  if (fromJd === toJd) return state;
  return stateFromElements(elementsFromState(state, mu, fromJd), toJd);
}

/** Two-body specific orbital energy, km²/s² — negative when bound. */
export function specificEnergy(state: State, mu: number): number {
  const v = length(state.velocity);
  return (v * v) / 2 - mu / length(state.position);
}

/** Local escape speed, km/s. */
export const escapeSpeed = (mu: number, r: number): number => Math.sqrt((2 * mu) / r);

/** Add two states — used when composing a moon's orbit onto its planet's. */
export const addStates = (a: State, b: State): State => ({
  position: add(a.position, b.position),
  velocity: add(a.velocity, b.velocity),
});
