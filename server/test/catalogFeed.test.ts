import { describe, expect, it } from 'vitest';
import {
  buildPollUrl,
  catalogIds,
  findCatalogSource,
  mapRecord,
  normalizeIncident,
  SOURCE_CATALOG,
  type RawIncident,
} from '@crimetracker/shared';
import { CatalogFeedSource } from '../src/sources/catalogFeed.js';
import type { SourceContext } from '../src/sources/types.js';

/**
 * Fixtures mirror the documented response shapes of the real endpoints. The live APIs are
 * not reachable from CI, so these pin the mapping; `npm run probe:source` is what checks
 * the mapping against the publisher's current columns.
 *
 * Timestamps are derived from the current clock rather than hardcoded: the normalizer
 * rejects records from the future, so a fixed date would turn these green or red
 * depending on when the suite runs.
 */
const minutesAgo = (minutes: number): string =>
  // Socrata publishes floating timestamps, with no zone suffix.
  new Date(Date.now() - minutes * 60_000).toISOString().replace('Z', '');

const FIRE_NEWEST = minutesAgo(12);
const FIRE_OLDER = minutesAgo(30);

const SEATTLE_FIRE = [
  {
    address: '3607 Beacon Av S',
    type: 'Aid Response',
    datetime: FIRE_NEWEST,
    latitude: '47.571509',
    longitude: '-122.311577',
    report_location: { type: 'Point', coordinates: [-122.311577, 47.571509] },
    incident_number: 'F260081234',
  },
  {
    address: '1519 3rd Av',
    type: 'Auto Fire Alarm',
    datetime: FIRE_OLDER,
    latitude: '47.610512',
    longitude: '-122.337891',
    incident_number: 'F260081233',
  },
];

/** SPD publishes blurred coordinates on purpose — block level, never a precise point. */
const SPD_CALLS = [
  {
    cad_event_number: '2026000123456',
    cad_event_original_time_queued: minutesAgo(120),
    initial_call_type: 'BURGLARY - IN PROGRESS',
    final_call_type: 'BURGLARY - COMMERCIAL',
    blurred_address: '1500 BLOCK OF 3RD AVE',
    blurred_latitude: '47.6105',
    blurred_longitude: '-122.3378',
    precinct: 'WEST',
    sector: 'D',
  },
];

const SPD_CRIME = [
  {
    report_number: '2026-000123',
    offense_start_datetime: minutesAgo(60 * 30),
    offense: 'Theft From Motor Vehicle',
    offense_parent_group: 'LARCENY-THEFT',
    _100_block_address: '12XX BLOCK OF PIKE ST',
    mcpp: 'DOWNTOWN COMMERCIAL',
    latitude: '47.6131',
    longitude: '-122.3352',
  },
];

