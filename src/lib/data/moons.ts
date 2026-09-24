import { GM, RADIUS } from '../astro/constants';
import { equatorialElementsToEcliptic } from '../astro/frames';
import { periodDays } from '../astro/kepler';
import { POLE, type PlanetId } from '../astro/planets';
import type { Provenance, SpaceObject } from './types';

/**
 * The natural satellites.
 *
 * Each entry quotes the values as they are published: semi-major axis in km,
 * eccentricity, and inclination **relative to the parent planet's equator** (or, for the
 * distant irregulars, its local Laplace plane, which is close enough at this scale). The
 * conversion into the app's J2000 ecliptic frame is done by `equatorialElementsToEcliptic`
 * from the planet's IAU pole, so what is written here can be checked against any
 * reference without first undoing an inclination someone folded a planet's tilt into.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *   Real: the size, shape and tilt of every orbit, and therefore the orbital period, the
 *   speed, and where the orbit sits relative to its planet and its neighbours.
 *   Not fitted: where along the orbit a moon is at a given instant. Longitudes of the
 *   node and periapsis for these bodies precess quickly and are not carried here, so each
 *   moon is given a deterministic phase from a fixed seed. Every moon's provenance says
 *   so, and the UI shows it.
 *
 * That trade is deliberate. Getting 57 orbital geometries right is worth far more to
 * someone flying around the Jovian system than getting four of them phased correctly and
 * omitting the rest.
 */

/** Deterministic phases, so the system looks the same on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MoonSpec {
  id: string;
  name: string;
  parent: PlanetId;
  /** Mean radius, km. */
  r: number;
  /** Semi-major axis, km. */
  a: number;
  e: number;
  /** Inclination to the parent's equator / Laplace plane, degrees. */
  i: number;
  /** Discovery year, where it adds something. */
  year?: number;
  note?: string;
  /** Raises label priority for the ones worth finding. */
  major?: boolean;
}

