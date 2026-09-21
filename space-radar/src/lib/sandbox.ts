import { AU_KM, GM, RADIUS } from './astro/constants';
import {
  elementsFromState,
  periodDays,
  sampleOrbit,
  stateFromElements,
  type Elements,
  type State,
} from './astro/kepler';
import { add, length, normalize, scale, sub, type Vec3 } from './astro/vec';
import type { World } from './sim/world';

/**
 * The WHAT IF sandbox.
 *
 * Every result here is a two-body Newtonian solution: one central mass, one test particle,
 * no perturbations. That model is *exact* for the questions it is asked — move the Earth
 * outward and its new period really is given by Kepler's third law — and it is hopeless
 * for anything involving a third body. The UI labels every output
 * `SIMULATION — NOT A REAL TRAJECTORY` and the notes below state the specific limitation
 * for each scenario, because the honest answer to "what if the Moon were twice as far" is
 * "here is the two-body consequence, and here is what this model cannot tell you".
 */

export type ScenarioId =
  | 'earth-distance'
  | 'moon-distance'
  | 'velocity-scale'
  | 'solar-mass';

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  /** Two or three characters for the tab strip — the full title does not fit. */
  tab: string;
  question: string;
  /** Which object the scenario acts on, when it is not fixed. */
  appliesTo: 'earth' | 'moon' | 'selection' | 'system';
  unit: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
  format: (v: number) => string;
  /** What this model genuinely cannot tell you. Always shown. */
  caveat: string;
}

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'earth-distance',
    tab: 'EARTH',
    title: 'MOVE THE EARTH',
    question: 'What if Earth orbited at a different distance from the Sun?',
    appliesTo: 'earth',
    unit: '× current distance',
    min: 0.5,
    max: 2.0,
    step: 0.01,
    neutral: 1,
    format: (v) => `${v.toFixed(2)}×`,
    caveat:
      'Two-body only. The new orbital period and the sunlight received are exact consequences of the change. The climate numbers are a blackbody estimate with Earth’s present albedo and no atmosphere model — a real Earth would not simply scale.',
  },
  {
    id: 'moon-distance',
    tab: 'MOON',
    title: 'MOVE THE MOON',
    question: 'What if the Moon orbited at a different distance from Earth?',
    appliesTo: 'moon',
    unit: '× current distance',
    min: 0.25,
    max: 4,
    step: 0.05,
    neutral: 1,
    format: (v) => `${v.toFixed(2)}×`,
    caveat:
      'Two-body only. Period and tidal scaling are exact for this model. Whether the resulting system is stable over billions of years is a question this model cannot answer.',
  },
  {
    id: 'velocity-scale',
    tab: 'VELOCITY',
    title: 'CHANGE ORBITAL VELOCITY',
    question: 'What if the selected object were moving faster or slower?',
    appliesTo: 'selection',
    unit: '× current speed',
    min: 0.4,
    max: 1.65,
    step: 0.01,
    neutral: 1,
    format: (v) => `${v.toFixed(2)}×`,
    caveat:
      'The new conic is exact for a two-body problem. Real trajectories are bent by every other mass in the system, and a real burn would take time rather than happening instantly.',
  },
  {
    id: 'solar-mass',
    tab: 'THE SUN',
    title: 'CHANGE THE SUN',
    question: 'What if the Sun had a different mass?',
    appliesTo: 'system',
    unit: '× solar mass',
    min: 0.4,
    max: 2.5,
    step: 0.02,
    neutral: 1,
    format: (v) => `${v.toFixed(2)} M☉`,
    caveat:
      'Positions and speeds are held at the instant of the change and the orbits re-derived. This is not a model of stellar evolution — changing the Sun’s mass in reality would take it off the main sequence.',
  },
];

export interface ScenarioResult {
  /** The hypothetical path, heliocentric km, ready to draw. */
  path: Vec3[];
  /** The unmodified path, for comparison. */
  reference: Vec3[];
  /** Headline consequences of the change. */
  readouts: { label: string; value: string; delta?: string }[];
  /** True when the change unbinds the object. */
  escapes: boolean;
  caveat: string;
  /** Parent body the path is drawn around. */
  parentId: string | null;
}

const BLACKBODY_EARTH_K = 278.6; // equilibrium temperature at 1 AU with zero albedo

/** Equilibrium temperature at a given distance, with Earth's present albedo. */
function equilibriumTempC(au: number, albedo = 0.306): number {
  const t = BLACKBODY_EARTH_K * Math.pow(1 - albedo, 0.25) / Math.sqrt(au);
  return t - 273.15;
}

function pathFrom(elements: Elements, jd: number, parentPos: Vec3): Vec3[] {
  return sampleOrbit(elements, elements.e >= 1 ? 160 : 220, jd).map((p) => add(p, parentPos));
}

