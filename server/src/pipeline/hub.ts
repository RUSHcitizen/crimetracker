import type {
  AppMode,
  Incident,
  PatternCluster,
  ServerFrame,
  SourceStatus,
  Stats,
} from '@crimetracker/shared';

export interface HubClient {
  readonly id: string;
  send(payload: string): void;
  close(): void;
}

/**
 * Fan-out to connected WebSocket clients.
 *
 * Deltas are coalesced on a short tick: a 40-incident burst becomes one frame and one
 * paint instead of 40. Statistics and pattern frames are collapsed to the latest value
 * within a tick, since only the newest one matters.
 */
export class RealtimeHub {
  readonly #clients = new Map<string, HubClient>();
  #newIncidents: Incident[] = [];
  #updatedIncidents: Incident[] = [];
  #pendingStats: Stats | null = null;
  #pendingPatterns: readonly PatternCluster[] | null = null;
  #pendingSources: readonly SourceStatus[] | null = null;
  #pendingMode: AppMode | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(private readonly flushIntervalMs = 100) {}

  get clientCount(): number {
    return this.#clients.size;
  }

  add(client: HubClient): void {
    this.#clients.set(client.id, client);
  }

  remove(clientId: string): void {
    this.#clients.delete(clientId);
  }

  /** Send a frame to exactly one client (used for the connection snapshot). */
  sendTo(clientId: string, frame: ServerFrame): void {
    const client = this.#clients.get(clientId);
    if (!client) return;
    try {
      client.send(JSON.stringify(frame));
    } catch {
      this.#clients.delete(clientId);
    }
  }

  publishIncidents(incidents: readonly Incident[]): void {
    if (incidents.length === 0) return;
    this.#newIncidents.push(...incidents);
    this.#schedule();
  }

  publishIncidentUpdates(incidents: readonly Incident[]): void {
    if (incidents.length === 0) return;
    this.#updatedIncidents.push(...incidents);
    this.#schedule();
  }

  publishStats(stats: Stats): void {
    this.#pendingStats = stats;
    this.#schedule();
  }

  publishPatterns(patterns: readonly PatternCluster[]): void {
    this.#pendingPatterns = patterns;
    this.#schedule();
  }

  publishSources(sources: readonly SourceStatus[]): void {
    this.#pendingSources = sources;
    this.#schedule();
  }

  publishMode(mode: AppMode): void {
    this.#pendingMode = mode;
    this.#schedule();
  }

  /** Heartbeat so clients can show connection health and detect a dead socket. */
  pulse(): void {
    this.#broadcast({ type: 'pulse', serverTime: new Date().toISOString() });
  }

  closeAll(): void {
    for (const client of this.#clients.values()) {
      try {
        client.close();
      } catch {
        // Already gone.
      }
    }
    this.#clients.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, this.flushIntervalMs);
    this.#timer.unref?.();
  }

  #flush(): void {
    if (this.#clients.size === 0) {
      // Nobody is listening; drop the backlog rather than accumulate it.
      this.#reset();
      return;
    }
    if (this.#newIncidents.length > 0) {
      this.#broadcast({ type: 'incidents', incidents: this.#newIncidents });
    }
    if (this.#updatedIncidents.length > 0) {
      this.#broadcast({ type: 'incident:update', incidents: this.#updatedIncidents });
    }
    if (this.#pendingPatterns) this.#broadcast({ type: 'patterns', patterns: this.#pendingPatterns });
    if (this.#pendingStats) this.#broadcast({ type: 'stats', stats: this.#pendingStats });
    if (this.#pendingSources) this.#broadcast({ type: 'sources', sources: this.#pendingSources });
    if (this.#pendingMode) this.#broadcast({ type: 'mode', mode: this.#pendingMode });
    this.#reset();
  }

  #reset(): void {
    this.#newIncidents = [];
    this.#updatedIncidents = [];
    this.#pendingStats = null;
    this.#pendingPatterns = null;
    this.#pendingSources = null;
    this.#pendingMode = null;
  }

  #broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const [id, client] of this.#clients) {
      try {
        client.send(payload);
      } catch {
        this.#clients.delete(id);
      }
    }
  }
}
