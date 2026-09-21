import { AU_KM, C_KM_S } from './astro/constants';
import { periodDays } from './astro/kepler';
import { distance, length } from './astro/vec';
import type { ResolvedObject } from './data/types';
import type { World } from './sim/world';
import { formatDistanceInline, formatDuration, formatSpeed } from './format';

/**
 * Missions.
 *
 * Every mission is a *question about the current state of the simulation*, answered by
 * evaluating the same numbers the rest of the app displays. Nothing is hard-coded: "find
 * the spacecraft farthest from Earth" is resolved by measuring, so the answer changes as
 * the catalogue grows, as live data arrives, and as you move through time.
 *
 * That also means a mission can be *checked* honestly — selecting the right object is
 * verified against a fresh measurement, not against a stored answer key.
 *
 * Progress lives in localStorage. No account, no server, nothing to sign up for.
 */

export interface Mission {
  id: string;
  code: string;
  title: string;
  brief: string;
  /** Extra nudge, revealed on request. */
  hint: string;
  /** Ids that satisfy the mission at this instant. */
  answers: string[];
  /** Shown on completion — the actual measured value. */
  reveal: (world: World, jd: number) => string;
  difficulty: 1 | 2 | 3;
  /** Set when the mission needs the user to move through time as well as find something. */
  requiresTimeTravel?: boolean;
}

const STORAGE_KEY = 'space-radar.missions.v1';

export interface MissionProgress {
  completed: string[];
  active: string | null;
}

export function loadProgress(): MissionProgress {
  if (typeof localStorage === 'undefined') return { completed: [], active: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: [], active: null };
    const parsed = JSON.parse(raw) as Partial<MissionProgress>;
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed.filter((x) => typeof x === 'string') : [],
      active: typeof parsed.active === 'string' ? parsed.active : null,
    };
  } catch {
    // Corrupt or blocked storage is not worth a crash — start fresh.
    return { completed: [], active: null };
  }
}

export function saveProgress(p: MissionProgress): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Private browsing, quota, or a blocked origin. Progress is a nicety, not a feature
    // the app depends on.
  }
}

// ---------------------------------------------------------------------------

const isSpacecraft = (r: ResolvedObject) => r.object.kind === 'spacecraft' && !r.unplaced;
const isRealObject = (r: ResolvedObject) =>
  !r.unplaced && r.object.provenance.tier !== 'simulated';

function maxBy<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const s = score(item);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return best;
}

function minBy<T>(items: T[], score: (t: T) => number): T | null {
  return maxBy(items, (t) => -score(t));
}

/**
 * Build the mission list against the current world.
 * Called whenever the catalogue changes so live objects can become answers.
 */
