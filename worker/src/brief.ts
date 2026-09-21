/**
 * Briefs on the Worker.
 *
 * The generators themselves live in `server/src/brief` and are plain, runtime-neutral
 * code — but the Worker cannot import across that workspace boundary, so this re-states
 * the small amount of wiring it needs against the same shared types. The prose logic is
 * the one thing worth keeping identical, so `composeBrief` is imported from shared.
 */
import { composeBrief, type Incident } from '@crimetracker/shared';
import type { WorkerConfig } from './config.js';

export interface Brief {
  readonly text: string;
  readonly origin: 'derived' | 'ai-inferred';
  readonly generatorId: string;
  readonly generatedAt: string;
}

export interface BriefGenerator {
  readonly id: string;
  readonly label: string;
  generate(incident: Incident): Promise<Brief>;
}

export class ComposedBriefGenerator implements BriefGenerator {
  readonly id = 'composed-v1';
  readonly label = 'Composed locally from the record';

  async generate(incident: Incident): Promise<Brief> {
    return {
      text: composeBrief(incident),
      origin: 'derived',
      generatorId: this.id,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Bounded per-object cache; an incident's fields never change after ingestion. */
export class BriefService {
  readonly #generator: BriefGenerator;
  readonly #cache = new Map<string, Brief>();
  readonly #limit: number;

  constructor(generator: BriefGenerator, limit = 300) {
    this.#generator = generator;
    this.#limit = limit;
  }

  get label(): string {
    return this.#generator.label;
  }

  async briefFor(incident: Incident): Promise<Brief> {
    const cached = this.#cache.get(incident.id);
    if (cached) return cached;

    const brief = await this.#generator.generate(incident);
    this.#cache.set(incident.id, brief);
    while (this.#cache.size > this.#limit) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    return brief;
  }
}

export function createBriefGenerator(_config: WorkerConfig): BriefGenerator {
  // Model-backed briefs are Node-server only for now: a per-click model call inside a
  // Durable Object competes with ingestion for the same subrequest budget.
  return new ComposedBriefGenerator();
}
