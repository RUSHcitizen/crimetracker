import { IncidentRepository } from '@crimetracker/shared';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { loadConfig } from './config.js';
import { openDatabase, resolveDatabasePath } from './db/database.js';
import { createExtractor } from './extraction/index.js';
import { registerRoutes } from './http/routes.js';
import { WsdotCameraDirectory } from './cameras/directory.js';
import { BriefService, createBriefGenerator } from './brief/index.js';
import { registerWebsocket } from './http/ws.js';
import { RealtimeHub } from './pipeline/hub.js';
import { IngestionPipeline } from './pipeline/ingest.js';
import { buildSources } from './sources/registry.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.stdout.isTTY
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    },
    // Incoming payloads are tiny; nothing here should ever accept a large body.
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'POST'],
  });
  /*
   * WebSocket upgrades are not covered by CORS: a browser will happily let any page
   * open a socket to this server and read the whole incident stream. The allowed-origin
   * list is therefore enforced on the handshake as well.
   *
   * A request with no Origin header is not a browser page, so it is allowed — that is
   * how curl, tests and native clients connect.
   */
  const allowedOrigins = new Set(config.corsOrigins);
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
      verifyClient: (info: { origin?: string }, next: (ok: boolean, code?: number, message?: string) => void) => {
        const origin = info.origin;
        if (!origin || allowedOrigins.has(origin)) return next(true);
        app.log.warn(`rejected websocket upgrade from disallowed origin: ${origin}`);
        next(false, 403, 'Origin not allowed');
      },
    },
  });

  const db = openDatabase(config.databasePath);
  const repository = new IncidentRepository(db.driver);
  app.log.info(`database: ${resolveDatabasePath(config.databasePath)}`);

  if (config.retentionHours > 0) {
    const removed = repository.deleteOlderThan(Date.now() - config.retentionHours * 3_600_000);
    if (removed > 0) app.log.info(`pruned ${removed} incidents older than ${config.retentionHours}h`);
  }

  const hub = new RealtimeHub();
  const pipeline = new IngestionPipeline({
    config,
    repository,
    hub,
    logger: {
      info: (msg, detail) => app.log.info(detail ?? {}, msg),
      warn: (msg, detail) => app.log.warn(detail ?? {}, msg),
      error: (msg, detail) => app.log.error(detail ?? {}, msg),
    },
  });

  /*
   * The camera overlay exists only when the operator supplied the agency's free access
   * code. Building it here rather than inside the route keeps the directory cached for
   * the process lifetime instead of refetching per request.
   */
  const cameras = config.cameras.enabled
    ? new WsdotCameraDirectory({
        url: config.cameras.url,
        accessCode: config.cameras.accessCode,
        region: config.region,
        imageHosts: config.cameras.imageHosts,
        refreshMinutes: config.cameras.refreshMinutes,
      })
    : null;
  if (cameras) app.log.info('public roadway camera overlay enabled (WSDOT)');

  const briefs = new BriefService(createBriefGenerator(config));
  app.log.info(`brief generator: ${briefs.label}`);

  await registerRoutes(app, { config, repository, pipeline, cameras, briefs });
  await registerWebsocket(app, { repository, pipeline, hub });

  /*
   * Bind the port *before* starting any source. Sources begin writing immediately (the
   * simulation backfills thousands of rows), so if the port is already taken we must
   * fail here rather than after polluting the database with a run that can never serve
   * a request.
   */
  await app.listen({ port: config.port, host: config.host });

  const extractor = createExtractor(config);
  app.log.info(`extraction provider: ${extractor.label}`);

  const { sources, warnings } = buildSources(config, extractor);
  for (const warning of warnings) app.log.warn(warning);
  for (const source of sources) pipeline.register(source);

  if (!pipeline.hasSources) {
    app.log.error(
      'No source is configured, so no incidents will arrive. Run `npm run sources` to ' +
        'list the catalogued feeds and set SOURCES.',
    );
  }
  await pipeline.startAll();

  // First analysis pass so a client connecting immediately sees patterns and stats.
  pipeline.runAnalysis();

  // Periodic refresh keeps time-windowed stats and pattern recency honest even when no
  // new incidents are arriving.
  const analysisInterval = setInterval(() => {
    try {
      pipeline.runAnalysis();
    } catch (error) {
      app.log.error({ error }, 'periodic analysis failed');
    }
  }, 30_000);
  analysisInterval.unref();

  const pulseInterval = setInterval(() => hub.pulse(), 10_000);
  pulseInterval.unref();

  app.log.info(`CRIME TRACKER server listening on http://${config.host}:${config.port}`);
  app.log.info(
    `ingesting from ${sources.length} published source(s): ${
      sources.map((s) => s.descriptor.id).join(', ') || 'none'
    }`,
  );

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    clearInterval(analysisInterval);
    clearInterval(pulseInterval);
    hub.closeAll();
    await pipeline.shutdown();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('fatal: failed to start Crime Tracker server');
  console.error(error);
  process.exit(1);
});
