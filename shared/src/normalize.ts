import { randomUUID } from './id.js';
import { validateCoordinates, type BBox, WASHINGTON_BBOX } from './geo.js';
import {
  incidentSchema,
  parseTimestamp,
  sanitizeMultiline,
  sanitizeText,
  TEXT_LIMITS,
} from './schema.js';
import {
  classifyText,
  coerceSeverity,
  INCIDENT_STATUSES,
  INCIDENT_TYPE_META,
  isIncidentType,
  LOCATION_PRECISIONS,
  type IncidentStatus,
  type IncidentType,
  type LocationPrecision,
} from './taxonomy.js';
import type {
  Incident,
  ProvenanceEntry,
  ProvenanceMap,
  RawIncident,
  SourceDescriptor,
} from './types.js';

export interface NormalizeOptions {
  /** Identity of the adapter that produced this record. */
  readonly source: SourceDescriptor;
  /** Region a coordinate must fall inside to be accepted. `null` disables the check. */
  readonly region?: BBox | null;
  readonly now?: number;
}

export interface NormalizeSuccess {
  readonly ok: true;
  readonly incident: Incident;
  /** Non-fatal problems: a dropped coordinate, a coerced type, etc. */
  readonly warnings: readonly string[];
}

export interface NormalizeFailure {
  readonly ok: false;
  readonly reason: string;
  readonly warnings: readonly string[];
}

export type NormalizeResult = NormalizeSuccess | NormalizeFailure;

function defaultOrigin(sourceKind: SourceDescriptor['kind']): ProvenanceEntry['origin'] {
  return sourceKind === 'simulation' ? 'simulated' : 'source';
}

function coercePrecision(value: unknown): LocationPrecision | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  return (LOCATION_PRECISIONS as readonly string[]).includes(lower)
    ? (lower as LocationPrecision)
    : null;
}

function coerceStatus(value: unknown, fallback: IncidentStatus): IncidentStatus {
  if (typeof value !== 'string') return fallback;
  return (INCIDENT_STATUSES as readonly string[]).includes(value)
    ? (value as IncidentStatus)
    : fallback;
}

function coerceConfidence(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  // Tolerate percentages from feeds that report 0–100.
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(scaled * 1000) / 1000));
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    // Feeds routinely emit numeric tags (district ids, beat numbers). Coercing them is
    // safe — everything still goes through `sanitizeText` — and dropping them silently
    // would lose data the source did provide.
    const raw = typeof entry === 'number' && Number.isFinite(entry) ? String(entry) : entry;
    const tag = sanitizeText(raw, TEXT_LIMITS.tag).toLowerCase();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Turn an untrusted `RawIncident` into a validated `Incident`.
 *
 * Guarantees:
 *  - the result always passes `incidentSchema`, or the call fails;
 *  - a coordinate that cannot be validated becomes `null`, never a guess;
 *  - a location known only by name is marked `approximate`;
 *  - every field carries provenance, so the UI can separate source data from inference.
 */
