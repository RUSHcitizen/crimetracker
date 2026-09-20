import type {
  ConnectionState,
  RawIncident,
  SourceDescriptor,
  SourceStatus,
} from '@crimetracker/shared';

/** Services a source is given by the pipeline. Sources never touch the DB or the hub. */
export interface SourceContext {
  /** Hand a raw record to the ingestion pipeline. Returns once it has been queued. */
  emit(raw: RawIncident): void;
  /** Hand a batch over — cheaper for backfills. */
  emitMany(raws: readonly RawIncident[]): void;
  log(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void;
  /** Report connection state changes so the HUD can show them. */
  setState(state: ConnectionState, message?: string | null): void;
  /** Aborts when the server is shutting down. */
  readonly signal: AbortSignal;
}

/**
 * The single extension point for getting data into Crime Tracker.
 *
 * A new provider means a new implementation of this interface plus one registry entry —
 * nothing else in the application knows which sources exist.
 */
export interface DataSource {
  readonly descriptor: SourceDescriptor;
  /** Current connection/health snapshot for the HUD. */
  status(): SourceStatus;
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
}

/** Shared bookkeeping so every source reports status the same way. */
export class SourceStatusTracker {
  #state: ConnectionState = 'idle';
  #message: string | null = null;
  #lastEventAt: string | null = null;
  #ingested = 0;
  #rejected = 0;

  constructor(private readonly descriptor: SourceDescriptor, private enabled: boolean) {}

  setState(state: ConnectionState, message: string | null = null): void {
    this.#state = state;
    this.#message = message;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  recordEvent(count = 1): void {
    this.#ingested += count;
    this.#lastEventAt = new Date().toISOString();
  }

  recordRejection(count = 1): void {
    this.#rejected += count;
  }

  snapshot(): SourceStatus {
    return {
      id: this.descriptor.id,
      name: this.descriptor.name,
      kind: this.descriptor.kind,
      note: this.descriptor.note,
      state: this.#state,
      enabled: this.enabled,
      lastEventAt: this.#lastEventAt,
      eventsIngested: this.#ingested,
      eventsRejected: this.#rejected,
      message: this.#message,
      url: this.descriptor.url ?? null,
    };
  }
}
