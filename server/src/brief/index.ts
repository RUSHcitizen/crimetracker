import type { Incident } from '@crimetracker/shared';
import type { Config } from '../config.js';
import { ComposedBriefGenerator } from './compose.js';
import { LlmBriefGenerator } from './llm.js';
import type { Brief, BriefGenerator } from './types.js';

export * from './types.js';
export { ComposedBriefGenerator } from './compose.js';
export { LlmBriefGenerator, groundingFor } from './llm.js';

/**
 * Briefs, cached per incident.
 *
 * Without a cache, every click would be a model call: slow, billable, and — because these
 * are summaries of a fixed record — pointlessly non-deterministic, so the same incident
 * would describe itself differently each time you opened it. An incident's fields do not
 * change after ingestion, so one brief per incident is correct as well as cheap.
 *
 * The cache is bounded and evicts oldest-first; it is a convenience, never a store of
 * record.
 */
export class BriefService {
  readonly #generator: BriefGenerator;
  readonly #cache = new Map<string, Brief>();
  readonly #limit: number;
  /** Coalesces concurrent requests for the same incident onto one generation. */
  readonly #inFlight = new Map<string, Promise<Brief>>();

  constructor(generator: BriefGenerator, limit = 500) {
    this.#generator = generator;
    this.#limit = limit;
  }

  get label(): string {
    return this.#generator.label;
  }

  get generatorId(): string {
    return this.#generator.id;
  }

  async briefFor(incident: Incident): Promise<Brief> {
    const cached = this.#cache.get(incident.id);
    if (cached) return cached;

    const existing = this.#inFlight.get(incident.id);
    if (existing) return existing;

    const pending = this.#generator
      .generate(incident)
      .then((brief) => {
        this.#remember(incident.id, brief);
        return brief;
      })
      .finally(() => {
        this.#inFlight.delete(incident.id);
      });

    this.#inFlight.set(incident.id, pending);
    return pending;
  }

  #remember(id: string, brief: Brief): void {
    this.#cache.set(id, brief);
    while (this.#cache.size > this.#limit) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
  }
}

/**
 * Pick a generator from configuration.
 *
 * Deliberately shares `AI_*` with the extractor: someone who has configured a model for
 * one wants it for the other, and asking for the same endpoint twice would be a trap.
 */
export function createBriefGenerator(config: Config): BriefGenerator {
  if (config.ai.provider === 'openai-compatible' && config.ai.baseUrl && config.ai.model) {
    return new LlmBriefGenerator({
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      apiKey: config.ai.apiKey,
      timeoutMs: config.ai.timeoutMs,
    });
  }
  return new ComposedBriefGenerator();
}