export function normalizeIncident(raw: RawIncident, options: NormalizeOptions): NormalizeResult {
  const warnings: string[] = [];
  const now = options.now ?? Date.now();
  const region = options.region === undefined ? WASHINGTON_BBOX : options.region;
  const { source } = options;
  const origin = defaultOrigin(source.kind);
  const provenance: ProvenanceMap = { ...(raw.provenance ?? {}) };

  const setProvenance = (field: keyof ProvenanceMap, entry: ProvenanceEntry) => {
    if (!provenance[field]) provenance[field] = entry;
  };

  /* --- timestamp ------------------------------------------------------------ */
  const timestamp = parseTimestamp(raw.timestamp, now);
  if (!timestamp) {
    // A record we cannot place in time is not useful on a time-filtered map.
    return { ok: false, reason: 'invalid-timestamp', warnings };
  }
  setProvenance('timestamp', { origin });

  /* --- description ---------------------------------------------------------- */
  const description = sanitizeText(raw.description, TEXT_LIMITS.description);
  const transcript = raw.transcript == null
    ? null
    : sanitizeMultiline(raw.transcript, TEXT_LIMITS.transcript) || null;

  if (!description && !transcript) {
    return { ok: false, reason: 'empty-record', warnings };
  }
  // A description the source actually wrote is source-held. One we fall back to from the
  // transcript is derived — and must stay replaceable by the extractor, which is the
  // whole point of the audio pipeline.
  setProvenance(
    'description',
    description ? { origin } : { origin: 'derived', note: 'transcript fallback' },
  );
  if (transcript) setProvenance('transcript', { origin });

  /* --- type ----------------------------------------------------------------- */
  let incidentType: IncidentType;
  if (isIncidentType(raw.incidentType)) {
    incidentType = raw.incidentType;
    setProvenance('incidentType', { origin });
  } else {
    const basis = `${description} ${transcript ?? ''}`;
    const classified = classifyText(basis);
    if (raw.incidentType != null && typeof raw.incidentType === 'string') {
      // The source gave us a type we do not recognise — try to map its text.
      const fromLabel = classifyText(raw.incidentType.toLowerCase());
      incidentType = fromLabel.type !== 'other' ? fromLabel.type : classified.type;
      warnings.push(`unknown-incident-type:${sanitizeText(raw.incidentType, 40)}`);
    } else {
      incidentType = classified.type;
    }
    setProvenance('incidentType', {
      origin: 'derived',
      note: 'keyword classification',
      confidence: incidentType === 'other' ? 0.3 : 0.7,
    });
  }

  /* --- severity ------------------------------------------------------------- */
  const hasSourceSeverity = raw.severity != null && raw.severity !== '';
  const severity = hasSourceSeverity
    ? coerceSeverity(raw.severity, INCIDENT_TYPE_META[incidentType].baseSeverity)
    : INCIDENT_TYPE_META[incidentType].baseSeverity;
  setProvenance('severity', hasSourceSeverity ? { origin } : { origin: 'derived', note: 'type baseline' });

  /* --- location ------------------------------------------------------------- */
  const label = sanitizeText(raw.locationLabel, TEXT_LIMITS.locationLabel);
  const area = sanitizeText(raw.area, TEXT_LIMITS.area) || null;
  const coordinates = validateCoordinates(raw.coordinates, region);
  if (raw.coordinates != null && !coordinates) {
    warnings.push('coordinates-rejected');
  }

  let precision = coercePrecision(raw.locationPrecision);
  if (!precision) {
    if (coordinates) precision = label ? 'block' : 'area';
    else precision = label ? 'area' : 'unknown';
  }
  // A point we did not validate cannot be called exact.
  if (!coordinates && precision === 'exact') precision = 'area';
  const approximate = precision !== 'exact';

  setProvenance('location', { origin: label ? origin : 'derived' });
  if (coordinates) setProvenance('coordinates', { origin });

  /* --- confidence ----------------------------------------------------------- */
  let confidence = coerceConfidence(raw.confidence, 0.6);
  if (!coordinates) confidence = Math.min(confidence, 0.65);
  if (incidentType === 'other') confidence = Math.min(confidence, 0.5);

  /* --- assemble ------------------------------------------------------------- */
  const id = raw.externalId
    ? `${source.id}:${sanitizeText(raw.externalId, 48)}`
    : `${source.id}:${randomUUID()}`;

  const candidate: Incident = {
    id,
    timestamp,
    ingestedAt: new Date(now).toISOString(),
    source: { id: source.id, name: source.name, kind: source.kind, url: source.url ?? null },
    incidentType,
    severity,
    description: description || sanitizeText(transcript, TEXT_LIMITS.description),
    location: {
      label: label || (area ? area : 'Location not specified'),
      approximate,
      precision,
      area,
    },
    coordinates,
    confidence,
    transcript,
    status: coerceStatus(raw.status, 'normalized'),
    provenance,
    tags: coerceTags(raw.tags),
    raw: raw.raw,
  };

  const parsed = incidentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `schema:${parsed.error.issues[0]?.path.join('.') ?? 'unknown'}`,
      warnings,
    };
  }

  return { ok: true, incident: candidate, warnings };
}

/** Merge extractor output into an incident without ever overwriting source-held fields. */
export function applyExtraction(
  incident: Incident,
  extraction: {
    incidentType: IncidentType | null;
    severity: Incident['severity'] | null;
    description: string | null;
    locationLabel: string | null;
    locationPrecision: LocationPrecision | null;
    area: string | null;
    confidence: number;
    extractorId: string;
  },
): Incident {
  const provenance: ProvenanceMap = { ...incident.provenance };
  const ai = (note: string): ProvenanceEntry => ({
    origin: 'ai-inferred',
    confidence: extraction.confidence,
    note,
  });
  const isFromSource = (field: keyof ProvenanceMap) =>
    provenance[field]?.origin === 'source' || provenance[field]?.origin === 'simulated';

  let incidentType = incident.incidentType;
  if (extraction.incidentType && !isFromSource('incidentType')) {
    incidentType = extraction.incidentType;
    provenance.incidentType = ai(extraction.extractorId);
  }

  let severity = incident.severity;
  if (extraction.severity && !isFromSource('severity')) {
    severity = extraction.severity;
    provenance.severity = ai(extraction.extractorId);
  }

  let description = incident.description;
  if (extraction.description && !isFromSource('description')) {
    description = sanitizeText(extraction.description, TEXT_LIMITS.description);
    provenance.description = ai(extraction.extractorId);
  }

  let location = incident.location;
  if (extraction.locationLabel && !isFromSource('location')) {
    const precision = extraction.locationPrecision ?? 'area';
    location = {
      label: sanitizeText(extraction.locationLabel, TEXT_LIMITS.locationLabel),
      // An extracted location is never exact: it was read out of prose.
      approximate: true,
      precision: precision === 'exact' ? 'block' : precision,
      area: extraction.area ? sanitizeText(extraction.area, TEXT_LIMITS.area) : incident.location.area,
    };
    provenance.location = ai(extraction.extractorId);
  }

  return {
    ...incident,
    incidentType,
    severity,
    description,
    location,
    provenance,
    confidence: Math.min(incident.confidence, Math.max(0.2, extraction.confidence)),
  };
}
