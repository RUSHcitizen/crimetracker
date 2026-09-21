import { parseTimestamp, sanitizeText } from './schema.js';
import { resolveField, type FeedField } from './feed.js';

/**
 * OpenMHz — archived public radio calls.
 *
 * OpenMHz aggregates recordings made by community-run trunk-recorder receivers and
 * publishes them as discrete *calls*: each one a short audio clip with a talkgroup, a
 * start time and a duration. That shape is considerably better for this project than a
 * live scanner stream, for three reasons:
 *
 *   - each call already carries an exact timestamp, so nothing has to be inferred from
 *     where a byte landed in a buffer;
 *   - each call names its talkgroup, which identifies the agency and usually the
 *     district — the only non-inferred location signal radio traffic ever offers;
 *   - calls are discrete and identified, so deduplication is exact and only the audio
 *     that is actually new is ever fetched.
 *
 * **On encryption.** Nothing here decodes anything. A trunk-recorder receives what is
 * broadcast in the clear; encrypted talkgroups produce no intelligible audio and are not
 * published. So this reads already-public recordings of already-unencrypted traffic, and
 * the project's rule against touching encrypted communications is untouched by it. Much
 * of Puget Sound law-enforcement dispatch *is* encrypted and simply will not appear.
 *
 * **On radio identifiers.** Call metadata includes `srcList` — the radio IDs of the units
 * that transmitted. This module drops that field and never exposes it. A radio ID is a
 * persistent identifier for a specific unit, and retaining it across calls would build
 * exactly the movement history of identifiable people that this project refuses to build.
 * See the README's *Out of scope*.
 */

/** An OpenMHz system to poll, as named in the site's own URL: openmhz.com/system/<id>. */
export interface OpenMhzSystem {
  readonly shortName: string;
  readonly apiBase: string;
  /**
   * Talkgroup numbers to keep. Empty means everything the system publishes.
   *
   * Applied client-side as the guarantee, and passed upstream as an optimisation — so a
   * filter the API ignores or spells differently narrows bandwidth at worst, never
   * correctness.
   */
  readonly talkgroups: readonly number[];
}

/** One archived call. `srcList` is deliberately absent — see the module note. */
export interface RadioCall {
  readonly id: string;
  readonly shortName: string;
  readonly talkgroup: number;
  /** ISO 8601 UTC. */
  readonly startedAt: string;
  readonly durationSeconds: number;
  readonly audioUrl: string;
  readonly frequencyHz: number | null;
}

/** Talkgroup metadata, used to label an agency and area without inferring anything. */
export interface TalkgroupInfo {
  readonly num: number;
  readonly label: string;
  readonly description: string | null;
  readonly group: string | null;
}

export const DEFAULT_OPENMHZ_API_BASE = 'https://api.openmhz.com';

/** `+` is the documented one; the others are accepted for a spec passed on its own. */
const TALKGROUP_SEPARATORS = /[+,;]/;

/**
 * Hosts OpenMHz audio may be fetched from.
 *
 * OpenMHz has served call audio from its own domain and from object storage at different
 * times. Both are listed; anything else is refused rather than fetched, because these
 * URLs arrive inside feed records and are fetched server-side.
 */
export const DEFAULT_OPENMHZ_AUDIO_HOSTS: readonly string[] = [
  'openmhz.com',
  'amazonaws.com',
];

/*
 * Field candidates. As everywhere else in this project, the mapping lists alternatives
 * rather than one path: OpenMHz is a volunteer-run service whose payload has changed
 * shape before, and a source that silently maps to nothing is worse than one that fails
 * loudly. `npm run probe:openmhz -- <system>` prints which candidate actually resolved.
 */
