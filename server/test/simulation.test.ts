import { describe, expect, it } from 'vitest';
import { normalizeIncident, WASHINGTON_BBOX, containsPoint, INCIDENT_TYPES } from '@crimetracker/shared';
import { SimulationGenerator } from '../src/sim/generator.js';
import { SIM_PLACES } from '../src/sim/places.js';
import { SIMULATION_DESCRIPTOR } from '../src/sources/simulation.js';

describe('SimulationGenerator', () => {
  it('is deterministic for a given seed', () => {
    const at = new Date('2026-09-20T18:00:00Z');
    const a = new SimulationGenerator({ seed: 'fixed' }).generate(at);
    const b = new SimulationGenerator({ seed: 'fixed' }).generate(at);
    expect(a.description).toBe(b.description);
    expect(a.coordinates).toEqual(b.coordinates);
    expect(a.incidentType).toBe(b.incidentType);
  });

  it('differs between seeds', () => {
    const at = new Date('2026-09-20T18:00:00Z');
    const a = new SimulationGenerator({ seed: 'one' }).generate(at);
    const b = new SimulationGenerator({ seed: 'two' }).generate(at);
    expect([a.description, a.place.name]).not.toEqual([b.description, b.place.name]);
  });

  it('produces records that normalize cleanly', () => {
    const generator = new SimulationGenerator({ seed: 'normalize-check' });
    const now = Date.now();
    for (let i = 0; i < 400; i += 1) {
      const event = generator.generate(new Date(now - i * 1000));
      const result = normalizeIncident(event, { source: SIMULATION_DESCRIPTOR, now });
      if (!result.ok) throw new Error(`generated record failed to normalize: ${result.reason}`);
      expect(result.warnings).toEqual([]);
    }
  });

  it('only ever places incidents inside Washington', () => {
    const generator = new SimulationGenerator({ seed: 'inside-wa' });
    for (let i = 0; i < 600; i += 1) {
      const event = generator.generate();
      if (!event.coordinates) continue;
      expect(containsPoint(WASHINGTON_BBOX, event.coordinates as { lat: number; lon: number })).toBe(true);
    }
  });

  it('emits some records with no position at all, as real feeds do', () => {
    const generator = new SimulationGenerator({ seed: 'no-position', noCoordinateRate: 0.3 });
    const events = Array.from({ length: 300 }, () => generator.generate());
    const missing = events.filter((e) => e.coordinates === null).length;
    expect(missing).toBeGreaterThan(0);
    expect(missing).toBeLessThan(events.length);
    for (const event of events) {
      if (event.coordinates === null) expect(event.locationPrecision).toBe('unknown');
    }
  });

  it('marks every record as fictional in its raw payload', () => {
    const event = new SimulationGenerator({ seed: 'fiction' }).generate();
    expect((event.raw as { simulation?: boolean }).simulation).toBe(true);
  });

  it('uses only known incident types and valid severities', () => {
    const generator = new SimulationGenerator({ seed: 'taxonomy' });
    for (let i = 0; i < 300; i += 1) {
      const event = generator.generate();
      expect(INCIDENT_TYPES).toContain(event.incidentType);
      expect(event.severity).toBeGreaterThanOrEqual(1);
      expect(event.severity).toBeLessThanOrEqual(5);
    }
  });

  it('generates transcripts for some records and not others', () => {
    const generator = new SimulationGenerator({ seed: 'transcripts', transcriptRate: 0.5 });
    const events = Array.from({ length: 200 }, () => generator.generate());
    const withTranscript = events.filter((e) => e.transcript).length;
    expect(withTranscript).toBeGreaterThan(20);
    expect(withTranscript).toBeLessThan(180);
  });

  it('produces bursts that are tight in space and time', () => {
    const generator = new SimulationGenerator({ seed: 'burst' });
    const at = new Date();
    const burst = generator.generateBurst(at, 7);
    expect(burst).toHaveLength(7);

    const places = new Set(burst.map((e) => e.place.name));
    expect(places.size).toBe(1);

    const times = burst.map((e) => Date.parse(String(e.timestamp)));
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(25 * 60_000);
    // Sorted oldest-first, so the stream replays a burst in order.
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('derives inter-arrival gaps that are positive and vary', () => {
    const generator = new SimulationGenerator({ seed: 'arrivals' });
    const gaps = Array.from({ length: 50 }, () => generator.nextInterval(8));
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(40);
  });

  it('generates unique external ids', () => {
    const generator = new SimulationGenerator({ seed: 'ids' });
    const at = new Date();
    const ids = Array.from({ length: 200 }, () => generator.generate(at).externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('place table', () => {
  it('places every entry inside Washington', () => {
    for (const place of SIM_PLACES) {
      expect(containsPoint(WASHINGTON_BBOX, { lat: place.lat, lon: place.lon })).toBe(true);
    }
  });

  it('gives every place a positive weight and at least one street', () => {
    for (const place of SIM_PLACES) {
      expect(place.weight).toBeGreaterThan(0);
      expect(place.spreadKm).toBeGreaterThan(0);
      expect(place.streets.length).toBeGreaterThan(0);
    }
  });
});
