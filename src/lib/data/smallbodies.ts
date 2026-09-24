import { AU_KM, DEG, GM } from '../astro/constants';
import type { Elements } from '../astro/kepler';
import type { Provenance, SpaceObject } from './types';

/**
 * Small bodies: asteroids, Trojans, centaurs, trans-Neptunian objects and comets.
 *
 * Each entry carries the published orbit shape — semi-major axis, eccentricity,
 * inclination, and where known the node and argument of perihelion. What separates the
 * two halves of this file is whether the *phase* along that orbit is known:
 *
 *   `tp` present  — time of perihelion passage is well established, so the body is placed
 *                   on its orbit and every readout about it is meaningful.
 *   `tp` absent   — the orbit is drawn and the body is NOT placed. The panel shows dashes
 *                   rather than a distance computed from a phase nobody fitted.
 *
 * That second case is the honest one for a heliocentric body: inventing a phase would put
 * Ceres up to 5 AU from where it is, and "distance from Earth" would be fiction. A moon
 * can take a synthetic phase because the error stays inside its orbit around its planet;
 * an asteroid cannot.
 */

export type BodyKind = 'asteroid' | 'comet' | 'dwarf' | 'interstellar';

interface BodySpec {
  id: string;
  name: string;
  /** Designation line, e.g. `(10) HYGIEA — MAIN BELT`. */
  subtitle: string;
  kind: BodyKind;
  /** Semi-major axis, AU. Negative for hyperbolic orbits. */
  a: number;
  e: number;
  /** Inclination to the ecliptic, degrees. */
  i: number;
  /** Longitude of ascending node, degrees. */
  node: number;
  /** Argument of perihelion, degrees. */
  peri: number;
  /** Time of perihelion passage. Omit when it is not well established. */
  tp?: string;
  /** Mean radius, km. */
  r?: number;
  group: string;
  facts: [string, string][];
  status?: string;
  /** Bumps label priority for the famous ones. */
  major?: boolean;
}

