import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { IncidentRepository } from '@crimetracker/shared';
import { loadConfig, publicConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { registerRoutes } from '../src/http/routes.js';
import { RealtimeHub } from '../src/pipeline/hub.js';
import { IngestionPipeline } from '../src/pipeline/ingest.js';
import { buildSources } from '../src/sources/registry.js';
import { HeuristicExtractor } from '../src/extraction/heuristic.js';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  DATABASE_PATH: ':memory:',
  SIM_BACKFILL: '0',
  ...over,
});

describe('source access keys', () => {
  it('reads only the variables the configured sources declare', () => {
    const config = loadConfig(
      env({
        SOURCES: 'wsdot-highway-alerts',
        WSDOT_ACCESS_CODE: 'CODE-1',
        SOME_OTHER_SECRET: 'must-not-be-collected',
      }),
    );
    expect(config.sourceKeys).toEqual({ WSDOT_ACCESS_CODE: 'CODE-1' });
  });

  it('collects nothing when no configured source needs a key', () => {
    const config = loadConfig(env({ SOURCES: 'seattle-fire-911', WSDOT_ACCESS_CODE: 'CODE-1' }));
    expect(config.sourceKeys).toEqual({});
  });

  it('never puts a key or an endpoint in the config the browser receives', () => {
    const config = loadConfig(
      env({
        SOURCES: 'wsdot-highway-alerts',
        WSDOT_ACCESS_CODE: 'CODE-1',
        AI_API_KEY: 'sk-test',
      }),
    );
    const serialized = JSON.stringify(publicConfig(config));
    expect(serialized).not.toContain('CODE-1');
    expect(serialized).not.toContain('sk-test');
    expect(serialized).not.toContain('wsdot.wa.gov');
    expect(publicConfig(config).camerasConfigured).toBe(true);
  });

  it('skips a keyed source when its key is missing, and says which one', () => {
    const config = loadConfig(env({ SOURCES: 'wsdot-highway-alerts' }));
    const { sources, warnings } = buildSources(config, new HeuristicExtractor());
    // Starting a source that can only ever 401 would show it "online" in the HUD.
    expect(sources.map((s) => s.descriptor.id)).not.toContain('wsdot-highway-alerts');
    expect(warnings.join('\n')).toContain('WSDOT_ACCESS_CODE');
  });

  it('builds the keyed source once the key is present', () => {
    const config = loadConfig(
      env({ SOURCES: 'wsdot-highway-alerts', WSDOT_ACCESS_CODE: 'CODE-1' }),
    );
    const { sources } = buildSources(config, new HeuristicExtractor());
    const built = sources.find((s) => s.descriptor.id === 'wsdot-highway-alerts');
    expect(built).toBeDefined();
    // The descriptor is broadcast to clients.
    expect(built?.descriptor.url).not.toContain('CODE-1');
  });

  it('accepts an ad-hoc source spec as well as a catalogue id', () => {
    const config = loadConfig(env({ SOURCES: 'socrata:data.kingcounty.gov/abcd-1234' }));
    const { sources, warnings } = buildSources(config, new HeuristicExtractor());
    expect(sources.map((s) => s.descriptor.id)).toContain('socrata:data.kingcounty.gov/abcd-1234');
    expect(warnings.join('\n')).not.toContain('Unknown source');
  });

  it('warns about a spec that is not a public https endpoint', () => {
    const config = loadConfig(env({ SOURCES: 'geojson:http://internal.local/x.json' }));
    const { warnings } = buildSources(config, new HeuristicExtractor());
    expect(warnings.join('\n')).toContain('Unknown source');
  });

  it('turns the camera overlay on from the same WSDOT registration', () => {
    expect(loadConfig(env({ WSDOT_ACCESS_CODE: 'CODE-1' })).cameras.enabled).toBe(true);
    expect(loadConfig(env({ CAMERAS_ACCESS_CODE: 'CODE-2' })).cameras.accessCode).toBe('CODE-2');
    expect(loadConfig(env()).cameras.enabled).toBe(false);
  });
});

