import { SimulationGenerator, type SourceDescriptor } from '@crimetracker/shared';
import { SourceStatusTracker, type DataSource, type SourceContext } from './types.js';

export interface SimulationSourceOptions {
  /** Mean seconds between generated incidents. */
  readonly intervalSeconds: number;
  readonly seed?: string | null;
  /** Historical records generated at startup so the map opens populated. */
  readonly backfill: number;
  readonly backfillHours: number;
  /** Probability that a given tick produces a clustered burst instead of one incident. */
  readonly burstProbability?: number;
}

export const SIMULATION_DESCRIPTOR: SourceDescriptor = {
  id: 'simulation',
  name: 'Simulation Engine',
  kind: 'simulation',
  note: 'Fictional incidents generated locally. Not real events, not derived from any feed.',
  url: null,
};

/**
 * The default source. Produces fictional incidents so the whole system — map, stream,
 * statistics, pattern detection — is exercisable with nothing connected.
 */
export class SimulationSource implements DataSource {
  readonly descriptor = SIMULATION_DESCRIPTOR;
  readonly #tracker = new SourceStatusTracker(SIMULATION_DESCRIPTOR, true);
  readonly #generator: SimulationGenerator;
  readonly #options: SimulationSourceOptions;
  #timer: NodeJS.Timeout | null = null;
  #ctx: SourceContext | null = null;
  #stopped = false;
  /** Backfill is history, so it happens once per process, not on every restart. */
  #hasBackfilled = false;

  constructor(options: SimulationSourceOptions) {
    this.#options = options;
    this.#generator = new SimulationGenerator(options.seed ? { seed: options.seed } : {});
  }

  status() {
    return this.#tracker.snapshot();
  }

  async start(ctx: SourceContext): Promise<void> {
    this.#ctx = ctx;
    this.#stopped = false;
    this.#tracker.setState('connecting', 'Priming simulation');
    ctx.setState('connecting', 'Priming simulation');

    if (this.#options.backfill > 0 && !this.#hasBackfilled) {
      this.#hasBackfilled = true;
      this.#backfill(ctx);
    }

    this.#tracker.setState('online', 'Generating fictional incidents');
    ctx.setState('online', 'Generating fictional incidents');
    this.#scheduleNext();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#tracker.setState('stopped', 'Simulation halted');
    this.#ctx?.setState('stopped', 'Simulation halted');
  }

  /** Fill the window behind `now` so the interface never opens empty. */
  #backfill(ctx: SourceContext): void {
    const { backfill, backfillHours } = this.#options;
    const now = Date.now();
    const spanMs = backfillHours * 3_600_000;
    const events = [];

    for (let i = 0; i < backfill; i += 1) {
      // Mild recency bias only. A steep bias piles every backfilled record into the
      // newest histogram bucket, which makes the activity timeline meaningless.
      const fraction = Math.random() ** 1.25;
      const at = new Date(now - fraction * spanMs);
      events.push(this.#generator.generate(at));
    }
    /*
     * Historical bursts, so the analytics view has concentrations in its history...
     */
    const burstCount = Math.max(2, Math.round(backfill / 600));
    for (let i = 0; i < burstCount; i += 1) {
      const at = new Date(now - Math.random() * spanMs);
      events.push(...this.#generator.generateBurst(at));
    }

    /*
     * ...plus two inside the pattern-detection window, so the interface has something
     * to detect the moment it opens rather than waiting for the live generator to
     * happen to produce one. These are ordinary generated bursts — nothing about them
     * is special-cased downstream.
     */
    for (let i = 0; i < 3; i += 1) {
      const at = new Date(now - (4 + Math.random() * 18) * 60_000);
      events.push(...this.#generator.generateBurst(at, 7 + Math.floor(Math.random() * 3)));
    }

    events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    ctx.emitMany(events);
    this.#tracker.recordEvent(events.length);
    ctx.log('info', `simulation backfilled ${events.length} fictional incidents`);
  }

  #scheduleNext(): void {
    if (this.#stopped) return;
    const delayMs = this.#generator.nextInterval(this.#options.intervalSeconds) * 1000;
    this.#timer = setTimeout(() => this.#tick(), delayMs);
    // Do not hold the event loop open on shutdown.
    this.#timer.unref?.();
  }

  #tick(): void {
    if (this.#stopped || !this.#ctx) return;
    const ctx = this.#ctx;
    const now = new Date();
    const burstProbability = this.#options.burstProbability ?? 0.06;

    if (Math.random() < burstProbability) {
      const burst = this.#generator.generateBurst(now);
      ctx.emitMany(burst);
      this.#tracker.recordEvent(burst.length);
      ctx.log('info', `simulation emitted a ${burst.length}-report burst`);
    } else {
      ctx.emit(this.#generator.generate(now));
      this.#tracker.recordEvent();
    }
    this.#scheduleNext();
  }
}
