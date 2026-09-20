import { describe, expect, it } from 'vitest';
import type { Incident, IncidentType } from '@crimetracker/shared';
import { matchesFilters } from '../src/state/selectors.js';
import { DEFAULT_FILTERS, type Filters } from '../src/state/store.js';
import { findPlaces, WA_PLACES } from '../src/lib/places.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'x',
    timestamp: new Date(NOW - 10 * 60_000).toISOString(),
    ingestedAt: new Date(NOW - 10 * 60_000).toISOString(),
    source: { id: 'simulation', name: 'Simulation Engine', kind: 'simulation', url: null },
    incidentType: 'theft',
    severity: 2,
    description: 'Reported theft from a parked vehicle near Pike St.',
    location: { label: '300 block of Pike St, Seattle', approximate: true, precision: 'block', area: 'Seattle' },
    coordinates: { lat: 47.6062, lon: -122.3321 },
    confidence: 0.8,
    transcript: null,
    status: 'normalized',
    provenance: {},
    tags: [],
    ...overrides,
  };
}

const filters = (patch: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...patch });

describe('matchesFilters', () => {
  it('passes everything through with the default filters', () => {
    expect(matchesFilters(incident(), filters(), NOW, null)).toBe(true);
  });

  it('filters by type', () => {
    const only = new Set<IncidentType>(['robbery']);
    expect(matchesFilters(incident(), filters({ types: only }), NOW, null)).toBe(false);
    expect(matchesFilters(incident({ incidentType: 'robbery' }), filters({ types: only }), NOW, null)).toBe(true);
  });

  it('treats an empty type set as "all types"', () => {
    expect(matchesFilters(incident(), filters({ types: new Set() }), NOW, null)).toBe(true);
  });

  it('filters by minimum severity', () => {
    expect(matchesFilters(incident({ severity: 2 }), filters({ minSeverity: 4 }), NOW, null)).toBe(false);
    expect(matchesFilters(incident({ severity: 5 }), filters({ minSeverity: 4 }), NOW, null)).toBe(true);
  });

  it('filters by time window', () => {
    const old = incident({ timestamp: new Date(NOW - 6 * 60 * 60_000).toISOString() });
    expect(matchesFilters(old, filters({ sinceMinutes: 60 }), NOW, null)).toBe(false);
    expect(matchesFilters(old, filters({ sinceMinutes: 720 }), NOW, null)).toBe(true);
  });

  it('filters by source', () => {
    const onlyFeed = new Set(['public-feed']);
    expect(matchesFilters(incident(), filters({ sources: onlyFeed }), NOW, null)).toBe(false);
  });

  it('filters by geographic radius and excludes positionless incidents', () => {
    const seattle = { label: 'Seattle', lat: 47.6062, lon: -122.3321, radiusKm: 10 };
    expect(matchesFilters(incident(), filters({ geo: seattle }), NOW, null)).toBe(true);

    const spokane = incident({ coordinates: { lat: 47.6588, lon: -117.426 } });
    expect(matchesFilters(spokane, filters({ geo: seattle }), NOW, null)).toBe(false);

    const noPosition = incident({ coordinates: null });
    expect(matchesFilters(noPosition, filters({ geo: seattle }), NOW, null)).toBe(false);
  });

  it('keeps positionless incidents visible when no geographic filter is set', () => {
    expect(matchesFilters(incident({ coordinates: null }), filters(), NOW, null)).toBe(true);
  });

  it('filters to the viewport only when asked', () => {
    const viewport: [number, number, number, number] = [-122.5, 47.5, -122.2, 47.7];
    expect(matchesFilters(incident(), filters({ viewportOnly: true }), NOW, viewport)).toBe(true);

    const spokane = incident({ coordinates: { lat: 47.6588, lon: -117.426 } });
    expect(matchesFilters(spokane, filters({ viewportOnly: true }), NOW, viewport)).toBe(false);
    // With the toggle off, the viewport is irrelevant.
    expect(matchesFilters(spokane, filters(), NOW, viewport)).toBe(true);
  });

  it('matches keywords across description, location, type and source', () => {
    expect(matchesFilters(incident(), filters({ query: 'pike' }), NOW, null)).toBe(true);
    expect(matchesFilters(incident(), filters({ query: 'theft' }), NOW, null)).toBe(true);
    expect(matchesFilters(incident(), filters({ query: 'simulation' }), NOW, null)).toBe(true);
    expect(matchesFilters(incident(), filters({ query: 'spokane' }), NOW, null)).toBe(false);
  });

  it('requires every word of a multi-word query', () => {
    expect(matchesFilters(incident(), filters({ query: 'theft pike' }), NOW, null)).toBe(true);
    expect(matchesFilters(incident(), filters({ query: 'theft spokane' }), NOW, null)).toBe(false);
  });

  it('matches the transcript when one is present', () => {
    const withTranscript = incident({ transcript: 'Units respond for a shoplifting call at the mall.' });
    expect(matchesFilters(withTranscript, filters({ query: 'shoplifting' }), NOW, null)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesFilters(incident(), filters({ query: 'PIKE ST' }), NOW, null)).toBe(true);
  });
});

describe('place lookup', () => {
  it('prefers a prefix match', () => {
    expect(findPlaces('sea')[0]?.label).toBe('Seattle');
  });

  it('matches on county as a fallback', () => {
    expect(findPlaces('kitsap').map((p) => p.label)).toContain('Bremerton');
  });

  it('is case-insensitive and returns nothing for an empty query', () => {
    expect(findPlaces('SPOKANE')[0]?.label).toBe('Spokane');
    expect(findPlaces('')).toEqual([]);
    expect(findPlaces('   ')).toEqual([]);
  });

  it('bounds the number of results', () => {
    expect(findPlaces('a', 3).length).toBeLessThanOrEqual(3);
  });

  it('gives every place a sane default radius', () => {
    for (const place of WA_PLACES) {
      expect(place.radiusKm).toBeGreaterThan(0);
      expect(place.radiusKm).toBeLessThan(60);
    }
  });
});
