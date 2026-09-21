import type { RawIncident, SourceDescriptor } from '@crimetracker/shared';

/**
 * Deterministic fixture records.
 *
 * Tests used to lean on the simulation engine for their sample data. That engine is gone
 * — the system has no way to fabricate an incident — and leaning on it was the wrong
 * shape anyway: a test fixture should state exactly what it is asserting about, not
 * inherit whatever a generator happened to produce this run.
 *
 * Everything here is fixed and explicit. `at` is passed in so a suite controls its own
 * clock rather than racing the wall clock.
 */

const PLACES: readonly { label: string; area: string; lat: number; lon: number }[] = [
  { label: '1500 block of 3rd Ave, Seattle', area: 'Seattle', lat: 47.6105, lon: -122.3378 },
  { label: 'E Pine St & 12th Ave, Seattle', area: 'Seattle', lat: 47.6152, lon: -122.3171 },
  { label: '900 block of Pacific Ave, Tacoma', area: 'Tacoma', lat: 47.2494, lon: -122.4392 },
  { label: 'N Division St & W Sprague Ave, Spokane', area: 'Spokane', lat: 47.6572, lon: -117.4109 },
  { label: 'Bellevue Way NE & NE 8th St', area: 'Bellevue', lat: 47.6154, lon: -122.2016 },
];

const KINDS: readonly { type: string; description: string; severity: number }[] = [
  { type: 'burglary', description: 'Forced entry reported at a commercial address', severity: 3 },
  { type: 'theft', description: 'Shoplifting reported, suspect left on foot', severity: 2 },
  { type: 'traffic', description: 'Two-vehicle collision blocking the right lane', severity: 2 },
  { type: 'assault', description: 'Fight in progress outside a licensed premises', severity: 4 },
  { type: 'medical', description: 'Aid response requested for an unconscious subject', severity: 3 },
];

/** One fully-specified record. Every field is stated, nothing is random. */
export function makeRaw(index: number, at: Date): RawIncident {
  const place = PLACES[index % PLACES.length]!;
  const kind = KINDS[index % KINDS.length]!;
  return {
    externalId: `fixture-${index}`,
    timestamp: at.toISOString(),
    incidentType: kind.type,
    severity: kind.severity,
    description: `${kind.description} (${index})`,
    locationLabel: place.label,
    locationPrecision: 'block',
    area: place.area,
    coordinates: { lat: place.lat, lon: place.lon },
    confidence: 0.8,
  };
}

/** `count` records, one per minute going back from `now`. */
export function makeRaws(count: number, now = Date.now()): RawIncident[] {
  return Array.from({ length: count }, (_, i) => makeRaw(i, new Date(now - i * 60_000)));
}

/**
 * A tight cluster: `count` records within a few hundred metres and a few minutes, which
 * is what the pattern detector exists to find. Stated explicitly so the assertions do not
 * depend on anything having randomly landed close together.
 */
export function makeCluster(count: number, now = Date.now(), area = 'Seattle'): RawIncident[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: `cluster-${i}`,
    timestamp: new Date(now - (count - i) * 60_000).toISOString(),
    incidentType: 'burglary',
    severity: 3,
    description: `Forced entry reported near Pike St, report ${i}`,
    locationLabel: `${100 + i} block of Pike St, Seattle`,
    locationPrecision: 'block',
    area,
    coordinates: { lat: 47.606 + i * 0.0006, lon: -122.332 + i * 0.0006 },
    confidence: 0.8,
  }));
}

/** A stand-in source descriptor for suites that need one but are not testing sources. */
export const TEST_SOURCE: SourceDescriptor = {
  id: 'test-feed',
  name: 'Test Feed',
  kind: 'public-feed',
  note: 'Fixture source for unit tests.',
  url: null,
};
