import {
  coerceSeverity,
  isIncidentType,
  llmExtractionSchema,
  LOCATION_PRECISIONS,
  sanitizeText,
  TEXT_LIMITS,
  type ExtractionResult,
  type LocationPrecision,
  type SeverityLevel,
} from '@crimetracker/shared';
import { EMPTY_EXTRACTION, type ExtractionInput, type IncidentExtractor } from './types.js';

export interface OpenAICompatibleOptions {
  /** e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1 for Ollama. */
  readonly baseUrl: string;
  readonly model: string;
  /** Optional: local servers (Ollama, vLLM, LM Studio) usually need no key. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You extract structured fields from public-safety dispatch text.

Rules:
- Only report what the text supports. If a field is not stated, return null.
- NEVER invent an address, a city, or coordinates. You cannot return coordinates at all.
- "location" must be copied from the text (a block, an address, an intersection, a highway).
- "confidence" is your confidence in this extraction as a whole, 0 to 1.
- Respond with a single JSON object and nothing else.

JSON shape:
{"incident_type": string|null, "severity": 1-5|null, "description": string|null,
 "location": string|null, "location_precision": "exact"|"block"|"area"|"unknown"|null,
 "area": string|null, "confidence": number, "notes": string[]}

incident_type must be one of: assault, robbery, burglary, theft, vehicle, weapons,
disturbance, traffic, fire, medical, hazard, missing-person, suspicious, other.`;

/**
 * Extractor backed by any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Works unchanged against OpenAI, Ollama, vLLM, LM Studio and similar. The API key is
 * read from the server environment and never reaches the browser.
 *
 * Model output is untrusted input: it is parsed, schema-checked and coerced onto our
 * controlled vocabularies. A malformed or hostile response degrades to an empty
 * extraction rather than corrupting an incident.
 */
export class OpenAICompatibleExtractor implements IncidentExtractor {
  readonly id: string;
  readonly label: string;
  readonly #options: OpenAICompatibleOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.id = `openai-compatible:${options.model}`;
    this.label = `${options.model} via OpenAI-compatible API`;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000);
    try {
      const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.#options.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Received at: ${input.receivedAt}\n${
                input.areaHint ? `Coverage area: ${input.areaHint}\n` : ''
              }Transcript:\n"""\n${input.transcript.slice(0, 4000)}\n"""`,
            },
          ],
        }),
      });

      if (!response.ok) {
        return { ...EMPTY_EXTRACTION(this.id), notes: [`provider returned HTTP ${response.status}`] };
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        return { ...EMPTY_EXTRACTION(this.id), notes: ['provider returned no content'] };
      }
      return this.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return { ...EMPTY_EXTRACTION(this.id), notes: [`provider error: ${message.slice(0, 120)}`] };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Exposed for testing: turn raw model text into a validated `ExtractionResult`. */
  parse(content: string): ExtractionResult {
    const json = extractJsonObject(content);
    if (!json) return { ...EMPTY_EXTRACTION(this.id), notes: ['response was not JSON'] };

    const parsed = llmExtractionSchema.safeParse(json);
    if (!parsed.success) {
      return { ...EMPTY_EXTRACTION(this.id), notes: ['response failed schema validation'] };
    }
    const data = parsed.data;

    const typeRaw = typeof data.incident_type === 'string' ? data.incident_type.trim().toLowerCase() : null;
    const incidentType = typeRaw && isIncidentType(typeRaw) ? typeRaw : null;

    const precisionRaw =
      typeof data.location_precision === 'string' ? data.location_precision.trim().toLowerCase() : null;
    let locationPrecision: LocationPrecision | null =
      precisionRaw && (LOCATION_PRECISIONS as readonly string[]).includes(precisionRaw)
        ? (precisionRaw as LocationPrecision)
        : null;
    // A model reading prose cannot establish an exact position.
    if (locationPrecision === 'exact') locationPrecision = 'block';

    const confidenceRaw = typeof data.confidence === 'string' ? Number(data.confidence) : data.confidence;
    const confidence =
      typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
        ? Math.min(1, Math.max(0, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw))
        : 0.4;

    const notes = (data.notes ?? []).slice(0, 10).map((n) => sanitizeText(n, 200)).filter(Boolean);
    if (typeRaw && !incidentType) notes.push(`discarded unknown type "${sanitizeText(typeRaw, 40)}"`);

    return {
      incidentType,
      severity: data.severity == null ? null : (coerceSeverity(data.severity, 2) as SeverityLevel),
      description: data.description ? sanitizeText(data.description, TEXT_LIMITS.description) : null,
      locationLabel: data.location ? sanitizeText(data.location, TEXT_LIMITS.locationLabel) : null,
      locationPrecision,
      area: data.area ? sanitizeText(data.area, TEXT_LIMITS.area) : null,
      // Not negotiable: an LLM never supplies coordinates in this system.
      coordinates: null,
      confidence: Math.round(confidence * 100) / 100,
      extractorId: this.id,
      notes,
    };
  }
}

/** Models sometimes wrap JSON in prose or a code fence. Pull out the first object. */
export function extractJsonObject(content: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