const BODIES: readonly BodySpec[] = [
  // ---- Dwarf planets and large trans-Neptunian objects ---------------------
  { id: 'eris', name: 'ERIS', subtitle: '(136199) ERIS — DWARF PLANET', kind: 'dwarf', a: 67.78, e: 0.4416, i: 44.04, node: 35.95, peri: 151.4, r: 1163, group: 'Scattered disc', major: true,
    facts: [['Why Pluto was demoted', 'Eris is more massive than Pluto, forcing the IAU to define "planet" in 2006'], ['Surface', 'Methane ice, −240 °C'], ['Moon', 'Dysnomia'], ['Orbital period', '~559 years']] },
  { id: 'makemake', name: 'MAKEMAKE', subtitle: '(136472) MAKEMAKE — DWARF PLANET', kind: 'dwarf', a: 45.43, e: 0.162, i: 28.98, node: 79.38, peri: 296.0, r: 715, group: 'Classical Kuiper belt', major: true,
    facts: [['Named for', 'The creator god of Rapa Nui'], ['Discovered', '2005, just after Easter'], ['Atmosphere', 'None detected — it froze out']] },
  { id: 'haumea', name: 'HAUMEA', subtitle: '(136108) HAUMEA — DWARF PLANET', kind: 'dwarf', a: 43.22, e: 0.1912, i: 28.21, node: 122.1, peri: 239.0, r: 780, group: 'Classical Kuiper belt', major: true,
    facts: [['Shape', 'A spinning ellipsoid roughly 2 100 × 1 700 × 1 100 km'], ['Rotation', 'Once every 3.9 hours — fastest of any large body known'], ['Rings', 'Yes, confirmed in 2017'], ['Moons', 'Hiʻiaka and Namaka']] },
  { id: 'gonggong', name: 'GONGGONG', subtitle: '(225088) GONGGONG — DWARF PLANET', kind: 'dwarf', a: 67.38, e: 0.5024, i: 30.63, node: 336.8, peri: 207.0, r: 615, group: 'Scattered disc',
    facts: [['Named for', 'A Chinese water god with a serpent’s tail'], ['Surface', 'Red, with water ice and possibly methane'], ['Moon', 'Xiangliu']] },
  { id: 'quaoar', name: 'QUAOAR', subtitle: '(50000) QUAOAR — TRANS-NEPTUNIAN', kind: 'dwarf', a: 43.69, e: 0.0392, i: 7.99, node: 188.8, peri: 147.5, r: 555, group: 'Classical Kuiper belt',
    facts: [['Ring', 'Has one — far outside the distance where theory said a ring could survive'], ['Orbit', 'Nearly circular for a TNO'], ['Moon', 'Weywot']] },
  { id: 'sedna', name: 'SEDNA', subtitle: '(90377) SEDNA — DETACHED OBJECT', kind: 'dwarf', a: 506.8, e: 0.8496, i: 11.93, node: 144.2, peri: 311.4, r: 498, group: 'Detached / inner Oort', major: true,
    facts: [['Orbital period', '~11 400 years'], ['Aphelion', '~937 AU — twenty times farther than Neptune'], ['Perihelion', '76 AU, still beyond the Kuiper belt'], ['Why it matters', 'Nothing known could have put it on this orbit; it is evidence of something else out there']] },
  { id: 'orcus', name: 'ORCUS', subtitle: '(90482) ORCUS — PLUTINO', kind: 'dwarf', a: 39.42, e: 0.2201, i: 20.59, node: 268.7, peri: 72.4, r: 458, group: 'Plutino (3:2 with Neptune)',
    facts: [['Nickname', 'The anti-Pluto — same resonance, opposite phase'], ['Moon', 'Vanth, unusually large'], ['Surface', 'Water ice and ammonia']] },
  { id: 'salacia', name: 'SALACIA', subtitle: '(120347) SALACIA — TRANS-NEPTUNIAN', kind: 'dwarf', a: 42.18, e: 0.1035, i: 23.92, node: 280.0, peri: 311.0, r: 423, group: 'Classical Kuiper belt',
    facts: [['Moon', 'Actaea'], ['Albedo', 'Dark — it reflects only 4% of the light that hits it']] },
  { id: 'varuna', name: 'VARUNA', subtitle: '(20000) VARUNA — TRANS-NEPTUNIAN', kind: 'dwarf', a: 42.92, e: 0.0512, i: 17.15, node: 97.3, peri: 262.2, r: 334, group: 'Classical Kuiper belt',
    facts: [['Rotation', '6.3 hours — fast enough to have stretched it out of round']] },
  { id: 'ixion', name: 'IXION', subtitle: '(28978) IXION — PLUTINO', kind: 'dwarf', a: 39.65, e: 0.2417, i: 19.6, node: 71.0, peri: 300.0, r: 308, group: 'Plutino (3:2 with Neptune)',
    facts: [['Resonance', 'Two orbits for every three of Neptune’s, like Pluto']] },
  { id: 'arrokoth', name: 'ARROKOTH', subtitle: '(486958) ARROKOTH — COLD CLASSICAL KBO', kind: 'asteroid', a: 44.58, e: 0.0417, i: 2.45, node: 158.9, peri: 175.0, r: 9, group: 'Cold classical Kuiper belt', major: true,
    facts: [['Visited', 'New Horizons, 1 January 2019 — the most distant flyby ever made'], ['Shape', 'Two flattened lobes joined at a narrow neck'], ['Significance', 'A pristine planetesimal, never heated, unchanged for 4.5 billion years']] },

  // ---- Centaurs ------------------------------------------------------------
  { id: 'chiron', name: 'CHIRON', subtitle: '(2060) CHIRON — CENTAUR', kind: 'asteroid', a: 13.65, e: 0.3831, i: 6.93, node: 209.3, peri: 339.6, r: 105, group: 'Centaur',
    facts: [['Identity crisis', 'Catalogued as an asteroid, then found to have a coma — it is also comet 95P'], ['Rings', 'Probably, detected by stellar occultation'], ['Orbit', 'Unstable; it crosses Saturn and will not last a million years']] },
  { id: 'chariklo', name: 'CHARIKLO', subtitle: '(10199) CHARIKLO — CENTAUR', kind: 'asteroid', a: 15.8, e: 0.1721, i: 23.38, node: 300.4, peri: 241.5, r: 124, group: 'Centaur',
    facts: [['First', 'The first minor body found to have rings, in 2013'], ['Rings', 'Two narrow ones, 3 and 7 km wide'], ['Size', 'Largest known centaur']] },
  { id: 'pholus', name: 'PHOLUS', subtitle: '(5145) PHOLUS — CENTAUR', kind: 'asteroid', a: 20.33, e: 0.573, i: 24.66, node: 119.3, peri: 354.8, r: 92, group: 'Centaur',
    facts: [['Colour', 'One of the reddest objects in the Solar System — organics baked by radiation']] },

  // ---- Jupiter Trojans -----------------------------------------------------
  { id: 'hektor', name: 'HEKTOR', subtitle: '(624) HEKTOR — JUPITER TROJAN', kind: 'asteroid', a: 5.245, e: 0.023, i: 18.18, node: 342.8, peri: 184.0, r: 113, group: 'Trojan (L4, leading)',
    facts: [['Size', 'Largest Jupiter Trojan — 400 km long and shaped like a peanut'], ['Moon', 'Yes, a small one'], ['Target of', 'Lucy, arriving 2027']] },
  { id: 'patroclus', name: 'PATROCLUS', subtitle: '(617) PATROCLUS — JUPITER TROJAN', kind: 'asteroid', a: 5.221, e: 0.1396, i: 22.05, node: 44.4, peri: 307.4, r: 70, group: 'Trojan (L5, trailing)',
    facts: [['Binary', 'Two nearly equal bodies, Patroclus and Menoetius, orbiting each other'], ['Target of', 'Lucy, arriving 2033 — its final encounter']] },
  { id: 'achilles', name: 'ACHILLES', subtitle: '(588) ACHILLES — JUPITER TROJAN', kind: 'asteroid', a: 5.192, e: 0.1477, i: 10.32, node: 316.5, peri: 132.0, r: 65, group: 'Trojan (L4, leading)',
    facts: [['First', 'The first Trojan ever found, in 1906 — it proved Lagrange’s points were real']] },
  { id: 'leucus', name: 'LEUCUS', subtitle: '(11351) LEUCUS — JUPITER TROJAN', kind: 'asteroid', a: 5.294, e: 0.0645, i: 11.55, node: 251.0, peri: 160.0, r: 17, group: 'Trojan (L4, leading)',
    facts: [['Rotation', '445 hours — one of the slowest spinners known'], ['Target of', 'Lucy, 2028']] },
  { id: 'eurybates', name: 'EURYBATES', subtitle: '(3548) EURYBATES — JUPITER TROJAN', kind: 'asteroid', a: 5.198, e: 0.0885, i: 8.06, node: 43.5, peri: 27.8, r: 32, group: 'Trojan (L4, leading)',
    facts: [['Moon', 'Queta, found by Hubble in 2020'], ['Target of', 'Lucy, 2027']] },

  // ---- Main belt -----------------------------------------------------------
  { id: 'juno', name: 'JUNO', subtitle: '(3) JUNO — MAIN BELT', kind: 'asteroid', a: 2.669, e: 0.2554, i: 12.99, node: 169.8, peri: 248.4, r: 123, group: 'Main belt',
    facts: [['Discovered', '1804, the third asteroid found'], ['Was called a planet', 'For about forty years, along with Ceres, Pallas and Vesta']] },
  { id: 'astraea', name: 'ASTRAEA', subtitle: '(5) ASTRAEA — MAIN BELT', kind: 'asteroid', a: 2.574, e: 0.1914, i: 5.37, node: 141.6, peri: 358.7, r: 60, group: 'Main belt',
    facts: [['Discovered', '1845 — it ended a 38-year gap and started the asteroid rush']] },
  { id: 'hebe', name: 'HEBE', subtitle: '(6) HEBE — MAIN BELT', kind: 'asteroid', a: 2.425, e: 0.2027, i: 14.74, node: 138.6, peri: 239.7, r: 93, group: 'Main belt',
    facts: [['Possible origin of', 'Ordinary chondrites — the most common meteorites that fall on Earth']] },
  { id: 'iris', name: 'IRIS', subtitle: '(7) IRIS — MAIN BELT', kind: 'asteroid', a: 2.386, e: 0.231, i: 5.52, node: 259.6, peri: 145.3, r: 100, group: 'Main belt',
    facts: [['Brightness', 'Can reach magnitude 6.7 — almost naked-eye']] },
  { id: 'flora', name: 'FLORA', subtitle: '(8) FLORA — MAIN BELT', kind: 'asteroid', a: 2.202, e: 0.1564, i: 5.89, node: 110.9, peri: 285.5, r: 68, group: 'Main belt',
    facts: [['Family', 'Parent of the Flora family — thousands of fragments from an ancient collision']] },
  { id: 'metis-ast', name: 'METIS', subtitle: '(9) METIS — MAIN BELT', kind: 'asteroid', a: 2.386, e: 0.1233, i: 5.58, node: 68.9, peri: 6.4, r: 95, group: 'Main belt',
    facts: [['Not to be confused with', 'Metis, the inner moon of Jupiter']] },
  { id: 'hygiea', name: 'HYGIEA', subtitle: '(10) HYGIEA — MAIN BELT', kind: 'dwarf', a: 3.139, e: 0.1125, i: 3.83, node: 283.2, peri: 312.3, r: 217, group: 'Main belt', major: true,
    facts: [['Rank', 'Fourth-largest object in the asteroid belt'], ['Shape', 'Round — it may qualify as a dwarf planet'], ['Composition', 'Dark and carbonaceous']] },
  { id: 'egeria', name: 'EGERIA', subtitle: '(13) EGERIA — MAIN BELT', kind: 'asteroid', a: 2.576, e: 0.0851, i: 16.54, node: 43.2, peri: 80.4, r: 103, group: 'Main belt',
    facts: [['Composition', 'Unusually water-rich for a main belt body']] },
  { id: 'eunomia', name: 'EUNOMIA', subtitle: '(15) EUNOMIA — MAIN BELT', kind: 'asteroid', a: 2.644, e: 0.1866, i: 11.75, node: 293.2, peri: 98.6, r: 133, group: 'Main belt',
    facts: [['Rank', 'Largest of the stony S-type asteroids'], ['Family', 'Parent of the Eunomia family']] },
  { id: 'fortuna', name: 'FORTUNA', subtitle: '(19) FORTUNA — MAIN BELT', kind: 'asteroid', a: 2.442, e: 0.158, i: 1.57, node: 211.1, peri: 182.3, r: 100, group: 'Main belt',
    facts: [['Surface', 'Among the darkest known, with primitive organics']] },
  { id: 'lutetia', name: 'LUTETIA', subtitle: '(21) LUTETIA — MAIN BELT', kind: 'asteroid', a: 2.435, e: 0.1638, i: 3.06, node: 80.9, peri: 250.2, r: 49, group: 'Main belt',
    facts: [['Visited', 'Rosetta flew past in 2010 on its way to comet 67P'], ['Surprise', 'Unexpectedly dense — it may have a metal core']] },
  { id: 'kalliope', name: 'KALLIOPE', subtitle: '(22) KALLIOPE — MAIN BELT', kind: 'asteroid', a: 2.911, e: 0.0989, i: 13.7, node: 66.1, peri: 355.7, r: 83, group: 'Main belt',
    facts: [['Moon', 'Linus, discovered in 2001'], ['Composition', 'Metal-rich']] },
  { id: 'themis', name: 'THEMIS', subtitle: '(24) THEMIS — MAIN BELT', kind: 'asteroid', a: 3.135, e: 0.1242, i: 0.75, node: 35.9, peri: 107.6, r: 99, group: 'Main belt',
    facts: [['Water ice', 'Frost was detected on its surface in 2009 — on an asteroid'], ['Family', 'Parent of the Themis family']] },
  { id: 'amphitrite', name: 'AMPHITRITE', subtitle: '(29) AMPHITRITE — MAIN BELT', kind: 'asteroid', a: 2.554, e: 0.073, i: 6.09, node: 356.3, peri: 63.3, r: 106, group: 'Main belt', facts: [['Orbit', 'Unusually circular for a large asteroid']] },
  { id: 'eugenia', name: 'EUGENIA', subtitle: '(45) EUGENIA — MAIN BELT', kind: 'asteroid', a: 2.721, e: 0.083, i: 6.61, node: 147.8, peri: 87.9, r: 100, group: 'Main belt',
    facts: [['Moons', 'Two — Petit-Prince and a second, unnamed'], ['First', 'One of the first asteroids found to have a satellite']] },
  { id: 'europa-ast', name: 'EUROPA', subtitle: '(52) EUROPA — MAIN BELT', kind: 'asteroid', a: 3.096, e: 0.1097, i: 7.48, node: 128.6, peri: 343.5, r: 152, group: 'Main belt',
    facts: [['Rank', 'Sixth-largest asteroid'], ['Not to be confused with', 'Europa, the moon of Jupiter']] },
  { id: 'cybele', name: 'CYBELE', subtitle: '(65) CYBELE — OUTER BELT', kind: 'asteroid', a: 3.433, e: 0.1053, i: 3.56, node: 155.6, peri: 102.7, r: 118, group: 'Cybele group',
    facts: [['Location', 'Beyond the 2:1 Kirkwood gap, in the belt’s outer fringe']] },
  { id: 'sylvia', name: 'SYLVIA', subtitle: '(87) SYLVIA — OUTER BELT', kind: 'asteroid', a: 3.485, e: 0.093, i: 10.87, node: 73.1, peri: 265.9, r: 143, group: 'Cybele group',
    facts: [['Moons', 'Romulus and Remus — the first triple asteroid system found']] },
  { id: 'davida', name: 'DAVIDA', subtitle: '(511) DAVIDA — MAIN BELT', kind: 'asteroid', a: 3.168, e: 0.1861, i: 15.94, node: 107.6, peri: 339.0, r: 149, group: 'Main belt', facts: [['Rank', 'Seventh-largest asteroid']] },
  { id: 'interamnia', name: 'INTERAMNIA', subtitle: '(704) INTERAMNIA — MAIN BELT', kind: 'asteroid', a: 3.062, e: 0.155, i: 17.31, node: 280.3, peri: 95.7, r: 166, group: 'Main belt', facts: [['Rank', 'Fifth-largest asteroid, yet it has no moon and is barely studied']] },
  { id: 'ida', name: 'IDA', subtitle: '(243) IDA — MAIN BELT', kind: 'asteroid', a: 2.862, e: 0.0417, i: 1.14, node: 324.2, peri: 113.0, r: 15.7, group: 'Koronis family',
    facts: [['Visited', 'Galileo, 1993'], ['Moon', 'Dactyl — the first asteroid moon ever confirmed'], ['Shape', '56 km long and cratered all over']] },
  { id: 'mathilde', name: 'MATHILDE', subtitle: '(253) MATHILDE — MAIN BELT', kind: 'asteroid', a: 2.646, e: 0.2661, i: 6.74, node: 179.6, peri: 157.4, r: 26.4, group: 'Main belt',
    facts: [['Visited', 'NEAR Shoemaker, 1997'], ['Density', 'Half that of water — it is mostly empty space'], ['Rotation', '17.4 days, extraordinarily slow']] },
  { id: 'gaspra', name: 'GASPRA', subtitle: '(951) GASPRA — MAIN BELT', kind: 'asteroid', a: 2.209, e: 0.1737, i: 4.1, node: 253.2, peri: 129.5, r: 6.1, group: 'Flora family',
    facts: [['First', 'The first asteroid ever photographed close up — Galileo, 1991']] },
  { id: 'steins', name: 'ŠTEINS', subtitle: '(2867) ŠTEINS — MAIN BELT', kind: 'asteroid', a: 2.363, e: 0.1459, i: 9.94, node: 55.4, peri: 250.7, r: 2.7, group: 'Main belt',
    facts: [['Visited', 'Rosetta, 2008'], ['Shape', 'A cut diamond, with a chain of craters across the top']] },
  { id: 'dinkinesh', name: 'DINKINESH', subtitle: '(152830) DINKINESH — MAIN BELT', kind: 'asteroid', a: 2.191, e: 0.1119, i: 2.09, node: 21.4, peri: 66.6, r: 0.4, group: 'Main belt',
    facts: [['Visited', 'Lucy, November 2023'], ['Surprise', 'Its moon turned out to be two touching lobes — a contact binary orbiting an asteroid']] },
  { id: 'donaldjohanson', name: 'DONALDJOHANSON', subtitle: '(52246) DONALDJOHANSON — MAIN BELT', kind: 'asteroid', a: 2.383, e: 0.1866, i: 4.42, node: 262.6, peri: 212.9, r: 1.9, group: 'Erigone family',
    facts: [['Visited', 'Lucy, April 2025'], ['Named for', 'The discoverer of the Lucy fossil']] },

  // ---- Near-Earth ----------------------------------------------------------
  { id: 'icarus', name: 'ICARUS', subtitle: '(1566) ICARUS — APOLLO NEO', kind: 'asteroid', a: 1.078, e: 0.827, i: 22.83, node: 88.0, peri: 31.4, r: 0.7, group: 'Apollo (Earth-crossing)',
    facts: [['Perihelion', '0.187 AU — it passes well inside Mercury’s orbit and reaches 600 °C'], ['Named for', 'The boy who flew too close to the Sun']] },
  { id: 'geographos', name: 'GEOGRAPHOS', subtitle: '(1620) GEOGRAPHOS — APOLLO NEO', kind: 'asteroid', a: 1.246, e: 0.3355, i: 13.34, node: 337.2, peri: 276.9, r: 1.3, group: 'Apollo (Earth-crossing)',
    facts: [['Shape', 'The most elongated body in the Solar System — 5 km long, 2 km wide']] },
  { id: 'toutatis', name: 'TOUTATIS', subtitle: '(4179) TOUTATIS — APOLLO NEO', kind: 'asteroid', a: 2.531, e: 0.6294, i: 0.45, node: 124.4, peri: 278.8, r: 2.4, group: 'Apollo (Earth-crossing)',
    facts: [['Rotation', 'Tumbles chaotically — it has no fixed north pole'], ['Visited', 'Chang’e 2, 2012'], ['Inclination', 'Just 0.45° — it orbits almost exactly in Earth’s plane']] },
  { id: 'cruithne', name: 'CRUITHNE', subtitle: '(3753) CRUITHNE — ATEN NEO', kind: 'asteroid', a: 0.998, e: 0.515, i: 19.81, node: 126.3, peri: 43.8, r: 2.5, group: 'Earth co-orbital',
    facts: [['Often called', 'Earth’s second moon — it is not'], ['Actually', 'It shares Earth’s orbital period, tracing a horseshoe against our motion'], ['Closest approach', 'It never comes nearer than about 12 million km']] },
  { id: 'didymos', name: 'DIDYMOS', subtitle: '(65803) DIDYMOS — APOLLO NEO', kind: 'asteroid', a: 1.644, e: 0.384, i: 3.41, node: 72.9, peri: 319.3, r: 0.39, group: 'Apollo (Earth-crossing)', major: true,
    facts: [['Moon', 'Dimorphos'], ['DART', 'NASA deliberately crashed a spacecraft into Dimorphos on 26 September 2022'], ['Result', 'Its orbital period shortened by 32 minutes — humanity’s first demonstrated planetary defence'], ['Follow-up', 'ESA’s Hera arrives to survey the crater']] },

  // ---- Comets with a well-established perihelion ---------------------------
  { id: 'encke', name: 'ENCKE', subtitle: '2P/ENCKE — PERIODIC COMET', kind: 'comet', a: 2.215, e: 0.848, i: 11.78, node: 334.6, peri: 186.5, tp: '2023-10-22T00:00:00Z', r: 2.4, group: 'Encke-type',
    facts: [['Period', '3.3 years — the shortest of any known comet'], ['Meteor shower', 'The Taurids'], ['History', 'Only the second comet ever shown to be periodic, after Halley']] },
  { id: 'churyumov', name: 'CHURYUMOV–GERASIMENKO', subtitle: '67P — PERIODIC COMET', kind: 'comet', a: 3.463, e: 0.641, i: 7.04, node: 50.1, peri: 12.8, tp: '2021-11-02T00:00:00Z', r: 2.0, group: 'Jupiter-family', major: true,
    facts: [['Visited', 'Rosetta orbited it for two years, 2014–2016'], ['Landing', 'Philae touched down in November 2014 — the first landing on a comet'], ['Shape', 'Two lobes joined at a neck, like a rubber duck'], ['Finding', 'Its water is isotopically unlike Earth’s, weakening the idea that comets filled our oceans']] },
  { id: 'tempel-1', name: 'TEMPEL 1', subtitle: '9P/TEMPEL — PERIODIC COMET', kind: 'comet', a: 3.145, e: 0.5096, i: 10.47, node: 68.9, peri: 179.2, tp: '2022-03-04T00:00:00Z', r: 3.0, group: 'Jupiter-family',
    facts: [['Deep Impact', 'NASA fired an 370 kg impactor into it on 4 July 2005'], ['Result', 'The plume revealed fine, fluffy dust beneath the crust'], ['Revisited', 'Stardust photographed the crater in 2011']] },
  { id: 'wild-2', name: 'WILD 2', subtitle: '81P/WILD — PERIODIC COMET', kind: 'comet', a: 3.448, e: 0.5378, i: 3.24, node: 136.1, peri: 41.7, tp: '2022-12-15T00:00:00Z', r: 2.0, group: 'Jupiter-family',
    facts: [['Sample returned', 'Stardust caught its dust in aerogel and dropped it in Utah in 2006'], ['Surprise', 'The grains included minerals that only form at very high temperature — near the Sun, not out here']] },
  { id: 'hartley-2', name: 'HARTLEY 2', subtitle: '103P/HARTLEY — PERIODIC COMET', kind: 'comet', a: 3.47, e: 0.694, i: 13.6, node: 219.8, peri: 181.3, tp: '2023-10-12T00:00:00Z', r: 0.6, group: 'Jupiter-family',
    facts: [['Visited', 'EPOXI, 2010'], ['Activity', 'Jets of carbon dioxide dragging out chunks of ice the size of basketballs']] },
  { id: 'giacobini', name: 'GIACOBINI–ZINNER', subtitle: '21P — PERIODIC COMET', kind: 'comet', a: 3.503, e: 0.7068, i: 31.9, node: 195.4, peri: 172.5, tp: '2018-09-10T00:00:00Z', r: 1.0, group: 'Jupiter-family',
    facts: [['First', 'The first comet ever visited by a spacecraft — ICE, in 1985'], ['Meteor shower', 'The Draconids, which can storm spectacularly']] },
  { id: 'tempel-tuttle', name: 'TEMPEL–TUTTLE', subtitle: '55P — PERIODIC COMET', kind: 'comet', a: 10.33, e: 0.9055, i: 162.49, node: 235.3, peri: 172.5, tp: '1998-02-28T00:00:00Z', r: 1.8, group: 'Halley-type',
    facts: [['Meteor shower', 'The Leonids — which produce storms of thousands per hour every 33 years'], ['Orbit', 'Retrograde, so the Leonids hit our atmosphere head-on at 71 km/s']] },
  { id: 'swift-tuttle', name: 'SWIFT–TUTTLE', subtitle: '109P — PERIODIC COMET', kind: 'comet', a: 26.09, e: 0.9632, i: 113.45, node: 139.4, peri: 153.0, tp: '1992-12-12T00:00:00Z', r: 13.0, group: 'Halley-type', major: true,
    facts: [['Meteor shower', 'The Perseids, every August'], ['Size', '26 km across — large enough to end civilisation if it ever hit'], ['Next perihelion', '2126'], ['Reassurance', 'Its orbit is now known well enough to rule out an impact for millennia']] },
  { id: 'hale-bopp', name: 'HALE–BOPP', subtitle: 'C/1995 O1 — LONG-PERIOD COMET', kind: 'comet', a: 186.0, e: 0.9951, i: 89.43, node: 282.5, peri: 130.6, tp: '1997-04-01T00:00:00Z', r: 30.0, group: 'Long-period', major: true,
    facts: [['The Great Comet of 1997', 'Visible to the naked eye for 18 months — longer than any comet in recorded history'], ['Nucleus', '~60 km across, exceptionally large'], ['Returns', 'Around the year 4385']] },
  { id: 'neowise', name: 'NEOWISE', subtitle: 'C/2020 F3 — LONG-PERIOD COMET', kind: 'comet', a: 358.0, e: 0.99921, i: 128.94, node: 61.0, peri: 37.3, tp: '2020-07-03T00:00:00Z', r: 2.5, group: 'Long-period',
    facts: [['2020', 'The brightest comet in the northern sky since Hale–Bopp'], ['Orbit', 'Retrograde and nearly parabolic'], ['Returns', 'In roughly 6 800 years']] },

  // ---- Interstellar --------------------------------------------------------
  { id: 'atlas-3i', name: '3I/ATLAS', subtitle: '3I/2025 N1 — INTERSTELLAR OBJECT', kind: 'interstellar', a: -0.265, e: 6.14, i: 175.1, node: 322.2, peri: 128.0, tp: '2025-10-29T00:00:00Z', r: 2.8, group: 'Interstellar', major: true, status: 'DEPARTING — UNBOUND',
    facts: [['Third of its kind', 'After ʻOumuamua (2017) and Borisov (2019)'], ['Discovered', 'July 2025, by the ATLAS survey in Chile'], ['Orbit', 'Retrograde and steeply hyperbolic — eccentricity above 6, far higher than either predecessor'], ['Origin', 'It came from interstellar space and is leaving for good']] },
];

