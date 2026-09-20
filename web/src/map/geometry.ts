import type { BBox } from '@crimetracker/shared';

/** GeoJSON helpers used to build the procedural parts of the map. */

export type LineFeature = GeoJSON.Feature<GeoJSON.LineString, { kind: string; major: number }>;

/**
 * A latitude/longitude graticule.
 *
 * Drawn from generated geometry rather than a tile source, so the grid is ours: it lines
 * up with the HUD's visual rhythm and costs one small GeoJSON source.
 */
export function buildGraticule(
  bounds: BBox,
  stepDeg = 0.5,
  majorEvery = 2,
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: LineFeature[] = [];
  const pad = stepDeg * 2;

  const startLon = Math.floor((bounds.west - pad) / stepDeg) * stepDeg;
  const endLon = Math.ceil((bounds.east + pad) / stepDeg) * stepDeg;
  const startLat = Math.floor((bounds.south - pad) / stepDeg) * stepDeg;
  const endLat = Math.ceil((bounds.north + pad) / stepDeg) * stepDeg;

  let index = 0;
  for (let lon = startLon; lon <= endLon + 1e-9; lon += stepDeg) {
    features.push({
      type: 'Feature',
      properties: { kind: 'meridian', major: index % majorEvery === 0 ? 1 : 0 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [round(lon), round(startLat)],
          [round(lon), round(endLat)],
        ],
      },
    });
    index += 1;
  }

  index = 0;
  for (let lat = startLat; lat <= endLat + 1e-9; lat += stepDeg) {
    features.push({
      type: 'Feature',
      properties: { kind: 'parallel', major: index % majorEvery === 0 ? 1 : 0 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [round(startLon), round(lat)],
          [round(endLon), round(lat)],
        ],
      },
    });
    index += 1;
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Approximate a geographic circle as a polygon, so a radius drawn on the map stays
 * correct in kilometres as the user zooms.
 */
export function circlePolygon(
  center: { lat: number; lon: number },
  radiusKm: number,
  steps = 72,
): GeoJSON.Polygon {
  const coordinates: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.max(0.02, Math.cos(latRad)));

  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * Math.PI * 2;
    coordinates.push([
      round(center.lon + dLon * Math.cos(theta)),
      round(center.lat + dLat * Math.sin(theta)),
    ]);
  }
  return { type: 'Polygon', coordinates: [coordinates] };
}

/** Deterministic 0–1 value from a string, used to vary county fill tone. */
export function toneOf(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 1000) / 1000;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