const CALL_ID: FeedField = ['_id', 'id', 'callId'];
const CALL_TALKGROUP: FeedField = ['talkgroupNum', 'talkgroup', 'talkgroup_num', 'tg'];
const CALL_TIME: FeedField = ['time', 'start_time', 'startTime', 'timestamp'];
const CALL_LENGTH: FeedField = ['len', 'length', 'duration', 'call_length'];
const CALL_URL: FeedField = ['url', 'audioUrl', 'm4a', 'filename'];
const CALL_FREQ: FeedField = ['freq', 'frequency'];

const TG_NUM: FeedField = ['num', 'number', 'talkgroupNum', 'decimal'];
const TG_LABEL: FeedField = ['alphaTag', 'alpha_tag', 'tag', 'name'];
const TG_DESCRIPTION: FeedField = ['description', 'desc'];
const TG_GROUP: FeedField = ['group', 'category', 'groupTag'];

/**
 * Parse a source spec.
 *
 *   openmhz:psern025              every talkgroup the system publishes
 *   openmhz:psern025/1103+1104    only these talkgroups
 *
 * The short name is the last path segment of the system's page on openmhz.com, so
 * `https://openmhz.com/system/psern025` becomes `openmhz:psern025`.
 *
 * Talkgroups are separated by `+` because `SOURCES` is itself a comma-separated list: a
 * comma here would split the spec in half and silently poll every talkgroup. `,` and `;`
 * are accepted too, for a spec passed on its own (the probe script takes one), and
 * `TALKGROUP_SEPARATORS` is what the registry uses to recognise the mistake and say so.
 */
export function parseOpenMhzSpec(
  spec: string,
  apiBase: string = DEFAULT_OPENMHZ_API_BASE,
): OpenMhzSystem | undefined {
  const trimmed = spec.trim();
  if (!trimmed.toLowerCase().startsWith('openmhz:')) return undefined;

  const rest = trimmed.slice('openmhz:'.length);
  if (!rest) return undefined;

  const [rawName, rawTalkgroups = ''] = splitOnce(rest, '/');
  const shortName = rawName.trim();
  // Short names appear in a URL path; keep them to the character set OpenMHz itself uses.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(shortName)) return undefined;

  const talkgroups: number[] = [];
  for (const part of rawTalkgroups.split(TALKGROUP_SEPARATORS)) {
    const value = part.trim();
    if (!value) continue;
    const num = Number(value);
    // A non-numeric talkgroup would silently widen the filter to everything.
    if (!Number.isInteger(num) || num < 0 || num > 1e9) return undefined;
    if (!talkgroups.includes(num)) talkgroups.push(num);
  }

  return { shortName, apiBase: apiBase.replace(/\/$/, ''), talkgroups };
}

/** Stable id for the source, matching the spec the operator wrote. */
export function openMhzSourceId(system: OpenMhzSystem): string {
  return system.talkgroups.length > 0
    ? `openmhz:${system.shortName}/${system.talkgroups.join('+')}`
    : `openmhz:${system.shortName}`;
}

export function openMhzSystemUrl(system: OpenMhzSystem): string {
  return `https://openmhz.com/system/${system.shortName}`;
}

/**
 * URL for a page of calls.
 *
 * `time`/`direction` are how OpenMHz pages its archive. They are sent as an optimisation
 * only: the adapter's own watermark and dedup set decide what is new, so an API that
 * ignores or renames these still yields correct behaviour, just a larger page.
 */
export function buildCallsUrl(
  system: OpenMhzSystem,
  options: { since?: string | null } = {},
): string {
  const url = new URL(`${system.apiBase}/${encodeURIComponent(system.shortName)}/calls`);
  if (options.since) {
    const ms = Date.parse(options.since);
    if (Number.isFinite(ms)) {
      url.searchParams.set('time', String(ms));
      url.searchParams.set('direction', 'newer');
    }
  }
  if (system.talkgroups.length > 0) {
    url.searchParams.set('filter-type', 'talkgroup');
    url.searchParams.set('filter-code', system.talkgroups.join(','));
  }
  // (The upstream filter uses commas; only the *spec* separator is `+`.)
  return url.toString();
}

