import { describe, expect, it } from 'vitest';
import { applyExtraction, normalizeIncident } from '../src/normalize.js';
import { incidentSchema, parseTimestamp } from '../src/schema.js';
import { PROVENANCE_ORIGINS, SOURCE_KINDS } from '../src/taxonomy.js';
import type { SourceDescriptor } from '../src/types.js';

const SOURCE: SourceDescriptor = {
  id: 'test-feed',
  name: 'Test Feed',
  kind: 'public-feed',
  note: 'unit test',
};


const NOW = Date.parse('2026-09-20T12:00:00.000Z');
const RECENT = '2026-09-20T11:45:00.000Z';

function ok(result: ReturnType<typeof normalizeIncident>) {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
  return result;
}

describe('normalizeIncident', () => {
  it('produces a schema-valid incident from a minimal record', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Reported theft from a vehicle on Pike St.' },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(incidentSchema.safeParse(result.incident).success).toBe(true);
    expect(result.incident.source.id).toBe('test-feed');
  });

  it('rejects a record with an unparseable timestamp', () => {
    const result = normalizeIncident(
      { timestamp: 'sometime yesterday', description: 'theft' },
      { source: SOURCE, now: NOW },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-timestamp');
  });

  it('rejects a record with no description and no transcript', () => {
    const result = normalizeIncident({ timestamp: RECENT }, { source: SOURCE, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty-record');
  });

  it('drops an invalid coordinate instead of inventing one, and keeps the record', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Burglary reported', coordinates: { lat: 0, lon: 0 } },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.coordinates).toBeNull();
    expect(result.warnings).toContain('coordinates-rejected');
  });

  it('never marks a positionless record as an exact location', () => {
    const result = ok(
      normalizeIncident(
        {
          timestamp: RECENT,
          description: 'Disturbance reported',
          locationPrecision: 'exact',
          coordinates: null,
        },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.coordinates).toBeNull();
    expect(result.incident.location.precision).toBe('area');
    expect(result.incident.location.approximate).toBe(true);
  });

  it('marks a name-only location as approximate', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Theft', locationLabel: 'Downtown Seattle' },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.location.approximate).toBe(true);
    expect(result.incident.location.label).toBe('Downtown Seattle');
  });

  it('classifies free text when the source gives no usable type', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Multiple callers report shots fired near 3rd Ave.' },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.incidentType).toBe('weapons');
    expect(result.incident.provenance.incidentType?.origin).toBe('derived');
  });

  it('keeps a source-supplied type and records it as source provenance', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'something happened', incidentType: 'robbery' },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.incidentType).toBe('robbery');
    expect(result.incident.provenance.incidentType?.origin).toBe('source');
  });

  it('maps an unrecognised source type through its text and warns', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'call for service', incidentType: 'STRUCTURE FIRE' },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.incidentType).toBe('fire');
    expect(result.warnings.some((w) => w.startsWith('unknown-incident-type'))).toBe(true);
  });

  it('strips control characters and bidi overrides from external text', () => {
    const result = ok(
      normalizeIncident(
        {
          timestamp: RECENT,
          description: 'Theft\u0000 reported‮ evil​ here',
          locationLabel: 'Pike\u0007 St',
        },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.description).not.toMatch(/[\u0000-\u001F‪-‮​]/);
    expect(result.incident.location.label).toBe('Pike St');
  });

  it('clamps an over-long description', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'x'.repeat(5000) },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.description.length).toBeLessThanOrEqual(600);
  });

  it('normalizes percentage confidence and clamps the range', () => {
    const asPercent = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Theft on Pike St', confidence: 85, coordinates: { lat: 47.6, lon: -122.3 } },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(asPercent.incident.confidence).toBeCloseTo(0.85, 2);

    const negative = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Theft on Pike St', confidence: -3 },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(negative.incident.confidence).toBeGreaterThanOrEqual(0);
  });

  it('caps confidence when no position could be established', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Robbery reported', confidence: 0.99 },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.confidence).toBeLessThanOrEqual(0.65);
  });

  it('has no vocabulary for a fabricated incident', () => {
    /*
     * There is no `simulation` source kind and no `simulated` provenance origin: this
     * system ingests published data and cannot generate an incident of its own. Pinning
     * it here means reintroducing a generator would have to reintroduce the vocabulary
     * first, in the open, rather than a fabricated record quietly passing validation.
     */
    expect(SOURCE_KINDS as readonly string[]).not.toContain('simulation');
    expect(PROVENANCE_ORIGINS as readonly string[]).not.toContain('simulated');

    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Theft reported', coordinates: { lat: 47.6, lon: -122.3 } },
        { source: SOURCE, now: NOW },
      ),
    );
    // A value the publisher stated is `source`; nothing else can produce one.
    expect(result.incident.provenance.description?.origin).toBe('source');
  });

  it('derives ids from the external id when one is given, and is stable', () => {
    const make = () =>
      ok(
        normalizeIncident(
          { externalId: 'CAD-991', timestamp: RECENT, description: 'Theft' },
          { source: SOURCE, now: NOW },
        ),
      ).incident.id;
    expect(make()).toBe('test-feed:CAD-991');
    expect(make()).toBe(make());
  });

  it('generates distinct ids when the source has none', () => {
    const a = ok(normalizeIncident({ timestamp: RECENT, description: 'A theft' }, { source: SOURCE, now: NOW }));
    const b = ok(normalizeIncident({ timestamp: RECENT, description: 'A theft' }, { source: SOURCE, now: NOW }));
    expect(a.incident.id).not.toBe(b.incident.id);
  });

  it('deduplicates and lowercases tags', () => {
    const result = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Theft', tags: ['King', 'king', 'THEFT', 42] },
        { source: SOURCE, now: NOW },
      ),
    );
    expect(result.incident.tags).toEqual(['king', 'theft', '42']);
  });
});

