import { DEG, OBLIQUITY_J2000 } from './constants';
import { rotateX, type Vec3 } from './vec';
import type { State } from './kepler';

/**
 * SGP4 — the propagator that two-line element sets are *defined* against.
 *
 * A TLE is not a state vector. Its "elements" are mean elements fitted under this exact
 * analytical model, so feeding them to a plain Kepler propagator is simply wrong: it puts
 * the ISS kilometres off within hours. This implements the near-Earth branch of SGP4 as
 * specified in Spacetrack Report #3 with the Vallado et al. (2006) corrections.
 *
 * SCOPE — deliberately the near-Earth branch only.
 *   Objects with a period of 225 minutes or more (GEO, Molniya, GNSS) need the deep-space
 *   SDP4 half, with lunar/solar resonance terms that roughly double the size of this file.
 *   Rather than propagate those badly, `sgp4Init` refuses them and returns
 *   `{ deepSpace: true }`; the catalogue drops them and the UI says why. Getting a wrong
 *   answer quietly would be worse than not answering.
 *
 * ACCURACY — kilometres near epoch, degrading roughly linearly. TLEs are typically
 * refreshed every few hours to a couple of days; past about a week from epoch the result
 * is indicative only, which is why every satellite panel shows its TLE age.
 */

const XKE = 0.07436685316871385; // sqrt(GM_earth) in earth-radii^(3/2)/min
const J2 = 0.001082616;
const J3 = -0.00000253881;
const J4 = -0.00000165597;
const XKMPER = 6378.135; // km per Earth radius, the WGS-72 value SGP4 is fitted to
const MIN_PER_DAY = 1440;
const CK2 = 0.5 * J2;
const CK4 = -0.375 * J4;
const A3OVK2 = -J3 / CK2;

export interface Tle {
  name: string;
  line1: string;
  line2: string;
}

/** The subset of a TLE this app reads, plus its epoch as a Julian Date. */
export interface TleFields {
  noradId: number;
  epochJd: number;
  /** Ballistic coefficient derivative, rev/day^2 — the drag term. */
  bstar: number;
  inclination: number; // rad
  raan: number; // rad
  eccentricity: number;
  argPerigee: number; // rad
  meanAnomaly: number; // rad
  meanMotion: number; // rad/min
  revNumber: number;
}

export interface Sgp4Satellite extends TleFields {
  name: string;
  deepSpace: boolean;
  /** Nodal period, minutes — handy for the UI and for the deep-space cutoff. */
  periodMinutes: number;
  init?: Sgp4Init;
}

interface Sgp4Init {
  aodp: number; cosio: number; sinio: number; x3thm1: number; x1mth2: number; x7thm1: number;
  xmdot: number; omgdot: number; xnodot: number; xnodcf: number; t2cof: number; xlcof: number;
  aycof: number; c1: number; c4: number; c5: number; d2: number; d3: number; d4: number;
  delmo: number; sinmo: number; eta: number; omgcof: number; xmcof: number; t3cof: number;
  t4cof: number; t5cof: number; isimp: boolean; xnodp: number; betao: number; betao2: number;
}

const JD_UNIX_EPOCH = 2440587.5;

/** Convert a TLE's two-digit-year + fractional-day epoch to a Julian Date. */
function tleEpochToJd(epochYear: number, epochDay: number): number {
  const year = epochYear < 57 ? epochYear + 2000 : epochYear + 1900;
  const jan1 = Date.UTC(year, 0, 1) / 86400000 + JD_UNIX_EPOCH;
  return jan1 + epochDay - 1;
}

/** Parse the exponent-notation fields TLEs use, e.g. ` 12345-3` meaning 0.12345e-3. */
function parseDecimalPoint(field: string): number {
  const s = field.trim();
  if (!s) return 0;
  const sign = s.startsWith('-') ? -1 : 1;
  const body = s.replace(/^[+-]/, '');
  const m = body.match(/^(\d+)([+-]\d)$/);
  if (!m) return sign * Number(`0.${body}`);
  return sign * Number(`0.${m[1]}`) * Math.pow(10, Number(m[2]));
}

