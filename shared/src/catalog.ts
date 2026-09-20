import type { FeedFieldMap } from './feed.js';
import type { LocationPrecision } from './taxonomy.js';

/**
 * Catalogue of real, publicly published incident feeds covering Washington.
 *
 * The point of this file is that connecting real data should not require anyone to
 * hand-map a dozen column names. Pick an id, set `SOURCES=<id>`, done.
 *
 * Three honesty notes that shape every entry:
 *
 *  1. **`precision` describes what the publisher's coordinates actually mean.** Several
 *     agencies deliberately blur or round positions before release — Seattle PD publishes
 *     "blurred" call coordinates at block level on purpose, and a weather warning covers a
 *     polygon rather than a point. We record that as `block`/`area`, never `exact`, so the
 *     interface says APPROXIMATE LOCATION rather than implying a precision the source
 *     never claimed.
 *  2. **Column names drift.** Open-data publishers rename fields without notice, so each
 *     mapping lists candidates and `npm run probe:source -- <id>` prints exactly which
 *     one resolved against a live record. Verify before trusting a feed.
 *  3. **`latency` is part of the data.** An offence report filed last week and a call
 *     dispatched two minutes ago must not look alike on a live map, so every entry states
 *     its publication lag and the HUD repeats it.
 *
 * Every endpoint here is published by the agency for public use, and none of them requires
 * defeating a control to read: the one credential in the catalogue is WSDOT's free,
 * self-issued access code, which the agency hands out precisely so that public traveller
 * data can be re-used. Check each dataset's own terms and rate limits before running a
 * poller against it continuously.
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
  /**
   * Environment variable holding this publisher's access key, when it issues one.
   *
   * The key is read server-side and appended to the poll URL at request time. It is never
   * part of `url`, never stored in the catalogue, and never reaches the browser — the
   * source descriptor the client sees carries the bare endpoint.
   */
  readonly keyEnv?: string;
  /** Query parameter the key is passed in. */
  readonly keyParam?: string;
  /** `json` adapter only: query parameter accepting an ISO lower bound, if supported. */
  readonly sinceParam?: string;
  /** `json` adapter only: query parameter capping the page size, if supported. */
  readonly limitParam?: string;
}

export const SOURCE_CATALOG: readonly CatalogSource[] = [
  /* ------------------------------ Seattle ------------------------------ */
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

  /* ---------------------------- Statewide ------------------------------ */
  {
    id: 'wsdot-highway-alerts',
    name: 'WSDOT Highway Alerts',
    agency: 'Washington State Department of Transportation',
    area: 'Washington State',
    adapter: 'json',
    url: 'https://www.wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson',
    note:
      'Statewide roadway incidents: collisions, closures, debris, police activity and ' +
      'construction, positioned by route and milepost. The broadest genuinely real-time ' +
      'public incident feed for Washington. Requires a free WSDOT access code.',
    docsUrl: 'https://wsdot.wa.gov/traffic/api/',
    attribution: 'Washington State Department of Transportation',
    // Milepost-level on a named route: good, but not a street address.
    precision: 'block',
    timeField: 'StartTime',
    keyEnv: 'WSDOT_ACCESS_CODE',
    keyParam: 'AccessCode',
    map: {
      id: ['AlertID'],
      timestamp: ['StartTime', 'LastUpdatedTime'],
      type: ['EventCategory'],
      description: ['HeadlineDescription', 'ExtendedDescription', 'EventCategory'],
      location: ['StartRoadwayLocation.Description', 'County', 'Region'],
      lat: ['StartRoadwayLocation.Latitude', 'EndRoadwayLocation.Latitude'],
      lon: ['StartRoadwayLocation.Longitude', 'EndRoadwayLocation.Longitude'],
    },
    latency: 'minutes',
  },
  {
    id: 'nws-alerts-wa',
    name: 'NWS Active Weather Alerts (WA)',
    agency: 'National Weather Service',
    area: 'Washington State',
    adapter: 'json',
    url: 'https://api.weather.gov/alerts/active?area=WA',
    note:
      'Active warnings, watches and advisories for Washington: flooding, severe storms, ' +
      'fire weather, winter conditions. Each alert covers an AREA — where a polygon is ' +
      'published we plot its centre of area, and many alerts are zone-based with no ' +
      'geometry at all, so they appear in the stream without a position.',
    docsUrl: 'https://www.weather.gov/documentation/services-web-api',
    attribution: 'NOAA / National Weather Service',
    precision: 'area',
    timeField: 'sent',
    map: {
      id: ['id'],
      timestamp: ['sent', 'effective', 'onset'],
      type: ['event'],
      description: ['headline', 'event'],
      location: ['areaDesc', 'senderName'],
      // Position comes from the feature's own polygon, not from columns.
      lat: [],
      lon: [],
    },
    latency: 'seconds',
  },
  {
    id: 'usgs-earthquakes-wa',
    name: 'USGS Earthquakes (WA region)',
    agency: 'United States Geological Survey',
    area: 'Washington State',
    adapter: 'json',
    url:
      'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson' +
      '&minlatitude=45.5&maxlatitude=49.1&minlongitude=-124.9&maxlongitude=-116.9' +
      '&orderby=time',
    note:
      'Seismic events inside the Washington bounding box, published within minutes of ' +
      'detection. Epicentres are instrument-derived estimates with real uncertainty, so ' +
      'they are treated as approximate rather than exact points.',
    docsUrl: 'https://earthquake.usgs.gov/fdsnws/event/1/',
    attribution: 'U.S. Geological Survey Earthquake Hazards Program',
    precision: 'block',
    timeField: 'time',
    sinceParam: 'starttime',
    limitParam: 'limit',
    map: {
      id: ['code', 'ids', 'net'],
      timestamp: ['time', 'updated'],
      type: ['type'],
      description: ['title', 'place'],
      location: ['place'],
      // Position comes from the GeoJSON point geometry.
      lat: [],
      lon: [],
    },
    latency: 'minutes',
  },
];

