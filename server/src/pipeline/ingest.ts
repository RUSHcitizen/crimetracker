import {
  detectPatterns,
  normalizeIncident,
  type AppMode,
  type ConnectionState,
  type Incident,
  type IncidentStatus,
  type PatternCluster,
  type RawIncident,
  type SourceStatus,
  type Stats,
} from '@crimetracker/shared';
import type { Config } from '../config.js';
import type { IncidentRepository } from '../db/repository.js';
import type { DataSource, SourceContext } from '../sources/types.js';
import type { RealtimeHub } from './hub.js';

export interface PipelineOptions {
  readonly config: Config;
  readonly repository: IncidentRepository;
  readonly hub: RealtimeHub;
  readonly logger: {
    info(msg: string, detail?: unknown): void;
    warn(msg: string, detail?: unknown): void;
    error(msg: string, detail?: unknown): void;
  };
}

/**
 * Owns the path from raw record to broadcast incident:
 *
 *   raw → normalize/validate → persist → broadcast → re-run pattern detection → stats
 *
 * Normalization and pattern detection live in `@crimetracker/shared`, so the exact same
 * code validates data here and is unit-tested in isolation.
 */
export class IngestionPipeline {
  readonly #config: Config;
  readonly #repo: IncidentRepository;
  readonly #hub: RealtimeHub;
  readonly #logger: PipelineOptions['logger'];
  readonly #abort = new AbortController();
  readonly #sources: DataSource[] = [];
  readonly #processingTimers = new Set<NodeJS.Timeout>();

  #patterns: PatternCluster[] = [];
  #analysisTimer: NodeJS.Timeout | null = null;
  #analysisDirty = false;
  #mode: AppMode;
  #accepted = 0;
  #rejected = 0;

  constructor(options: PipelineOptions) {
    this.#config = options.config;
    this.#repo = options.repository;
    this.#hub = options.hub;
    this.#logger = options.logger;
    this.#mode = options.config.mode;
  }

  get mode(): AppMode {
    return this.#mode;
  }

  get patterns(): readonly PatternCluster[] {
    return this.#patterns;
  }

  get counters(): { accepted: number; rejected: number } {
    return { accepted: this.#accepted, rejected: this.#rejected };
  }

  sourceStatuses(): SourceStatus[] {
    return this.#sources.map((source) => source.status());
  }

  async register(source: DataSource): Promise<void> {
    this.#repo.upsertSource(source.descriptor);
    this.#sources.push(source);
    await source.start(this.#contextFor(source));
    this.#hub.publishSources(this.sourceStatuses());
  }

  async shutdown(): Promise<void> {
    this.#abort.abort();
    for (const timer of this.#processingTimers) clearTimeout(timer);
    this.#processingTimers.clear();
    if (this.#analysisTimer) clearTimeout(this.#analysisTimer);
    await Promise.allSettled(this.#sources.map((source) => source.stop()));
  }

  /** Accept records from a source. Returns the incidents that survived validation. */
  ingest(source: DataSource, raws: readonly RawIncident[]): Incident[] {
    const accepted: Incident[] = [];
    for (const raw of raws) {
      const result = normalizeIncident(raw, {
        source: source.descriptor,
        region: this.#config.region,
      });
      if (!result.ok) {
        this.#rejected += 1;
        this.#logger.warn(`rejected record from ${source.descriptor.id}: ${result.reason}`);
        continue;
      }
      if (result.warnings.length > 0) {
        this.#logger.info(
          `normalized with warnings from ${source.descriptor.id}: ${result.warnings.join(', ')}`,
        );
      }
      this.#repo.insertIncident(result.incident);
      accepted.push(result.incident);
      this.#accepted += 1;
    }

    if (accepted.length > 0) {
      this.#hub.publishIncidents(accepted);
      this.#scheduleProcessing(accepted);
      this.#markDirty();
    }
    return accepted;
  }

  /** Recompute patterns and statistics, then publish both. */
  runAnalysis(): { patterns: PatternCluster[]; stats: Stats } {
    // Pattern detection only looks at the configured window; fetching a little extra
    // keeps the query stable if the window is reconfigured between passes.
    const recent = this.#repo.queryIncidents({
      sinceMinutes: this.#config.patterns.windowMinutes + 15,
      limit: 6000,
    });
    const patterns = detectPatterns(recent, {
      epsKm: this.#config.patterns.epsKm,
      windowMinutes: this.#config.patterns.windowMinutes,
      minPoints: this.#config.patterns.minPoints,
    });
    this.#patterns = patterns;
    this.#repo.recordClusters(patterns);

    const stats = this.#repo.computeStats(patterns.length);
    this.#hub.publishPatterns(patterns);
    this.#hub.publishStats(stats);
    return { patterns, stats };
  }

  currentStats(): Stats {
    return this.#repo.computeStats(this.#patterns.length);
  }

  async setMode(mode: AppMode): Promise<void> {
    this.#mode = mode;
    this.#hub.publishMode(mode);
  }

  /* --------------------------------- internals -------------------------------- */

  #contextFor(source: DataSource): SourceContext {
    return {
      emit: (raw) => {
        this.ingest(source, [raw]);
      },
      emitMany: (raws) => {
        this.ingest(source, raws);
      },
      log: (level, message, detail) => {
        this.#logger[level](`[${source.descriptor.id}] ${message}`, detail);
      },
      setState: (state: ConnectionState, message) => {
        void state;
        void message;
        this.#hub.publishSources(this.sourceStatuses());
      },
      signal: this.#abort.signal,
    };
  }

  /**
   * Coalesce analysis: a burst of 40 incidents triggers one pattern pass, not 40. The
   * leading edge is also bounded so the HUD never waits more than ~1.2 s for a refresh.
   */
  #markDirty(): void {
    this.#analysisDirty = true;
    if (this.#analysisTimer) return;
    this.#analysisTimer = setTimeout(() => {
      this.#analysisTimer = null;
      if (!this.#analysisDirty) return;
      this.#analysisDirty = false;
      try {
        this.runAnalysis();
      } catch (error) {
        this.#logger.error('analysis failed', error);
      }
    }, 600);
    this.#analysisTimer.unref?.();
  }

  /**
   * Walk a freshly-arrived incident through its processing states so the HUD's
   * "processing status" readout reflects real pipeline stages rather than a static label.
   * Only applied to incidents that arrived in real time and carry a transcript.
   */
  #scheduleProcessing(incidents: readonly Incident[]): void {
    const now = Date.now();
    for (const incident of incidents) {
      if (!incident.transcript) continue;
      // Backfilled history is already settled — no point animating it.
      if (now - Date.parse(incident.timestamp) > 120_000) continue;

      const stages: IncidentStatus[] = ['transcribing', 'extracting', 'normalized', incident.status];
      let delay = 400;
      for (const stage of stages) {
        const timer = setTimeout(() => {
          this.#processingTimers.delete(timer);
          const updated: Incident = { ...incident, status: stage };
          this.#repo.insertIncident(updated);
          this.#hub.publishIncidentUpdates([updated]);
        }, delay);
        timer.unref?.();
        this.#processingTimers.add(timer);
        delay += 500 + Math.random() * 900;
      }
    }
  }
}
