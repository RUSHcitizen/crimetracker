import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import {
  IncidentRepository, SimulationGenerator, type RawIncident, type SourceDescriptor, type SourceStatus } from '@crimetracker/shared';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { registerRoutes } from '../src/http/routes.js';
import { RealtimeHub } from '../src/pipeline/hub.js';
import { IngestionPipeline } from '../src/pipeline/ingest.js';
import type { DataSource } from '../src/sources/types.js';

const DESCRIPTOR: SourceDescriptor = {
  id: 'test-source',
  name: 'Test Source',
  kind: 'simulation',
  note: 'unit test',
};

/** A source that never starts itself — the test feeds the pipeline directly. */
class InertSource implements DataSource {
  readonly descriptor = DESCRIPTOR;
  status(): SourceStatus {
    return {
      id: DESCRIPTOR.id,
      name: DESCRIPTOR.name,
      kind: DESCRIPTOR.kind,
      note: DESCRIPTOR.note,
      state: 'online',
      enabled: true,
      lastEventAt: null,
      eventsIngested: 0,
      eventsRejected: 0,
      message: null,
      url: null,
    };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

let app: FastifyInstance;
let pipeline: IngestionPipeline;
let repository: IncidentRepository;
const source = new InertSource();

beforeAll(async () => {
  const config = { ...loadConfig(), databasePath: ':memory:', mode: 'simulation' as const };
  const db = openDatabase(':memory:');
  repository = new IncidentRepository(db.driver);
  repository.upsertSource(DESCRIPTOR);

  const hub = new RealtimeHub(5);
  pipeline = new IngestionPipeline({
    config,
    repository,
    hub,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  app = Fastify({ logger: false });
  await app.register(cors, { origin: false });
  await registerRoutes(app, { config, repository, pipeline });
  await app.ready();

  // Seed a deterministic, known-good history.
  const generator = new SimulationGenerator({ seed: 'api-test' });
  const now = Date.now();
  const records: RawIncident[] = [];
  for (let i = 0; i < 300; i += 1) {
    records.push(generator.generate(new Date(now - i * 60_000)));
  }
  // An explicit, tight concentration so the pattern assertions do not depend on which
  // place the generator happened to pick.
  for (let i = 0; i < 9; i += 1) {
    records.push({
      externalId: `burst-${i}`,
      timestamp: new Date(now - (20 - i * 2) * 60_000).toISOString(),
      incidentType: 'burglary',
      severity: 3,
      description: `Forced entry reported near Pike St, report ${i}`,
      locationLabel: `${100 + i} block of Pike St, Seattle`,
      area: 'Seattle',
      coordinates: { lat: 47.606 + i * 0.0006, lon: -122.332 + i * 0.0006 },
      confidence: 0.8,
    });
  }
  pipeline.ingest(source, records);
  pipeline.runAnalysis();
});

afterAll(async () => {
  await app?.close();
});

const get = async (url: string) => {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
};

describe('GET /api/health', () => {
  it('reports mode and counters', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('simulation');
    expect(body.incidents).toBeGreaterThan(0);
  });
});

describe('GET /api/config', () => {
  it('exposes no secrets', async () => {
    const { body } = await get('/api/config');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/apiKey|api_key|AI_API_KEY|password|secret/i);
    expect(body).toHaveProperty('mode');
    expect(body).toHaveProperty('feedConfigured');
    // Booleans only — never a URL the browser could be pointed at.
    expect(typeof body.feedConfigured).toBe('boolean');
    expect(body).not.toHaveProperty('baseUrl');
  });
});

describe('GET /api/incidents', () => {
  it('returns incidents newest-first', async () => {
    const { status, body } = await get('/api/incidents?limit=50');
    expect(status).toBe(200);
    const incidents = body.incidents as { timestamp: string }[];
    expect(incidents.length).toBe(50);
    for (let i = 1; i < incidents.length; i += 1) {
      expect(incidents[i - 1]!.timestamp >= incidents[i]!.timestamp).toBe(true);
    }
  });

  it('filters by type', async () => {
    const { body } = await get('/api/incidents?types=theft&limit=200');
    const incidents = body.incidents as { incidentType: string }[];
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents.every((i) => i.incidentType === 'theft')).toBe(true);
  });

  it('ignores unknown type names rather than erroring', async () => {
    const { status, body } = await get('/api/incidents?types=theft,not-a-type&limit=20');
    expect(status).toBe(200);
    expect((body.incidents as unknown[]).length).toBeGreaterThan(0);
  });

  it('filters by minimum severity', async () => {
    const { body } = await get('/api/incidents?minSeverity=4&limit=200');
    const incidents = body.incidents as { severity: number }[];
    expect(incidents.every((i) => i.severity >= 4)).toBe(true);
  });

  it('filters by time window', async () => {
    const { body } = await get('/api/incidents?sinceMinutes=30&limit=500');
    const incidents = body.incidents as { timestamp: string }[];
    const cutoff = Date.now() - 31 * 60_000;
    expect(incidents.every((i) => Date.parse(i.timestamp) >= cutoff)).toBe(true);
  });

  it('filters by bounding box', async () => {
    const { body } = await get('/api/incidents?bbox=-122.5,47.4,-122.1,47.8&limit=500');
    const incidents = body.incidents as { coordinates: { lat: number; lon: number } | null }[];
    expect(incidents.length).toBeGreaterThan(0);
    for (const incident of incidents) {
      expect(incident.coordinates).not.toBeNull();
      expect(incident.coordinates!.lat).toBeGreaterThanOrEqual(47.4);
      expect(incident.coordinates!.lat).toBeLessThanOrEqual(47.8);
    }
  });

  it('filters by radius around a point', async () => {
    const { body } = await get('/api/incidents?lat=47.6062&lon=-122.3321&radiusKm=12&limit=500');
    const incidents = body.incidents as { coordinates: { lat: number; lon: number } }[];
    expect(incidents.length).toBeGreaterThan(0);
    for (const incident of incidents) {
      const dLat = (incident.coordinates.lat - 47.6062) * 111;
      const dLon = (incident.coordinates.lon + 122.3321) * 75;
      expect(Math.sqrt(dLat * dLat + dLon * dLon)).toBeLessThan(16);
    }
  });

  it('searches keywords', async () => {
    const { body } = await get('/api/incidents?q=seattle&limit=100');
    const incidents = body.incidents as { location: { label: string; area: string | null } }[];
    expect(incidents.length).toBeGreaterThan(0);
    expect(
      incidents.every(
        (i) =>
          i.location.label.toLowerCase().includes('seattle') ||
          (i.location.area ?? '').toLowerCase().includes('seattle'),
      ),
    ).toBe(true);
  });

  it('treats search input as data, not SQL', async () => {
    const before = repository.countIncidents();
    const { status } = await get(`/api/incidents?q=${encodeURIComponent("'; DROP TABLE incidents; --")}`);
    expect(status).toBe(200);
    expect(repository.countIncidents()).toBe(before);
  });

  it('treats LIKE wildcards in a query as literal characters', async () => {
    const { body } = await get('/api/incidents?q=%25%25%25&limit=20');
    expect((body.incidents as unknown[]).length).toBe(0);
  });

  it('rejects an out-of-range limit', async () => {
    const { status } = await get('/api/incidents?limit=999999');
    expect(status).toBe(400);
  });

  it('rejects a malformed severity', async () => {
    expect((await get('/api/incidents?minSeverity=abc')).status).toBe(400);
    expect((await get('/api/incidents?minSeverity=99')).status).toBe(400);
  });

  it('paginates', async () => {
    const first = await get('/api/incidents?limit=10&offset=0');
    const second = await get('/api/incidents?limit=10&offset=10');
    const idsA = (first.body.incidents as { id: string }[]).map((i) => i.id);
    const idsB = (second.body.incidents as { id: string }[]).map((i) => i.id);
    expect(idsA).not.toEqual(idsB);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });
});

describe('GET /api/incidents/:id', () => {
  it('returns a single incident with its provenance', async () => {
    const list = await get('/api/incidents?limit=1');
    const id = (list.body.incidents as { id: string }[])[0]!.id;
    const { status, body } = await get(`/api/incidents/${encodeURIComponent(id)}`);
    expect(status).toBe(200);
    const incident = body.incident as { id: string; provenance: Record<string, unknown> };
    expect(incident.id).toBe(id);
    expect(Object.keys(incident.provenance).length).toBeGreaterThan(0);
  });

  it('404s for an unknown id', async () => {
    expect((await get('/api/incidents/does-not-exist')).status).toBe(404);
  });
});

describe('GET /api/stats', () => {
  it('reports coherent aggregates', async () => {
    const { body } = await get('/api/stats');
    const stats = body.stats as {
      total: number;
      today: number;
      lastHour: number;
      byType: unknown[];
      timeline: unknown[];
      withoutCoordinates: number;
    };
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.lastHour).toBeLessThanOrEqual(stats.total);
    expect(stats.today).toBeLessThanOrEqual(stats.total);
    expect(stats.byType.length).toBeGreaterThan(0);
    expect(stats.timeline.length).toBe(48);
    expect(stats.withoutCoordinates).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/patterns', () => {
  it('returns clusters and always states that they are inference', async () => {
    const { body } = await get('/api/patterns');
    expect(Array.isArray(body.patterns)).toBe(true);
    expect(String(body.disclaimer)).toMatch(/not a prediction/i);
    for (const pattern of body.patterns as { confidence: number; count: number }[]) {
      expect(pattern.confidence).toBeGreaterThanOrEqual(0);
      expect(pattern.confidence).toBeLessThanOrEqual(1);
      expect(pattern.count).toBeGreaterThanOrEqual(3);
    }
  });

  it('found the seeded burst', async () => {
    const { body } = await get('/api/patterns');
    expect((body.patterns as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('GET /api/sources and POST /api/mode', () => {
  it('lists registered sources', async () => {
    const { body } = await get('/api/sources');
    expect(body.mode).toBe('simulation');
  });

  it('refuses live mode when no live source is registered', async () => {
    // This harness registers a simulation-kind source only, so switching to live would
    // put a LIVE label over simulated data. The server must refuse instead.
    const refused = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'live' } });
    expect(refused.statusCode).toBe(409);
    expect(pipeline.mode).toBe('simulation');
  });

  it('rejects an invalid mode', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'chaos' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('ingestion', () => {
  it('rejects malformed records and counts them', async () => {
    const before = pipeline.counters;
    const accepted = pipeline.ingest(source, [
      { timestamp: 'nonsense', description: 'bad time' },
      { timestamp: new Date().toISOString() },
      { timestamp: new Date().toISOString(), description: 'A valid theft report on Pike St' },
    ]);
    expect(accepted).toHaveLength(1);
    expect(pipeline.counters.rejected).toBe(before.rejected + 2);
  });

  it('drops an out-of-region coordinate but keeps the record', () => {
    const [incident] = pipeline.ingest(source, [
      {
        timestamp: new Date().toISOString(),
        description: 'Theft reported far away',
        coordinates: { lat: 40.7829, lon: -73.9654 },
      },
    ]);
    expect(incident).toBeDefined();
    expect(incident!.coordinates).toBeNull();
  });

  it('is idempotent for a repeated external id', () => {
    const record: RawIncident = {
      externalId: 'DUP-1',
      timestamp: new Date().toISOString(),
      description: 'Duplicate theft report',
    };
    pipeline.ingest(source, [record]);
    const before = repository.countIncidents();
    pipeline.ingest(source, [record]);
    expect(repository.countIncidents()).toBe(before);
  });
});

describe('config loading', () => {
  it('reads the environment it is given, not the ambient process env', async () => {
    const { loadConfig: load } = await import('../src/config.js');
    const custom = load({
      PORT: '9911',
      MODE: 'live',
      PATTERN_EPS_KM: '3.5',
      CORS_ORIGINS: 'https://a.example,https://b.example',
      FEED_URL: 'https://data.example.gov/feed.json',
    } as NodeJS.ProcessEnv);

    expect(custom.port).toBe(9911);
    expect(custom.mode).toBe('live');
    expect(custom.patterns.epsKm).toBe(3.5);
    expect(custom.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(custom.feed.enabled).toBe(true);
  });

  it('falls back to defaults for an empty environment', async () => {
    const { loadConfig: load } = await import('../src/config.js');
    const empty = load({} as NodeJS.ProcessEnv);
    expect(empty.port).toBe(8787);
    expect(empty.mode).toBe('simulation');
    expect(empty.feed.enabled).toBe(false);
    expect(empty.audio.enabled).toBe(false);
    expect(empty.ai.provider).toBe('heuristic');
  });
});