// Roman numeral order within each system, inner to outer.
const SPECS: readonly MoonSpec[] = [
  // ---- Mars ----------------------------------------------------------------
  { id: 'phobos', name: 'PHOBOS', parent: 'mars', r: 11.27, a: 9_376, e: 0.0151, i: 1.075, year: 1877, major: true, note: 'Orbits faster than Mars rotates, so it rises in the west. Spiralling inward; it will break up in ~50 million years.' },
  { id: 'deimos', name: 'DEIMOS', parent: 'mars', r: 6.2, a: 23_463, e: 0.00033, i: 1.788, year: 1877, major: true, note: 'Only 12 km across. From the Martian surface it is little more than a bright star.' },

  // ---- Jupiter -------------------------------------------------------------
  { id: 'metis', name: 'METIS', parent: 'jupiter', r: 21.5, a: 128_000, e: 0.0002, i: 0.06, year: 1979, note: 'Inside the main ring, and a major source of its dust.' },
  { id: 'adrastea', name: 'ADRASTEA', parent: 'jupiter', r: 8.2, a: 129_000, e: 0.0015, i: 0.03, year: 1979, note: 'One of the smallest moons of Jupiter, and a shepherd of the main ring.' },
  { id: 'amalthea', name: 'AMALTHEA', parent: 'jupiter', r: 83.5, a: 181_400, e: 0.003, i: 0.37, year: 1892, note: 'Reddest object in the Solar System, probably coloured by sulphur from Io.' },
  { id: 'thebe', name: 'THEBE', parent: 'jupiter', r: 49.3, a: 221_900, e: 0.018, i: 1.08, year: 1979 },
  { id: 'io', name: 'IO', parent: 'jupiter', r: 1_821.6, a: 421_800, e: 0.0041, i: 0.036, year: 1610, major: true, note: 'The most volcanically active body known. Tidal flexing from Jupiter keeps its interior molten.' },
  { id: 'europa', name: 'EUROPA', parent: 'jupiter', r: 1_560.8, a: 671_100, e: 0.0094, i: 0.466, year: 1610, major: true, note: 'A shell of ice over a salt-water ocean with more water than all of Earth’s.' },
  { id: 'ganymede', name: 'GANYMEDE', parent: 'jupiter', r: 2_634.1, a: 1_070_400, e: 0.0013, i: 0.177, year: 1610, major: true, note: 'Largest moon in the Solar System — bigger than Mercury — and the only one with its own magnetic field.' },
  { id: 'callisto', name: 'CALLISTO', parent: 'jupiter', r: 2_410.3, a: 1_882_700, e: 0.0074, i: 0.192, year: 1610, major: true, note: 'The most heavily cratered surface known. Outside the worst of Jupiter’s radiation belts.' },
  { id: 'themisto', name: 'THEMISTO', parent: 'jupiter', r: 4, a: 7_393_000, e: 0.242, i: 43.08, year: 1975, note: 'Orbits alone between the inner moons and the irregular swarms.' },
  { id: 'leda', name: 'LEDA', parent: 'jupiter', r: 10, a: 11_165_000, e: 0.164, i: 27.46, year: 1974 },
  { id: 'himalia', name: 'HIMALIA', parent: 'jupiter', r: 69.8, a: 11_461_000, e: 0.162, i: 27.5, year: 1904, note: 'Largest of Jupiter’s irregular moons — a captured asteroid.' },
  { id: 'lysithea', name: 'LYSITHEA', parent: 'jupiter', r: 21, a: 11_717_000, e: 0.112, i: 28.3, year: 1938 },
  { id: 'elara', name: 'ELARA', parent: 'jupiter', r: 43, a: 11_741_000, e: 0.217, i: 26.63, year: 1905 },
  { id: 'ananke', name: 'ANANKE', parent: 'jupiter', r: 14, a: 21_276_000, e: 0.244, i: 148.9, year: 1951, note: 'Retrograde. Namesake of a whole family of captured fragments.' },
  { id: 'carme', name: 'CARME', parent: 'jupiter', r: 23, a: 23_404_000, e: 0.253, i: 164.9, year: 1938, note: 'Retrograde, and the largest of its family.' },
  { id: 'pasiphae', name: 'PASIPHAE', parent: 'jupiter', r: 30, a: 23_624_000, e: 0.409, i: 151.4, year: 1908, note: 'Retrograde, on a markedly eccentric orbit.' },
  { id: 'sinope', name: 'SINOPE', parent: 'jupiter', r: 19, a: 23_939_000, e: 0.25, i: 158.1, year: 1914, note: 'Retrograde; for decades the outermost known moon of Jupiter.' },

  // ---- Saturn --------------------------------------------------------------
  { id: 'pan', name: 'PAN', parent: 'saturn', r: 14.1, a: 133_584, e: 0.0000, i: 0.0, year: 1990, note: 'Orbits inside the Encke Gap and keeps it open. Shaped like a ravioli.' },
  { id: 'atlas', name: 'ATLAS', parent: 'saturn', r: 15.1, a: 137_670, e: 0.0012, i: 0.003, year: 1980, note: 'Has an enormous equatorial ridge of accreted ring material.' },
  { id: 'prometheus', name: 'PROMETHEUS', parent: 'saturn', r: 43.1, a: 139_380, e: 0.0022, i: 0.008, year: 1980, note: 'Steals material from the F ring and leaves dark channels behind it.' },
  { id: 'pandora', name: 'PANDORA', parent: 'saturn', r: 40.6, a: 141_720, e: 0.0042, i: 0.05, year: 1980, note: 'The outer shepherd of the F ring.' },
  { id: 'epimetheus', name: 'EPIMETHEUS', parent: 'saturn', r: 58.1, a: 151_410, e: 0.0098, i: 0.351, year: 1977, note: 'Swaps orbits with Janus every four years — the only co-orbital pair known to do it.' },
  { id: 'janus', name: 'JANUS', parent: 'saturn', r: 89.2, a: 151_460, e: 0.0068, i: 0.163, year: 1966, note: 'Trades places with Epimetheus; their orbits differ by less than either moon is wide.' },
  { id: 'mimas', name: 'MIMAS', parent: 'saturn', r: 198.2, a: 185_540, e: 0.0196, i: 1.574, year: 1789, major: true, note: 'Herschel crater spans a third of its diameter. The impact nearly destroyed it.' },
  { id: 'enceladus', name: 'ENCELADUS', parent: 'saturn', r: 252.1, a: 238_040, e: 0.0047, i: 0.009, year: 1789, major: true, note: 'Jets water vapour from south-polar fractures into space — feeding Saturn’s E ring. Brightest surface in the Solar System.' },
  { id: 'tethys', name: 'TETHYS', parent: 'saturn', r: 531.1, a: 294_670, e: 0.0001, i: 1.091, year: 1684, major: true, note: 'Ithaca Chasma runs three-quarters of the way around it.' },
  { id: 'telesto', name: 'TELESTO', parent: 'saturn', r: 12.4, a: 294_710, e: 0.0, i: 1.18, year: 1980, note: 'Sits at Tethys’s leading Lagrange point.' },
  { id: 'calypso', name: 'CALYPSO', parent: 'saturn', r: 10.7, a: 294_710, e: 0.0, i: 1.5, year: 1980, note: 'Sits at Tethys’s trailing Lagrange point.' },
  { id: 'dione', name: 'DIONE', parent: 'saturn', r: 561.4, a: 377_420, e: 0.0022, i: 0.028, year: 1684, major: true, note: 'Wispy terrain on its trailing side turned out to be ice cliffs, not frost.' },
  { id: 'helene', name: 'HELENE', parent: 'saturn', r: 17.6, a: 377_420, e: 0.0071, i: 0.199, year: 1980, note: 'A Trojan of Dione, 60° ahead of it.' },
  { id: 'rhea', name: 'RHEA', parent: 'saturn', r: 763.8, a: 527_070, e: 0.0013, i: 0.333, year: 1672, major: true, note: 'Second-largest moon of Saturn, and almost entirely ice.' },
  { id: 'titan', name: 'TITAN', parent: 'saturn', r: 2_574.7, a: 1_221_870, e: 0.0288, i: 0.306, year: 1655, major: true, note: 'Thicker atmosphere than Earth’s, and lakes of liquid methane. Huygens landed here in 2005.' },
  { id: 'hyperion', name: 'HYPERION', parent: 'saturn', r: 135, a: 1_500_880, e: 0.0232, i: 0.615, year: 1848, note: 'Tumbles chaotically — its rotation is genuinely unpredictable. Looks like a sponge.' },
  { id: 'iapetus', name: 'IAPETUS', parent: 'saturn', r: 734.5, a: 3_560_840, e: 0.0293, i: 15.47, year: 1671, major: true, note: 'One hemisphere is as dark as coal, the other as bright as snow. A 13 km ridge runs along its equator.' },
  { id: 'phoebe', name: 'PHOEBE', parent: 'saturn', r: 106.5, a: 12_947_780, e: 0.1634, i: 175.24, year: 1899, note: 'Retrograde and captured, probably from the Kuiper belt. Its dust makes the dark half of Iapetus.' },

  // ---- Uranus --------------------------------------------------------------
  { id: 'cordelia', name: 'CORDELIA', parent: 'uranus', r: 20.1, a: 49_800, e: 0.0003, i: 0.08, year: 1986, note: 'Inner shepherd of the Epsilon ring.' },
  { id: 'ophelia', name: 'OPHELIA', parent: 'uranus', r: 21.4, a: 53_800, e: 0.0099, i: 0.1, year: 1986, note: 'Outer shepherd of the Epsilon ring.' },
  { id: 'bianca', name: 'BIANCA', parent: 'uranus', r: 25.7, a: 59_200, e: 0.0009, i: 0.19, year: 1986 },
  { id: 'cressida', name: 'CRESSIDA', parent: 'uranus', r: 39.8, a: 61_800, e: 0.0004, i: 0.01, year: 1986 },
  { id: 'desdemona', name: 'DESDEMONA', parent: 'uranus', r: 32, a: 62_700, e: 0.0001, i: 0.11, year: 1986 },
  { id: 'juliet', name: 'JULIET', parent: 'uranus', r: 46.8, a: 64_400, e: 0.0007, i: 0.07, year: 1986 },
  { id: 'portia', name: 'PORTIA', parent: 'uranus', r: 67.6, a: 66_100, e: 0.0001, i: 0.06, year: 1986 },
  { id: 'rosalind', name: 'ROSALIND', parent: 'uranus', r: 36, a: 69_900, e: 0.0001, i: 0.28, year: 1986 },
  { id: 'belinda', name: 'BELINDA', parent: 'uranus', r: 40.3, a: 75_300, e: 0.0001, i: 0.03, year: 1986 },
  { id: 'puck', name: 'PUCK', parent: 'uranus', r: 81, a: 86_000, e: 0.0001, i: 0.32, year: 1985, note: 'Largest of the inner Uranian moons, and the only one Voyager 2 resolved.' },
  { id: 'miranda', name: 'MIRANDA', parent: 'uranus', r: 235.8, a: 129_900, e: 0.0013, i: 4.232, year: 1948, major: true, note: 'Verona Rupes is a 20 km cliff — the tallest known anywhere. A jumble that looks reassembled.' },
  { id: 'ariel', name: 'ARIEL', parent: 'uranus', r: 578.9, a: 190_900, e: 0.0012, i: 0.26, year: 1851, major: true, note: 'Brightest and youngest-looking Uranian surface, cut by deep rift valleys.' },
  { id: 'umbriel', name: 'UMBRIEL', parent: 'uranus', r: 584.7, a: 266_000, e: 0.0039, i: 0.128, year: 1851, major: true, note: 'The darkest of the five, with one unexplained bright ring nicknamed the Fluorescent Cheerio.' },
  { id: 'titania', name: 'TITANIA', parent: 'uranus', r: 788.4, a: 436_300, e: 0.0011, i: 0.34, year: 1787, major: true, note: 'Largest moon of Uranus. Messina Chasmata runs 1 500 km across it.' },
  { id: 'oberon', name: 'OBERON', parent: 'uranus', r: 761.4, a: 583_500, e: 0.0014, i: 0.058, year: 1787, major: true, note: 'Outermost of the major five, with dark patches on several crater floors.' },

  // ---- Neptune -------------------------------------------------------------
  { id: 'naiad', name: 'NAIAD', parent: 'neptune', r: 33, a: 48_227, e: 0.0004, i: 4.75, year: 1989 },
  { id: 'thalassa', name: 'THALASSA', parent: 'neptune', r: 41, a: 50_075, e: 0.0002, i: 0.21, year: 1989, note: 'Locked in an unusual dancing resonance with Naiad.' },
  { id: 'despina', name: 'DESPINA', parent: 'neptune', r: 75, a: 52_526, e: 0.0002, i: 0.07, year: 1989 },
  { id: 'galatea', name: 'GALATEA', parent: 'neptune', r: 88, a: 61_953, e: 0.0001, i: 0.05, year: 1989, note: 'Its resonance holds Neptune’s ring arcs together.' },
  { id: 'larissa', name: 'LARISSA', parent: 'neptune', r: 97, a: 73_548, e: 0.0014, i: 0.2, year: 1981 },
  { id: 'proteus', name: 'PROTEUS', parent: 'neptune', r: 210, a: 117_646, e: 0.0005, i: 0.04, year: 1989, note: 'About as large as a body can be while staying irregular rather than round.' },
  { id: 'triton', name: 'TRITON', parent: 'neptune', r: 1_353.4, a: 354_759, e: 0.000016, i: 156.865, year: 1846, major: true, note: 'Retrograde — a captured Kuiper belt object. Nitrogen geysers, and a surface at −235 °C. It is spiralling in.' },
  { id: 'nereid', name: 'NEREID', parent: 'neptune', r: 170, a: 5_513_400, e: 0.7512, i: 7.23, year: 1949, note: 'One of the most eccentric orbits of any moon: it swings from 1.4 to 9.7 million km out.' },

  // ---- Pluto ---------------------------------------------------------------
  { id: 'charon', name: 'CHARON', parent: 'pluto', r: 606, a: 19_591, e: 0.0002, i: 0.08, year: 1978, major: true, note: 'Half Pluto’s diameter. The two are tidally locked to each other and orbit a point in open space between them.' },
  { id: 'styx', name: 'STYX', parent: 'pluto', r: 5.2, a: 42_656, e: 0.0058, i: 0.81, year: 2012 },
  { id: 'nix', name: 'NIX', parent: 'pluto', r: 19.3, a: 48_694, e: 0.002, i: 0.13, year: 2005, note: 'Tumbles chaotically in the double planet’s shifting gravity.' },
  { id: 'kerberos', name: 'KERBEROS', parent: 'pluto', r: 6, a: 57_783, e: 0.0033, i: 0.39, year: 2011 },
  { id: 'hydra', name: 'HYDRA', parent: 'pluto', r: 20.9, a: 64_738, e: 0.0059, i: 0.24, year: 2005, note: 'Outermost of Pluto’s small moons, and the most reflective.' },
];

