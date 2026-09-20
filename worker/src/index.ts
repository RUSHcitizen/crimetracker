import { loadWorkerConfig, type Env } from './config.js';

export { TrackerRoom } from './room.js';

/**
 * Worker entrypoint.
 *
 * Everything is served from one origin: `/api/*` and `/ws` go to the Durable Object that
 * owns the incident store, and every other path falls through to the built client in the
 * assets binding. Same-origin means no CORS, no second deployment to keep in step, and no
 * API host baked into the client bundle.
 *
 * A single Durable Object instance holds the whole tracker, so ordering and the incident
 * store stay consistent — the same guarantee the single-process Node server had.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isWs = url.pathname === '/ws';

    if (!isApi && !isWs) return env.ASSETS.fetch(request);

    /*
     * WebSocket upgrades are not covered by CORS, so a browser will let any page open a
     * socket to this Worker. Because the client is served from this same origin, a
     * cross-origin upgrade is never legitimate and is refused.
     */
    if (isWs) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) {
        return new Response('Origin not allowed', { status: 403 });
      }
    }

    const config = loadWorkerConfig(env);
    void config;

    // One room per deployment. A regional or multi-tenant build would derive the name
    // from the request instead.
    const id = env.TRACKER.idFromName('wa-statewide');
    const room = env.TRACKER.get(id);

    ctx.passThroughOnException();
    return room.fetch(request);
  },

  /**
   * Cron entrypoint. The Durable Object drives itself with alarms, so this only nudges
   * the room awake — useful if the object has been idle and no client is connected.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const room = env.TRACKER.get(env.TRACKER.idFromName('wa-statewide'));
    await room.fetch(new Request('https://crimetracker.internal/api/health'));
  },
} satisfies ExportedHandler<Env>;