describe('parseTimestamp', () => {
  it('accepts ISO strings', () => {
    expect(parseTimestamp('2026-09-20T11:00:00Z', NOW)).toBe('2026-09-20T11:00:00.000Z');
  });

  it('accepts epoch seconds and milliseconds', () => {
    const seconds = Math.floor(NOW / 1000) - 60;
    expect(parseTimestamp(seconds, NOW)).toBe(new Date(seconds * 1000).toISOString());
    expect(parseTimestamp(NOW - 60_000, NOW)).toBe(new Date(NOW - 60_000).toISOString());
  });

  it('rejects implausible and unparseable values', () => {
    expect(parseTimestamp('1975-01-01T00:00:00Z', NOW)).toBeNull();
    expect(parseTimestamp(NOW + 3_600_000, NOW)).toBeNull();
    expect(parseTimestamp('not a date', NOW)).toBeNull();
    expect(parseTimestamp(null, NOW)).toBeNull();
    expect(parseTimestamp('', NOW)).toBeNull();
  });

  it('tolerates a small amount of clock skew', () => {
    expect(parseTimestamp(NOW + 60_000, NOW)).not.toBeNull();
  });
});

describe('applyExtraction', () => {
  const base = ok(
    normalizeIncident(
      { timestamp: RECENT, transcript: 'Units respond for a disturbance', description: '' },
      { source: SOURCE, now: NOW },
    ),
  ).incident;

  it('labels every value it writes as ai-inferred', () => {
    const merged = applyExtraction(base, {
      incidentType: 'robbery',
      severity: 4,
      description: 'Robbery in progress',
      locationLabel: '300 block of Pike St',
      locationPrecision: 'block',
      area: 'Seattle',
      confidence: 0.8,
      extractorId: 'test-model',
    });
    expect(merged.incidentType).toBe('robbery');
    expect(merged.provenance.incidentType?.origin).toBe('ai-inferred');
    expect(merged.provenance.location?.origin).toBe('ai-inferred');
    expect(merged.provenance.description?.note).toBe('test-model');
  });

  it('never overwrites a value the source supplied', () => {
    const fromSource = ok(
      normalizeIncident(
        { timestamp: RECENT, description: 'Reported burglary', incidentType: 'burglary', severity: 3 },
        { source: SOURCE, now: NOW },
      ),
    ).incident;

    const merged = applyExtraction(fromSource, {
      incidentType: 'weapons',
      severity: 5,
      description: 'model rewrite',
      locationLabel: null,
      locationPrecision: null,
      area: null,
      confidence: 0.95,
      extractorId: 'test-model',
    });

    expect(merged.incidentType).toBe('burglary');
    expect(merged.severity).toBe(3);
    expect(merged.description).toBe('Reported burglary');
    expect(merged.provenance.incidentType?.origin).toBe('source');
  });

  it('downgrades an extracted "exact" location, since prose cannot establish one', () => {
    const merged = applyExtraction(base, {
      incidentType: null,
      severity: null,
      description: null,
      locationLabel: '300 block of Pike St',
      locationPrecision: 'exact',
      area: null,
      confidence: 0.7,
      extractorId: 'test-model',
    });
    expect(merged.location.precision).toBe('block');
    expect(merged.location.approximate).toBe(true);
  });
});

describe('identifier derivation', () => {
  it('does not collapse records whose external id sanitizes to nothing', () => {
    const make = (externalId: string) =>
      ok(
        normalizeIncident(
          { externalId, timestamp: RECENT, description: 'Theft reported on Pike St' },
          { source: SOURCE, now: NOW },
        ),
      ).incident.id;

    // Both ids are made entirely of characters the sanitizer strips.
    const a = make('\u0000\u0000');
    const b = make('‮​');
    expect(a).not.toBe(b);
    expect(a).not.toBe('test-feed:');
    expect(b).not.toBe('test-feed:');
  });

  it('still derives a stable id from a usable external id', () => {
    const make = () =>
      ok(
        normalizeIncident(
          { externalId: ' CAD-77 ', timestamp: RECENT, description: 'Theft' },
          { source: SOURCE, now: NOW },
        ),
      ).incident.id;
    expect(make()).toBe('test-feed:CAD-77');
    expect(make()).toBe(make());
  });
});