const PROVENANCE: Provenance = {
  tier: 'catalog',
  source: 'Published mean orbital elements for the natural satellites (IAU / JPL Solar System Dynamics)',
  sourceUrl: 'https://ssd.jpl.nasa.gov/sats/elem/',
  cadence: 'Static — baked into the build.',
  accuracy:
    'Orbit size, shape and tilt are published values, converted from the planet’s equatorial frame using its IAU pole. Period and orbital speed follow exactly.',
  limitations:
    'The longitudes of node and periapsis are not carried, so the phase along the orbit is a fixed deterministic value, not a fitted ephemeris. Where a moon is in its orbit at a given instant is indicative only — good for seeing the system’s structure, useless for predicting an eclipse or a transit. Pluto’s moons are drawn about Pluto rather than about the Pluto–Charon barycentre, which sits roughly 2 000 km outside Pluto itself.',
};

/**
 * Gravitational parameter governing each satellite system, km³/s².
 *
 * Normally this is just the planet's GM. Pluto is the exception: Charon is an eighth of
 * Pluto's mass, so its moons orbit the *barycentre* of the pair and feel the combined
 * mass. Using Pluto alone stretches Charon's period from the published 6.39 days to 6.76
 * — a 6% error that the period test catches immediately.
 */
const SYSTEM_GM: Partial<Record<PlanetId, number>> = {
  // Pluto 869.6 + Charon 105.9.
  pluto: 975.5,
};

