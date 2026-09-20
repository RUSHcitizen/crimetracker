import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Incident, ServerFrame, SnapshotFrame, Stats } from '@crimetracker/shared';
import { RealtimeHub, type HubClient } from '../src/pipeline/hub.js';
import { openDatabase } from '../src/db/database.js';
import { IncidentRepository } from '../src/db/repository.js';
import { IngestionPipeline } from '../src/pipeline/ingest.js';
import { loadConfig } from '../src/config.js';
import { SimulationGenerator } from '../src/sim/generator.js';
import { SIMULATION_DESCRIPTOR } from '../src/sources/simulation.js';
import type { DataSource } from '../src/sources/types.js';

function recordingClient(id = 'c1') {
  const frames: ServerFrame[] = [];
  let closed = false;
  const client: HubClient = {
    id,
    send: (payload) => frames.push(JSON.parse(payload) as ServerFrame),
    close: () => {
      closed = true;
    },
  };
  return { client, frames, isClosed: () => closed };
}

const incident = (id: string): Incident => ({
  id,
  timestamp: new Date().toISOString(),
  ingestedAt: new Date().toISOString(),
  source: { id: 'sim', name: 'Sim', kind: 'simulation', url: null },
  incidentType: 'theft',
  severity: 2,
  description: `incident ${id}`,
  location: { label: 'Pike St', approximate: true, precision: 'block', area: 'Seattle' },
  coordinates: { lat: 47.6, lon: -122.33 },
  confidence: 0.7,
  transcript: null,
  status: 'normalized',
  provenance: {},
  tags: [],
});

describe('RealtimeHub', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst into a single frame', async () => {
    vi.useFakeTimers();
    const hub = new RealtimeHub(50);
    const { client, frames } = recordingClient();
    hub.add(client);

    for (let i = 0; i < 40; i += 1) hub.publishIncidents([incident(`i-${i}`)]);
    expect(frames).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('incidents');
    expect((frames[0] as { incidents: Incident[] }).incidents).toHaveLength(40);
  });

  it('collapses repeated stats to only the newest value', async () => {
    vi.useFakeTimers();
    const hub = new RealtimeHub(50);
    const { client, frames } = recordingClient();
    hub.add(client);

    const stats = (total: number) => ({ total } as unknown as Stats);
    hub.publishStats(stats(1));
    hub.publishStats(stats(2));
    hub.publishStats(stats(3));

    await vi.advanceTimersByTimeAsync(60);
    const statsFrames = frames.filter((f) => f.type === 'stats');
    expect(statsFrames).toHaveLength(1);
    expect((statsFrames[0] as { stats: { total: number } }).stats.total).toBe(3);
  });

  it('sends a snapshot to exactly one client', () => {
    const hub = new RealtimeHub(50);
    const a = recordingClient('a');
    const b = recordingClient('b');
    hub.add(a.client);
    hub.add(b.client);

    hub.sendTo('a', { type: 'pulse', serverTime: new Date().toISOString() });
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(0);
  });

  it('drops a client whose socket throws', async () => {
    vi.useFakeTimers();
    const hub = new RealtimeHub(10);
    hub.add({
      id: 'broken',
      send: () => {
        throw new Error('socket closed');
      },
      close: () => {},
    });
    expect(hub.clientCount).toBe(1);
    hub.publishIncidents([incident('x')]);
    await vi.advanceTimersByTimeAsync(20);
    expect(hub.clientCount).toBe(0);
  });

  it('discards the backlog when nobody is connected', async () => {
    vi.useFakeTimers();
    const hub = new RealtimeHub(10);
    hub.publishIncidents([incident('x')]);
    await vi.advanceTimersByTimeAsync(20);

    const { client, frames } = recordingClient();
    hub.add(client);
    await vi.advanceTimersByTimeAsync(50);
    expect(frames).toHaveLength(0);
  });

  it('closes every client on shutdown', () => {
    const hub = new RealtimeHub(10);
    const a = recordingClient('a');
    hub.add(a.client);
    hub.closeAll();
    expect(a.isClosed()).toBe(true);
    expect(hub.clientCount).toBe(0);
  });
});

