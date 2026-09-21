import type { FastifyInstance } from 'fastify';
import {
  IncidentRepository,
  incidentQuerySchema,
  INCIDENT_TYPE_META,
  type IncidentQuery,
} from '@crimetracker/shared';
import { publicConfig, type Config } from '../config.js';
import type { WsdotCameraDirectory } from '../cameras/directory.js';
import type { BriefService } from '../brief/index.js';
import type { IngestionPipeline } from '../pipeline/ingest.js';

export interface RouteDeps {
  readonly config: Config;
  readonly repository: IncidentRepository;
  readonly pipeline: IngestionPipeline;
  /** Absent when no camera access code is configured. */
  readonly cameras?: WsdotCameraDirectory | null;
  readonly briefs: BriefService;
}

/**
 * REST surface. Every query parameter goes through a Zod schema before it reaches the
 * repository, so a malformed or hostile request produces a 400 rather than a query.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { config, repository, pipeline, cameras, briefs } = deps;

  app.get('/api/health', async () => ({
    status: 'ok',
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

  /**
   * A short spoken-form account of one incident.
   *
   * Separate from the incident itself because it is a *rendering* of it, not part of the
   * record: it is generated on demand, cached, and carries its own origin so the client
   * can label a model-written brief differently from a composed one.
   */
  app.get('/api/incidents/:id/brief', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (typeof id !== 'string' || id.length > 120) {
      return reply.status(400).send({ error: 'invalid-id' });
    }
    const incident = repository.getIncident(id);
    if (!incident) return reply.status(404).send({ error: 'not-found' });

    const brief = await briefs.briefFor(incident);
    return { brief, incidentId: incident.id };
  });

  app.get('/api/stats', async () => ({ stats: pipeline.currentStats() }));

  app.get('/api/patterns', async () => ({
    patterns: pipeline.patterns,
    // The API says the same thing the UI does: this describes received data.
    disclaimer:
      'Analytical inference over incidents already received. Not a prediction of future events.',
  }));

  app.get('/api/sources', async () => ({ sources: pipeline.sourceStatuses() }));


  /**
   * Public roadway cameras.
   *
   * A separate resource from incidents on purpose: these are conditions imagery, not
   * reports of events, and nothing here ever joins the incident store. The response
   * carries the agency's attribution and the use notice the client is required to show.
   */
  app.get('/api/cameras', async () => {
    if (!cameras) {
      return {
        configured: false,
        cameras: [],
        count: 0,
        reason:
          'No camera access code configured. Set WSDOT_ACCESS_CODE to enable the public ' +
          'roadway-camera overlay.',
      };
    }
    const listing = await cameras.list();
    return {
      configured: true,
      ...listing.directory,
      count: listing.directory.cameras.length,
      stale: listing.stale,
      message: listing.message,
    };
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
