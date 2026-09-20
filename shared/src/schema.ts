import { z } from 'zod';
import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  LOCATION_PRECISIONS,
  PROVENANCE_ORIGINS,
  SOURCE_KINDS,
} from './taxonomy.js';

/** Maximum characters we retain for free-text fields coming from outside. */
export const TEXT_LIMITS = {
  description: 600,
  locationLabel: 180,
  area: 80,
  transcript: 6000,
  tag: 40,
  query: 200,
} as const;

/**
 * Strip control characters and normalize whitespace before anything is stored or
 * rendered. External text is treated as hostile: no markup survives, no zero-width or
 * bidi-override characters survive, and length is capped.
 */
export function sanitizeText(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  const withoutControls = input
    // C0/C1 controls (keep nothing — newlines are normalized to spaces below)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // zero-width + bidi overrides, which can disguise text in a readout
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutControls.slice(0, maxLength);
}

/** Same as `sanitizeText`, but paragraph breaks are preserved (used for transcripts). */
export function sanitizeMultiline(input: unknown, maxLength: number): string {
  if (typeof input !== 'string') return '';
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export const coordinatesSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});

export const sourceRefSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  kind: z.enum(SOURCE_KINDS),
  url: z.string().url().max(500).nullable().optional(),
});

export const provenanceEntrySchema = z.object({
  origin: z.enum(PROVENANCE_ORIGINS),
  confidence: z.number().min(0).max(1).optional(),
  note: z.string().max(200).optional(),
});

export const provenanceMapSchema = z.record(
  z.enum(['incidentType', 'severity', 'description', 'location', 'coordinates', 'timestamp', 'transcript']),
  provenanceEntrySchema,
);

export const incidentLocationSchema = z.object({
  label: z.string().max(TEXT_LIMITS.locationLabel),
  approximate: z.boolean(),
  precision: z.enum(LOCATION_PRECISIONS),
  area: z.string().max(TEXT_LIMITS.area).nullable(),
});

export const incidentSchema = z.object({
  id: z.string().min(1).max(80),
  timestamp: z.string().datetime({ offset: true }),
  ingestedAt: z.string().datetime({ offset: true }),
  source: sourceRefSchema,
  incidentType: z.enum(INCIDENT_TYPES),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  description: z.string().max(TEXT_LIMITS.description),
  location: incidentLocationSchema,
  coordinates: coordinatesSchema.nullable(),
  confidence: z.number().min(0).max(1),
  transcript: z.string().max(TEXT_LIMITS.transcript).nullable(),
  status: z.enum(INCIDENT_STATUSES),
  provenance: provenanceMapSchema,
  tags: z.array(z.string().max(TEXT_LIMITS.tag)).max(12),
  raw: z.unknown().optional(),
});

/** Output shape required from an `IncidentExtractor` (including an LLM). */
export const extractionResultSchema = z.object({
  incidentType: z.enum(INCIDENT_TYPES).nullable(),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullable(),
  description: z.string().max(TEXT_LIMITS.description).nullable(),
  locationLabel: z.string().max(TEXT_LIMITS.locationLabel).nullable(),
  locationPrecision: z.enum(LOCATION_PRECISIONS).nullable(),
  area: z.string().max(TEXT_LIMITS.area).nullable(),
  coordinates: coordinatesSchema.nullable(),
  confidence: z.number().min(0).max(1),
  extractorId: z.string().max(64),
  notes: z.array(z.string().max(200)).max(10),
});

/** Loose schema for what an LLM returns before we coerce it. */
export const llmExtractionSchema = z.object({
  incident_type: z.string().nullish(),
  severity: z.union([z.number(), z.string()]).nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  location_precision: z.string().nullish(),
  area: z.string().nullish(),
  confidence: z.union([z.number(), z.string()]).nullish(),
  notes: z.array(z.string()).nullish(),
});

const csv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export const incidentQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((v) => (v ? csv(v).filter((t): t is (typeof INCIDENT_TYPES)[number] => (INCIDENT_TYPES as readonly string[]).includes(t)) : undefined)),
  minSeverity: z.coerce.number().min(1).max(5).optional(),
  sources: z
    .string()
    .optional()
    .transform((v) => (v ? csv(v).slice(0, 20) : undefined)),
  sinceMinutes: z.coerce.number().min(1).max(60 * 24 * 90).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  bbox: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const parts = v.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
      return parts as [number, number, number, number];
    }),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.05).max(2000).optional(),
  q: z
    .string()
    .max(TEXT_LIMITS.query)
    .optional()
    .transform((v) => (v ? sanitizeText(v, TEXT_LIMITS.query) : undefined)),
  limit: z.coerce.number().min(1).max(5000).optional(),
  offset: z.coerce.number().min(0).max(1_000_000).optional(),
});

export const modeSchema = z.object({ mode: z.enum(['live', 'simulation']) });

/**
 * Parse a timestamp from an untrusted source.
 *
 * Accepts ISO strings, epoch seconds and epoch milliseconds. Rejects anything
 * unparseable, absurdly old (pre-2000) or more than `futureToleranceMs` ahead of now —
 * a bad clock upstream should not push incidents to the front of the stream forever.
 */
export function parseTimestamp(
  input: unknown,
  now: number = Date.now(),
  futureToleranceMs = 5 * 60_000,
): string | null {
  let ms: number | null = null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    // Heuristic: values below 1e11 are seconds, above are milliseconds.
    ms = input < 1e11 ? input * 1000 : input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      ms = n < 1e11 ? n * 1000 : n;
    } else {
      // Microsoft's ASP.NET JSON date, e.g. `/Date(1699999999000-0800)/`. WSDOT's
      // traveler-information API still emits it, and `Date.parse` cannot read it. The
      // number is already epoch UTC milliseconds; the trailing offset is only the
      // publisher's local zone, so it must not be applied a second time.
      const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(trimmed);
      if (dotNet) {
        ms = Number(dotNet[1]);
      } else {
        const parsed = Date.parse(trimmed);
        ms = Number.isNaN(parsed) ? null : parsed;
      }
    }
  } else if (input instanceof Date) {
    ms = input.getTime();
  }

  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms < Date.UTC(2000, 0, 1)) return null;
  if (ms > now + futureToleranceMs) return null;
  return new Date(ms).toISOString();
}