function normalize(raw: RawIncident, id: string) {
  const source = findCatalogSource(id)!;
  return normalizeIncident(
    { ...raw, locationPrecision: source.precision, area: source.area },
    { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
  );
}

function testContext() {
  const emitted: RawIncident[] = [];
  const states: string[] = [];
  const ctx: SourceContext = {
    emit: (raw) => emitted.push(raw),
    emitMany: (raws) => emitted.push(...raws),
    log: () => {},
    setState: (state) => states.push(state),
    signal: new AbortController().signal,
  };
  return { ctx, emitted, states };
}

describe('source catalogue', () => {
  it('gives every entry the fields the adapter needs', () => {
    for (const source of SOURCE_CATALOG) {
      expect(source.id).toMatch(/^[a-z0-9-]+$/);
      expect(source.url.startsWith('https://')).toBe(true);
      expect(source.attribution.length).toBeGreaterThan(0);
      expect(source.docsUrl.startsWith('https://')).toBe(true);
      expect(source.timeField.length).toBeGreaterThan(0);
    }
  });

  it('never claims exact positions for a publisher that does not provide them', () => {
    // Every catalogued agency publishes blurred, block or area-level positions. Asserting
    // this stops a future entry from quietly promising precision the source never gave.
    for (const source of SOURCE_CATALOG) {
      expect(source.precision).not.toBe('exact');
    }
  });

  it('looks sources up case-insensitively and lists ids', () => {
    expect(findCatalogSource('SEATTLE-FIRE-911')?.id).toBe('seattle-fire-911');
    expect(findCatalogSource('nope')).toBeUndefined();
    expect(catalogIds()).toContain('seattle-police-calls');
  });
});

describe('buildPollUrl', () => {
  const fire = findCatalogSource('seattle-fire-911')!;

  it('asks Socrata for the newest records first', () => {
    const url = new URL(buildPollUrl(fire, { limit: 50 }));
    expect(url.searchParams.get('$limit')).toBe('50');
    expect(url.searchParams.get('$order')).toBe('datetime DESC');
    expect(url.searchParams.get('$where')).toBeNull();
  });

  it('polls incrementally once a watermark exists', () => {
    const url = new URL(buildPollUrl(fire, { since: '2026-09-20T17:00:00.000Z' }));
    // Socrata floating timestamps carry no zone suffix.
    expect(url.searchParams.get('$where')).toBe("datetime > '2026-09-20T17:00:00'");
  });

  it('requests WGS84 from ArcGIS so coordinates are lat/lon, not web mercator', () => {
    const arcgis = {
      ...fire,
      adapter: 'arcgis' as const,
      url: 'https://services.arcgis.com/x/arcgis/rest/services/Y/FeatureServer/0/query',
      timeField: 'reported_date',
    };
    const url = new URL(buildPollUrl(arcgis, { limit: 25 }));
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('where')).toBe('1=1');
    expect(url.searchParams.get('resultRecordCount')).toBe('25');
  });
});

describe('Seattle Fire 911 mapping', () => {
  const source = findCatalogSource('seattle-fire-911')!;

  it('maps a dispatch record into a plottable incident', () => {
    const raw = mapRecord(SEATTLE_FIRE[0], source.map)!;
    const result = normalize(raw, source.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.incident.id).toBe('seattle-fire-911:F260081234');
    expect(result.incident.location.label).toBe('3607 Beacon Av S');
    expect(result.incident.coordinates).toEqual({ lat: 47.57151, lon: -122.31158 });
    expect(result.incident.source.kind).toBe('public-feed');
  });

  it('classifies dispatch language into the taxonomy', () => {
    const aid = normalize(mapRecord(SEATTLE_FIRE[0], source.map)!, source.id);
    const alarm = normalize(mapRecord(SEATTLE_FIRE[1], source.map)!, source.id);
    expect(aid.ok && aid.incident.incidentType).toBe('medical');
    expect(alarm.ok && alarm.incident.incidentType).toBe('fire');
  });

  it('marks the position approximate — an address is not a surveyed point', () => {
    const result = normalize(mapRecord(SEATTLE_FIRE[0], source.map)!, source.id);
    expect(result.ok && result.incident.location.precision).toBe('block');
    expect(result.ok && result.incident.location.approximate).toBe(true);
  });
});

describe('Seattle Police call mapping', () => {
  const source = findCatalogSource('seattle-police-calls')!;

  it('uses the blurred coordinates the department publishes', () => {
    const raw = mapRecord(SPD_CALLS[0], source.map)!;
    const result = normalize(raw, source.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.incident.coordinates).toEqual({ lat: 47.6105, lon: -122.3378 });
    // The department blurs these deliberately; the UI must say so.
    expect(result.incident.location.approximate).toBe(true);
    expect(result.incident.location.precision).toBe('block');
    expect(result.incident.incidentType).toBe('burglary');
  });

  it('falls back through renamed call-type columns', () => {
    const renamed = { ...SPD_CALLS[0], initial_call_type: '', final_call_type: '', call_type: 'ROBBERY' };
    const raw = mapRecord(renamed, source.map)!;
    expect(normalize(raw, source.id).ok).toBe(true);
    expect(String(raw.incidentType)).toBe('ROBBERY');
  });
});

describe('Seattle crime report mapping', () => {
  const source = findCatalogSource('seattle-crime-reports')!;

  it('maps an offence report and keeps it area-level', () => {
    const result = normalize(mapRecord(SPD_CRIME[0], source.map)!, source.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.incidentType).toBe('theft');
    expect(result.incident.location.precision).toBe('area');
    expect(result.incident.location.label).toBe('12XX BLOCK OF PIKE ST');
  });
});

