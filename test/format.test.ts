import { describe, expect, it } from 'vitest';
import { AU_KM } from '../src/lib/astro/constants';
import { distanceAside, formatDistance, formatDistanceInline, formatDuration, formatSpeed } from '../src/lib/format';
import { formatLightTime, formatOffset, formatRate } from '../src/lib/astro/time';

describe('distance formatting', () => {
  it('picks a unit that stays readable across the whole range', () => {
    expect(formatDistanceInline(0.4)).toBe('400 m');
    expect(formatDistanceInline(408)).toBe('408.0 km');
    // The case that used to render as "1,644" + "000 km".
    expect(formatDistanceInline(1_644_000)).toBe('1,644,000 km');
    expect(formatDistanceInline(384_400)).toBe('384,400 km');
    expect(formatDistance(1.0 * AU_KM)).toEqual({ value: '1.0000', unit: 'AU' });
    expect(formatDistance(172 * AU_KM).unit).toBe('AU');
  });

  it('never emits a unit that contains digits', () => {
    for (const km of [0.5, 5, 500, 50_000, 1e6, 1e7, 1e8, 1e10, 1e14]) {
      expect(formatDistance(km).unit).not.toMatch(/\d/);
    }
  });

  it('handles non-finite input without producing nonsense', () => {
    expect(formatDistance(Number.NaN).value).toBe('—');
    expect(formatDistance(Number.POSITIVE_INFINITY).value).toBe('—');
    expect(formatLightTime(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('gives a useful second reading for large distances', () => {
    expect(distanceAside(500)).toBeNull();
    expect(distanceAside(1_644_000)).toContain('light-seconds');
    expect(distanceAside(1.5 * AU_KM)).toContain('light-minutes');
  });
});

describe('time formatting', () => {
  it('formats offsets from live', () => {
    expect(formatOffset(0)).toBe('LIVE');
    expect(formatOffset(1 / 24)).toBe('+1h 00m');
    expect(formatOffset(-2.5)).toBe('−2d 12h');
    expect(formatOffset(400)).toMatch(/^\+1y/);
  });

  it('formats rates', () => {
    expect(formatRate(0)).toBe('HOLD');
    expect(formatRate(1)).toBe('1×');
    expect(formatRate(86_400)).toBe('86.4k×');
  });

  it('formats light time at every scale', () => {
    expect(formatLightTime(0.2)).toBe('200 ms');
    expect(formatLightTime(1.28)).toBe('1.3 s');
    expect(formatLightTime(760)).toBe('12.7 min');
    expect(formatLightTime(86_000)).toMatch(/h$/);
  });

  it('formats speeds', () => {
    expect(formatSpeed(0.001)).toBe('1.0 m/s');
    expect(formatSpeed(29.78)).toBe('29.780 km/s');
    expect(formatSpeed(192)).toBe('192.0 km/s');
  });
});
