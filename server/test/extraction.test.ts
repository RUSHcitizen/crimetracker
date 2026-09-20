import { describe, expect, it } from 'vitest';
import { HeuristicExtractor, extractLocation, estimateSeverity } from '../src/extraction/heuristic.js';
import { OpenAICompatibleExtractor, extractJsonObject } from '../src/extraction/openaiCompatible.js';
import { FallbackExtractor } from '../src/extraction/index.js';
import type { ExtractionInput, IncidentExtractor } from '../src/extraction/types.js';

const RECEIVED = '2026-09-20T12:00:00.000Z';
const input = (transcript: string): ExtractionInput => ({ transcript, receivedAt: RECEIVED });

describe('HeuristicExtractor', () => {
  const extractor = new HeuristicExtractor();

  it('extracts type, location and severity from a dispatch-style transcript', async () => {
    const result = await extractor.extract(
      input('All units, robbery just occurred 1400 block of Pike St, suspect last seen northbound on foot.'),
    );
    expect(result.incidentType).toBe('robbery');
    expect(result.locationLabel).toBe('1400 block of Pike St');
    expect(result.locationPrecision).toBe('block');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.extractorId).toBe('heuristic-v1');
  });

  it('never returns coordinates — text cannot establish a position', async () => {
    const result = await extractor.extract(
      input('Shots fired at latitude 47.6062 longitude -122.3321, units respond.'),
    );
    expect(result.coordinates).toBeNull();
  });

  it('reports low confidence and no type when nothing is recognisable', async () => {
    const result = await extractor.extract(input('Radio check, how do you copy.'));
    expect(result.incidentType).toBeNull();
    expect(result.confidence).toBeLessThanOrEqual(0.35);
  });

  it('raises severity for urgency language and lowers it for routine language', async () => {
    const urgent = await extractor.extract(input('Assault in progress, multiple victims, aid staging.'));
    const routine = await extractor.extract(input('Assault report, cold call, no injuries.'));
    expect(urgent.severity!).toBeGreaterThan(routine.severity!);
  });

  it('explains what it matched', async () => {
    const result = await extractor.extract(input('Structure fire reported at 800 block of Main St.'));
    expect(result.notes.join(' ')).toContain('matched phrase');
    expect(result.notes.join(' ')).toContain('location phrase');
  });

  it('handles empty input without throwing', async () => {
    const result = await extractor.extract(input(''));
    expect(result.incidentType).toBeNull();
    expect(result.locationLabel).toBeNull();
  });
});

describe('extractLocation', () => {
  it('reads block references', () => {
    expect(extractLocation('units to the 2300 block of E Pine St')).toEqual({
      label: '2300 block of E Pine St',
      precision: 'block',
    });
  });

  it('reads street addresses as block-level, never exact', () => {
    const result = extractLocation('respond to 1425 4th Avenue for a theft');
    expect(result?.precision).toBe('block');
    expect(result?.label).toContain('4th Avenue');
  });

  it('reads highway references as area-level', () => {
    expect(extractLocation('collision on I-90 near milepost 34')).toEqual({
      label: 'I-90',
      precision: 'area',
    });
  });

  it('reads intersections as area-level', () => {
    const result = extractLocation('traffic at Pike St and 3rd Ave, blocking');
    expect(result?.precision).toBe('area');
    expect(result?.label).toContain('&');
  });

  it('returns null when there is no location at all', () => {
    expect(extractLocation('all units stand by for a radio check')).toBeNull();
  });
});

describe('estimateSeverity', () => {
  it('clamps to the 1–5 range', () => {
    expect(estimateSeverity('shots fired in progress weapon cpr officer needs', 5)).toBeLessThanOrEqual(5);
    expect(estimateSeverity('cold call report only no injuries unfounded', 1)).toBeGreaterThanOrEqual(1);
  });
});

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses an object inside a fenced block', () => {
    expect(extractJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('parses an object surrounded by prose', () => {
    expect(extractJsonObject('Here you go: {"a":3} — hope that helps')).toEqual({ a: 3 });
  });

  it('returns null for unusable content', () => {
    expect(extractJsonObject('no json at all')).toBeNull();
    expect(extractJsonObject('{broken')).toBeNull();
  });
});

