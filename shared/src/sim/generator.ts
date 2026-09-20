import { createRng, type Rng } from '../rng.js';
import { offsetCoordinates } from '../geo.js';
import type { IncidentType, SeverityLevel } from '../taxonomy.js';
import type { RawIncident } from '../types.js';
import { SIM_PLACES, streetsFor, type SimPlace } from './places.js';

/**
 * Fictional-incident generator.
 *
 * Everything this module produces is invented. It exists so the interface is fully
 * exercisable with no live feed attached, and every incident it emits is tagged with the
 * `simulation` source kind so the UI can label it unmistakably.
 */

interface TypeProfile {
  readonly type: IncidentType;
  /** Base likelihood. */
  readonly weight: number;
  /** Severity distribution — picked uniformly from this list. */
  readonly severities: readonly SeverityLevel[];
  /** Hour-of-day multiplier, 24 entries. */
  readonly diurnal: readonly number[];
  readonly templates: readonly string[];
  readonly radioTemplates: readonly string[];
}

const NIGHT = [1.4, 1.5, 1.4, 1.1, 0.8, 0.5, 0.4, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.9, 1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.6, 1.5];
const DAY = [0.4, 0.3, 0.3, 0.3, 0.4, 0.6, 0.9, 1.2, 1.4, 1.4, 1.3, 1.3, 1.3, 1.3, 1.4, 1.5, 1.5, 1.4, 1.2, 1.0, 0.8, 0.7, 0.6, 0.5];
const COMMUTE = [0.3, 0.2, 0.2, 0.3, 0.5, 0.9, 1.6, 2.0, 1.8, 1.1, 0.9, 0.9, 1.0, 1.0, 1.1, 1.5, 2.0, 2.1, 1.6, 1.0, 0.7, 0.5, 0.4, 0.3];
const FLAT = new Array(24).fill(1) as number[];

