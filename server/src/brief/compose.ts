import { composeBrief, type Incident } from '@crimetracker/shared';
import type { Brief, BriefGenerator } from './types.js';

/**
 * The default brief generator: deterministic, local, no model.
 *
 * It reads as prose but invents nothing — every clause is a field of the incident. That
 * makes it the right default (no key, no network, no data leaving the machine) and also
 * the floor the model-backed generator has to beat: if a language model is unavailable or
 * returns something unusable, a caller still gets an accurate sentence rather than an
 * error or, worse, a plausible fabrication.
 *
 * It is labelled `derived`, not `ai-inferred`, because that is what it is.
 */
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
