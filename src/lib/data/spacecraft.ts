import { GM, RADIUS } from '../astro/constants';
import { equatorialElementsToEcliptic } from '../astro/frames';
import { periodDays } from '../astro/kepler';
import { POLE } from '../astro/planets';
import type { Provenance, SpaceObject } from './types';

/**
 * Robotic spacecraft in stable, well-defined orbits.
 *
 * Deliberately excludes anything mid-cruise. A spacecraft on its way somewhere is not on
 * a fixed conic — its trajectory is a sequence of arcs stitched together by gravity
 * assists and burns, and drawing any one of them as a closed orbit would be a fiction.
 * The interstellar probes are handled separately, as published distance and heading; the
 * Lagrange-point observatories are computed from Earth's position.
 *
 * What is here: the orbit each craft actually occupies — its altitude, eccentricity and
 * inclination about its parent body — from published mission parameters. As with the
 * moons, the phase along that orbit is not fitted, and every entry says so. For a
 * satellite that is a bounded error; you can see that Chandra's orbit reaches a third of
 * the way to the Moon, which is the interesting part.
 */

interface CraftSpec {
  id: string;
  name: string;
  operator: string;
  launched: string;
  parent: 'earth' | 'mars' | 'moon' | 'venus' | 'jupiter';
  /** Periapsis and apoapsis ALTITUDE above the parent's surface, km. */
  peri: number;
  apo: number;
  /** Inclination to the parent's equator, degrees. */
  inc: number;
  status: string;
  facts: [string, string][];
  major?: boolean;
  color?: string;
}

