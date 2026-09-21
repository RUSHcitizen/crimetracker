import { IncidentRepository } from '@crimetracker/shared';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { openDatabase } from '../src/db/database.js';
import { registerWebsocket } from '../src/http/ws.js';
import { RealtimeHub } from '../src/pipeline/hub.js';
import { IngestionPipeline } from '../src/pipeline/ingest.js';
import { loadConfig } from '../src/config.js';
import { TEST_SOURCE } from './helpers/records.js';

const ALLOWED = 'http://localhost:5173';

/**
 * CORS does not apply to WebSocket upgrades, so the origin allow-list has to be enforced
 * on the handshake. Without it any page the user visits could open a socket to the local
 * server and read the whole incident stream.
 */
async function server() {
  const db = openDatabase(':memory:');
  const repository = new IncidentRepository(db.driver);
  repository.upsertSource(TEST_SOURCE);
  const hub = new RealtimeHub(10);
  const pipeline = new IngestionPipeline({
    config: { ...loadConfig(), databasePath: ':memory:' },
    repository,
    hub,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const app = Fastify({ logger: false });
  const allowedOrigins = new Set([ALLOWED]);
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      verifyClient: (
        info: { origin?: string },
        next: (ok: boolean, code?: number, message?: string) => void,
      ) => {
        const origin = info.origin;
        if (!origin || allowedOrigins.has(origin)) return next(true);
        next(false, 403, 'Origin not allowed');
      },
    },
  });
  await registerWebsocket(app, { repository, pipeline, hub });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  return { app, db, pipeline, url: `ws://127.0.0.1:${port}/ws` };
}

function connect(url: string, origin?: string): Promise<'open' | string> {
  return new Promise((resolve) => {
    const socket = origin ? new WebSocket(url, { origin }) : new WebSocket(url);
    socket.once('open', () => {
      socket.close();
      resolve('open');
    });
    socket.once('error', (error: Error) => resolve(error.message));
  });
}

describe('websocket origin enforcement', () => {
  it('accepts the configured origin', async () => {
    const s = await server();
    expect(await connect(s.url, ALLOWED)).toBe('open');
    await s.pipeline.shutdown();
    await s.app.close();
    s.db.close();
  });

  it('accepts a request with no Origin header (curl, tests, native clients)', async () => {
    const s = await server();
    expect(await connect(s.url)).toBe('open');
    await s.pipeline.shutdown();
    await s.app.close();
    s.db.close();
  });

  it('rejects a cross-origin page', async () => {
    const s = await server();
    const result = await connect(s.url, 'https://evil.example');
    expect(result).not.toBe('open');
    expect(result).toMatch(/403/);
    await s.pipeline.shutdown();
    await s.app.close();
    s.db.close();
  });
});
