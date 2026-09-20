import type { RawIncident } from './types.js';

/**
 * Projection of an arbitrary public feed record onto the incident model.
 *
 * Declared as configuration rather than code so connecting a new open-data endpoint is a
 * settings change. The mapping is pure and runtime-neutral, so the Node server and the
 * Cloudflare Worker share one definition of what a feed record means.
 */
export interface FeedFieldMap {
  readonly id: string;
  readonly timestamp: string;
  readonly type: string;
  readonly description: string;
  readonly location: string;
  readonly lat: string;
  readonly lon: string;
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
  const props =
    isFeature && obj.properties && typeof obj.properties === 'object'
      ? (obj.properties as Record<string, unknown>)
      : obj;

  let coordinates: unknown = null;
  if (isFeature) {
    const geometry = obj.geometry as { type?: unknown; coordinates?: unknown } | null;
    if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
      coordinates = geometry.coordinates; // [lon, lat] — the validator handles the order
    }
  }
  if (!coordinates) {
    const lat = dotPath(props, map.lat);
    const lon = dotPath(props, map.lon);
    if (lat != null && lon != null) coordinates = { lat, lon };
  }

  const description = dotPath(props, map.description);
  const type = dotPath(props, map.type);
  if (description == null && type == null) return null;

  const id = dotPath(props, map.id);

  return {
    externalId: id == null ? null : String(id).slice(0, 48),
    timestamp: dotPath(props, map.timestamp),
    incidentType: type,
    description: description ?? type,
    locationLabel: dotPath(props, map.location),
    coordinates,
    // The feed's own classification is retained for audit, but the normalizer decides
    // what the incident type actually is.
    raw: props,
  };
}