/** Parse the two data lines of a TLE. Returns null if the lines are malformed. */
export function parseTle(line1: string, line2: string): TleFields | null {
  if (line1.length < 63 || line2.length < 63) return null;
  if (line1[0] !== '1' || line2[0] !== '2') return null;

  const noradId = Number.parseInt(line1.slice(2, 7), 10);
  const epochYear = Number.parseInt(line1.slice(18, 20), 10);
  const epochDay = Number.parseFloat(line1.slice(20, 32));
  const bstar = parseDecimalPoint(line1.slice(53, 61));

  const inclination = Number.parseFloat(line2.slice(8, 16));
  const raan = Number.parseFloat(line2.slice(17, 25));
  const eccentricity = Number.parseFloat(`0.${line2.slice(26, 33).trim()}`);
  const argPerigee = Number.parseFloat(line2.slice(34, 42));
  const meanAnomaly = Number.parseFloat(line2.slice(43, 51));
  const meanMotionRevPerDay = Number.parseFloat(line2.slice(52, 63));
  const revNumber = Number.parseInt(line2.slice(63, 68), 10) || 0;

  const values = [inclination, raan, eccentricity, argPerigee, meanAnomaly, meanMotionRevPerDay];
  if (!Number.isFinite(noradId) || values.some((v) => !Number.isFinite(v))) return null;
  if (eccentricity < 0 || eccentricity >= 1 || meanMotionRevPerDay <= 0) return null;

  return {
    noradId,
    epochJd: tleEpochToJd(epochYear, epochDay),
    bstar,
    inclination: inclination * DEG,
    raan: raan * DEG,
    eccentricity,
    argPerigee: argPerigee * DEG,
    meanAnomaly: meanAnomaly * DEG,
    meanMotion: (meanMotionRevPerDay * 2 * Math.PI) / MIN_PER_DAY,
    revNumber,
  };
}