/**
 * Open-data portals that publish Washington public-safety data.
 *
 * These are listed rather than catalogued because a portal is stable but an individual
 * dataset id is not: agencies retire and re-publish datasets regularly. Find the dataset
 * you want on the portal, then connect it with an ad-hoc source spec (see
 * `parseSourceSpec`) and confirm the column mapping with `npm run probe:source`. Shipping
 * a guessed dataset id would look like a working source and quietly return nothing.
 */
export interface DataPortal {
  readonly host: string;
  readonly name: string;
  readonly kind: 'socrata' | 'arcgis';
  readonly example: string;
}

export const WA_DATA_PORTALS: readonly DataPortal[] = [
  {
    host: 'data.seattle.gov',
    name: 'City of Seattle Open Data',
    kind: 'socrata',
    example: 'socrata:data.seattle.gov/kzjm-xkqj',
  },
  {
    host: 'data.wa.gov',
    name: 'Washington State Open Data',
    kind: 'socrata',
    example: 'socrata:data.wa.gov/<dataset-id>',
  },
  {
    host: 'data.kingcounty.gov',
    name: 'King County Open Data',
    kind: 'socrata',
    example: 'socrata:data.kingcounty.gov/<dataset-id>',
  },
  {
    host: 'data.cityoftacoma.org',
    name: 'City of Tacoma Open Data',
    kind: 'socrata',
    example: 'socrata:data.cityoftacoma.org/<dataset-id>',
  },
  {
    host: 'data.bellevuewa.gov',
    name: 'City of Bellevue Open Data',
    kind: 'socrata',
    example: 'socrata:data.bellevuewa.gov/<dataset-id>',
  },
  {
    host: 'geo.wa.gov',
    name: 'Washington State Geospatial Portal (ArcGIS Hub)',
    kind: 'arcgis',
    example: 'arcgis:https://services.arcgis.com/<org>/ArcGIS/rest/services/<layer>/FeatureServer/0',
  },
];

/**
 * Field candidates for a feed nobody has mapped yet.
 *
 * Public-safety datasets across US portals reuse a small vocabulary of column names, so a
 * generic mapping resolves most of them on the first try. It is a starting point, not a
 * guarantee: `npm run probe:source` reports which candidate actually matched, and any
 * field it reports as NO MATCH needs a catalogue entry of its own.
 */
