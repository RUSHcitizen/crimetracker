import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, publicWorkerConfig, type Env } from '../src/config.js';

/**
 * Workers have no `process.env`, so configuration arrives on the `Env` binding. These
 * cover the same ground as the Node config tests: defaults, coercion, and above all that
 * nothing secret can reach the browser.
 */
const env = (over: Partial<Env> = {}): Env => ({ ...(over as Env) });

describe('loadWorkerConfig', () => {
  it('defaults to simulation with no vars set', () => {
    const config = loadWorkerConfig(env());
    expect(config.mode).toBe('simulation');
    expect(config.simulation.intervalSeconds).toBe(20);
    expect(config.simulation.backfill).toBe(2400);
    expect(config.feed.enabled).toBe(false);
    expect(config.ai.provider).toBe('heuristic');
    expect(config.patterns).toEqual({ windowMinutes: 45, epsKm: 0.9, minPoints: 5 });
  });

  it('reads vars and coerces numbers', () => {
    const config = loadWorkerConfig(
      env({
        MODE: 'live',
        SIM_INTERVAL_SECONDS: '5',
        PATTERN_EPS_KM: '2.5',
        PATTERN_MIN_POINTS: '8',
        FEED_URL: 'https://data.example.gov/feed.json',
        FEED_POLL_SECONDS: '30',
      }),
    );
    expect(config.mode).toBe('live');
    expect(config.simulation.intervalSeconds).toBe(5);
    expect(config.patterns.epsKm).toBe(2.5);
    expect(config.patterns.minPoints).toBe(8);
    expect(config.feed.enabled).toBe(true);
    expect(config.feed.pollSeconds).toBe(30);
  });

  it('clamps values that would break the pipeline', () => {
    const config = loadWorkerConfig(
      env({ SIM_INTERVAL_SECONDS: '0', FEED_POLL_SECONDS: '1', PATTERN_MIN_POINTS: '1' }),
    );
    expect(config.simulation.intervalSeconds).toBeGreaterThanOrEqual(1);
    // Never poll an upstream faster than every 15s.
    expect(config.feed.pollSeconds).toBeGreaterThanOrEqual(15);
    expect(config.patterns.minPoints).toBeGreaterThanOrEqual(3);
  });

  it('ignores an unrecognised mode rather than trusting it', () => {
    expect(loadWorkerConfig(env({ MODE: 'chaos' })).mode).toBe('simulation');
  });

  it('ignores an unrecognised AI provider', () => {
    expect(loadWorkerConfig(env({ AI_PROVIDER: 'magic' })).ai.provider).toBe('heuristic');
  });
});

describe('publicWorkerConfig', () => {
  it('exposes booleans, never endpoints or secrets', () => {
    const config = loadWorkerConfig(
      env({
        FEED_URL: 'https://data.example.gov/feed.json',
        AI_PROVIDER: 'openai-compatible',
        AI_BASE_URL: 'https://api.openai.com/v1',
        AI_MODEL: 'gpt-4o-mini',
        AI_API_KEY: 'sk-super-secret',
      }),
    );
    const serialized = JSON.stringify(publicWorkerConfig(config));

    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('api.openai.com');
    expect(serialized).not.toContain('data.example.gov');
    expect(JSON.parse(serialized).feedConfigured).toBe(true);
  });
});