/** Pre-compute the per-satellite constants SGP4 needs. */
export function sgp4Init(name: string, fields: TleFields): Sgp4Satellite {
  const periodMinutes = (2 * Math.PI) / fields.meanMotion;
  const sat: Sgp4Satellite = { ...fields, name, deepSpace: periodMinutes >= 225, periodMinutes };
  if (sat.deepSpace) return sat;

  const { eccentricity: eo, inclination: xincl, meanMotion: xno, bstar } = fields;

  // Recover the original mean motion and semi-major axis from the Kozai-form element.
  const a1 = Math.pow(XKE / xno, 2 / 3);
  const cosio = Math.cos(xincl);
  const theta2 = cosio * cosio;
  const x3thm1 = 3 * theta2 - 1;
  const eosq = eo * eo;
  const betao2 = 1 - eosq;
  const betao = Math.sqrt(betao2);
  const del1 = (1.5 * CK2 * x3thm1) / (a1 * a1 * betao * betao2);
  const ao = a1 * (1 - del1 * (1 / 3 + del1 * (1 + (134 / 81) * del1)));
  const delo = (1.5 * CK2 * x3thm1) / (ao * ao * betao * betao2);
  const xnodp = xno / (1 + delo);
  const aodp = ao / (1 - delo);

  // Perigee height decides which drag simplifications apply.
  const perigee = (aodp * (1 - eo) - 1) * XKMPER;
  let s4 = 1.01222928;
  let qoms24 = 1.88027916e-9;
  if (perigee < 156) {
    s4 = perigee > 98 ? perigee - 78 : 20;
    qoms24 = Math.pow(((120 - s4) * 1) / XKMPER, 4);
    s4 = s4 / XKMPER + 1;
  }

  const pinvsq = 1 / (aodp * aodp * betao2 * betao2);
  const tsi = 1 / (aodp - s4);
  const eta = aodp * eo * tsi;
  const etasq = eta * eta;
  const eeta = eo * eta;
  const psisq = Math.abs(1 - etasq);
  const coef = qoms24 * Math.pow(tsi, 4);
  const coef1 = coef / Math.pow(psisq, 3.5);

  const c2 =
    coef1 *
    xnodp *
    (aodp * (1 + 1.5 * etasq + eeta * (4 + etasq)) +
      0.75 * CK2 * tsi * (1 / psisq) * x3thm1 * (8 + 3 * etasq * (8 + etasq)));
  const c1 = bstar * c2;
  const sinio = Math.sin(xincl);
  const a3ovk2 = A3OVK2;
  const c3 = eo > 1e-4 ? (coef * tsi * a3ovk2 * xnodp * sinio) / eo : 0;
  const x1mth2 = 1 - theta2;
  const c4 =
    2 *
    xnodp *
    coef1 *
    aodp *
    betao2 *
    (eta * (2 + 0.5 * etasq) +
      eo * (0.5 + 2 * etasq) -
      ((2 * CK2 * tsi) / (aodp * psisq)) *
        (-3 * x3thm1 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) +
          0.75 * x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * fields.argPerigee)));
  const c5 = 2 * coef1 * aodp * betao2 * (1 + 2.75 * (etasq + eeta) + eeta * etasq);

  const theta4 = theta2 * theta2;
  const temp1 = 3 * CK2 * pinvsq * xnodp;
  const temp2 = temp1 * CK2 * pinvsq;
  const temp3 = 1.25 * CK4 * pinvsq * pinvsq * xnodp;

  const xmdot =
    xnodp +
    0.5 * temp1 * betao * x3thm1 +
    0.0625 * temp2 * betao * (13 - 78 * theta2 + 137 * theta4);
  const omgdot =
    -0.5 * temp1 * (1 - 5 * theta2) +
    0.0625 * temp2 * (7 - 114 * theta2 + 395 * theta4) +
    temp3 * (3 - 36 * theta2 + 49 * theta4);
  const xhdot1 = -temp1 * cosio;
  const xnodot =
    xhdot1 + (0.5 * temp2 * (4 - 19 * theta2) + 2 * temp3 * (3 - 7 * theta2)) * cosio;

  const omgcof = bstar * c3 * Math.cos(fields.argPerigee);
  const xmcof = eo > 1e-4 ? (-(2 / 3) * coef * bstar) / eeta : 0;
  const xnodcf = 3.5 * betao2 * xhdot1 * c1;
  const t2cof = 1.5 * c1;
  const xlcof = (0.125 * a3ovk2 * sinio * (3 + 5 * cosio)) / (1 + cosio);
  const aycof = 0.25 * a3ovk2 * sinio;
  const delmo = Math.pow(1 + eta * Math.cos(fields.meanAnomaly), 3);
  const sinmo = Math.sin(fields.meanAnomaly);
  const x7thm1 = 7 * theta2 - 1;

  // `isimp` selects the simplified drag model for short-lived low orbits.
  const isimp = aodp * (1 - eo) / 1 < 220 / XKMPER + 1;

  let d2 = 0, d3 = 0, d4 = 0, t3cof = 0, t4cof = 0, t5cof = 0;
  if (!isimp) {
    const c1sq = c1 * c1;
    d2 = 4 * aodp * tsi * c1sq;
    const temp = (d2 * tsi * c1) / 3;
    d3 = (17 * aodp + s4) * temp;
    d4 = 0.5 * temp * aodp * tsi * (221 * aodp + 31 * s4) * c1;
    t3cof = d2 + 2 * c1sq;
    t4cof = 0.25 * (3 * d3 + c1 * (12 * d2 + 10 * c1sq));
    t5cof = 0.2 * (3 * d4 + 12 * c1 * d3 + 6 * d2 * d2 + 15 * c1sq * (2 * d2 + c1sq));
  }

  sat.init = {
    aodp, cosio, sinio, x3thm1, x1mth2, x7thm1, xmdot, omgdot, xnodot, xnodcf, t2cof,
    xlcof, aycof, c1, c4, c5, d2, d3, d4, delmo, sinmo, eta, omgcof, xmcof, t3cof, t4cof,
    t5cof, isimp, xnodp, betao, betao2,
  };
  return sat;
}