const PROFILES: readonly TypeProfile[] = [
  {
    type: 'theft',
    weight: 20,
    severities: [1, 2, 2, 3],
    diurnal: DAY,
    templates: [
      'Reported theft from a parked vehicle near {street}.',
      'Retail loss report filed at a business on {street}.',
      'Caller reports a package taken from a porch on {street}.',
      'Bicycle reported stolen from a rack near {street}.',
    ],
    radioTemplates: [
      'Units, respond {block} {street} for a theft report, complainant on scene, no suspect present.',
      'Copy, take a report at {block} {street}, theft cold call, no injuries.',
    ],
  },
  {
    type: 'disturbance',
    weight: 17,
    severities: [1, 2, 2, 3],
    diurnal: NIGHT,
    templates: [
      'Verbal disturbance reported between two parties outside a business on {street}.',
      'Noise complaint at a residence near {block} {street}.',
      'Caller reports an ongoing argument in a parking area near {street}.',
    ],
    radioTemplates: [
      '{unit}, disturbance call {block} {street}, two parties yelling, no weapons mentioned.',
      'Any available unit for a noise complaint, {block} {street}, third call tonight.',
    ],
  },
  {
    type: 'traffic',
    weight: 15,
    severities: [1, 2, 2, 3, 3],
    diurnal: COMMUTE,
    templates: [
      'Two-vehicle collision reported at {street} and {cross}; lanes partially blocked.',
      'Disabled vehicle reported in the right lane near {street}.',
      'Non-injury collision reported in a parking area off {street}.',
    ],
    radioTemplates: [
      'Traffic, we have a two-car {street} at {cross}, blocking the number two lane, no injuries reported.',
      'Show me out at {block} {street} with a disabled vehicle, requesting a cone truck.',
    ],
  },
  {
    type: 'suspicious',
    weight: 12,
    severities: [1, 2, 2],
    diurnal: NIGHT,
    templates: [
      'Caller reports a person checking door handles on parked cars near {street}.',
      'Suspicious circumstances reported behind a business on {block} {street}.',
      'Area check requested near {street} following a caller report.',
    ],
    radioTemplates: [
      '{unit}, check the area {block} {street} for a suspicious circumstances call, caller will be by phone.',
      'Clear of the area check at {block} {street}, negative contact.',
    ],
  },
  {
    type: 'burglary',
    weight: 9,
    severities: [2, 3, 3, 4],
    diurnal: NIGHT,
    templates: [
      'Forced entry reported at a commercial unit on {block} {street}.',
      'Residential burglary reported near {street}; entry through a rear window.',
      'Alarm activation followed by a report of a broken door at {block} {street}.',
    ],
    radioTemplates: [
      '{unit}, burglary report at {block} {street}, rear door forced, unknown if suspect still inside.',
      'Dispatch, we have an open door at {block} {street}, starting a search, request a second unit.',
    ],
  },
  {
    type: 'vehicle',
    weight: 9,
    severities: [2, 3, 3, 4],
    diurnal: NIGHT,
    templates: [
      'Vehicle reported stolen from a lot near {street}.',
      'Vehicle prowl reported at {block} {street}; window broken.',
      'Reckless driver reported travelling on {street} toward {cross}.',
    ],
    radioTemplates: [
      'Be advised, stolen vehicle out of {block} {street}, taken within the last hour.',
      '{unit}, we have a reckless driver reported {street} at {cross}, no plate given.',
    ],
  },
  {
    type: 'medical',
    weight: 8,
    severities: [2, 3, 3, 4],
    diurnal: FLAT,
    templates: [
      'Aid response requested for a person reported unconscious near {block} {street}.',
      'Medical aid requested at a residence on {street}.',
      'Aid crew dispatched for a reported fall at a business on {block} {street}.',
    ],
    radioTemplates: [
      'Aid {unitNum}, respond {block} {street} for an unresponsive party, CPR in progress per caller.',
      'Medic {unitNum} responding to {block} {street}, code yellow.',
    ],
  },
  {
    type: 'assault',
    weight: 6,
    severities: [3, 4, 4, 5],
    diurnal: NIGHT,
    templates: [
      'Physical altercation reported outside a venue on {block} {street}.',
      'Assault reported near {street}; one party reported injured.',
      'Fight in progress reported near the intersection of {street} and {cross}.',
    ],
    radioTemplates: [
      '{unit}, fight in progress {block} {street}, multiple parties, aid is staging.',
      'Dispatch, we have one party with visible injuries at {block} {street}, request aid.',
    ],
  },
  {
    type: 'fire',
    weight: 5,
    severities: [3, 4, 4, 5],
    diurnal: FLAT,
    templates: [
      'Smoke reported from a single-storey structure on {block} {street}.',
      'Vehicle fire reported in a parking area near {street}.',
      'Brush fire reported adjacent to {street}, spreading toward {cross}.',
    ],
    radioTemplates: [
      'Engine {unitNum} on scene {block} {street}, smoke showing from the rear, establishing command.',
      'Dispatch, upgrade {block} {street} to a full structure response.',
    ],
  },
  {
    type: 'hazard',
    weight: 5,
    severities: [2, 3, 3, 4],
    diurnal: FLAT,
    templates: [
      'Wires reported down across {street} near {cross}.',
      'Reported fluid spill in a roadway near {block} {street}.',
      'Localised flooding reported on {street}; roadway partially impassable.',
    ],
    radioTemplates: [
      '{unit}, wires down {street} at {cross}, utility notified, blocking the roadway.',
      'Show us out at {block} {street} with a roadway hazard, requesting flares.',
    ],
  },
  {
    type: 'robbery',
    weight: 4,
    severities: [4, 4, 5],
    diurnal: NIGHT,
    templates: [
      'Robbery reported at a business on {block} {street}; suspect left on foot.',
      'Strong-arm robbery reported near a transit stop on {street}.',
    ],
    radioTemplates: [
      'All units, robbery just occurred {block} {street}, suspect last seen northbound on foot.',
      'Dispatch, get me a containment for {block} {street}, robbery, no weapon seen.',
    ],
  },
  {
    type: 'weapons',
    weight: 3,
    severities: [4, 5, 5],
    diurnal: NIGHT,
    templates: [
      'Multiple callers report hearing possible gunshots in the area of {block} {street}.',
      'Weapon reportedly displayed during a dispute near {street}.',
    ],
    radioTemplates: [
      'All units, shots heard {block} {street}, multiple callers, no victims located at this time.',
      'Dispatch, be advised callers report a weapon displayed at {block} {street}, units use caution.',
    ],
  },
  {
    type: 'missing-person',
    weight: 3,
    severities: [3, 4, 4],
    diurnal: DAY,
    templates: [
      'Welfare check requested for a person last seen near {street}.',
      'Missing person report taken at a residence on {block} {street}.',
    ],
    radioTemplates: [
      '{unit}, take a missing person report at {block} {street}, last seen approximately two hours ago.',
      'Dispatch, start an area check around {block} {street} for a welfare check.',
    ],
  },
];

const UNIT_PREFIXES = ['Adam', 'Baker', 'Charlie', 'David', 'Edward', 'Frank', 'King', 'Lincoln'];

export interface SimulatedEvent extends RawIncident {
  /** Place used, exposed so the burst generator can cluster around the same spot. */
  readonly place: SimPlace;
}

export interface GeneratorOptions {
  readonly seed?: string | number;
  /** Probability an event carries a radio-style transcript instead of a structured line. */
  readonly transcriptRate?: number;
  /** Probability the position is degraded to an area-level (no coordinates) report. */
  readonly noCoordinateRate?: number;
}

export class SimulationGenerator {
  readonly #rng: Rng;
  readonly #transcriptRate: number;
  readonly #noCoordinateRate: number;
  #sequence = 0;