/** Scale the distance of a body from its parent, preserving a circularised orbit shape. */
function scaleOrbitRadius(state: State, mu: number, factor: number): State {
  const r = length(state.position);
  const newR = r * factor;
  const dir = normalize(state.position);
  // Keep the direction of motion, rescale the speed to the value the new radius implies
  // for the same orbit shape. For a circular orbit this is exactly v = sqrt(mu/r).
  const vDir = normalize(state.velocity);
  const oldSpeed = length(state.velocity);
  const circularOld = Math.sqrt(mu / r);
  const shapeRatio = oldSpeed / circularOld;
  const newSpeed = Math.sqrt(mu / newR) * shapeRatio;
  return { position: scale(dir, newR), velocity: scale(vDir, newSpeed) };
}

export function runScenario(
  world: World,
  jd: number,
  id: ScenarioId,
  value: number,
  selectionId: string | null,
): ScenarioResult | null {
  switch (id) {
    case 'earth-distance': {
      const earth = world.get('earth');
      if (!earth) return null;
      const state = world.state('earth', jd);
      const modified = scaleOrbitRadius(state, GM.sun, value);
      const el = elementsFromState(modified, GM.sun, jd);
      const refEl = elementsFromState(state, GM.sun, jd);
      const period = periodDays(el);
      const refPeriod = periodDays(refEl);
      const au = length(modified.position) / AU_KM;
      const flux = 1361 / (au * au);

      return {
        path: pathFrom(el, jd, [0, 0, 0]),
        reference: pathFrom(refEl, jd, [0, 0, 0]),
        escapes: el.e >= 1,
        parentId: 'sun',
        caveat: SCENARIOS[0]!.caveat,
        readouts: [
          { label: 'Orbital radius', value: `${au.toFixed(3)} AU` },
          {
            label: 'Year length',
            value: period ? `${period.toFixed(1)} days` : 'unbound',
            ...(period && refPeriod ? { delta: `${(period / refPeriod).toFixed(2)}× today` } : {}),
          },
          { label: 'Sunlight received', value: `${flux.toFixed(0)} W/m²`, delta: `${(flux / 1361).toFixed(2)}× today` },
          { label: 'Equilibrium temperature', value: `${equilibriumTempC(au).toFixed(1)} °C`, delta: 'blackbody, present albedo' },
          {
            label: 'Liquid water',
            value: au < 0.95 ? 'Too hot — runaway greenhouse likely' : au > 1.37 ? 'Too cold — global glaciation likely' : 'Within the conservative habitable zone',
          },
        ],
      };
    }

    case 'moon-distance': {
      const state = world.localState(world.get('moon')!, jd);
      const modified = scaleOrbitRadius(state, GM.earth, value);
      const el = elementsFromState(modified, GM.earth, jd);
      const refEl = elementsFromState(state, GM.earth, jd);
      const earthPos = world.state('earth', jd).position;
      const period = periodDays(el);
      const r = length(modified.position);

      // Tidal acceleration goes as 1/r^3; angular size as 1/r.
      const tidal = Math.pow(1 / value, 3);
      const angular = (2 * Math.atan(RADIUS.moon / r) * 180) / Math.PI;

      return {
        path: pathFrom(el, jd, earthPos),
        reference: pathFrom(refEl, jd, earthPos),
        escapes: r > 1.5e6, // beyond Earth's Hill radius the Sun takes over
        parentId: 'earth',
        caveat: SCENARIOS[1]!.caveat,
        readouts: [
          { label: 'Distance', value: `${Math.round(r).toLocaleString('en-US')} km` },
          { label: 'Month length', value: period ? `${period.toFixed(2)} days` : 'unbound', delta: `${(period! / 27.32).toFixed(2)}× today` },
          { label: 'Tidal force', value: `${tidal.toFixed(2)}× today` },
          { label: 'Apparent size', value: `${angular.toFixed(2)}°`, delta: `Sun is 0.53°` },
          {
            label: 'Total solar eclipses',
            value: angular < 0.53 ? 'Impossible — the Moon is too small to cover the Sun' : 'Still possible',
          },
          {
            label: 'Beyond Earth’s Hill sphere',
            value: r > 1.5e6 ? 'YES — the Sun would take the Moon' : 'No — still bound to Earth',
          },
        ],
      };
    }

    case 'velocity-scale': {
      const obj = selectionId ? world.get(selectionId) : null;
      if (!obj || obj.id === 'sun') return null;
      const parentId = obj.parent ?? 'sun';
      const mu = parentId === 'sun' ? GM.sun : (GM[parentId as keyof typeof GM] ?? GM.sun);
      const local = world.localState(obj, jd);
      if (length(local.velocity) === 0) return null;

      const modified: State = { position: local.position, velocity: scale(local.velocity, value) };
      const el = elementsFromState(modified, mu, jd);
      const refEl = elementsFromState(local, mu, jd);
      const parentPos = parentId === 'sun' ? ([0, 0, 0] as Vec3) : world.state(parentId, jd).position;

      const period = periodDays(el);
      const escape = Math.sqrt((2 * mu) / length(local.position));
      const newSpeed = length(modified.velocity);
      const peri = el.a * (1 - el.e);
      const apo = el.e < 1 ? el.a * (1 + el.e) : null;
      const parentRadius = parentId === 'sun' ? RADIUS.sun : (RADIUS[parentId as keyof typeof RADIUS] ?? 0);

      return {
        path: pathFrom(el, jd, parentPos),
        reference: pathFrom(refEl, jd, parentPos),
        escapes: el.e >= 1,
        parentId,
        caveat: SCENARIOS[2]!.caveat,
        readouts: [
          { label: 'New speed', value: `${newSpeed.toFixed(3)} km/s`, delta: `escape speed here is ${escape.toFixed(3)} km/s` },
          { label: 'Eccentricity', value: el.e.toFixed(4), delta: el.e >= 1 ? 'hyperbolic — unbound' : el.e > 0.6 ? 'highly elliptical' : 'bound' },
          { label: 'Closest approach', value: `${Math.round(peri).toLocaleString('en-US')} km` },
          { label: 'Farthest point', value: apo ? `${Math.round(apo).toLocaleString('en-US')} km` : 'never returns' },
          { label: 'New period', value: period ? `${period.toFixed(period < 10 ? 3 : 1)} days` : '—' },
          ...(parentRadius > 0 && peri < parentRadius
            ? [{ label: 'Outcome', value: `IMPACT — periapsis is below the surface of ${parentId.toUpperCase()}` }]
            : []),
        ],
      };
    }

    case 'solar-mass': {
      const obj = selectionId ? world.get(selectionId) : world.get('earth');
      if (!obj) return null;
      const target = obj.parent === 'sun' ? obj : world.get('earth')!;
      const state = world.state(target.id, jd);
      const mu = GM.sun * value;
      const el = elementsFromState(state, mu, jd);
      const refEl = elementsFromState(state, GM.sun, jd);
      const period = periodDays(el);
      const refPeriod = periodDays(refEl);
      const escape = Math.sqrt((2 * mu) / length(state.position));

      return {
        path: pathFrom(el, jd, [0, 0, 0]),
        reference: pathFrom(refEl, jd, [0, 0, 0]),
        escapes: el.e >= 1,
        parentId: 'sun',
        caveat: SCENARIOS[3]!.caveat,
        readouts: [
          { label: 'Applied to', value: target.name },
          { label: 'Solar mass', value: `${value.toFixed(2)} M☉` },
          { label: 'Orbit', value: el.e >= 1 ? 'UNBOUND — thrown out of the system' : `e = ${el.e.toFixed(4)}` },
          {
            label: 'Year length',
            value: period ? `${(period / 365.25).toFixed(3)} years` : 'unbound',
            ...(period && refPeriod ? { delta: `${(period / refPeriod).toFixed(2)}× today` } : {}),
          },
          { label: 'Escape speed here', value: `${escape.toFixed(2)} km/s`, delta: `orbiting at ${length(state.velocity).toFixed(2)} km/s` },
          {
            label: 'Main-sequence lifetime',
            value: `${(10 * Math.pow(value, -2.5)).toFixed(1)} billion years`,
            delta: 'from the mass–luminosity relation',
          },
        ],
      };
    }

    default:
      return null;
  }
}

