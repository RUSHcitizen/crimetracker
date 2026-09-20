import { IncidentRepository } from '@crimetracker/shared';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AppMode, SourceDescriptor, SourceStatus } from '@crimetracker/shared';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { registerRoutes } from '../src/http/routes.js';
import { RealtimeHub } from '../src/pipeline/hub.js';
import { IngestionPipeline } from '../src/pipeline/ingest.js';
import { modeOfSource } from '../src/sources/registry.js';
import type { DataSource, SourceContext } from '../src/sources/types.js';

/**
 * A source that records whether it is running and emits on demand, so a test can prove
 * that stopping a mode really stops production rather than merely relabelling it.
 */
class SpySource implements DataSource {
  running = false;
  starts = 0;
  #ctx: SourceContext | null = null;

  constructor(readonly descriptor: SourceDescriptor) {}

  status(): SourceStatus {
    return {
      id: this.descriptor.id,
      name: this.descriptor.name,
      kind: this.descriptor.kind,
      note: this.descriptor.note,
      state: this.running ? 'online' : 'stopped',
      enabled: this.running,
      lastEventAt: null,
      eventsIngested: 0,
      eventsRejected: 0,
      message: null,
      url: null,
    };
  }

  async start(ctx: SourceContext): Promise<void> {
    this.running = true;
    this.starts += 1;
    this.#ctx = ctx;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Emit only while running, exactly as a real adapter would. */
  produce(description: string): void {
    if (!this.running || !this.#ctx) return;
    this.#ctx.emit({ timestamp: new Date().toISOString(), description });
  }
}

const simDescriptor: SourceDescriptor = {
  id: 'simulation',
  name: 'Simulation Engine',
  kind: 'simulation',
  note: 'fictional',
};
const feedDescriptor: SourceDescriptor = {
  id: 'public-feed',
  name: 'Public Feed',
  kind: 'public-feed',
  note: 'real',
};

function harness(withFeed: boolean, mode: AppMode = 'simulation') {
  const db = openDatabase(':memory:');
  const repository = new IncidentRepository(db.driver);
  const hub = new RealtimeHub(5);
  const pipeline = new IngestionPipeline({
    config: { ...loadConfig(), databasePath: ':memory:', mode },
    repository,
    hub,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const sim = new SpySource(simDescriptor);
  const feed = new SpySource(feedDescriptor);
  pipeline.register(sim);
  if (withFeed) pipeline.register(feed);

  return { db, repository, hub, pipeline, sim, feed };
}

describe('modeOfSource', () => {
  it('derives the mode from the adapter kind, never from configuration', () => {
    expect(modeOfSource(new SpySource(simDescriptor))).toBe('simulation');
    expect(modeOfSource(new SpySource(feedDescriptor))).toBe('live');
    expect(
      modeOfSource(new SpySource({ ...feedDescriptor, id: 'audio', kind: 'audio' })),
    ).toBe('live');
  });
});

describe('mode switching', () => {
  it('starts only the sources belonging to the active mode', async () => {
    const { pipeline, sim, feed, db } = harness(true);
    await pipeline.applyMode('simulation');
    expect(sim.running).toBe(true);
    expect(feed.running).toBe(false);

    await pipeline.applyMode('live');
    expect(sim.running).toBe(false);
    expect(feed.running).toBe(true);
    db.close();
  });

  it('stops the simulation producing once live mode is active', async () => {
    const { pipeline, sim, feed, repository, db } = harness(true);
    await pipeline.applyMode('simulation');

    sim.produce('A simulated theft on Pike St');
    expect(repository.countIncidents()).toBe(1);

    const switched = await pipeline.setMode('live');
    expect(switched.ok).toBe(true);
    expect(pipeline.mode).toBe('live');

    // The regression this guards: a LIVE label over simulated data.
    sim.produce('A simulated theft that must never arrive in live mode');
    expect(repository.countIncidents()).toBe(1);

    feed.produce('A real reported burglary on Main St');
    expect(repository.countIncidents()).toBe(2);
    expect(repository.queryIncidents({ limit: 1 })[0]!.source.kind).toBe('public-feed');
    db.close();
  });

  it('refuses live mode when no live source is configured, and keeps the old mode', async () => {
    const { pipeline, sim, db } = harness(false);
    await pipeline.applyMode('simulation');

    const result = await pipeline.setMode('live');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no live source/i);
    // Crucially, the mode did not change and the simulation is still what is running.
    expect(pipeline.mode).toBe('simulation');
    expect(sim.running).toBe(true);
    db.close();
  });

  it('does not restart a source that is already running for the mode', async () => {
    const { pipeline, sim, db } = harness(true);
    await pipeline.applyMode('simulation');
    await pipeline.applyMode('simulation');
    expect(sim.starts).toBe(1);
    db.close();
  });

  it('reports which sources can serve each mode', async () => {
    const withFeed = harness(true);
    expect(withFeed.pipeline.canServe('live')).toBe(true);
    expect(withFeed.pipeline.canServe('simulation')).toBe(true);
    withFeed.db.close();

    const simOnly = harness(false);
    expect(simOnly.pipeline.canServe('live')).toBe(false);
    expect(simOnly.pipeline.canServe('simulation')).toBe(true);
    simOnly.db.close();
  });
});

describe('POST /api/mode', () => {
  async function api(withFeed: boolean) {
    const h = harness(withFeed);
    await h.pipeline.applyMode('simulation');
    const app = Fastify({ logger: false });
    const config = { ...loadConfig(), databasePath: ':memory:' };
    await registerRoutes(app, { config, repository: h.repository, pipeline: h.pipeline });
    await app.ready();
    return { ...h, app };
  }

  it('switches when the target mode is available', async () => {
    const { app, pipeline, db } = await api(true);
    const response = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'live' } });
    expect(response.statusCode).toBe(200);
    expect(pipeline.mode).toBe('live');
    await app.close();
    db.close();
  });

  it('answers 409 with a reason when the target mode cannot be served', async () => {
    const { app, pipeline, db } = await api(false);
    const response = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'live' } });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string; reason: string; mode: string };
    expect(body.error).toBe('mode-unavailable');
    expect(body.reason).toMatch(/FEED_URL/);
    // The reported mode is the one still in force, not the one that was asked for.
    expect(body.mode).toBe('simulation');
    expect(pipeline.mode).toBe('simulation');
    await app.close();
    db.close();
  });

  it('still rejects a malformed mode with 400', async () => {
    const { app, db } = await api(true);
    const response = await app.inject({ method: 'POST', url: '/api/mode', payload: { mode: 'chaos' } });
    expect(response.statusCode).toBe(400);
    await app.close();
    db.close();
  });
});