describe('IngestionPipeline → hub', () => {
  class InertSource implements DataSource {
    readonly descriptor = SIMULATION_DESCRIPTOR;
    status() {
      return {
        ...SIMULATION_DESCRIPTOR,
        state: 'online' as const,
        enabled: true,
        lastEventAt: null,
        eventsIngested: 0,
        eventsRejected: 0,
        message: null,
        url: null,
      };
    }
    async start() {}
    async stop() {}
  }

  it('broadcasts accepted incidents, then patterns and stats', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const repository = new IncidentRepository(db);
    repository.upsertSource(SIMULATION_DESCRIPTOR);

    const hub = new RealtimeHub(20);
    const { client, frames } = recordingClient();
    hub.add(client);

    const pipeline = new IngestionPipeline({
      config: { ...loadConfig(), databasePath: ':memory:' },
      repository,
      hub,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const generator = new SimulationGenerator({ seed: 'hub-test' });
    const burst = generator.generateBurst(new Date(), 8);
    pipeline.ingest(new InertSource(), burst);

    await vi.advanceTimersByTimeAsync(40);
    const incidentFrames = frames.filter((f) => f.type === 'incidents');
    expect(incidentFrames).toHaveLength(1);

    // The debounced analysis pass follows.
    await vi.advanceTimersByTimeAsync(700);
    expect(frames.some((f) => f.type === 'patterns')).toBe(true);
    expect(frames.some((f) => f.type === 'stats')).toBe(true);

    vi.useRealTimers();
    await pipeline.shutdown();
    db.close();
  });

  it('advances a new incident through its processing states', async () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const repository = new IncidentRepository(db);
    repository.upsertSource(SIMULATION_DESCRIPTOR);

    const hub = new RealtimeHub(20);
    const { client, frames } = recordingClient();
    hub.add(client);

    const pipeline = new IngestionPipeline({
      config: { ...loadConfig(), databasePath: ':memory:' },
      repository,
      hub,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    pipeline.ingest(new InertSource(), [
      {
        externalId: 'stage-test',
        timestamp: new Date().toISOString(),
        description: 'Robbery reported on Pike St',
        transcript: 'All units, robbery just occurred 1400 block of Pike St.',
        coordinates: { lat: 47.6, lon: -122.33 },
        status: 'verified',
      },
    ]);

    await vi.advanceTimersByTimeAsync(6000);
    const updates = frames.filter((f) => f.type === 'incident:update');
    expect(updates.length).toBeGreaterThan(0);

    const statuses = updates.flatMap((f) => (f as { incidents: Incident[] }).incidents.map((i) => i.status));
    expect(statuses).toContain('transcribing');
    expect(statuses).toContain('extracting');
    expect(statuses[statuses.length - 1]).toBe('verified');

    vi.useRealTimers();
    await pipeline.shutdown();
    db.close();
  });
});

describe('websocket endpoint', () => {
  it('sends a snapshot on connect and streams subsequent incidents', async () => {
    const [{ default: Fastify }, { default: websocket }, { registerWebsocket }, WS] = await Promise.all([
      import('fastify'),
      import('@fastify/websocket'),
      import('../src/http/ws.js'),
      import('ws'),
    ]);

    const db = openDatabase(':memory:');
    const repository = new IncidentRepository(db);
    repository.upsertSource(SIMULATION_DESCRIPTOR);

    const hub = new RealtimeHub(20);
    const pipeline = new IngestionPipeline({
      config: { ...loadConfig(), databasePath: ':memory:' },
      repository,
      hub,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    class Inert implements DataSource {
      readonly descriptor = SIMULATION_DESCRIPTOR;
      status() {
        return {
          ...SIMULATION_DESCRIPTOR,
          state: 'online' as const,
          enabled: true,
          lastEventAt: null,
          eventsIngested: 0,
          eventsRejected: 0,
          message: null,
          url: null,
        };
      }
      async start() {}
      async stop() {}
    }

    const generator = new SimulationGenerator({ seed: 'ws-test' });
    pipeline.ingest(
      new Inert(),
      Array.from({ length: 20 }, (_, i) => generator.generate(new Date(Date.now() - i * 60_000))),
    );

    const app = Fastify({ logger: false });
    await app.register(websocket);
    await registerWebsocket(app, { repository, pipeline, hub });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const socket = new WS.WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as ServerFrame));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 4000 });
    const snapshot = frames[0] as SnapshotFrame;
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.incidents.length).toBe(20);
    expect(snapshot.mode).toBe('simulation');
    expect(snapshot.stats).toBeDefined();

    pipeline.ingest(new Inert(), [generator.generate(new Date())]);
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'incidents')).toBe(true), {
      timeout: 4000,
    });

    socket.close();
    await pipeline.shutdown();
    await app.close();
    db.close();
  });
});
