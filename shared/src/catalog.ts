import type { FeedFieldMap } from './feed.js';
import type { LocationPrecision } from './taxonomy.js';

/**
 * Catalogue of real, publicly published Washington incident feeds.
 *
 * The point of this file is that connecting real data should not require anyone to
 * hand-map a dozen column names. Pick an id, set `SOURCES=<id>`, done.
 *
 * Two honesty notes that shape every entry:
 *
 *  1. **`precision` describes what the publisher's coordinates actually mean.** Several
 *     agencies deliberately blur or round positions before release — Seattle PD publishes
 *     "blurred" call coordinates at block level on purpose. We record that as
 *     `block`/`area`, never `exact`, so the interface says APPROXIMATE LOCATION rather
 *     than implying a precision the source never claimed.
 *  2. **Column names drift.** Open-data publishers rename fields without notice, so each
 *     mapping lists candidates and `npm run probe:source -- <id>` prints exactly which
 *     one resolved against a live record. Verify before trusting a feed.
 *
 * Every endpoint here is published by the agency for public use. Check each dataset's own
 * terms and rate limits before running a poller against it continuously.
 */

export type FeedAdapter = 'socrata' | 'arcgis' | 'json';

export interface CatalogSource {
  readonly id: string;
  readonly name: string;
  readonly agency: string;
  readonly area: string;
  readonly adapter: FeedAdapter;
  readonly url: string;
  /** What this dataset actually contains, and its known caveats. */
  readonly note: string;
  /** Where the publisher documents the dataset and its terms. */
  readonly docsUrl: string;
  /** Required attribution, shown in the source panel. */
  readonly attribution: string;
  /** What the published coordinates really represent. */
  readonly precision: LocationPrecision;
  /** Field used for incremental polling and ordering. */
  readonly timeField: string;
  readonly map: FeedFieldMap;
  /** Typical publication lag, for the HUD to state plainly. */
  readonly latency: string;
}

export const SOURCE_CATALOG: readonly CatalogSource[] = [
  {
    id: 'seattle-fire-911',
    name: 'Seattle Fire 911 Dispatch',
    agency: 'Seattle Fire Department',
    area: 'Seattle',
    adapter: 'socrata',
    url: 'https://data.seattle.gov/resource/kzjm-xkqj.json',
    note:
      'Live fire and medical 911 dispatches. Updated continuously, usually within minutes ' +
      'of dispatch. Addresses are published at street-address level.',
    docsUrl: 'https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj',
    attribution: 'City of Seattle Open Data',
    precision: 'block',
    timeField: 'datetime',
    map: {
      id: ['incident_number', 'cad_number'],
      timestamp: ['datetime', 'date'],
      type: ['type'],
      description: ['type'],
      location: ['address'],
      lat: ['latitude'],
      lon: ['longitude'],
    },
    latency: 'minutes',
  },
  {
    id: 'seattle-police-calls',
    name: 'Seattle Police Call Data',
    agency: 'Seattle Police Department',
    area: 'Seattle',
    adapter: 'socrata',
    url: 'https://data.seattle.gov/resource/33kz-ixgy.json',
    note:
      'Police dispatch calls for service. SPD deliberately blurs the published coordinates ' +
      'to roughly block level, so positions are approximate by design, not by accident. ' +
      'Publication lags dispatch by hours.',
    docsUrl: 'https://data.seattle.gov/Public-Safety/Call-Data/33kz-ixgy',
    attribution: 'City of Seattle Open Data / Seattle Police Department',
    precision: 'block',
    timeField: 'cad_event_original_time_queued',
    map: {
      id: ['cad_event_number', 'cad_event_clearance_code'],
      timestamp: [
        'cad_event_original_time_queued',
        'original_time_queued',
        'cad_event_arrived_time',
      ],
      type: ['initial_call_type', 'final_call_type', 'call_type'],
      description: ['final_call_type', 'initial_call_type', 'call_type'],
      location: ['blurred_address', 'hundred_block_location', 'precinct'],
      lat: ['blurred_latitude', 'latitude'],
      lon: ['blurred_longitude', 'longitude'],
    },
    latency: 'hours',
  },
  {
    id: 'seattle-crime-reports',
    name: 'Seattle Police Crime Reports',
    agency: 'Seattle Police Department',
    area: 'Seattle',
    adapter: 'socrata',
    url: 'https://data.seattle.gov/resource/tazs-3rd5.json',
    note:
      'Offense reports classified to NIBRS. This is reported crime after the fact, not live ' +
      'dispatch: records appear days to weeks later and are revised. Useful for history and ' +
      'patterns, misleading if read as current activity.',
    docsUrl: 'https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5',
    attribution: 'City of Seattle Open Data / Seattle Police Department',
    precision: 'area',
    timeField: 'offense_start_datetime',
    map: {
      id: ['report_number', 'offense_id'],
      timestamp: ['offense_start_datetime', 'report_datetime'],
      type: ['offense', 'offense_parent_group'],
      description: ['offense', 'offense_parent_group'],
      location: ['_100_block_address', 'mcpp', 'neighborhood'],
      lat: ['latitude'],
      lon: ['longitude'],
    },
    latency: 'days',
  },
];

export function findCatalogSource(
  id: string,
  overrideUrl?: string | null,
): CatalogSource | undefined {
  const source = SOURCE_CATALOG.find((entry) => entry.id === id.trim().toLowerCase());
  if (!source) return undefined;
  // Lets a catalogued source be pointed at a mirror, a cached copy or a local stub
  // without forking the entry. Everything else about the source is unchanged.
  return overrideUrl ? { ...source, url: overrideUrl } : source;
}

export function catalogIds(): string[] {
  return SOURCE_CATALOG.map((source) => source.id);
}

/**
 * Build the request URL for a poll.
 *
 * Each adapter has its own dialect for "give me the newest records since X". Doing this
 * properly matters: without it a poller either re-downloads the whole dataset every
 * minute or silently reads a stale page.
 */
export function buildPollUrl(
  source: CatalogSource,
  options: { since?: string | null; limit?: number } = {},
): string {
  const limit = options.limit ?? 200;
  const url = new URL(source.url);

  switch (source.adapter) {
    case 'socrata': {
      url.searchParams.set('$limit', String(limit));
      url.searchParams.set('$order', `${source.timeField} DESC`);
      if (options.since) {
        // Socrata floating timestamps have no zone suffix.
        url.searchParams.set('$where', `${source.timeField} > '${toFloating(options.since)}'`);
      }
      return url.toString();
    }
    case 'arcgis': {
      url.searchParams.set('f', 'json');
      url.searchParams.set('outFields', '*');
      url.searchParams.set('returnGeometry', 'true');
      // Always ask for WGS84 so the coordinate validator sees lat/lon, not web mercator.
      url.searchParams.set('outSR', '4326');
      url.searchParams.set('resultRecordCount', String(limit));
      url.searchParams.set('orderByFields', `${source.timeField} DESC`);
      url.searchParams.set(
        'where',
        options.since
          ? `${source.timeField} > TIMESTAMP '${toFloating(options.since).replace('T', ' ')}'`
          : '1=1',
      );
      return url.toString();
    }
    default:
      return url.toString();
  }
}

function toFloating(iso: string): string {
  return iso.replace(/\.\d+Z$/, '').replace(/Z$/, '');
}