describe('OpenAICompatibleExtractor', () => {
  const extractor = new OpenAICompatibleExtractor({ baseUrl: 'https://example.invalid/v1', model: 'test-model' });

  it('coerces a well-formed model response onto the controlled vocabulary', () => {
    const result = extractor.parse(
      JSON.stringify({
        incident_type: 'Robbery',
        severity: '4',
        description: 'Robbery at a business',
        location: '1400 block of Pike St',
        location_precision: 'block',
        area: 'Seattle',
        confidence: 0.82,
        notes: ['suspect fled on foot'],
      }),
    );
    expect(result.incidentType).toBe('robbery');
    expect(result.severity).toBe(4);
    expect(result.confidence).toBeCloseTo(0.82, 2);
    expect(result.area).toBe('Seattle');
  });

  it('discards an incident type it does not recognise instead of passing it through', () => {
    const result = extractor.parse(JSON.stringify({ incident_type: 'alien-invasion', confidence: 0.9 }));
    expect(result.incidentType).toBeNull();
    expect(result.notes.join(' ')).toContain('discarded unknown type');
  });

  it('downgrades a claimed exact location: a model reading prose cannot establish one', () => {
    const result = extractor.parse(
      JSON.stringify({ location: '1425 4th Ave', location_precision: 'exact', confidence: 0.9 }),
    );
    expect(result.locationPrecision).toBe('block');
  });

  it('refuses coordinates even when the model supplies them', () => {
    const result = extractor.parse(
      JSON.stringify({ incident_type: 'theft', coordinates: { lat: 47.6, lon: -122.3 }, confidence: 0.9 }),
    );
    expect(result.coordinates).toBeNull();
  });

  it('sanitizes and clamps hostile text in the response', () => {
    const result = extractor.parse(
      JSON.stringify({
        incident_type: 'theft',
        description: `Theft\u0000 report‮ ${'x'.repeat(2000)}`,
        confidence: 5000,
      }),
    );
    expect(result.description!.length).toBeLessThanOrEqual(600);
    expect(result.description).not.toMatch(/[\u0000‮]/);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('degrades to an empty extraction on unusable output', () => {
    const result = extractor.parse('the model is unavailable right now');
    expect(result.confidence).toBe(0);
    expect(result.incidentType).toBeNull();
    expect(result.notes.join(' ')).toContain('not JSON');
  });

  it('surfaces a provider HTTP error without throwing', async () => {
    const failing = new OpenAICompatibleExtractor({
      baseUrl: 'https://example.invalid/v1',
      model: 'm',
      fetchImpl: async () => new Response('nope', { status: 500 }),
    });
    const result = await failing.extract(input('robbery in progress'));
    expect(result.confidence).toBe(0);
    expect(result.notes.join(' ')).toContain('HTTP 500');
  });

  it('never sends the API key unless one is configured', async () => {
    let headers: Record<string, string> = {};
    const spy = new OpenAICompatibleExtractor({
      baseUrl: 'https://example.invalid/v1',
      model: 'm',
      fetchImpl: async (_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await spy.extract(input('theft'));
    expect(headers.authorization).toBeUndefined();
  });
});

describe('FallbackExtractor', () => {
  it('falls back to the local extractor when the primary returns nothing usable', async () => {
    const dead: IncidentExtractor = {
      id: 'dead',
      label: 'dead',
      extract: async () => ({
        incidentType: null,
        severity: null,
        description: null,
        locationLabel: null,
        locationPrecision: null,
        area: null,
        coordinates: null,
        confidence: 0,
        extractorId: 'dead',
        notes: ['provider offline'],
      }),
    };
    const extractor = new FallbackExtractor(dead, new HeuristicExtractor());
    const result = await extractor.extract(input('Robbery just occurred 1400 block of Pike St.'));
    expect(result.incidentType).toBe('robbery');
    expect(result.notes.join(' ')).toContain('fell back to heuristic-v1');
  });

  it('keeps the primary result when it is usable', async () => {
    const good: IncidentExtractor = {
      id: 'good',
      label: 'good',
      extract: async () => ({
        incidentType: 'fire',
        severity: 4,
        description: 'Structure fire',
        locationLabel: null,
        locationPrecision: null,
        area: null,
        coordinates: null,
        confidence: 0.9,
        extractorId: 'good',
        notes: [],
      }),
    };
    const extractor = new FallbackExtractor(good, new HeuristicExtractor());
    const result = await extractor.extract(input('Robbery just occurred 1400 block of Pike St.'));
    expect(result.incidentType).toBe('fire');
  });
});
