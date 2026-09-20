/** Geographic primitives. Pure functions, no dependencies — shared by server and client. */

export interface Coordinates {
  readonly lat: number;
  readonly lon: number;
}

export interface BBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * Washington State, with a small margin. Used as the default validity region: a
 * coordinate outside it is treated as bad data rather than plotted somewhere absurd.
 */
export const WASHINGTON_BBOX: BBox = {
  west: -124.85,
  south: 45.5,
  east: -116.9,
  north: 49.1,
};

export const WASHINGTON_CENTER: Coordinates = { lat: 47.38, lon: -120.6 };

/** Whole-earth bounds, for deployments that are not region-locked. */
export const WORLD_BBOX: BBox = { west: -180, south: -90, east: 180, north: 90 };

const EARTH_RADIUS_KM = 6371.0088;

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a coordinate pair from an untrusted source.
 *
 * Returns `null` for anything we cannot stand behind: non-numeric input, out-of-range
 * latitude/longitude, the `0,0` null-island sentinel, or a point outside the configured
 * region. We never "repair" a coordinate — a rejected one becomes `null` and the incident
 * is still kept, just without a plotted position.
 */
export function validateCoordinates(
  input: unknown,
  region: BBox | null = WASHINGTON_BBOX,
): Coordinates | null {
  let lat: unknown;
  let lon: unknown;

  if (Array.isArray(input)) {
    // GeoJSON order: [lon, lat]
    [lon, lat] = input as unknown[];
  } else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    lat = obj.lat ?? obj.latitude ?? obj.y;
    lon = obj.lon ?? obj.lng ?? obj.longitude ?? obj.x;
  } else {
    return null;
  }

  if (typeof lat === 'string') lat = Number(lat);
  if (typeof lon === 'string') lon = Number(lon);
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // Null island: almost always a missing-value artefact, never a real incident here.
  if (Math.abs(lat) < 1e-9 && Math.abs(lon) < 1e-9) return null;
  if (region && !containsPoint(region, { lat, lon })) return null;

  // Normalize to ~1.1 m precision. Enough to place a marker, and a small nod to not
  // storing more precision than a public feed can justify.
  return { lat: round(lat, 5), lon: round(lon, 5) };
}

export function containsPoint(box: BBox, point: Coordinates): boolean {
  return (
    point.lat >= box.south &&
    point.lat <= box.north &&
    point.lon >= box.west &&
    point.lon <= box.east
  );
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Centroid of a set of points. Adequate at state scale. */
export function centroid(points: readonly Coordinates[]): Coordinates | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: round(lat / points.length, 5), lon: round(lon / points.length, 5) };
}

/** Largest distance from `center` to any of `points`, in kilometres. */
export function radiusKm(center: Coordinates, points: readonly Coordinates[]): number {
  let max = 0;
  for (const p of points) max = Math.max(max, haversineKm(center, p));
  return round(max, 3);
}

export function bboxOf(points: readonly Coordinates[]): BBox | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const p of points) {
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
  }
  return { west, south, east, north };
}

/** Offset a coordinate by a distance/bearing. Used to fuzz approximate positions. */
export function offsetCoordinates(origin: Coordinates, km: number, bearingDeg: number): Coordinates {
  const angular = km / EARTH_RADIUS_KM;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    lat: round((lat2 * 180) / Math.PI, 5),
    lon: round((((lon2 * 180) / Math.PI + 540) % 360) - 180, 5),
  };
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

/**
 * Centroid of a GeoJSON Polygon or MultiPolygon coordinate array.
 *
 * Several public-safety feeds describe an *area* rather than a point — a National Weather
 * Service warning covers a polygon, not an address. Reducing that polygon to its centre of
 * area gives the map something to plot while the caller keeps the precision honest by
 * marking the result `area`, never `exact`.
 *
 * Uses the shoelace formula on the outer ring (the largest ring of a MultiPolygon), and
 * falls back to the mean vertex for degenerate rings where the signed area is zero.
 * Returns `null` for anything that is not a usable ring — a shape we cannot read becomes
 * no position at all, never a guess.
 */
export function ringCentroid(coordinates: unknown): Coordinates | null {
  const ring = outerRing(coordinates);
  if (!ring || ring.length < 3) {
    // A one- or two-point "ring" still has a defensible mean.
    return ring && ring.length > 0 ? meanOf(ring) : null;
  }

  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j]!;
    const b = ring[i]!;
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    x += (a[0] + b[0]) * cross;
    y += (a[1] + b[1]) * cross;
  }

  if (Math.abs(twiceArea) < 1e-12) return meanOf(ring);

  const factor = 1 / (3 * twiceArea);
  const lon = x * factor;
  const lat = y * factor;
  return isFiniteNumber(lat) && isFiniteNumber(lon) ? { lat, lon } : null;
}

/** The outer ring worth measuring: for a MultiPolygon, the one with the most vertices. */
function outerRing(coordinates: unknown): [number, number][] | null {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;

  // Polygon: [ring, ...holes]; MultiPolygon: [[ring, ...holes], ...].
  const first = coordinates[0];
  if (Array.isArray(first) && Array.isArray(first[0]) && Array.isArray(first[0][0])) {
    let best: [number, number][] | null = null;
    for (const polygon of coordinates as unknown[]) {
      const candidate = outerRing(polygon);
      if (candidate && (!best || candidate.length > best.length)) best = candidate;
    }
    return best;
  }

  const ring = Array.isArray(first) ? first : coordinates;
  const points: [number, number][] = [];
  for (const point of ring as unknown[]) {
    if (!Array.isArray(point)) continue;
    const [lon, lat] = point as unknown[];
    if (isFiniteNumber(lon) && isFiniteNumber(lat)) points.push([lon, lat]);
  }
  return points.length > 0 ? points : null;
}

function meanOf(ring: readonly [number, number][]): Coordinates | null {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return ring.length > 0 ? { lat: lat / ring.length, lon: lon / ring.length } : null;
}
