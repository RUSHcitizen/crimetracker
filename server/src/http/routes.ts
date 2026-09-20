import type { FastifyInstance } from 'fastify';
import {
  incidentQuerySchema,
  INCIDENT_TYPE_META,
  modeSchema,
  type IncidentQuery,
} from '@crimetracker/shared';
import { publicConfig, type Config } from '../config.js';
import type { IncidentRepository } from '../db/repository.js';
import type { IngestionPipeline } from '../pipeline/ingest.js';

export interface RouteDeps {
  readonly config: Config;
  readonly repository: IncidentRepository;
  readonly pipeline: IngestionPipeline;
}

/**
 * REST surface. Every query parameter goes through a Zod schema before it reaches the
 * repository, so a malformed or hostile request produces a 400 rather than a query.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, repository, pipeline } = deps;

  app.get('/api/health', async () => ({
    status: 'ok',
    mode: pipeline.mode,
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    incidents: repository.countIncidents(),
    counters: pipeline.counters,
  }));

  app.get('/api/config', async () => publicConfig(config));

  app.get('/api/taxonomy', async () => ({
    types: Object.values(INCIDENT_TYPE_META),
  }));

  app.get('/api/incidents', async (request, reply) => {
    const parsed = incidentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid-query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    const query: IncidentQuery = {
      ...(q.types ? { types: q.types } : {}),
      ...(q.sources ? { sources: q.sources } : {}),
      ...(q.minSeverity != null ? { minSeverity: q.minSeverity } : {}),
      ...(q.sinceMinutes != null ? { sinceMinutes: q.sinceMinutes } : {}),
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.bbox ? { bbox: q.bbox } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.lat != null && q.lon != null && q.radiusKm != null
        ? { near: { lat: q.lat, lon: q.lon, radiusKm: q.radiusKm } }
        : {}),
      limit: q.limit ?? 500,
      offset: q.offset ?? 0,
    };
    const incidents = repository.queryIncidents(query);
    return { incidents, count: incidents.length, query };
  });

  app.get('/api/incidents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (typeof id !== 'string' || id.length > 120) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const incident = repository.getIncident(id);
    if (!incident) return reply.status(404).send({ error: 'not-found' });
    return { incident };
  });

  app.get('/api/stats', async () => ({ stats: pipeline.currentStats() }));

  app.get('/api/patterns', async () => ({
    patterns: pipeline.patterns,
    // The API says the same thing the UI does: this describes received data.
    disclaimer:
      'Analytical inference over incidents already received. Not a prediction of future events.',
  }));

  app.get('/api/sources', async () => ({
    sources: pipeline.sourceStatuses(),
    mode: pipeline.mode,
  }));

  app.post('/api/mode', async (request, reply) => {
    const parsed = modeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-mode' });

    const result = await pipeline.setMode(parsed.data.mode);
    if (!result.ok) {
      // 409: the request was well-formed, the server just cannot honour it in its
      // current configuration. The client shows the reason rather than a wrong label.
      return reply.status(409).send({ error: 'mode-unavailable', reason: result.reason, mode: pipeline.mode });
    }
    return { mode: pipeline.mode };
  });

  app.get('/api/search', async (request, reply) => {
    const parsed = incidentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid-query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    const incidents = repository.queryIncidents({
      ...(q.q ? { q: q.q } : {}),
      ...(q.types ? { types: q.types } : {}),
      ...(q.sinceMinutes != null ? { sinceMinutes: q.sinceMinutes } : {}),
      ...(q.lat != null && q.lon != null && q.radiusKm != null
        ? { near: { lat: q.lat, lon: q.lon, radiusKm: q.radiusKm } }
        : {}),
      limit: Math.min(q.limit ?? 60, 200),
    });
    return { incidents, count: incidents.length };
  });
}
