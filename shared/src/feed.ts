import type { RawIncident } from './types.js';

/**
 * Projection of an arbitrary public feed record onto the incident model.
 *
 * Declared as configuration rather than code so connecting a new open-data endpoint is a
 * settings change. The mapping is pure and runtime-neutral, so the Node server and the
 * Cloudflare Worker share one definition of what a feed record means.
 */
/**
 * A field may list several candidate paths. Open-data publishers rename columns without
 * notice (`call_type` becomes `initial_call_type`, `datetime` becomes `cad_event_...`),
 * and a dataset that silently maps to nothing is worse than one that fails loudly. The
 * first candidate that resolves wins, and `describeMapping` reports which one did.
 */
export type FeedField = string | readonly string[];

export interface FeedFieldMap {
  readonly id: FeedField;
  readonly timestamp: FeedField;
  readonly type: FeedField;
  readonly description: FeedField;
  readonly location: FeedField;
  readonly lat: FeedField;
  readonly lon: FeedField;
}

/** Resolve `a.b.c` against an unknown object, returning `undefined` on any miss. */
export function dotPath(input: unknown, path: string): unknown {
  if (!path) return input;
  let cursor: unknown = input;
  for (const segment of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Resolve the first candidate path that yields a usable value. */
export function resolveField(record: unknown, field: FeedField): unknown {
  const candidates = typeof field === 'string' ? [field] : field;
  for (const path of candidates) {
    const value = dotPath(record, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** Which candidate actually matched, for diagnostics. */
export function matchedField(record: unknown, field: FeedField): string | null {
  const candidates = typeof field === 'string' ? [field] : field;
  for (const path of candidates) {
    const value = dotPath(record, path);
    if (value !== undefined && value !== null && value !== '') return path;
  }
  return null;
}

/**
 * Report how a mapping lands on a real record.
 *
 * Used by `npm run probe:source`, which is the honest answer to field drift: rather than
 * trusting that a publisher's column is still called what the docs say, fetch one record
 * and show exactly what resolved.
 */
export function describeMapping(
  record: unknown,
  map: FeedFieldMap,
): { field: keyof FeedFieldMap; matched: string | null; value: unknown }[] {
  return (Object.keys(map) as (keyof FeedFieldMap)[]).map((field) => ({
    field,
    matched: matchedField(record, map[field]),
    value: resolveField(record, map[field]),
  }));
}

/** Find the array of records in a response body, handling GeoJSON automatically. */
export function extractRecords(body: unknown, itemsPath: string): unknown[] {
  if (itemsPath) {
    const value = dotPath(body, itemsPath);
    return Array.isArray(value) ? value : [];
  }
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return obj.features;
    // ArcGIS FeatureServer: { features: [{ attributes, geometry }] }
    if (Array.isArray(obj.features)) return obj.features;
    // Common wrappers used by open-data portals.
    for (const key of ['results', 'data', 'items', 'records', 'incidents']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/** Project one feed record onto a `RawIncident` using the configured field mapping. */
export function mapRecord(record: unknown, map: FeedFieldMap): RawIncident | null {
  if (!record || typeof record !== 'object') return null;

  // GeoJSON features carry their payload under `properties` and position under `geometry`.
  const obj = record as Record<string, unknown>;
  const isFeature = obj.type === 'Feature';
  // GeoJSON puts fields under `properties`; ArcGIS puts them under `attributes`.
  const props =
    isFeature && obj.properties && typeof obj.properties === 'object'
      ? (obj.properties as Record<string, unknown>)
      : obj.attributes && typeof obj.attributes === 'object'
        ? (obj.attributes as Record<string, unknown>)
        : obj;

  let coordinates: unknown = null;
  if (isFeature) {
    const geometry = obj.geometry as { type?: unknown; coordinates?: unknown } | null;
    if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
      coordinates = geometry.coordinates; // [lon, lat] — the validator handles the order
    }
  }
  // Esri ArcGIS features carry a flat {x, y} geometry instead of GeoJSON coordinates.
  if (!coordinates && obj.geometry && typeof obj.geometry === 'object') {
    const esri = obj.geometry as { x?: unknown; y?: unknown };
    if (typeof esri.x === 'number' && typeof esri.y === 'number') {
      coordinates = { lat: esri.y, lon: esri.x };
    }
  }
  if (!coordinates) {
    const lat = resolveField(props, map.lat);
    const lon = resolveField(props, map.lon);
    if (lat != null && lon != null) coordinates = { lat, lon };
    else {
      // Socrata "location" columns nest the point under `coordinates` as [lon, lat].
      const point = dotPath(props, 'report_location') ?? dotPath(props, 'location');
      const nested = (point as { coordinates?: unknown } | null)?.coordinates;
      if (Array.isArray(nested)) coordinates = nested;
    }
  }

  const description = resolveField(props, map.description);
  const type = resolveField(props, map.type);
  if (description == null && type == null) return null;

  const id = resolveField(props, map.id);

  return {
    externalId: id == null ? null : String(id).slice(0, 48),
    timestamp: resolveField(props, map.timestamp),
    incidentType: type,
    description: description ?? type,
    locationLabel: resolveField(props, map.location),
    coordinates,
    // The feed's own classification is retained for audit, but the normalizer decides
    // what the incident type actually is.
    raw: props,
  };
}