const CRAFT: readonly CraftSpec[] = [
  // ---- Earth orbit ---------------------------------------------------------
  { id: 'iss-shell', name: 'INTERNATIONAL SPACE STATION', operator: 'NASA / Roscosmos / ESA / JAXA / CSA', launched: '1998-11-20', parent: 'earth', peri: 413, apo: 422, inc: 51.64, status: 'CREWED — CONTINUOUSLY OCCUPIED SINCE 2000', major: true, color: '#9fd4ff',
    facts: [['Size', '109 m across — about a football pitch'], ['Speed', '7.66 km/s; it circles the Earth every 92 minutes'], ['Sunrises per day', '16'], ['Note', 'Replaced by a live element set whenever CelesTrak is reachable']] },
  { id: 'css-shell', name: 'TIANGONG', operator: 'China Manned Space Agency', launched: '2021-04-29', parent: 'earth', peri: 370, apo: 390, inc: 41.5, status: 'CREWED', color: '#ff9f80',
    facts: [['Modules', 'Tianhe, Wentian, Mengtian'], ['Crew', 'Three taikonauts, rotated roughly every six months']] },
  { id: 'hubble', name: 'HUBBLE SPACE TELESCOPE', operator: 'NASA / ESA', launched: '1990-04-24', parent: 'earth', peri: 515, apo: 545, inc: 28.47, status: 'ACTIVE — OVER 1.6 MILLION OBSERVATIONS', major: true, color: '#cfd8e3',
    facts: [['Mirror', '2.4 m'], ['Serviced', 'Five times by Space Shuttle crews, the last in 2009'], ['Deep Field', 'Pointed at an apparently empty patch of sky for 10 days and found 3 000 galaxies'], ['Orbit', 'Slowly decaying; without a reboost it re-enters in the 2030s']] },
  { id: 'chandra', name: 'CHANDRA X-RAY OBSERVATORY', operator: 'NASA', launched: '1999-07-23', parent: 'earth', peri: 14_308, apo: 134_528, inc: 76.7, status: 'ACTIVE', color: '#b39ddb',
    facts: [['Orbit', 'Reaches a third of the way to the Moon, to get above Earth’s radiation belts'], ['Period', '64 hours'], ['Resolution', 'Half an arcsecond in X-rays — like reading a stop sign 20 km away']] },
  { id: 'xmm-newton', name: 'XMM-NEWTON', operator: 'ESA', launched: '1999-12-10', parent: 'earth', peri: 7_000, apo: 114_000, inc: 70.0, status: 'ACTIVE', color: '#b39ddb',
    facts: [['Mirrors', '58 nested gold-coated shells per telescope, three telescopes'], ['Period', '48 hours']] },
  { id: 'integral', name: 'INTEGRAL', operator: 'ESA', launched: '2002-10-17', parent: 'earth', peri: 9_000, apo: 153_000, inc: 51.6, status: 'ACTIVE — GAMMA-RAY OBSERVATORY', color: '#b39ddb',
    facts: [['Watches', 'Gamma-ray bursts and the annihilation radiation at the galactic centre']] },
  { id: 'tess', name: 'TESS', operator: 'NASA', launched: '2018-04-18', parent: 'earth', peri: 108_000, apo: 375_000, inc: 37.0, status: 'ACTIVE — EXOPLANET SURVEY', major: true, color: '#7fd4a8',
    facts: [['Orbit', 'A 2:1 resonance with the Moon — it laps the Moon twice for every one of its orbits, which keeps it stable with almost no fuel'], ['Found', 'Thousands of exoplanet candidates'], ['Coverage', 'Surveys about 85% of the sky']] },
  { id: 'swift', name: 'NEIL GEHRELS SWIFT', operator: 'NASA', launched: '2004-11-20', parent: 'earth', peri: 585, apo: 604, inc: 20.6, status: 'ACTIVE — GAMMA-RAY BURST HUNTER', color: '#7fd4a8',
    facts: [['Reaction time', 'Slews onto a new gamma-ray burst in under 90 seconds']] },
  { id: 'fermi', name: 'FERMI', operator: 'NASA', launched: '2008-06-11', parent: 'earth', peri: 535, apo: 553, inc: 25.6, status: 'ACTIVE — GAMMA-RAY TELESCOPE', color: '#7fd4a8',
    facts: [['Discovery', 'The Fermi bubbles — two lobes of gamma rays 25 000 light years tall above and below the galactic centre']] },
  { id: 'ibex', name: 'IBEX', operator: 'NASA', launched: '2008-10-19', parent: 'earth', peri: 48_000, apo: 320_000, inc: 11.0, status: 'ACTIVE — HELIOSPHERE MAPPER', color: '#7fd4a8',
    facts: [['Maps', 'The boundary where the solar wind meets interstellar space — from Earth orbit'], ['Found', 'The IBEX ribbon, a band of unexpectedly bright emission nobody predicted']] },

  // ---- Lunar orbit ---------------------------------------------------------
  { id: 'lro', name: 'LUNAR RECONNAISSANCE ORBITER', operator: 'NASA', launched: '2009-06-18', parent: 'moon', peri: 20, apo: 165, inc: 90.0, status: 'ACTIVE — MAPPING THE MOON', major: true, color: '#e0d8c8',
    facts: [['Resolution', '50 cm per pixel — good enough to see the Apollo descent stages and their footpath tracks'], ['Orbit', 'Polar, so the whole surface passes beneath it'], ['Found', 'Permanently shadowed craters at the poles, cold enough to trap water ice']] },
  { id: 'danuri', name: 'DANURI', operator: 'KARI (South Korea)', launched: '2022-08-04', parent: 'moon', peri: 100, apo: 100, inc: 90.0, status: 'ACTIVE', color: '#e0d8c8',
    facts: [['First', 'South Korea’s first mission beyond Earth orbit'], ['Route', 'Took a low-energy ballistic transfer, arriving four months after launch']] },

  // ---- Mars orbit ----------------------------------------------------------
  { id: 'mars-odyssey', name: 'MARS ODYSSEY', operator: 'NASA', launched: '2001-04-07', parent: 'mars', peri: 385, apo: 450, inc: 93.2, status: 'ACTIVE — LONGEST-SERVING MARS SPACECRAFT', major: true, color: '#d99a6c',
    facts: [['Record', 'In orbit since 2001 — no spacecraft has operated at Mars longer'], ['Found', 'Vast quantities of hydrogen, and therefore water ice, just below the surface'], ['Also', 'Relays data for the rovers on the ground']] },
  { id: 'mars-express', name: 'MARS EXPRESS', operator: 'ESA', launched: '2003-06-02', parent: 'mars', peri: 298, apo: 10_107, inc: 86.9, status: 'ACTIVE', color: '#d99a6c',
    facts: [['Radar', 'MARSIS found what may be liquid water beneath the south polar cap'], ['Lost', 'Its Beagle 2 lander, which reached the surface but never unfolded']] },
  { id: 'mro', name: 'MARS RECONNAISSANCE ORBITER', operator: 'NASA', launched: '2005-08-12', parent: 'mars', peri: 255, apo: 320, inc: 93.0, status: 'ACTIVE', major: true, color: '#d99a6c',
    facts: [['HiRISE', 'Resolves objects 30 cm across from 300 km up'], ['Data', 'Has returned more data than all other Mars missions combined'], ['Watched', 'Dark streaks appear and fade on slopes each Martian summer']] },
  { id: 'maven', name: 'MAVEN', operator: 'NASA', launched: '2013-11-18', parent: 'mars', peri: 150, apo: 6_200, inc: 75.0, status: 'ACTIVE — ATMOSPHERIC LOSS STUDY', color: '#d99a6c',
    facts: [['Question', 'Where did the Martian atmosphere go?'], ['Answer', 'The solar wind strips it away — Mars has no global magnetic field to stop it']] },
  { id: 'tgo', name: 'EXOMARS TRACE GAS ORBITER', operator: 'ESA / Roscosmos', launched: '2016-03-14', parent: 'mars', peri: 400, apo: 400, inc: 74.0, status: 'ACTIVE', color: '#d99a6c',
    facts: [['Looking for', 'Methane, which could signal life or active geology'], ['Result so far', 'Has not confirmed the methane other instruments reported — an unresolved argument']] },
  { id: 'tianwen-1', name: 'TIANWEN-1', operator: 'CNSA (China)', launched: '2020-07-23', parent: 'mars', peri: 265, apo: 12_000, inc: 86.9, status: 'ORBITER ACTIVE — ZHURONG ROVER DORMANT', color: '#ff9f80',
    facts: [['First', 'China’s first Mars mission — it orbited, landed and roved on the first attempt'], ['Rover', 'Zhurong went silent in 2022 after a dust storm']] },
  { id: 'hope', name: 'HOPE', operator: 'UAE Space Agency', launched: '2020-07-19', parent: 'mars', peri: 20_000, apo: 43_000, inc: 25.0, status: 'ACTIVE — MARTIAN WEATHER', color: '#d99a6c',
    facts: [['First', 'The Arab world’s first interplanetary mission'], ['Orbit', 'High and slow, so it can watch a whole hemisphere’s weather at once']] },

  // ---- Venus and Jupiter ---------------------------------------------------
  { id: 'akatsuki', name: 'AKATSUKI', operator: 'JAXA', launched: '2010-05-20', parent: 'venus', peri: 1_000, apo: 370_000, inc: 3.0, status: 'CONTACT LOST 2024', color: '#d8c08a',
    facts: [['Second chance', 'Missed Venus orbit insertion in 2010, then succeeded five years later on a second attempt'], ['Found', 'A 10 000 km stationary gravity wave in the atmosphere']] },
  { id: 'juno-spacecraft', name: 'JUNO', operator: 'NASA', launched: '2011-08-05', parent: 'jupiter', peri: 4_200, apo: 8_100_000, inc: 90.0, status: 'ACTIVE — JUPITER POLAR ORBIT', major: true, color: '#e0c060',
    facts: [['Orbit', 'Highly elliptical and polar, diving inside the radiation belts at each perijove'], ['Power', 'Solar — the farthest solar-powered spacecraft from the Sun'], ['Found', 'Jupiter’s core is "fuzzy", not a sharp sphere, and its poles are ringed by geometric cyclone clusters'], ['Vault', 'Its electronics sit in a titanium box against radiation that would otherwise kill them in weeks']] },
];

