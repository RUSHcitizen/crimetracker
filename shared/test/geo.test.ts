import { describe, expect, it } from 'vitest';
import {
  centroid,
  containsPoint,
  haversineKm,
  offsetCoordinates,
  radiusKm,
  validateCoordinates,
  WASHINGTON_BBOX,
} from '../src/geo.js';

describe('validateCoordinates', () => {
  it('accepts a well-formed point inside the region', () => {
    expect(validateCoordinates({ lat: 47.6062, lon: -122.3321 })).toEqual({
      lat: 47.6062,
      lon: -122.3321,
    });
  });

  it('accepts GeoJSON [lon, lat] arrays', () => {
    expect(validateCoordinates([-122.3321, 47.6062])).toEqual({ lat: 47.6062, lon: -122.3321 });
  });

  it('accepts numeric strings, which feeds routinely emit', () => {
    expect(validateCoordinates({ latitude: '47.6', longitude: '-122.33' })).toEqual({
      lat: 47.6,
      lon: -122.33,
    });
  });

  it('rejects rather than repairs: swapped lat/lon falls outside the region', () => {
    expect(validateCoordinates({ lat: -122.3321, lon: 47.6062 })).toBeNull();
  });

  it('rejects the null-island sentinel', () => {
    expect(validateCoordinates({ lat: 0, lon: 0 })).toBeNull();
  });

  it('rejects out-of-range values', () => {
    expect(validateCoordinates({ lat: 95, lon: -122 })).toBeNull();
    expect(validateCoordinates({ lat: 47, lon: -400 })).toBeNull();
  });

  it('rejects non-numeric and missing input', () => {
    expect(validateCoordinates({ lat: 'north', lon: 'west' })).toBeNull();
    expect(validateCoordinates(null)).toBeNull();
    expect(validateCoordinates(undefined)).toBeNull();
    expect(validateCoordinates({ lat: NaN, lon: 1 })).toBeNull();
    expect(validateCoordinates('47.6,-122.3')).toBeNull();
  });

  it('rejects a valid point that falls outside the configured region', () => {
    // Central Park: a perfectly valid coordinate, but not Washington.
    expect(validateCoordinates({ lat: 40.7829, lon: -73.9654 })).toBeNull();
    // ...and accepted when the region check is disabled.
    expect(validateCoordinates({ lat: 40.7829, lon: -73.9654 }, null)).not.toBeNull();
  });

  it('clamps stored precision to five decimals', () => {
    const result = validateCoordinates({ lat: 47.123456789, lon: -122.987654321 });
    expect(result).toEqual({ lat: 47.12346, lon: -122.98765 });
  });
});

describe('distance helpers', () => {
  it('computes a known great-circle distance', () => {
    // Seattle → Tacoma is about 40 km.
    const km = haversineKm({ lat: 47.6062, lon: -122.3321 }, { lat: 47.2529, lon: -122.4443 });
    expect(km).toBeGreaterThan(38);
    expect(km).toBeLessThan(42);
  });

  it('is zero for identical points', () => {
    expect(haversineKm({ lat: 47, lon: -122 }, { lat: 47, lon: -122 })).toBe(0);
  });

  it('offsets by a requested distance', () => {
    const origin = { lat: 47.6, lon: -122.33 };
    const moved = offsetCoordinates(origin, 5, 90);
    expect(haversineKm(origin, moved)).toBeCloseTo(5, 1);
  });

  it('computes centroid and radius over a set', () => {
    const points = [
      { lat: 47.6, lon: -122.3 },
      { lat: 47.7, lon: -122.3 },
      { lat: 47.65, lon: -122.4 },
    ];
    const center = centroid(points);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeCloseTo(47.65, 2);
    expect(radiusKm(center!, points)).toBeGreaterThan(0);
  });

  it('returns null centroid for an empty set', () => {
    expect(centroid([])).toBeNull();
  });
});

describe('containsPoint', () => {
  it('bounds Washington correctly', () => {
    expect(containsPoint(WASHINGTON_BBOX, { lat: 47.6, lon: -122.3 })).toBe(true);
    expect(containsPoint(WASHINGTON_BBOX, { lat: 34.05, lon: -118.24 })).toBe(false);
  });
});
