import { AU_KM, DEG, GM, OBLIQUITY_J2000 } from '../astro/constants';
import { elementsFromState, stateFromElements, type State } from '../astro/kepler';
import { moonState } from '../astro/moon';
import { earthState, planetState } from '../astro/planets';
import { sgp4At, temeStateToEcliptic } from '../astro/sgp4';
import { add, cross, length, normalize, rotateX, scale, sub, ZERO, type Vec3 } from '../astro/vec';
import type { Ephemeris, ResolvedObject, SpaceObject } from '../data/types';

/**
 * The world: every catalogue object resolved to a heliocentric state at one instant.
 *
 * Deliberately separate from rendering. Nothing here knows about three.js, the DOM or the
 * camera; it turns (catalogue, time) into positions, and the renderer reads the result.
 * That split is what lets the missions engine, the search ranking and the "surprise me"
 * picker all ask the same questions of the same numbers.
 */

const ZERO_STATE: State = { position: ZERO, velocity: ZERO };

/** Right ascension / declination (equatorial, degrees) to a unit vector in the ecliptic frame. */
export function raDecToEcliptic(raDeg: number, decDeg: number): Vec3 {
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
 * Collinear Lagrange point offsets for the Sun–Earth system.
 * α = (m/3M)^(1/3); the cubic correction is the standard series expansion.
 */
function lagrangeOffset(point: 'L1' | 'L2', sunToEarth: number): number {
  const alpha = Math.cbrt(GM.earth / (3 * GM.sun));
  const f =
    point === 'L1'
      ? alpha - alpha * alpha / 3 - (alpha ** 3) / 9
      : alpha + alpha * alpha / 3 - (alpha ** 3) / 9;
  return sunToEarth * f;
}

export class World {
  private readonly byId = new Map<string, SpaceObject>();
  private cache = new Map<string, State>();
  private cacheJd = Number.NaN;

  constructor(objects: SpaceObject[]) {
    for (const o of objects) this.byId.set(o.id, o);
  }

  get objects(): SpaceObject[] {
    return [...this.byId.values()];
  }

  get(id: string): SpaceObject | undefined {
    return this.byId.get(id);
  }

  add(objects: SpaceObject[]): void {
    for (const o of objects) this.byId.set(o.id, o);
    this.cacheJd = Number.NaN;
  }

  remove(predicate: (o: SpaceObject) => boolean): void {
    for (const [id, o] of this.byId) if (predicate(o)) this.byId.delete(id);
    this.cacheJd = Number.NaN;
  }

  /** Drop the per-instant cache. Called when time moves or the catalogue changes. */
  private ensureEpoch(jd: number): void {
    if (this.cacheJd !== jd) {
      this.cache.clear();
      this.cacheJd = jd;
    }
  }

  /**
   * Heliocentric state of an object, memoised for the current instant.
   *
   * The memo matters: a moon of Jupiter asks for Jupiter, and so do the other three, and
   * so does every orbit sample drawn around it. Without it a frame re-evaluates the same
   * Standish series dozens of times.
   */
  state(id: string, jd: number): State {
    this.ensureEpoch(jd);
    const hit = this.cache.get(id);
    if (hit) return hit;

    const obj = this.byId.get(id);
    if (!obj) return ZERO_STATE;

    // Mark as in-progress to break any accidental parent cycle in the catalogue.
    this.cache.set(id, ZERO_STATE);

    const local = this.localState(obj, jd);
    const parent = obj.parent ? this.state(obj.parent, jd) : ZERO_STATE;
    const result: State = {
      position: add(parent.position, local.position),
      velocity: add(parent.velocity, local.velocity),
    };
    this.cache.set(id, result);
    return result;
  }

  /** State relative to the object's parent. */
  localState(obj: SpaceObject, jd: number): State {
    return evaluate(obj.ephemeris, jd, this);
  }

  /** Resolve one object for display. */
  resolve(obj: SpaceObject, jd: number): ResolvedObject {
    const unplaced =
      obj.ephemeris.kind === 'elements-unphased' ||
      (obj.ephemeris.kind === 'tle' && obj.ephemeris.satellite.deepSpace);

    const local = this.localState(obj, jd);
    const parent = obj.parent ? this.state(obj.parent, jd) : ZERO_STATE;
    return {
      object: obj,
      position: add(parent.position, local.position),
      velocity: add(parent.velocity, local.velocity),
      local: local.position,
      unplaced,
    };
  }

  /** Resolve every object once. Callers filter afterwards. */
  resolveAll(jd: number): ResolvedObject[] {
    this.ensureEpoch(jd);
    return this.objects.map((o) => this.resolve(o, jd));
  }
}

function evaluate(eph: Ephemeris, jd: number, world: World): State {
  switch (eph.kind) {
    case 'sun':
      return ZERO_STATE;

    case 'planet':
      // The Earth entry in the Standish table is the Earth–Moon barycentre.
      return eph.planet === 'earth'
        ? earthState(jd, moonState(jd).position)
        : planetState(eph.planet, jd);

    case 'luna':
      return moonState(jd);

    case 'elements':
      return stateFromElements(eph.elements, jd);

    case 'elements-unphased':
      // Deliberately not placed: the orbit is real, the phase is not known.
      return ZERO_STATE;

    case 'state':
      // A raw state vector (from Horizons, say) propagated on its own osculating conic.
      return stateFromElements(elementsFromState(eph.state, GM.sun, eph.epoch), jd);

    case 'tle': {
      const teme = sgp4At(eph.satellite, jd);
      return teme ? temeStateToEcliptic(teme) : ZERO_STATE;
    }

    case 'radiant': {
      const dir = raDecToEcliptic(eph.raDeg, eph.decDeg);
      const secs = (jd - eph.epoch) * 86_400;
      const r = eph.auAtEpoch * AU_KM + eph.kmPerSec * secs;
      return { position: scale(dir, r), velocity: scale(dir, eph.kmPerSec) };
    }

    case 'lagrange': {
      // Positions are relative to the Earth, which is this object's parent.
      const earth = world.state('earth', jd);
      const sunToEarth = length(earth.position);
      if (sunToEarth === 0) return ZERO_STATE;

      const outward = normalize(earth.position);
      const d = lagrangeOffset(eph.point, sunToEarth);
      const alongLine = scale(outward, eph.point === 'L2' ? d : -d);

      if (!eph.haloKm) return { position: alongLine, velocity: ZERO };

      // A representative halo: a circle in the plane normal to the Sun–Earth line. Real
      // halo orbits are Lissajous figures with two unequal amplitudes; this is labelled
      // as indicative in the object's provenance.
      const normal = normalize(cross(outward, earth.velocity));
      const inPlane = normalize(cross(normal, outward));
      const theta =
        ((jd - 2451545.0) / (eph.haloPeriodDays ?? 180)) * Math.PI * 2 + (eph.phase ?? 0);
      const halo = add(
        scale(inPlane, Math.cos(theta) * eph.haloKm),
        scale(normal, Math.sin(theta) * eph.haloKm * 0.58),
      );
      return { position: add(alongLine, halo), velocity: ZERO };
    }

    default: {
      const never: never = eph;
      void never;
      return ZERO_STATE;
    }
  }
}

/** Distance between two resolved objects, km. */
export const separation = (a: ResolvedObject, b: ResolvedObject): number =>
  length(sub(a.position, b.position));
