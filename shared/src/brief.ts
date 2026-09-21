import { INCIDENT_TYPE_META, SEVERITY_LABEL } from './taxonomy.js';
import type { Incident } from './types.js';

/**
 * Compose a short spoken-form account of one incident, deterministically.
 *
 * Agency data is written for dispatchers, not readers: `BURGLARY - IN PROGRESS`,
 * `1500 BLOCK OF 3RD AVE`, `EventCategory: Collision`. This turns that into something a
 * person can listen to while looking at the map.
 *
 * It adds **no facts**. Every clause is a field of the incident, restated in prose — no
 * cause, no suspect, no outcome, no severity the record did not carry. Those would be
 * assertions about real events and, often enough, about real people.
 *
 * It lives in shared so the Node server and the Worker word a brief identically, and so
 * the wording can be tested without constructing a generator.
 */
/** Pure, and exported so the exact wording can be tested without a generator. */
export function composeBrief(incident: Incident, now = Date.now()): string {
  const meta = INCIDENT_TYPE_META[incident.incidentType];
  const when = spokenRelative(incident.timestamp, now);
  const sentences: string[] = [];

  /* --- what, and where ----------------------------------------------------- */
  const place = placePhrase(incident);
  sentences.push(
    `${article(meta.label)} ${meta.label.toLowerCase()} report${place ? ` ${place}` : ''}, ${when}.`,
  );

  /* --- what the source actually said --------------------------------------- */
  // The publisher's own words, not a paraphrase of them.
  const description = incident.description.trim();
  if (description && description.toLowerCase() !== meta.label.toLowerCase()) {
    sentences.push(`Reported as: ${sentenceCase(description)}`);
  }

  /* --- how precise, and how sure ------------------------------------------- */
  const caveats: string[] = [];
  if (!incident.coordinates) {
    caveats.push('no position was published for this record, so it is not plotted');
  } else if (incident.location.approximate) {
    caveats.push(
      incident.location.precision === 'area'
        ? 'the position is area-level only'
        : 'the position is approximate, to about block level',
    );
  }
  // Any category the publisher did not itself state — whether a model or the keyword
  // classifier produced it. Both are this system's reading of the text, not the agency's.
  if (incident.provenance.incidentType && incident.provenance.incidentType.origin !== 'source') {
    caveats.push('the category was inferred from the text rather than stated by the source');
  }
  if (incident.confidence < 0.5) {
    caveats.push('overall confidence in this record is low');
  }
  if (caveats.length > 0) sentences.push(`Note that ${joinClauses(caveats)}.`);

  /* --- provenance ----------------------------------------------------------- */
  sentences.push(
    `Severity ${incident.severity} of 5, ${SEVERITY_LABEL[incident.severity].toLowerCase()}. ` +
      `Source: ${incident.source.name}.`,
  );

  return sentences.join(' ');
}

function placePhrase(incident: Incident): string {
  const label = incident.location.label.trim();
  if (!label || label === 'Location not specified') {
    return incident.location.area ? `in ${incident.location.area}` : '';
  }
  /*
   * "at" for a specific place, "in" for a named area. A digit or an ampersand is the
   * reliable signal: block numbers, mileposts, route numbers and intersections all carry
   * one, and bare place names ("Seattle", "King County Sheriff North Dispatch") do not.
   */
  const specific = /\d/.test(label) || label.includes('&');
  return `${specific ? 'at' : 'in'} ${label}`;
}

/**
 * Elapsed time in words.
 *
 * The HUD's `formatRelative` is built for a dense readout and produces "5m", "2h" — which
 * a speech synthesiser reads as "five em". A brief is meant to be listened to, so it
 * spells the unit out.
 */
export function spokenRelative(timestamp: string, now: number): string {
  const ms = now - Date.parse(timestamp);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  // Floor for minutes: 30 seconds is "just now", not "a minute ago". Hours and days
  // round, where being off by a few minutes does not matter.
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes === 1) return 'a minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours === 1) return 'about an hour ago';
  if (hours < 24) return `about ${hours} hours ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'about a day ago' : `about ${days} days ago`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'An' : 'A';
}

function sentenceCase(text: string): string {
  const trimmed = text.trim();
  // Agency text is frequently SHOUTED; lower-casing it makes it speakable.
  const body = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
  const cased = body.charAt(0).toUpperCase() + body.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

function joinClauses(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
