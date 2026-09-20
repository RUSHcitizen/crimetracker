import {
  classifyText,
  INCIDENT_TYPE_META,
  sanitizeText,
  TEXT_LIMITS,
  type ExtractionResult,
  type LocationPrecision,
  type SeverityLevel,
} from '@crimetracker/shared';
import type { ExtractionInput, IncidentExtractor } from './types.js';

/**
 * Local, dependency-free extractor.
 *
 * It is the default (no network, no API key, no data leaves the machine) and also the
 * fallback whenever a remote provider errors or times out. It is deliberately
 * conservative: it reports a location string only when it actually matched one, and it
 * never produces coordinates.
 */
export class HeuristicExtractor implements IncidentExtractor {
  readonly id = 'heuristic-v1';
  readonly label = 'Local heuristic parser';

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const transcript = input.transcript;
    const notes: string[] = [];

    const { type, matched } = classifyText(transcript);
    if (matched) notes.push(`matched phrase "${matched}"`);

    const location = extractLocation(transcript);
    if (location) notes.push(`location phrase "${location.label}"`);

    const severity = estimateSeverity(transcript, INCIDENT_TYPE_META[type].baseSeverity);

    // Confidence is a function of how much we actually recognised, never a flat number.
    let confidence = 0.25;
    if (matched) confidence += 0.3;
    if (location) confidence += 0.2;
    if (transcript.length > 80) confidence += 0.1;
    if (type === 'other') confidence = Math.min(confidence, 0.35);

    return {
      incidentType: type === 'other' && !matched ? null : type,
      severity: severity as SeverityLevel,
      description: summarize(transcript),
      locationLabel: location?.label ?? null,
      locationPrecision: location?.precision ?? null,
      area: null,
      // A text parser has no basis for a coordinate. Never guess one.
      coordinates: null,
      confidence: Math.round(Math.min(0.85, confidence) * 100) / 100,
      extractorId: this.id,
      notes,
    };
  }
}

const URGENCY_UP = [
  'shots fired',
  'in progress',
  'weapon',
  'multiple victims',
  'unresponsive',
  'cpr',
  'fully involved',
  'officer needs',
  'code red',
];
const URGENCY_DOWN = ['cold call', 'report only', 'no injuries', 'negative contact', 'unfounded'];

export function estimateSeverity(text: string, base: number): number {
  const lower = text.toLowerCase();
  let score = base;
  for (const phrase of URGENCY_UP) if (lower.includes(phrase)) score += 1;
  for (const phrase of URGENCY_DOWN) if (lower.includes(phrase)) score -= 1;
  return Math.min(5, Math.max(1, Math.round(score)));
}

const BLOCK_RE = /\b(\d{1,5})\s*(?:block(?:\s+of)?)\s+([A-Za-z0-9.\- ]{3,40})/i;
const INTERSECTION_RE = /\b([A-Za-z0-9.\- ]{3,30}?)\s+(?:and|at|&|\/)\s+([A-Za-z0-9.\- ]{3,30}?)(?=[,.;]|\s+for\b|\s+on\b|$)/i;
// Street names routinely contain digits ("4th Ave", "196th St SW"), so name tokens are
// alphanumeric — only the leading house number is digits-only.
const ADDRESS_RE = /\b(\d{1,5})\s+((?:[NSEW]{1,2}\s+)?[A-Za-z0-9][A-Za-z0-9.\-]*(?:\s+[A-Za-z0-9][A-Za-z0-9.\-]*){0,3}\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Way|Ln|Lane|Pl|Place|Ct|Court|Hwy|Highway|Pkwy|Parkway))\b/i;
const HIGHWAY_RE = /\b(I-\d{1,3}|US-\d{1,3}|SR-\d{1,3}|Highway\s+\d{1,3})\b/i;

/**
 * Pull a location phrase out of free text.
 *
 * Precision is graded honestly: a street address is `block`-level at best (we have not
 * geocoded it), an intersection or highway reference is `area`-level. Nothing here is
 * ever `exact`, because nothing here is a verified position.
 */
export function extractLocation(
  text: string,
): { label: string; precision: LocationPrecision } | null {
  const block = BLOCK_RE.exec(text);
  if (block) {
    return {
      label: sanitizeText(`${block[1]} block of ${block[2]}`, TEXT_LIMITS.locationLabel),
      precision: 'block',
    };
  }

  const address = ADDRESS_RE.exec(text);
  if (address) {
    return {
      label: sanitizeText(`${address[1]} ${address[2]}`, TEXT_LIMITS.locationLabel),
      precision: 'block',
    };
  }

  const highway = HIGHWAY_RE.exec(text);
  if (highway) {
    return { label: sanitizeText(highway[1] as string, TEXT_LIMITS.locationLabel), precision: 'area' };
  }

  const intersection = INTERSECTION_RE.exec(text);
  if (intersection && /\b(st|ave|blvd|rd|dr|way|ln|hwy|street|avenue)\b/i.test(intersection[0])) {
    return {
      label: sanitizeText(`${intersection[1]?.trim()} & ${intersection[2]?.trim()}`, TEXT_LIMITS.locationLabel),
      precision: 'area',
    };
  }

  return null;
}

/** First sentence, clamped — enough for a HUD line without inventing a summary. */
function summarize(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sanitizeText(firstSentence, TEXT_LIMITS.description);
}