describe('GET /api/cameras', () => {
  it('says plainly that the overlay is unconfigured rather than returning an empty list', async () => {
    const config = loadConfig(env());
    const repository = new IncidentRepository(openDatabase(':memory:'));
    const pipeline = new IngestionPipeline({ config, repository, hub: new RealtimeHub() });
    const app = Fastify();
    await registerRoutes(app, { config, repository, pipeline, cameras: null });

    const response = await app.inject({ method: 'GET', url: '/api/cameras' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.configured).toBe(false);
    expect(body.cameras).toEqual([]);
    expect(body.reason).toContain('WSDOT_ACCESS_CODE');
    await app.close();
  });
});

describe('OpenMHz source wiring', () => {
  const openmhzEnv = (over: Record<string, string> = {}) =>
    env({
      SOURCES: 'openmhz:psern025',
      OPENMHZ_ACK: '1',
      STT_PROVIDER: 'whisper-http',
      STT_BASE_URL: 'https://stt.example.org/v1',
      ...over,
    });

  it('builds a radio source from the spec the site’s URL implies', () => {
    const { sources, warnings } = buildSources(loadConfig(openmhzEnv()), new HeuristicExtractor());
    const built = sources.find((s) => s.descriptor.id === 'openmhz:psern025');
    expect(built).toBeDefined();
    expect(built?.descriptor.kind).toBe('audio');
    expect(built?.descriptor.url).toBe('https://openmhz.com/system/psern025');
    expect(warnings.join('\n')).not.toContain('Unknown source');
  });

  it('counts as a live source, so LIVE mode becomes available', () => {
    const { warnings } = buildSources(loadConfig(openmhzEnv()), new HeuristicExtractor());
    expect(warnings.join('\n')).not.toContain('No live source is configured');
  });

  it('refuses to run without an explicit acknowledgement', () => {
    const { sources, warnings } = buildSources(
      loadConfig(openmhzEnv({ OPENMHZ_ACK: '' })),
      new HeuristicExtractor(),
    );
    expect(sources.some((s) => s.descriptor.id.startsWith('openmhz:'))).toBe(false);
    expect(warnings.join('\n')).toContain('OPENMHZ_ACK=1');
  });

  it('still registers the source without speech-to-text, and warns', () => {
    // A missing source in the HUD is indistinguishable from a broken one, so it is
    // registered and left to explain itself.
    const { sources, warnings } = buildSources(
      loadConfig(openmhzEnv({ STT_PROVIDER: '', STT_BASE_URL: '' })),
      new HeuristicExtractor(),
    );
    expect(sources.some((s) => s.descriptor.id === 'openmhz:psern025')).toBe(true);
    expect(warnings.join('\n')).toContain('STT_PROVIDER');
  });

  it('carries a talkgroup filter through to the source id', () => {
    const { sources } = buildSources(
      loadConfig(openmhzEnv({ SOURCES: 'openmhz:psern025/1103+1104' })),
      new HeuristicExtractor(),
    );
    expect(sources.map((s) => s.descriptor.id)).toContain('openmhz:psern025/1103+1104');
  });

  it('rejects a malformed spec as an unknown source rather than guessing', () => {
    const { warnings } = buildSources(
      loadConfig(openmhzEnv({ SOURCES: 'openmhz:psern025/all' })),
      new HeuristicExtractor(),
    );
    expect(warnings.join('\n')).toContain('Unknown source');
  });

  it('runs alongside catalogued structured feeds', () => {
    const { sources } = buildSources(
      loadConfig(openmhzEnv({ SOURCES: 'seattle-fire-911,openmhz:psern025' })),
      new HeuristicExtractor(),
    );
    const ids = sources.map((s) => s.descriptor.id);
    expect(ids).toContain('seattle-fire-911');
    expect(ids).toContain('openmhz:psern025');
  });
});