  constructor(options: GeneratorOptions = {}) {
    this.#rng = createRng(options.seed ?? Date.now());
    this.#transcriptRate = options.transcriptRate ?? 0.45;
    this.#noCoordinateRate = options.noCoordinateRate ?? 0.08;
  }

  /** Mean seconds until the next event, given the hour of day. */
  nextInterval(meanSeconds: number, at: Date = new Date()): number {
    const hourWeight = COMMUTE[at.getHours()] ?? 1;
    // Busier hours ⇒ shorter gaps.
    return Math.max(0.4, this.#rng.exponential(meanSeconds / Math.max(0.4, hourWeight)));
  }

  /** Generate one fictional incident for the given moment. */
  generate(at: Date = new Date()): SimulatedEvent {
    const place = this.#pickPlace();
    const profile = this.#pickProfile(at.getHours());
    return this.#build(place, profile, at);
  }

  /**
   * Generate a spatially and temporally tight run of related reports.
   *
   * This is what makes pattern detection worth having: without occasional bursts the
   * data is a uniform sprinkle and nothing ever stands out.
   */
  generateBurst(at: Date = new Date(), size?: number): SimulatedEvent[] {
    const place = this.#pickPlace();
    const count = size ?? this.#rng.int(4, 8);
    // A burst leans on one or two types, the way a real run of related calls would.
    const primary = this.#pickProfile(at.getHours());
    const events: SimulatedEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      const profile = this.#rng.bool(0.72) ? primary : this.#pickProfile(at.getHours());
      // Tight in both space and time, so a burst is distinguishable from the ambient
      // rate rather than blending into it.
      const when = new Date(at.getTime() - this.#rng.int(0, 12 * 60_000));
      events.push(this.#build(place, profile, when, 0.18));
    }
    return events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  }

  #pickPlace(): SimPlace {
    return this.#rng.weighted(SIM_PLACES.map((value) => ({ value, weight: value.weight })));
  }

  #pickProfile(hour: number): TypeProfile {
    return this.#rng.weighted(
      PROFILES.map((value) => ({ value, weight: value.weight * (value.diurnal[hour] ?? 1) })),
    );
  }

  #build(
    place: SimPlace,
    profile: TypeProfile,
    at: Date,
    spreadScale = 1,
  ): SimulatedEvent {
    const rng = this.#rng;
    const streets = streetsFor(place);
    const street = rng.pick(streets);
    let cross = rng.pick(streets);
    if (cross === street) cross = streets[(streets.indexOf(street) + 1) % streets.length] as string;
    const block = `${rng.int(1, 99) * 100}`;
    const unit = `${rng.pick(UNIT_PREFIXES)}-${rng.int(10, 89)}`;
    const unitNum = `${rng.int(1, 40)}`;

    const fill = (template: string) =>
      template
        .replaceAll('{street}', street)
        .replaceAll('{cross}', cross)
        .replaceAll('{block}', `${block} block of`)
        .replaceAll('{unit}', unit)
        .replaceAll('{unitNum}', unitNum);

    const description = fill(rng.pick(profile.templates));
    const useTranscript = rng.bool(this.#transcriptRate);
    const transcript = useTranscript
      ? [fill(rng.pick(profile.radioTemplates)), rng.bool(0.5) ? fill(rng.pick(profile.radioTemplates)) : null]
          .filter(Boolean)
          .join('\n')
      : null;

    // Scatter around the place centre. `gaussian` keeps most points near the middle.
    const bearing = rng.float(0, 360);
    const distance = Math.abs(rng.gaussian(0, (place.spreadKm * spreadScale) / 2));
    const point = offsetCoordinates({ lat: place.lat, lon: place.lon }, distance, bearing);

    // Some reports genuinely arrive without a usable position. Model that honestly rather
    // than pretending every incident can be plotted.
    const positionKnown = !rng.bool(this.#noCoordinateRate);
    const precision = positionKnown
      ? rng.bool(0.55)
        ? 'block'
        : 'exact'
      : 'unknown';

    const severity = rng.pick(profile.severities);
    this.#sequence += 1;

    return {
      place,
      externalId: `sim-${at.getTime().toString(36)}-${this.#sequence.toString(36)}`,
      timestamp: at.toISOString(),
      incidentType: profile.type,
      severity,
      description,
      locationLabel: positionKnown
        ? `${block} block of ${street}, ${place.area}`
        : `${place.area} area — position not specified`,
      locationPrecision: precision,
      area: place.area,
      coordinates: positionKnown ? point : null,
      confidence: Math.round(rng.float(positionKnown ? 0.62 : 0.4, 0.96) * 100) / 100,
      transcript,
      status: rng.bool(0.82) ? 'verified' : 'normalized',
      tags: [place.county.toLowerCase(), profile.type],
      raw: {
        simulation: true,
        place: place.name,
        note: 'Fictional record produced by the Crime Tracker simulation engine.',
      },
    };
  }
}