const COLOR: Record<PlanetId, string> = {
  mercury: '#a8a29a', venus: '#d8c08a', earth: '#c9c5bd', mars: '#8a7f74',
  jupiter: '#b8a88f', saturn: '#c9b184', uranus: '#9fc4c9', neptune: '#8fa5c7',
  pluto: '#b9a893',
};

/** Every catalogued natural satellite except Earth's Moon, which has its own theory. */
export function buildMoons(): SpaceObject[] {
  const rng = mulberry32(0x4d00_4e5b);

  return SPECS.map((m) => {
    const mu = SYSTEM_GM[m.parent] ?? GM[m.parent];
    const elements = equatorialElementsToEcliptic(
      {
        aKm: m.a,
        e: m.e,
        iDeg: m.i,
        // Not modelled — see the provenance note. Deterministic so the view is stable.
        nodeDeg: rng() * 360,
        argPeriDeg: rng() * 360,
        m0Deg: rng() * 360,
      },
      POLE[m.parent]!,
      2451545.0,
      mu,
    );

    const period = periodDays(elements);
    const retrograde = m.i > 90;
    const parentRadius = RADIUS[m.parent];

    const facts: { label: string; value: string }[] = [
      { label: 'Mean radius', value: m.r >= 100 ? `${Math.round(m.r).toLocaleString('en-US')} km` : `${m.r} km` },
      { label: 'Distance from planet', value: `${Math.round(m.a).toLocaleString('en-US')} km` },
      {
        label: 'Orbital period',
        value: period
          ? period < 1
            ? `${(period * 24).toFixed(2)} hours`
            : `${period.toFixed(period < 30 ? 2 : 1)} days`
          : '—',
      },
      { label: 'Inclination to equator', value: `${m.i.toFixed(m.i < 1 ? 3 : 2)}°${retrograde ? ' — retrograde' : ''}` },
      { label: 'Eccentricity', value: m.e.toFixed(4) },
      { label: 'Altitude above cloud tops', value: `${Math.round(m.a - parentRadius).toLocaleString('en-US')} km` },
    ];
    if (m.year) facts.push({ label: 'Discovered', value: String(m.year) });
    if (m.note) facts.push({ label: 'Of note', value: m.note });

    return {
      id: m.id,
      name: m.name,
      subtitle: `MOON OF ${m.parent.toUpperCase()}`,
      kind: 'moon',
      parent: m.parent,
      radiusKm: m.r,
      color: COLOR[m.parent],
      // Major moons deserve labels; a 20 km ring shepherd does not, until you select it.
      weight: m.major ? 0.62 : m.r > 100 ? 0.4 : 0.26,
      provenance: PROVENANCE,
      ephemeris: { kind: 'elements', elements },
      tags: ['moon', 'solar-system', m.parent, ...(retrograde ? ['retrograde'] : [])],
      facts,
      status: retrograde ? 'ORBIT REAL — RETROGRADE · PHASE NOT FITTED' : 'ORBIT REAL — PHASE NOT FITTED',
      phaseSynthetic: true,
    } satisfies SpaceObject;
  });
}

export const MOON_COUNT = SPECS.length;
