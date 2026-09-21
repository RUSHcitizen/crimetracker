import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, publicWorkerConfig, type Env } from '../src/config.js';
import { parseOpenMhzSpec } from '@crimetracker/shared';

/**
 * Workers have no `process.env`, so configuration arrives on the `Env` binding. These
 * cover the same ground as the Node config tests: defaults, coercion, and above all that
 * nothing secret can reach the browser.
 */
const env = (over: Partial<Env> = {}): Env => ({ ...(over as Env) });

describe('loadWorkerConfig', () => {
  it('defaults sensibly with no vars set', () => {
    const config = loadWorkerConfig(env());
    expect(config.sources).toEqual([]);
    expect(config.feed.enabled).toBe(false);
    expect(config.ai.provider).toBe('heuristic');
    expect(config.patterns).toEqual({ windowMinutes: 45, epsKm: 0.9, minPoints: 5 });
  });

  it('has no mode or simulation settings to read', () => {
    // There is nothing to switch between: the Worker ingests published data or it
    // ingests nothing. A leftover MODE var must not resurrect a concept that is gone.
    const config = loadWorkerConfig(env({ MODE: 'simulation', SIM_BACKFILL: '2400' } as Env));
    expect('mode' in config).toBe(false);
    expect('simulation' in config).toBe(false);
  });

  it('reads vars and coerces numbers', () => {
    const config = loadWorkerConfig(
      env({
        SOURCES: 'seattle-fire-911, nws-alerts-wa',
        PATTERN_EPS_KM: '2.5',
        PATTERN_MIN_POINTS: '8',
        FEED_URL: 'https://data.example.gov/feed.json',
        FEED_POLL_SECONDS: '30',
      }),
    );
    expect(config.sources).toEqual(['seattle-fire-911', 'nws-alerts-wa']);
    expect(config.patterns.epsKm).toBe(2.5);
    expect(config.patterns.minPoints).toBe(8);
    expect(config.feed.enabled).toBe(true);
    expect(config.feed.pollSeconds).toBe(30);
  });

  it('clamps values that would break the pipeline', () => {
    const config = loadWorkerConfig(env({ FEED_POLL_SECONDS: '1', PATTERN_MIN_POINTS: '1' }));
    // Never poll an upstream faster than every 15s.
    expect(config.feed.pollSeconds).toBeGreaterThanOrEqual(15);
    expect(config.patterns.minPoints).toBeGreaterThanOrEqual(3);
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


describe('sources the Worker cannot run', () => {
  it('recognises an OpenMHz spec so the room can report it rather than drop it', () => {
    // The room registers these in an error state naming the Node server. The important
    // property is that the spec is *recognised*: an unrecognised id is skipped silently,
    // which leaves an operator with a deployment that ingests nothing and says nothing.
    expect(parseOpenMhzSpec('openmhz:psern025')).toBeDefined();
    expect(parseOpenMhzSpec('openmhz:psern025/1103+1104')?.talkgroups).toEqual([1103, 1104]);
    expect(parseOpenMhzSpec('seattle-fire-911')).toBeUndefined();
  });

  it('reads the camera access code from either variable', () => {
    expect(loadWorkerConfig({ WSDOT_ACCESS_CODE: 'a' } as Env).cameras.enabled).toBe(true);
    expect(loadWorkerConfig({ CAMERAS_ACCESS_CODE: 'b' } as Env).cameras.accessCode).toBe('b');
    expect(loadWorkerConfig({} as Env).cameras.enabled).toBe(false);
  });

  it('never exposes an access key to the browser', () => {
    const config = loadWorkerConfig({
      SOURCES: 'wsdot-highway-alerts',
      WSDOT_ACCESS_CODE: 'CODE-1',
      AI_API_KEY: 'sk-test',
    } as Env);
    expect(config.sourceKeys).toEqual({ WSDOT_ACCESS_CODE: 'CODE-1' });
    const serialized = JSON.stringify(publicWorkerConfig(config));
    expect(serialized).not.toContain('CODE-1');
    expect(serialized).not.toContain('sk-test');
  });
});

