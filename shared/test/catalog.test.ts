import { describe, expect, it } from 'vitest';
import {
  buildPollUrl,
  findCatalogSource,
  GENERIC_PUBLIC_SAFETY_MAP,
  mapRecord,
  normalizeIncident,
  parseSourceSpec,
  parseTimestamp,
  redactPollUrl,
  ringCentroid,
  SOURCE_CATALOG,
  WA_DATA_PORTALS,
  type CatalogSource,
} from '../src/index.js';

/**
 * These fixtures mirror the documented response shape of each publisher. The live
 * endpoints are unreachable from CI, so what is pinned here is the *mapping*: that a
 * record of the published shape produces the incident we expect, with the precision and
 * provenance the catalogue claims. `npm run probe:source` is what checks the mapping
 * against the publisher's current columns.
 */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const sourceOf = (id: string): CatalogSource => {
  const source = findCatalogSource(id);
  if (!source) throw new Error(`missing catalogue entry: ${id}`);
  return source;
};

describe('catalogue integrity', () => {
  it('never claims an exact position for any published source', () => {
    // Every agency here rounds, blurs, geocodes or covers an area. Claiming `exact` would
    // put a precision on screen that no publisher stated.
    for (const source of SOURCE_CATALOG) {
      expect(source.precision, source.id).not.toBe('exact');
    }
  });

  it('uses https endpoints with no embedded credentials', () => {
    for (const source of SOURCE_CATALOG) {
      const url = new URL(source.url);
      expect(url.protocol, source.id).toBe('https:');
      expect(url.username, source.id).toBe('');
      expect(url.password, source.id).toBe('');
    }
  });

  it('never bakes an access key into a catalogued url', () => {
    for (const source of SOURCE_CATALOG) {
      if (!source.keyParam) continue;
      expect(new URL(source.url).searchParams.has(source.keyParam), source.id).toBe(false);
      expect(source.keyEnv, source.id).toBeTruthy();
    }
  });

  it('gives every entry a documentation link and an attribution', () => {
    for (const source of SOURCE_CATALOG) {
      expect(source.docsUrl, source.id).toMatch(/^https:\/\//);
      expect(source.attribution.length, source.id).toBeGreaterThan(0);
      expect(source.latency.length, source.id).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = SOURCE_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('lists portals that can be reached with an ad-hoc spec', () => {
    expect(WA_DATA_PORTALS.length).toBeGreaterThan(0);
    for (const portal of WA_DATA_PORTALS) {
      expect(portal.example.startsWith(`${portal.kind}:`), portal.host).toBe(true);
    }
  });
});

describe('buildPollUrl', () => {
  it('asks Socrata for the newest page, then only for records after the watermark', () => {
    const source = sourceOf('seattle-fire-911');
    const first = new URL(buildPollUrl(source, { limit: 50 }));
    expect(first.searchParams.get('$limit')).toBe('50');
    expect(first.searchParams.get('$order')).toBe('datetime DESC');
    expect(first.searchParams.has('$where')).toBe(false);

    const next = new URL(buildPollUrl(source, { since: '2026-01-02T03:04:05.678Z' }));
    // Socrata floating timestamps carry no zone suffix.
    expect(next.searchParams.get('$where')).toBe("datetime > '2026-01-02T03:04:05'");
  });

  it('requests WGS84 from ArcGIS so coordinates are never web mercator', () => {
    const source = parseSourceSpec(
      'arcgis:https://services.arcgis.com/abc/ArcGIS/rest/services/Calls/FeatureServer/0@REPORTED',
    );
    const url = new URL(buildPollUrl(source!, { since: '2026-01-02T03:04:05Z' }));
    expect(url.searchParams.get('outSR')).toBe('4326');
    expect(url.searchParams.get('f')).toBe('json');
    expect(url.searchParams.get('where')).toBe("REPORTED > TIMESTAMP '2026-01-02 03:04:05'");
    expect(url.pathname.endsWith('/query')).toBe(true);
  });

  it('applies only the parameters a plain JSON publisher documents', () => {
    // USGS documents `starttime` and `limit`; WSDOT documents neither.
    const usgs = new URL(buildPollUrl(sourceOf('usgs-earthquakes-wa'), {
      since: '2026-01-02T03:04:05Z',
      limit: 40,
    }));
    expect(usgs.searchParams.get('starttime')).toBe('2026-01-02T03:04:05');
    expect(usgs.searchParams.get('limit')).toBe('40');

    const wsdot = new URL(buildPollUrl(sourceOf('wsdot-highway-alerts'), {
      since: '2026-01-02T03:04:05Z',
      limit: 40,
    }));
    expect(wsdot.searchParams.has('starttime')).toBe(false);
    expect(wsdot.searchParams.has('limit')).toBe(false);
  });

  it('appends an access key only when the publisher issues one', () => {
    const keyed = new URL(buildPollUrl(sourceOf('wsdot-highway-alerts'), { apiKey: 'SECRET-123' }));
    expect(keyed.searchParams.get('AccessCode')).toBe('SECRET-123');

    // A key handed to a source that takes none must not be smuggled onto the request.
    const unkeyed = new URL(buildPollUrl(sourceOf('seattle-fire-911'), { apiKey: 'SECRET-123' }));
    expect(unkeyed.toString()).not.toContain('SECRET-123');
  });

  it('redacts the key when a url has to be shown or logged', () => {
    const source = sourceOf('wsdot-highway-alerts');
    const url = buildPollUrl(source, { apiKey: 'SECRET-123' });
    const safe = redactPollUrl(source, url);
    expect(safe).not.toContain('SECRET-123');
    expect(safe).toContain('AccessCode=REDACTED');
  });
});

describe('ad-hoc source specs', () => {
  it('builds a Socrata source from portal and dataset id', () => {
    const source = parseSourceSpec('socrata:data.cityoftacoma.org/abcd-1234@occurred_date');
    expect(source?.adapter).toBe('socrata');
    expect(source?.url).toBe('https://data.cityoftacoma.org/resource/abcd-1234.json');
    expect(source?.timeField).toBe('occurred_date');
    expect(source?.map).toBe(GENERIC_PUBLIC_SAFETY_MAP);
  });

  it('marks an unmapped feed as area precision rather than guessing finer', () => {
    // We do not know whether an unknown publisher rounds, blurs or geocodes, so the
    // conservative reading is the only defensible one.
    for (const spec of [
      'socrata:data.wa.gov/abcd-1234',
      'arcgis:https://services.arcgis.com/x/ArcGIS/rest/services/Y/FeatureServer/0',
      'geojson:https://example.gov/incidents.geojson',
    ]) {
      expect(parseSourceSpec(spec)?.precision, spec).toBe('area');
    }
  });

  it('tolerates an ArcGIS layer url given with or without /query', () => {
    const base = 'https://services.arcgis.com/x/ArcGIS/rest/services/Y/FeatureServer/0';
    expect(parseSourceSpec(`arcgis:${base}`)?.url).toBe(parseSourceSpec(`arcgis:${base}/query`)?.url);
  });

  it('refuses specs that are not public https endpoints', () => {
    expect(parseSourceSpec('geojson:http://example.gov/incidents.json')).toBeUndefined();
    expect(parseSourceSpec('geojson:https://user:pw@example.gov/incidents.json')).toBeUndefined();
    expect(parseSourceSpec('file:/etc/passwd')).toBeUndefined();
    expect(parseSourceSpec('socrata:data.wa.gov/not-a-dataset-id')).toBeUndefined();
    expect(parseSourceSpec('socrata:data.wa.gov')).toBeUndefined();
    expect(parseSourceSpec('mystery:whatever')).toBeUndefined();
  });

  it('resolves both catalogue ids and specs through findCatalogSource', () => {
    expect(findCatalogSource('seattle-fire-911')?.adapter).toBe('socrata');
    expect(findCatalogSource('socrata:data.wa.gov/abcd-1234')?.adapter).toBe('socrata');
    expect(findCatalogSource('no-such-source')).toBeUndefined();
  });
});

describe('WSDOT highway alerts', () => {
  const source = sourceOf('wsdot-highway-alerts');
  // Captured once: the fixture and the assertion must refer to the same instant.
  const startedAt = minutesAgo(9);
  const updatedAt = minutesAgo(4);
  const record = {
    AlertID: 665544,
    County: 'King',
    EventCategory: 'Collision',
    EventStatus: 'Open',
    HeadlineDescription: 'Collision blocking the right lane of southbound I-5 near Boeing Access Rd.',
    ExtendedDescription: '',
    Priority: 'High',
    Region: 'Northwest',
    StartTime: `/Date(${startedAt.getTime()}-0800)/`,
    LastUpdatedTime: `/Date(${updatedAt.getTime()}-0800)/`,
    StartRoadwayLocation: {
      Description: 'I-5 southbound at milepost 157',
      Direction: 'S',
      Latitude: 47.5361,
      Longitude: -122.2853,
      MilePost: 157,
      RoadName: '005',
    },
    EndRoadwayLocation: { Latitude: 0, Longitude: 0 },
  };

  it('reads the .NET timestamp WSDOT publishes', () => {
    // `Date.parse` cannot read `/Date(...)/`, and a record with no usable time is dropped.
    const raw = mapRecord(record, source.map);
    expect(parseTimestamp(raw?.timestamp)).toBe(startedAt.toISOString());
  });

  it('maps a collision to a positioned traffic incident at milepost precision', () => {
    const raw = mapRecord(record, source.map)!;
    const result = normalizeIncident(
      { ...raw, locationPrecision: source.precision, area: source.area },
      { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.incidentType).toBe('traffic');
    expect(result.incident.coordinates).toEqual({ lat: 47.5361, lon: -122.2853 });
    expect(result.incident.location.precision).toBe('block');
    expect(result.incident.location.approximate).toBe(true);
    expect(result.incident.location.label).toContain('milepost 157');
  });

  it('prefers the start location over an unset end location', () => {
    // `EndRoadwayLocation` is routinely 0,0 — null island, which the validator rejects.
    const raw = mapRecord(record, source.map)!;
    expect(raw.coordinates).toEqual({ lat: 47.5361, lon: -122.2853 });
  });
});

describe('NWS weather alerts', () => {
  const source = sourceOf('nws-alerts-wa');

  const alertWithPolygon = {
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
      id: 'urn:oid:2.49.0.1.840.0.abc123',
      areaDesc: 'King; Pierce',
      sent: minutesAgo(6).toISOString(),
      effective: minutesAgo(6).toISOString(),
      event: 'Flood Warning',
      headline: 'Flood Warning issued for King and Pierce counties',
      severity: 'Severe',
      senderName: 'NWS Seattle WA',
    },
  };

  it('plots a polygon alert at its centre of area, marked as an area', () => {
    const raw = mapRecord(alertWithPolygon, source.map)!;
    const result = normalizeIncident(
      { ...raw, locationPrecision: source.precision, area: source.area },
      { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.coordinates?.lat).toBeCloseTo(47.5, 5);
    expect(result.incident.coordinates?.lon).toBeCloseTo(-122.3, 5);
    // A warning covering two counties is not an event at its centroid, and must say so.
    expect(result.incident.location.precision).toBe('area');
    expect(result.incident.location.approximate).toBe(true);
    expect(result.incident.incidentType).toBe('hazard');
  });

  it('keeps a zone-based alert with no geometry, without inventing a position', () => {
    const zoneAlert = { ...alertWithPolygon, geometry: null };
    const raw = mapRecord(zoneAlert, source.map)!;
    const result = normalizeIncident(
      { ...raw, locationPrecision: source.precision, area: source.area },
      { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.coordinates).toBeNull();
    expect(result.incident.location.label).toContain('King');
  });
});

describe('USGS earthquakes', () => {
  const source = sourceOf('usgs-earthquakes-wa');

  it('maps a quake feature to a positioned hazard', () => {
    const feature = {
      type: 'Feature',
      id: 'uw61234567',
      geometry: { type: 'Point', coordinates: [-122.1, 47.2, 18.4] },
      properties: {
        mag: 2.8,
        place: '12 km NE of Enumclaw, Washington',
        time: minutesAgo(7).getTime(),
        updated: minutesAgo(5).getTime(),
        type: 'earthquake',
        title: 'M 2.8 - 12 km NE of Enumclaw, Washington',
        code: '61234567',
        net: 'uw',
      },
    };
    const raw = mapRecord(feature, source.map)!;
    expect(raw.externalId).toBe('61234567');
    const result = normalizeIncident(
      { ...raw, locationPrecision: source.precision, area: source.area },
      { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incident.incidentType).toBe('hazard');
    expect(result.incident.coordinates).toEqual({ lat: 47.2, lon: -122.1 });
    // An epicentre is an instrument estimate: never presented as exact.
    expect(result.incident.location.approximate).toBe(true);
  });
});

describe('ringCentroid', () => {
  it('finds the centre of a simple rectangle', () => {
    const square = [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
        [0, 0],
      ],
    ];
    expect(ringCentroid(square)).toEqual({ lat: 1, lon: 1 });
  });

  it('uses the largest ring of a multipolygon', () => {
    const multi = [
      [
        [
          [10, 10],
          [10.1, 10],
          [10.1, 10.1],
          [10, 10],
        ],
      ],
      [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [1, 1],
          [0, 0],
        ],
      ],
    ];
    const centre = ringCentroid(multi)!;
    expect(centre.lon).toBeGreaterThan(0.5);
    expect(centre.lon).toBeLessThan(2);
  });

  it('falls back to the mean vertex for a degenerate ring', () => {
    const line = [
      [
        [0, 0],
        [2, 2],
        [0, 0],
      ],
    ];
    expect(ringCentroid(line)).toEqual({ lat: 2 / 3, lon: 2 / 3 });
  });

  it('returns null rather than a guess for unusable input', () => {
    expect(ringCentroid(null)).toBeNull();
    expect(ringCentroid([])).toBeNull();
    expect(ringCentroid([[['a', 'b']]])).toBeNull();
  });
});