/**
 * A small RK4 propagator, offered for the cases where a conic genuinely is not enough.
 * Not used by the scenarios above — they have exact solutions — but available to the
 * sandbox for free-flight experiments, and honest about its step size.
 */
export function integrateRk4(
  initial: State,
  mu: number,
  totalSeconds: number,
  steps: number,
): Vec3[] {
  const h = totalSeconds / steps;
  const out: Vec3[] = [initial.position];
  let pos = initial.position;
  let vel = initial.velocity;

  const accel = (p: Vec3): Vec3 => {
    const r = length(p);
    return scale(p, -mu / (r * r * r));
  };

  for (let i = 0; i < steps; i++) {
    const k1v = accel(pos);
    const k1p = vel;
    const k2v = accel(add(pos, scale(k1p, h / 2)));
    const k2p = add(vel, scale(k1v, h / 2));
    const k3v = accel(add(pos, scale(k2p, h / 2)));
    const k3p = add(vel, scale(k2v, h / 2));
    const k4v = accel(add(pos, scale(k3p, h)));
    const k4p = add(vel, scale(k3v, h));

    pos = add(pos, scale(add(add(k1p, scale(k2p, 2)), add(scale(k3p, 2), k4p)), h / 6));
    vel = add(vel, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), h / 6));
    out.push(pos);
  }
  return out;
}

export const sandboxDistanceLabel = (v: Vec3): string =>
  `${(length(v) / AU_KM).toFixed(3)} AU`;

export { sub as sandboxSub };
