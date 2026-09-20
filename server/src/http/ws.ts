import type { FastifyInstance } from 'fastify';
import { randomUUID, type SnapshotFrame } from '@crimetracker/shared';
import type { IncidentRepository } from '../db/repository.js';
import type { IngestionPipeline } from '../pipeline/ingest.js';
import type { RealtimeHub } from '../pipeline/hub.js';

export interface WsDeps {
  readonly repository: IncidentRepository;
  readonly pipeline: IngestionPipeline;
  readonly hub: RealtimeHub;
  /** How many recent incidents a new client receives up front. */
  readonly snapshotSize?: number;
}

/**
 * `/ws` — one socket per client.
 *
 * On connect the client gets a full snapshot (recent incidents, patterns, stats, source
 * status, mode); after that it receives only deltas.
 */
export async function registerWebsocket(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { repository, pipeline, hub } = deps;
  const snapshotSize = deps.snapshotSize ?? 2500;

  app.get('/ws', { websocket: true }, (socket) => {
    const clientId = randomUUID();

    hub.add({
      id: clientId,
      send: (payload) => socket.send(payload),
      close: () => socket.close(),
    });

    const snapshot: SnapshotFrame = {
      type: 'snapshot',
      mode: pipeline.mode,
      serverTime: new Date().toISOString(),
      incidents: repository.queryIncidents({ limit: snapshotSize }),
      patterns: pipeline.patterns,
      stats: pipeline.currentStats(),
      sources: pipeline.sourceStatuses(),
    };
    hub.sendTo(clientId, snapshot);

    socket.on('close', () => hub.remove(clientId));
    socket.on('error', () => hub.remove(clientId));
    // Clients have nothing to say: all mutations go through the REST API, so inbound
    // frames are ignored rather than parsed.
    socket.on('message', () => {});
  });
}
