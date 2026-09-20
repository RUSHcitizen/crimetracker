import type { ExtractionResult } from '@crimetracker/shared';

export interface ExtractionInput {
  readonly transcript: string;
  readonly receivedAt: string;
  /** Optional hint (e.g. the dispatch area a stream covers). Never a coordinate. */
  readonly areaHint?: string | null;
}

/**
 * Provider-agnostic structured extraction.
 *
 * Implementations must never invent coordinates: the pipeline only accepts a position
 * that was already present in the input, and everything an extractor returns is recorded
 * with `origin: 'ai-inferred'` so the UI can label it.
 */
export interface IncidentExtractor {
  readonly id: string;
  /** Short description shown in the HUD's processing readout. */
  readonly label: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export const EMPTY_EXTRACTION = (extractorId: string): ExtractionResult => ({
  incidentType: null,
  severity: null,
  description: null,
  locationLabel: null,
  locationPrecision: null,
  area: null,
  coordinates: null,
  confidence: 0,
  extractorId,
  notes: [],
});