const PROVENANCE: Provenance = {
  tier: 'catalog',
  source: 'Published mission orbit parameters (NASA / ESA / JAXA / CNSA / KARI mission pages)',
  cadence: 'Static — baked into the build.',
  accuracy:
    'The orbit is the one the spacecraft actually occupies: periapsis, apoapsis and inclination from published mission parameters, so its size, shape, period and speed are right.',
  limitations:
    'The phase along the orbit is not fitted to an ephemeris, so where the craft is at a given instant is a fixed synthetic value. Orbits are also shown as they are today — manoeuvres, aerobraking and orbit-raising over a mission’s life are not modelled. Anything mid-cruise between worlds is deliberately absent rather than drawn as a conic it is not on.',
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Body radius and GM for the things spacecraft orbit here. */
const PARENT: Record<CraftSpec['parent'], { radius: number; mu: number; pole: { raDeg: number; decDeg: number } }> = {
  earth: { radius: RADIUS.earth, mu: GM.earth, pole: POLE.earth! },
  mars: { radius: RADIUS.mars, mu: GM.mars, pole: POLE.mars! },
  moon: { radius: RADIUS.moon, mu: GM.moon, pole: POLE.earth! },
  venus: { radius: RADIUS.venus, mu: GM.venus, pole: POLE.venus! },
  jupiter: { radius: RADIUS.jupiter, mu: GM.jupiter, pole: POLE.jupiter! },
};

export function buildSpacecraft(): SpaceObject[] {
  const rng = mulberry32(0x5c_7a_f7);

  return CRAFT.map((c) => {
    const p = PARENT[c.parent];
    const rPeri = p.radius + c.peri;
    const rApo = p.radius + c.apo;
    const a = (rPeri + rApo) / 2;
    const e = (rApo - rPeri) / (rApo + rPeri);

    const elements = equatorialElementsToEcliptic(
      { aKm: a, e, iDeg: c.inc, nodeDeg: rng() * 360, argPeriDeg: rng() * 360, m0Deg: rng() * 360 },
      p.pole,
      2451545.0,
      p.mu,
    );

    const period = periodDays(elements);
    const periodText = period
      ? period * 24 < 48
        ? `${(period * 24).toFixed(2)} hours`
        : `${period.toFixed(2)} days`
      : '—';

    return {
      id: c.id,
      name: c.name,
      subtitle: `${c.operator} — LAUNCHED ${c.launched}`,
      kind: 'spacecraft',
      parent: c.parent,
      radiusKm: 0.02,
      color: c.color ?? '#9fb4c7',
      weight: c.major ? 0.6 : 0.34,
      provenance: PROVENANCE,
      ephemeris: { kind: 'elements', elements },
      tags: ['spacecraft', 'orbiter', c.parent],
      status: c.status,
      phaseSynthetic: true,
      facts: [
        { label: 'Orbits', value: c.parent.toUpperCase() },
        { label: 'Altitude', value: c.peri === c.apo ? `${c.peri.toLocaleString('en-US')} km` : `${c.peri.toLocaleString('en-US')} – ${c.apo.toLocaleString('en-US')} km` },
        { label: 'Inclination', value: `${c.inc}°${c.inc > 85 && c.inc < 95 ? ' — polar' : ''}` },
        { label: 'Orbital period', value: periodText },
        { label: 'Eccentricity', value: e.toFixed(4) },
        ...c.facts.map(([label, value]) => ({ label, value })),
      ],
    } satisfies SpaceObject;
  });
}

export const SPACECRAFT_COUNT = CRAFT.length;