export const GENERIC_PUBLIC_SAFETY_MAP: FeedFieldMap = {
  id: [
    'incident_number',
    'incident_id',
    'case_number',
    'report_number',
    'event_number',
    'cad_event_number',
    'call_number',
    'event_id',
    'objectid',
    'OBJECTID',
    'id',
  ],
  timestamp: [
    'datetime',
    'date',
    'incident_datetime',
    'occurred_date',
    'occurred_datetime',
    'report_datetime',
    'offense_start_datetime',
    'call_datetime',
    'event_datetime',
    'received_date',
    'date_time',
    'start_time',
    'created_date',
    'time',
  ],
  type: [
    'incident_type',
    'call_type',
    'initial_call_type',
    'final_call_type',
    'offense',
    'offense_description',
    'event_category',
    'crime_type',
    'nature',
    'category',
    'type',
  ],
  description: [
    'description',
    'final_call_type',
    'initial_call_type',
    'offense',
    'narrative',
    'headline',
    'incident_type',
    'nature',
    'type',
  ],
  location: [
    'address',
    'block_address',
    'hundred_block_location',
    '_100_block_address',
    'blurred_address',
    'street',
    'block',
    'location_description',
    'neighborhood',
    'mcpp',
    'district',
    'city',
  ],
  // `x`/`y` are included last on purpose: many ArcGIS tables carry them in web mercator
  // metres, which `validateCoordinates` rejects outright rather than plotting wrongly.
  lat: ['latitude', 'lat', 'blurred_latitude', 'Latitude', 'LATITUDE', 'y'],
  lon: ['longitude', 'lon', 'lng', 'long', 'blurred_longitude', 'Longitude', 'LONGITUDE', 'x'],
};

const SOCRATA_ID = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

/**
 * Build a source from an ad-hoc spec, for a dataset that is not in the catalogue.
 *
 * Accepted forms:
 *
 *   socrata:data.cityoftacoma.org/abcd-1234[@time_column]
 *   arcgis:https://services.arcgis.com/.../FeatureServer/0[@TIME_FIELD]
 *   geojson:https://example.gov/incidents.geojson[@timestamp]
 *
 * This is how "as many sources as you can find" is meant to be answered: rather than a
 * catalogue of guessed dataset ids that quietly 404, any portal dataset can be connected
 * from configuration and verified with `probe:source` before it is trusted.
 *
 * Positions from an unmapped feed are marked `area` — the conservative reading. We do not
 * know whether the publisher rounds, blurs or geocodes, so claiming anything finer would
 * be asserting a precision nobody stated.
 */
export function parseSourceSpec(spec: string): CatalogSource | undefined {
  const trimmed = spec.trim();
  const separator = trimmed.indexOf(':');
  if (separator < 0) return undefined;

  const scheme = trimmed.slice(0, separator).toLowerCase();
  let rest = trimmed.slice(separator + 1);
  if (!rest) return undefined;

  // Optional `@field` suffix naming the time column. Guarded against matching the `@` of
  // a userinfo component, which `assertPublicUrl` refuses anyway.
  let timeField = '';
  const at = rest.lastIndexOf('@');
  if (at > 0 && !rest.slice(at + 1).includes('/')) {
    timeField = rest.slice(at + 1).trim();
    rest = rest.slice(0, at);
  }

  switch (scheme) {
    case 'socrata': {
      const [host, dataset] = splitOnce(rest, '/');
      if (!host || !dataset || !SOCRATA_ID.test(dataset.toLowerCase())) return undefined;
      if (!isPlainHost(host)) return undefined;
      return {
        id: `socrata:${host}/${dataset}`,
        name: `${dataset} @ ${host}`,
        agency: host,
        area: '',
        adapter: 'socrata',
        url: `https://${host}/resource/${dataset.toLowerCase()}.json`,
        note:
          'Ad-hoc Socrata dataset supplied by configuration. Column names are guessed from ' +
          'common open-data conventions — run `npm run probe:source` against it before ' +
          'trusting what it produces.',
        docsUrl: `https://${host}/d/${dataset.toLowerCase()}`,
        attribution: host,
        precision: 'area',
        timeField: timeField || 'datetime',
        map: GENERIC_PUBLIC_SAFETY_MAP,
        latency: 'unknown',
      };
    }
    case 'arcgis': {
      const url = asHttpsUrl(rest);
      if (!url) return undefined;
      // Accept a layer URL with or without the trailing `/query`.
      const path = url.pathname.replace(/\/query\/?$/, '');
      url.pathname = `${path}/query`;
      return {
        id: `arcgis:${url.host}${path}`,
        name: `${lastSegment(path)} @ ${url.host}`,
        agency: url.host,
        area: '',
        adapter: 'arcgis',
        url: url.toString(),
        note:
          'Ad-hoc ArcGIS FeatureServer layer supplied by configuration. Column names are ' +
          'guessed from common conventions — run `npm run probe:source` against it before ' +
          'trusting what it produces.',
        docsUrl: `https://${url.host}${path}`,
        attribution: url.host,
        precision: 'area',
        timeField: timeField || 'OBJECTID',
        map: GENERIC_PUBLIC_SAFETY_MAP,
        latency: 'unknown',
      };
    }
    case 'geojson':
    case 'json': {
      const url = asHttpsUrl(rest);
      if (!url) return undefined;
      return {
        id: `json:${url.host}${url.pathname}`,
        name: `${lastSegment(url.pathname) || url.host} @ ${url.host}`,
        agency: url.host,
        area: '',
        adapter: 'json',
        url: url.toString(),
        note:
          'Ad-hoc JSON or GeoJSON endpoint supplied by configuration. Column names are ' +
          'guessed from common conventions — run `npm run probe:source` against it before ' +
          'trusting what it produces.',
        docsUrl: url.toString(),
        attribution: url.host,
        precision: 'area',
        timeField: timeField || 'timestamp',
        map: GENERIC_PUBLIC_SAFETY_MAP,
        latency: 'unknown',
      };
    }
    default:
      return undefined;
  }
}

