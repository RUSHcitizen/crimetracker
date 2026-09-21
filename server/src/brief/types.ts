import type { Incident } from '@crimetracker/shared';

/**
 * A short plain-language account of one incident.
 *
 * Agency data is written for dispatchers, not readers: `BURGLARY - IN PROGRESS`,
 * `1500 BLOCK OF 3RD AVE`, `EventCategory: Collision`. A brief turns that into a sentence
 * you can listen to while looking at the map.
 *
 * The hard rule is that a brief adds **no facts**. It restates what the record already
 * says, in order, in prose. It never guesses a cause, a suspect, an outcome, or a severity
 * the data did not carry — those would be assertions about real events and, often enough,
 * about real people. Everything a brief contains must be traceable to a field of the
 * incident it was built from.
 */
export interface Brief {
  readonly text: string;
  /**
   * `derived` when composed deterministically from the record's own fields;
   * `ai-inferred` when a language model wrote it. The UI labels the two differently and
   * must never present the second as the first.
   */
  readonly origin: 'derived' | 'ai-inferred';
  /** Which generator produced it, for the audit trail. */
  readonly generatorId: string;
  readonly generatedAt: string;
}

export interface BriefGenerator {
  readonly id: string;
  readonly label: string;
  generate(incident: Incident): Promise<Brief>;
}