export function buildTalkgroupsUrl(system: OpenMhzSystem): string {
  return `${system.apiBase}/${encodeURIComponent(system.shortName)}/talkgroups`;
}

/** Pull the call array out of whichever envelope the service returns it in. */
export function extractCalls(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['calls', 'results', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export function extractTalkgroups(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['talkgroups', 'results', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export interface CallMapOptions {
  readonly shortName: string;
  /** Hosts the audio URL may point at. */
  readonly audioHosts?: readonly string[];
  readonly now?: number;
}

/**
 * Project one OpenMHz call record onto `RadioCall`.
 *
 * Returns `null` for anything unusable — a record we cannot place in time, cannot
 * identify, or whose audio lives somewhere we will not fetch from. `srcList` is never
 * read.
 */
export function mapOpenMhzCall(record: unknown, options: CallMapOptions): RadioCall | null {
  if (!record || typeof record !== 'object') return null;

  const id = sanitizeText(stringify(resolveField(record, CALL_ID)), 64);
  if (!id) return null;

  const talkgroup = numberOf(resolveField(record, CALL_TALKGROUP));
  if (talkgroup === null) return null;

  const startedAt = parseTimestamp(resolveField(record, CALL_TIME), options.now);
  // A call we cannot place in time is useless on a time-filtered map.
  if (!startedAt) return null;

  const rawUrl = resolveField(record, CALL_URL);
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  // Shape only: the server applies the real allow-list through `assertFetchableMediaUrl`
  // before fetching. This keeps obviously-wrong records out of the queue.
  if (!/^https:\/\//i.test(rawUrl)) return null;

  const duration = numberOf(resolveField(record, CALL_LENGTH));
  const frequency = numberOf(resolveField(record, CALL_FREQ));

  return {
    id,
    shortName: options.shortName,
    talkgroup,
    startedAt,
    durationSeconds: duration !== null && duration > 0 ? Math.min(duration, 3600) : 0,
    audioUrl: rawUrl,
    frequencyHz: frequency !== null && frequency > 0 ? frequency : null,
  };
}

export function mapOpenMhzTalkgroup(record: unknown): TalkgroupInfo | null {
  if (!record || typeof record !== 'object') return null;
  const num = numberOf(resolveField(record, TG_NUM));
  if (num === null) return null;

  const label = sanitizeText(stringify(resolveField(record, TG_LABEL)), 64);
  const description = sanitizeText(stringify(resolveField(record, TG_DESCRIPTION)), 120);
  const group = sanitizeText(stringify(resolveField(record, TG_GROUP)), 64);

  return {
    num,
    label: label || description || group || `Talkgroup ${num}`,
    description: description || null,
    group: group || null,
  };
}

/** Index talkgroup metadata by number, for labelling calls. */
export function indexTalkgroups(body: unknown): Map<number, TalkgroupInfo> {
  const index = new Map<number, TalkgroupInfo>();
  for (const record of extractTalkgroups(body)) {
    const info = mapOpenMhzTalkgroup(record);
    if (info) index.set(info.num, info);
  }
  return index;
}

/**
 * The human label for a call's talkgroup.
 *
 * This is the one piece of place information radio traffic gives without inference: the
 * talkgroup an agency assigned, as that agency named it. It is recorded as `derived` —
 * it comes from the source's own metadata, not from a model reading a transcript — and it
 * never becomes a coordinate.
 */
export function describeTalkgroup(
  call: RadioCall,
  talkgroups: ReadonlyMap<number, TalkgroupInfo>,
): { label: string; area: string | null } {
  const info = talkgroups.get(call.talkgroup);
  if (!info) return { label: `Talkgroup ${call.talkgroup}`, area: null };
  return {
    label: info.description ? `${info.label} — ${info.description}` : info.label,
    area: info.group ?? info.label ?? null,
  };
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