/**
 * Resolve a configured source id.
 *
 * Tries the catalogue first, then the ad-hoc spec syntax, so `SOURCES` accepts both
 * `seattle-fire-911` and `socrata:data.kingcounty.gov/abcd-1234`.
 */
export function findCatalogSource(
  id: string,
  overrideUrl?: string | null,
): CatalogSource | undefined {
  const wanted = id.trim();
  const source =
    SOURCE_CATALOG.find((entry) => entry.id === wanted.toLowerCase()) ?? parseSourceSpec(wanted);
  if (!source) return undefined;
  // Lets a source be pointed at a mirror, a cached copy or a local stub without forking
  // the entry. Everything else about the source is unchanged.
  return overrideUrl ? { ...source, url: overrideUrl } : source;
}

export function catalogIds(): string[] {
  return SOURCE_CATALOG.map((source) => source.id);
}

/** Catalogued sources that cannot run without a key, and the variable each one reads. */
export function requiredSourceKeys(ids: readonly string[]): { id: string; keyEnv: string }[] {
  const out: { id: string; keyEnv: string }[] = [];
  for (const id of ids) {
    const source = findCatalogSource(id);
    if (source?.keyEnv) out.push({ id: source.id, keyEnv: source.keyEnv });
  }
  return out;
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
  options: { since?: string | null; limit?: number; apiKey?: string | null } = {},
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
      break;
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
      break;
    }
    default: {
      // Plain JSON/GeoJSON endpoints vary: apply only the parameters the publisher
      // documents. Where none exists, the adapter's dedup set does the work instead.
      if (source.limitParam) url.searchParams.set(source.limitParam, String(limit));
      if (source.sinceParam && options.since) {
        url.searchParams.set(source.sinceParam, toFloating(options.since));
      }
      break;
    }
  }

  // Applied last, and never persisted: the key belongs to the request, not the catalogue.
  if (source.keyParam && options.apiKey) url.searchParams.set(source.keyParam, options.apiKey);

  return url.toString();
}

/** Strip any credential from a URL before it is shown to a client or written to a log. */
export function redactPollUrl(source: CatalogSource, url: string): string {
  if (!source.keyParam) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has(source.keyParam)) {
      parsed.searchParams.set(source.keyParam, 'REDACTED');
    }
    return parsed.toString();
  } catch {
    return source.url;
  }
}

function toFloating(iso: string): string {
  return iso.replace(/\.\d+Z$/, '').replace(/Z$/, '');
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

function isPlainHost(host: string): boolean {
  return /^[a-z0-9.-]+$/i.test(host) && !host.includes('..');
}

function asHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    // Ad-hoc specs may only name public https endpoints, and may not carry credentials —
    // the same rule `assertPublicUrl` enforces, applied before the spec is even built.
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function lastSegment(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