const PHASED: Provenance = {
  tier: 'catalog',
  source: 'Published osculating elements and perihelion epoch (JPL Small-Body Database)',
  sourceUrl: 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html',
  cadence: 'Static — baked into the build.',
  accuracy:
    'Orbit shape and orientation are published values, and the phase is anchored to a well-established perihelion passage, so the body is placed on its orbit.',
  limitations:
    'A single unperturbed conic. No planetary perturbations and, for comets, no non-gravitational jet forces — which are large enough to shift a perihelion by days. Position drifts from reality the further you travel from the anchoring perihelion.',
};

const UNPHASED: Provenance = {
  tier: 'catalog',
  source: 'Published osculating elements (JPL Small-Body Database)',
  sourceUrl: 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html',
  cadence: 'Static — baked into the build. A live epoch is fetched when the network allows.',
  accuracy:
    'The orbit is real: its size, shape, tilt and orientation are published values, so the track drawn here is where this body actually travels.',
  limitations:
    'The phase along that orbit is NOT known offline, so the body is deliberately not placed and every position-derived readout shows a dash. Inventing a phase would put it up to two orbit radii from the truth and make "distance from Earth" fiction.',
};

const COLOR: Record<BodyKind, string> = {
  asteroid: '#9a8f80',
  comet: '#86c5d6',
  dwarf: '#a99d8c',
  interstellar: '#c084e0',
};