/**
 * Propagate to `minutesSinceEpoch`.
 * Returns TEME position (km) and velocity (km/s), or null if the orbit has decayed.
 */
export function sgp4(sat: Sgp4Satellite, minutesSinceEpoch: number): State | null {
  const k = sat.init;
  if (!k || sat.deepSpace) return null;
  const tsince = minutesSinceEpoch;

  const xmdf = sat.meanAnomaly + k.xmdot * tsince;
  const omgadf = sat.argPerigee + k.omgdot * tsince;
  const xnoddf = sat.raan + k.xnodot * tsince;
  let omega = omgadf;
  let xmp = xmdf;
  const tsq = tsince * tsince;
  const xnode = xnoddf + k.xnodcf * tsq;
  let tempa = 1 - k.c1 * tsince;
  let tempe = sat.bstar * k.c4 * tsince;
  let templ = k.t2cof * tsq;

  if (!k.isimp) {
    const delomg = k.omgcof * tsince;
    const delm = k.xmcof * (Math.pow(1 + k.eta * Math.cos(xmdf), 3) - k.delmo);
    const temp = delomg + delm;
    xmp = xmdf + temp;
    omega = omgadf - temp;
    const tcube = tsq * tsince;
    const tfour = tsince * tcube;
    tempa = tempa - k.d2 * tsq - k.d3 * tcube - k.d4 * tfour;
    tempe = tempe + sat.bstar * k.c5 * (Math.sin(xmp) - k.sinmo);
    templ = templ + k.t3cof * tcube + tfour * (k.t4cof + tsince * k.t5cof);
  }

  const a = k.aodp * tempa * tempa;
  const e = sat.eccentricity - tempe;
  // Decayed or numerically dead: report it rather than returning nonsense.
  if (e >= 1 || e < -0.001 || a < 1) return null;
  const ecc = Math.max(e, 1e-6);

  const xl = xmp + omega + xnode + k.xnodp * templ;
  const beta = Math.sqrt(1 - ecc * ecc);
  const xn = XKE / Math.pow(a, 1.5);

  // Long-period periodics.
  const axn = ecc * Math.cos(omega);
  const temp0 = 1 / (a * beta * beta);
  const xll = temp0 * k.xlcof * axn;
  const aynl = temp0 * k.aycof;
  const xlt = xl + xll;
  const ayn = ecc * Math.sin(omega) + aynl;

  // Solve Kepler's equation in the (axn, ayn) form SGP4 uses.
  const capu = mod2pi(xlt - xnode);
  let epw = capu;
  let sinepw = 0;
  let cosepw = 0;
  for (let i = 0; i < 12; i++) {
    sinepw = Math.sin(epw);
    cosepw = Math.cos(epw);
    const ecosE = axn * cosepw + ayn * sinepw;
    const esinE = axn * sinepw - ayn * cosepw;
    const f = capu - epw + esinE;
    const fp = 1 - ecosE;
    let delta = f / fp;
    if (Math.abs(delta) > 0.95) delta = delta > 0 ? 0.95 : -0.95;
    epw += delta;
    if (Math.abs(delta) < 1e-12) break;
  }

  const ecosE = axn * cosepw + ayn * sinepw;
  const esinE = axn * sinepw - ayn * cosepw;
  const elsq = axn * axn + ayn * ayn;
  const tempS = 1 - elsq;
  const pl = a * tempS;
  if (pl < 0) return null;
  const r = a * (1 - ecosE);
  const rdot = (XKE * Math.sqrt(a) * esinE) / r;
  const rfdot = (XKE * Math.sqrt(pl)) / r;
  const betal = Math.sqrt(tempS);
  const temp3 = esinE / (1 + betal);
  const cosu = (a / r) * (cosepw - axn + ayn * temp3);
  const sinu = (a / r) * (sinepw - ayn - axn * temp3);
  const u = Math.atan2(sinu, cosu);
  const sin2u = 2 * sinu * cosu;
  const cos2u = 1 - 2 * sinu * sinu;
  const tempA = 1 / pl;
  const tempB = CK2 * tempA;
  const tempC = tempB * tempA;

  // Short-period periodics.
  const rk = r * (1 - 1.5 * tempC * betal * k.x3thm1) + 0.5 * tempB * k.x1mth2 * cos2u;
  const uk = u - 0.25 * tempC * k.x7thm1 * sin2u;
  const xnodek = xnode + 1.5 * tempC * k.cosio * sin2u;
  const xinck = sat.inclination + 1.5 * tempC * k.cosio * k.sinio * cos2u;
  const rdotk = rdot - xn * tempB * k.x1mth2 * sin2u;
  const rfdotk = rfdot + xn * tempB * (k.x1mth2 * cos2u + 1.5 * k.x3thm1);

  // Orientation vectors.
  const sinuk = Math.sin(uk);
  const cosuk = Math.cos(uk);
  const sinik = Math.sin(xinck);
  const cosik = Math.cos(xinck);
  const sinnok = Math.sin(xnodek);
  const cosnok = Math.cos(xnodek);
  const xmx = -sinnok * cosik;
  const xmy = cosnok * cosik;
  const ux = xmx * sinuk + cosnok * cosuk;
  const uy = xmy * sinuk + sinnok * cosuk;
  const uz = sinik * sinuk;
  const vx = xmx * cosuk - cosnok * sinuk;
  const vy = xmy * cosuk - sinnok * sinuk;
  const vz = sinik * cosuk;

  // Earth radii and radii/min out; kilometres and km/s in.
  const kmPerMin = XKMPER / 60;
  return {
    position: [rk * ux * XKMPER, rk * uy * XKMPER, rk * uz * XKMPER],
    velocity: [
      (rdotk * ux + rfdotk * vx) * kmPerMin,
      (rdotk * uy + rfdotk * vy) * kmPerMin,
      (rdotk * uz + rfdotk * vz) * kmPerMin,
    ],
  };
}