export function buildMissions(world: World, jd: number): Mission[] {
  const resolved = world.resolveAll(jd);
  const earth = resolved.find((r) => r.object.id === 'earth');
  const earthPos = earth?.position ?? ([0, 0, 0] as const);

  const fromEarth = (r: ResolvedObject) => distance(r.position, earthPos);
  const fromSun = (r: ResolvedObject) => length(r.position);

  const missions: Mission[] = [];
  const push = (m: Omit<Mission, 'code'>) => {
    missions.push({ ...m, code: `MISSION ${String(missions.length + 1).padStart(3, '0')}` });
  };

  const farthestCraft = maxBy(resolved.filter(isSpacecraft), fromEarth);
  if (farthestCraft) {
    push({
      id: 'farthest-spacecraft',
      title: 'THE LONG WAY OUT',
      brief: 'Find the spacecraft currently farthest from Earth.',
      hint: 'It launched in 1977 and its radio signal now takes almost a day to reach us.',
      answers: [farthestCraft.object.id],
      difficulty: 1,
      reveal: (w, t) => {
        const r = w.resolve(w.get(farthestCraft.object.id)!, t);
        const km = distance(r.position, w.state('earth', t).position);
        return `${formatDistanceInline(km)} from Earth — a radio round trip of ${formatDuration(((km / C_KM_S) * 2) / 86400)}.`;
      },
    });
  }

  const fastest = maxBy(resolved.filter(isRealObject), (r) => length(r.velocity));
  if (fastest) {
    push({
      id: 'fastest-object',
      title: 'TERMINAL VELOCITY',
      brief: 'Find the fastest-moving object in the catalogue.',
      hint: 'Speed comes from falling. Look for whatever is closest to the Sun right now.',
      answers: [fastest.object.id],
      difficulty: 2,
      reveal: (w, t) => {
        const r = w.resolve(w.get(fastest.object.id)!, t);
        return `${formatSpeed(length(r.velocity))} — ${((length(r.velocity) / C_KM_S) * 100).toFixed(3)}% of the speed of light.`;
      },
    });
  }

  const insideEarthOrbit = resolved.filter(
    (r) => isRealObject(r) && r.object.parent === 'sun' && fromSun(r) < 0.98 * AU_KM && r.object.id !== 'sun',
  );
  if (insideEarthOrbit.length > 0) {
    push({
      id: 'inside-earth-orbit',
      title: 'INSIDE THE LINE',
      brief: "Find an object currently orbiting inside Earth's orbital radius.",
      hint: 'Two planets qualify permanently. Others drift in and out — check the small bodies.',
      answers: insideEarthOrbit.map((r) => r.object.id),
      difficulty: 1,
      reveal: (w, t) => {
        const hits = w
          .resolveAll(t)
          .filter((r) => isRealObject(r) && r.object.parent === 'sun' && length(r.position) < 0.98 * AU_KM && r.object.id !== 'sun');
        return `${hits.length} catalogued object${hits.length === 1 ? '' : 's'} are inside 0.98 AU at this instant.`;
      },
    });
  }

  const mostEccentric = maxBy(
    resolved.filter((r) => isRealObject(r) && r.object.ephemeris.kind === 'elements' && r.object.parent === 'sun'),
    (r) => (r.object.ephemeris.kind === 'elements' ? r.object.ephemeris.elements.e : 0),
  );
  if (mostEccentric) {
    push({
      id: 'most-eccentric',
      title: 'THE LONG ELLIPSE',
      brief: 'Find the object on the most stretched-out orbit around the Sun.',
      hint: 'Turn on ORBITS and look for the track that barely fits on screen.',
      answers: [mostEccentric.object.id],
      difficulty: 2,
      reveal: () => {
        const e = mostEccentric.object.ephemeris.kind === 'elements' ? mostEccentric.object.ephemeris.elements.e : 0;
        return `Eccentricity ${e.toFixed(4)}. A circle is 0; anything at or above 1 never comes back.`;
      },
    });
  }

  const unbound = resolved.filter(
    (r) => r.object.ephemeris.kind === 'elements' && r.object.ephemeris.elements.e >= 1,
  );
  if (unbound.length > 0) {
    push({
      id: 'unbound',
      title: 'JUST PASSING THROUGH',
      brief: 'Find an object on an orbit that will never bring it back to the Sun.',
      hint: 'It did not form here. Its orbit is an open curve, not a closed loop.',
      answers: unbound.map((r) => r.object.id),
      difficulty: 2,
      reveal: () => `${unbound.length} object${unbound.length === 1 ? '' : 's'} in the catalogue are on hyperbolic, unbound orbits.`,
    });
  }

  const retrograde = resolved.filter(
    (r) => r.object.ephemeris.kind === 'elements' && r.object.ephemeris.elements.i > Math.PI / 2 && r.object.parent === 'sun',
  );
  if (retrograde.length > 0) {
    push({
      id: 'retrograde',
      title: 'AGAINST THE TRAFFIC',
      brief: 'Find an object orbiting the Sun backwards, against the direction of the planets.',
      hint: 'Its inclination is greater than 90°. It is famous, and it comes back every 75 years or so.',
      answers: retrograde.map((r) => r.object.id),
      difficulty: 2,
      reveal: () => {
        const el = retrograde[0]!.object.ephemeris.kind === 'elements' ? retrograde[0]!.object.ephemeris.elements : null;
        return el ? `Inclination ${((el.i * 180) / Math.PI).toFixed(2)}° — more than 90°, so it goes round the wrong way.` : '';
      },
    });
  }

  const closestToSun = minBy(
    resolved.filter((r) => isRealObject(r) && r.object.id !== 'sun' && r.object.parent === 'sun'),
    fromSun,
  );
  if (closestToSun) {
    push({
      id: 'closest-to-sun',
      title: 'CLOSE TO THE FIRE',
      brief: 'Find the catalogued object closest to the Sun at this instant.',
      hint: 'Change the time and the answer changes. Try scrubbing forward a few weeks.',
      answers: [closestToSun.object.id],
      difficulty: 3,
      requiresTimeTravel: true,
      reveal: (w, t) => {
        const hit = minBy(
          w.resolveAll(t).filter((r) => isRealObject(r) && r.object.id !== 'sun' && r.object.parent === 'sun'),
          (r) => length(r.position),
        );
        return hit ? `${hit.object.name}, at ${(length(hit.position) / AU_KM).toFixed(4)} AU from the Sun.` : '';
      },
    });
  }

  const shortestPeriod = minBy(
    resolved.filter(
      (r) =>
        isRealObject(r) &&
        r.object.ephemeris.kind === 'elements' &&
        (periodDays(r.object.ephemeris.elements) ?? Infinity) > 0,
    ),
    (r) => (r.object.ephemeris.kind === 'elements' ? (periodDays(r.object.ephemeris.elements) ?? Infinity) : Infinity),
  );
  if (shortestPeriod) {
    push({
      id: 'shortest-year',
      title: 'THE SHORT YEAR',
      brief: 'Find the real object with the shortest orbital period.',
      hint: 'Smaller orbits are faster. Check the moons before you check the planets.',
      answers: [shortestPeriod.object.id],
      difficulty: 2,
      reveal: () => {
        const el = shortestPeriod.object.ephemeris.kind === 'elements' ? shortestPeriod.object.ephemeris.elements : null;
        const p = el ? periodDays(el) : null;
        return p ? `One orbit every ${formatDuration(p)}.` : '';
      },
    });
  }

  const simulated = resolved.filter((r) => r.object.provenance.tier === 'simulated');
  if (simulated.length > 0) {
    push({
      id: 'find-the-fake',
      title: 'TRUST NOTHING',
      brief: 'Find an object in this app that is NOT real.',
      hint: 'Open any object panel and read the provenance strip at the bottom. One tier means "generated here".',
      answers: simulated.map((r) => r.object.id),
      difficulty: 1,
      reveal: () =>
        `${simulated.length} objects in this view are simulated. They sit in real orbital shells, but no such satellite exists.`,
    });
  }

  push({
    id: 'eclipse-geometry',
    title: 'LINE THEM UP',
    brief: 'Travel in time until the Moon sits almost exactly between Earth and the Sun, then select it.',
    hint: 'That is a new moon, and it happens every 29.5 days. Use the 1 DAY/S rate and watch the Moon’s phase readout.',
    answers: ['moon'],
    difficulty: 3,
    requiresTimeTravel: true,
    reveal: (w, t) => {
      const moon = w.localState(w.get('moon')!, t).position;
      const earth = w.state('earth', t).position;
      const toSun = [-earth[0], -earth[1], -earth[2]] as const;
      const cos =
        (moon[0] * toSun[0] + moon[1] * toSun[1] + moon[2] * toSun[2]) /
        (length(moon) * length(toSun));
      const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      return `Sun–Earth–Moon angle is ${angle.toFixed(1)}°. Under about 5° and an eclipse becomes possible.`;
    },
  });

  const mostDistantReal = maxBy(resolved.filter(isRealObject), fromSun);
  if (mostDistantReal) {
    push({
      id: 'edge-of-catalog',
      title: 'THE FAR EDGE',
      brief: 'Find the most distant real object this instrument is tracking.',
      hint: 'Zoom all the way out. It is not a planet.',
      answers: [mostDistantReal.object.id],
      difficulty: 1,
      reveal: (w, t) => {
        const r = w.resolve(w.get(mostDistantReal.object.id)!, t);
        return `${(length(r.position) / AU_KM).toFixed(1)} AU from the Sun — light from here takes ${formatDuration(length(r.position) / C_KM_S / 86400)} to arrive.`;
      },
    });
  }

  return missions;
}

/** True when the selected object satisfies the mission. */
export function checkMission(mission: Mission, world: World, jd: number, selectedId: string | null): boolean {
  if (!selectedId) return false;
  // Re-derive rather than trusting the answers captured when the list was built: time may
  // have moved, and for the time-travel missions that is the entire point.
  const fresh = buildMissions(world, jd).find((m) => m.id === mission.id);
  const answers = fresh ? fresh.answers : mission.answers;

  if (mission.id === 'eclipse-geometry') {
    if (selectedId !== 'moon') return false;
    const moon = world.localState(world.get('moon')!, jd).position;
    const earth = world.state('earth', jd).position;
    const cos =
      (moon[0] * -earth[0] + moon[1] * -earth[1] + moon[2] * -earth[2]) /
      (length(moon) * length(earth));
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    return angle < 8;
  }

  return answers.includes(selectedId);
}