describe('CatalogFeedSource', () => {
  const source = findCatalogSource('seattle-fire-911')!;

  it('emits mapped records and reports what the poll returned', async () => {
    const feed = new CatalogFeedSource({
      source,
      pollSeconds: 60,
      fetchImpl: async () =>
        new Response(JSON.stringify(SEATTLE_FIRE), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { ctx, emitted } = testContext();
    await feed.start(ctx);
    await feed.stop();

    expect(emitted).toHaveLength(2);
    expect(feed.status().eventsIngested).toBe(2);
    // Precision is stamped from the catalogue, not guessed per record.
    expect(emitted.every((r) => r.locationPrecision === 'block')).toBe(true);
    expect(feed.status().note).toContain('Publication lag: minutes');
  });

  it('polls incrementally: the second request asks only for newer records', async () => {
    const urls: string[] = [];
    const feed = new CatalogFeedSource({
      source,
      pollSeconds: 60,
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(SEATTLE_FIRE), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const { ctx } = testContext();
    await feed.start(ctx);
    await feed.start(ctx);
    await feed.stop();

    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toContain('%24where');

    // The watermark is the newest record seen, so nothing is re-downloaded. URLSearchParams
    // encodes spaces as '+', so compare against the decoded, normalized form.
    const second = decodeURIComponent(urls[1]!).replace(/\+/g, ' ');
    const expected = FIRE_NEWEST.replace(/\.\d+$/, '');
    expect(second).toContain(`$where=datetime > '${expected}'`);
  });

  it('de-duplicates records that reappear across polls', async () => {
    const feed = new CatalogFeedSource({
      source,
      pollSeconds: 60,
      fetchImpl: async () =>
        new Response(JSON.stringify(SEATTLE_FIRE), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { ctx, emitted } = testContext();
    await feed.start(ctx);
    await feed.start(ctx);
    await feed.stop();
    expect(emitted).toHaveLength(2);
  });

  it('backs off on a publisher rate limit instead of retrying harder', async () => {
    const feed = new CatalogFeedSource({
      source,
      pollSeconds: 60,
      fetchImpl: async () => new Response('slow down', { status: 429 }),
    });
    const { ctx, states, emitted } = testContext();
    await feed.start(ctx);
    await feed.stop();
    expect(emitted).toHaveLength(0);
    expect(states).toContain('degraded');
  });

  it('reports an error state rather than throwing when the publisher is unreachable', async () => {
    const feed = new CatalogFeedSource({
      source,
      pollSeconds: 60,
      fetchImpl: async () => {
        throw new Error('ENOTFOUND data.seattle.gov');
      },
    });
    const { ctx, states } = testContext();
    await expect(feed.start(ctx)).resolves.toBeUndefined();
    await feed.stop();
    expect(states).toContain('error');
  });

  it('carries the publisher attribution into the source panel', () => {
    const feed = new CatalogFeedSource({ source, pollSeconds: 60 });
    expect(feed.descriptor.note).toContain('City of Seattle Open Data');
    expect(feed.descriptor.kind).toBe('public-feed');
  });
});

describe('sources that require an access key', () => {
  const wsdot = findCatalogSource('wsdot-highway-alerts')!;
  const alert = (over: Record<string, unknown> = {}) => ({
    AlertID: 700001,
    County: 'Snohomish',
    EventCategory: 'Collision',
    HeadlineDescription: 'Collision blocking the left lane of northbound I-405.',
    StartTime: `/Date(${Date.now() - 6 * 60_000}-0800)/`,
    StartRoadwayLocation: {
      Description: 'I-405 northbound at milepost 23',
      Direction: 'N',
      Latitude: 47.7623,
      Longitude: -122.2054,
      MilePost: 23,
      RoadName: '405',
    },
    ...over,
  });

  it('sends the key to the publisher and keeps it out of the descriptor', async () => {
    let requested = '';
    const source = new CatalogFeedSource({
      source: wsdot,
      pollSeconds: 3600,
      apiKey: 'SECRET-123',
      fetchImpl: (async (input: RequestInfo | URL) => {
        requested = String(input);
        return new Response(JSON.stringify([alert()]), { status: 200 });
      }) as typeof fetch,
    });

    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(new URL(requested).searchParams.get('AccessCode')).toBe('SECRET-123');
    expect(emitted).toHaveLength(1);
    // The descriptor is broadcast to every connected browser.
    expect(source.descriptor.url).not.toContain('SECRET-123');
    expect(JSON.stringify(source.status())).not.toContain('SECRET-123');
  });

  it('says which variable to check when the publisher rejects the key', async () => {
    const source = new CatalogFeedSource({
      source: wsdot,
      pollSeconds: 3600,
      apiKey: 'WRONG',
      fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch,
    });
    const { ctx } = testContext();
    await source.start(ctx);
    // Read before stopping: a stopped source reports no current message.
    const status = source.status();
    await source.stop();

    expect(status.state).toBe('error');
    expect(status.message).toContain('WSDOT_ACCESS_CODE');
  });

  it('strips the key out of a fetch error before it reaches a client', async () => {
    const source = new CatalogFeedSource({
      source: wsdot,
      pollSeconds: 3600,
      apiKey: 'SECRET-123',
      fetchImpl: (async () => {
        // Node quotes the full request URL in network errors.
        throw new Error('request to https://wsdot.example/a?AccessCode=SECRET-123 failed');
      }) as typeof fetch,
    });
    const { ctx, states } = testContext();
    await source.start(ctx);
    const status = source.status();
    await source.stop();

    expect(states).toContain('error');
    expect(status.message).not.toContain('SECRET-123');
    expect(status.message).toContain('REDACTED');
  });

  it('stamps milepost precision rather than an exact point', async () => {
    const source = new CatalogFeedSource({
      source: wsdot,
      pollSeconds: 3600,
      apiKey: 'SECRET-123',
      fetchImpl: (async () =>
        new Response(JSON.stringify([alert()]), { status: 200 })) as typeof fetch,
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    const result = normalize(emitted[0]!, 'wsdot-highway-alerts');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.location.approximate).toBe(true);
    expect(result.incident.incidentType).toBe('traffic');
  });
});

describe('NWS and USGS adapters through the poller', () => {
  it('ingests a polygon weather alert as an area-level hazard', async () => {
    const nws = findCatalogSource('nws-alerts-wa')!;
    const body = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [-122.4, 47.4],
                [-122.2, 47.4],
                [-122.2, 47.6],
                [-122.4, 47.6],
                [-122.4, 47.4],
              ],
            ],
          },
          properties: {
            id: 'urn:oid:2.49.0.1.840.0.zzz',
            areaDesc: 'King',
            sent: new Date(Date.now() - 4 * 60_000).toISOString(),
            event: 'High Wind Warning',
            headline: 'High Wind Warning in effect',
            senderName: 'NWS Seattle WA',
          },
        },
      ],
    };

    const source = new CatalogFeedSource({
      source: nws,
      pollSeconds: 3600,
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(1);
    const result = normalize(emitted[0]!, 'nws-alerts-wa');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.location.precision).toBe('area');
    expect(result.incident.incidentType).toBe('hazard');
  });

  it('asks USGS only for events after the watermark on the second poll', async () => {
    const usgs = findCatalogSource('usgs-earthquakes-wa')!;
    const quakeAt = Date.now() - 8 * 60_000;
    const requests: string[] = [];
    const body = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-122.1, 47.2, 12] },
          properties: {
            mag: 3.1,
            place: '9 km E of Carnation, Washington',
            time: quakeAt,
            type: 'earthquake',
            title: 'M 3.1 - 9 km E of Carnation, Washington',
            code: '61999001',
          },
        },
      ],
    };

    const source = new CatalogFeedSource({
      source: usgs,
      pollSeconds: 0.01,
      fetchImpl: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    });

    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await source.stop();

    expect(requests.length).toBeGreaterThan(1);
    expect(new URL(requests[0]!).searchParams.has('starttime')).toBe(false);
    expect(new URL(requests[1]!).searchParams.get('starttime')).toBe(
      new Date(quakeAt).toISOString().replace(/\.\d+Z$/, ''),
    );
    // The same quake returned twice is ingested once.
    expect(emitted).toHaveLength(1);
  });
});