function mod2pi(x: number): number {
  const r = x % (2 * Math.PI);
  return r < 0 ? r + 2 * Math.PI : r;
}

/** Propagate at a Julian Date rather than minutes-from-epoch. */
export function sgp4At(sat: Sgp4Satellite, jd: number): State | null {
  return sgp4(sat, (jd - sat.epochJd) * MIN_PER_DAY);
}

/**
 * SGP4 works in TEME (true equator, mean equinox); the rest of this app works in the
 * J2000 ecliptic frame. Rotating by the obliquity is the dominant term — the residual
 * TEME-to-J2000 frame bias is under an arcsecond, far below the propagator's own error.
 */
export function temeToEcliptic(v: Vec3): Vec3 {
  return rotateX(v, -OBLIQUITY_J2000);
}

export function temeStateToEcliptic(s: State): State {
  return { position: temeToEcliptic(s.position), velocity: temeToEcliptic(s.velocity) };
}

/** Split a CelesTrak/Space-Track 3LE text blob into TLE records. */
export function parseTleText(text: string): Tle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const out: Tle[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith('1 ')) continue;
    const l2 = lines[i + 1];
    if (!l2?.startsWith('2 ')) continue;
    const prev = lines[i - 1];
    const name = prev && !prev.startsWith('1 ') && !prev.startsWith('2 ')
      ? prev.replace(/^0\s+/, '').trim()
      : `NORAD ${l.slice(2, 7).trim()}`;
    out.push({ name, line1: l, line2: l2 });
    i++;
  }
  return out;
}