const jd = (iso: string): number => new Date(iso).getTime() / 86400000 + 2440587.5;

export function buildSmallBodies(): SpaceObject[] {
  return BODIES.map((b) => {
    const phased = b.tp !== undefined;
    const elements: Elements = {
      a: b.a * AU_KM,
      e: b.e,
      i: b.i * DEG,
      om: b.node * DEG,
      w: b.peri * DEG,
      // Elements are anchored at perihelion, where the mean anomaly is zero by definition.
      m0: 0,
      epoch: phased ? jd(b.tp!) : 2451545.0,
      mu: GM.sun,
    };

    const obj: SpaceObject = {
      id: b.id,
      name: b.name,
      subtitle: b.subtitle,
      kind: b.kind,
      parent: 'sun',
      color: COLOR[b.kind],
      weight: b.major ? 0.5 : 0.28,
      provenance: phased ? PHASED : UNPHASED,
      ephemeris: phased ? { kind: 'elements', elements } : { kind: 'elements-unphased', elements },
      tags: ['small-body', b.kind, b.group.toLowerCase().replace(/[^a-z]+/g, '-')],
      facts: [
        { label: 'Group', value: b.group },
        { label: 'Semi-major axis', value: `${b.a.toFixed(b.a < 10 ? 3 : 1)} AU` },
        { label: 'Perihelion', value: `${(Math.abs(b.a) * (1 - b.e)).toFixed(3)} AU` },
        ...(b.e < 1 ? [{ label: 'Aphelion', value: `${(b.a * (1 + b.e)).toFixed(b.a < 10 ? 3 : 1)} AU` }] : []),
        { label: 'Eccentricity', value: b.e.toFixed(4) },
        { label: 'Inclination', value: `${b.i.toFixed(2)}°${b.i > 90 ? ' — retrograde' : ''}` },
        ...b.facts.map(([label, value]) => ({ label, value })),
      ],
    };
    if (b.r !== undefined) obj.radiusKm = b.r;
    if (b.status) obj.status = b.status;
    else obj.status = phased ? 'TRACKED' : 'ORBIT ONLY — POSITION NOT FITTED';
    if (!phased) obj.phaseUnknown = true;
    return obj;
  });
}

export const SMALL_BODY_COUNT = BODIES.length;
