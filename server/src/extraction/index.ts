import type { Config } from '../config.js';
import { HeuristicExtractor } from './heuristic.js';
import { OpenAICompatibleExtractor } from './openaiCompatible.js';
import type { ExtractionInput, IncidentExtractor } from './types.js';

export * from './types.js';
export { HeuristicExtractor } from './heuristic.js';
export { OpenAICompatibleExtractor } from './openaiCompatible.js';

/**
 * Wraps a primary extractor and falls back to the local heuristic one whenever the
 * primary returns nothing useful. The pipeline therefore always gets a result, and a
 * misconfigured or offline model provider degrades instead of breaking ingestion.
 */
export class FallbackExtractor implements IncidentExtractor {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly primary: IncidentExtractor,
    private readonly fallback: IncidentExtractor = new HeuristicExtractor(),
  ) {
    this.id = primary.id;
    this.label = `${primary.label} (fallback: ${fallback.label})`;
  }

  async extract(input: ExtractionInput) {
    const result = await this.primary.extract(input);
    if (result.confidence > 0 && (result.incidentType || result.description)) return result;
    const fallbackResult = await this.fallback.extract(input);
    return {
      ...fallbackResult,
      notes: [...result.notes, `fell back to ${this.fallback.id}`, ...fallbackResult.notes].slice(0, 10),
    };
  }
}

export function createExtractor(config: Config): IncidentExtractor {
  if (config.ai.provider === 'openai-compatible') {
    if (!config.ai.baseUrl || !config.ai.model) {
      // Misconfigured — say so once and keep working locally.
      console.warn(
        '[extraction] AI_PROVIDER=openai-compatible requires AI_BASE_URL and AI_MODEL; ' +
          'falling back to the local heuristic extractor.',
      );
      return new HeuristicExtractor();
    }
    return new FallbackExtractor(
      new OpenAICompatibleExtractor({
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
        apiKey: config.ai.apiKey,
        timeoutMs: config.ai.timeoutMs,
      }),
    );
  }
  return new HeuristicExtractor();
}
