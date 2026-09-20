import type { Map as MapLibreMap, ExpressionSpecification } from 'maplibre-gl';
import type { Incident, PatternCluster } from '@crimetracker/shared';
import { circlePolygon } from './geometry.js';

/**
 * Incident and pattern rendering.
 *
 * Everything lives in three GeoJSON sources fed to GPU circle/fill layers, with MapLibre
 * doing the clustering. That is the whole performance story: thousands of incidents cost
 * a handful of layers, not thousands of DOM nodes or markers.
 */

export const SRC_INCIDENTS = 'incidents';
export const SRC_PATTERNS = 'patterns';
export const SRC_FOCUS = 'focus';
export const SRC_SPAWN = 'spawn';

export const LAYER_CLUSTER_RING = 'incident-cluster-ring';
export const LAYER_POINT = 'incident-point';

/** Severity → colour, matching the `--sev-*` tokens in the stylesheet. */
const SEVERITY_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'sev'],
  1,
  '#5d7a8c',
  2,
  '#4fd8ff',
  3,
  '#ffd166',
  4,
  '#ffa23a',
  5,
  '#ff3c5f',
  '#4fd8ff',
];

const CLUSTER_SEVERITY_COLOR: ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['get', 'sevMax'],
  1,
  '#5d7a8c',
  2,
  '#4fd8ff',
  3,
  '#ffd166',
  4,
  '#ffa23a',
  5,
  '#ff3c5f',
];

export interface IncidentProperties {
  id: string;
  sev: number;
  type: string;
  approx: number;
  ts: number;
}

export function incidentsToGeoJson(
  incidents: readonly Incident[],
): GeoJSON.FeatureCollection<GeoJSON.Point, IncidentProperties> {
  const features: GeoJSON.Feature<GeoJSON.Point, IncidentProperties>[] = [];
  for (const incident of incidents) {
    // Incidents without a trustworthy position are deliberately not plotted — they are
    // still listed in the HUD, flagged as having no coordinates.
    if (!incident.coordinates) continue;
    features.push({
      type: 'Feature',
      id: features.length,
      properties: {
        id: incident.id,
        sev: incident.severity,
        type: incident.incidentType,
        approx: incident.location.approximate ? 1 : 0,
        ts: Date.parse(incident.timestamp),
      },
      geometry: { type: 'Point', coordinates: [incident.coordinates.lon, incident.coordinates.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function patternsToGeoJson(
  patterns: readonly PatternCluster[],
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: 'FeatureCollection',
    features: patterns.map((pattern) => ({
      type: 'Feature',
      properties: {
        id: pattern.id,
        count: pattern.count,
        confidence: pattern.confidence,
        type: pattern.dominantType,
      },
      // A geographic polygon, so the radius stays honest in kilometres at every zoom.
      geometry: circlePolygon(pattern.center, Math.max(pattern.radiusKm, 0.35)),
    })),
  };
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Install all incident/pattern sources and layers. Called once, after `style.load`. */
export function installIncidentLayers(map: MapLibreMap): void {
  map.addSource(SRC_PATTERNS, { type: 'geojson', data: EMPTY });
  map.addSource(SRC_INCIDENTS, {
    type: 'geojson',
    data: EMPTY,
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 12,
    // Carry the worst severity in a cluster up to the cluster feature so the ring's
    // colour still communicates urgency when points are merged.
    clusterProperties: { sevMax: ['max', ['get', 'sev']] },
  });
  map.addSource(SRC_FOCUS, { type: 'geojson', data: EMPTY });
  map.addSource(SRC_SPAWN, { type: 'geojson', data: EMPTY });

  /* ---------------------- pattern emphasis (violet) --------------------- */
  map.addLayer({
    id: 'pattern-fill',
    type: 'fill',
    source: SRC_PATTERNS,
    paint: {
      'fill-color': '#b98cff',
      'fill-opacity': ['interpolate', ['linear'], ['get', 'confidence'], 0.4, 0.04, 1, 0.12],
    },
  });
  map.addLayer({
    id: 'pattern-glow',
    type: 'line',
    source: SRC_PATTERNS,
    paint: {
      'line-color': '#b98cff',
      'line-width': 10,
      'line-blur': 10,
      'line-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'pattern-ring',
    type: 'line',
    source: SRC_PATTERNS,
    paint: {
      'line-color': '#b98cff',
      'line-width': 1.2,
      'line-opacity': 0.75,
      'line-dasharray': [3, 2],
    },
  });

  /* --------------------------- incident points -------------------------- */
  // Soft halo under every point gives the markers presence on a dark field.
  map.addLayer({
    id: 'incident-halo',
    type: 'circle',
    source: SRC_INCIDENTS,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': SEVERITY_COLOR,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 12, 13, 16, 20],
      'circle-blur': 1.1,
      'circle-opacity': ['interpolate', ['linear'], ['get', 'sev'], 1, 0.16, 5, 0.42],
    },
  });
  map.addLayer({
    id: LAYER_POINT,
    type: 'circle',
    source: SRC_INCIDENTS,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': '#04070a',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.2, 12, 5.4, 16, 7.5],
      'circle-stroke-color': SEVERITY_COLOR,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 12, 1.6],
      'circle-opacity': 0.92,
      // Approximate positions are drawn hollow-ish, precise ones solid.
      'circle-stroke-opacity': ['case', ['==', ['get', 'approx'], 1], 0.62, 1],
    },
  });
  map.addLayer({
    id: 'incident-core',
    type: 'circle',
    source: SRC_INCIDENTS,
    // Only exact positions get a solid core — an honest visual distinction.
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'approx'], 0]],
    paint: {
      'circle-color': SEVERITY_COLOR,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.1, 12, 1.9, 16, 2.6],
      'circle-opacity': 0.95,
    },
  });

  /* ------------------------------ clusters ------------------------------ */
  map.addLayer({
    id: 'incident-cluster-glow',
    type: 'circle',
    source: SRC_INCIDENTS,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': CLUSTER_SEVERITY_COLOR,
      'circle-radius': clusterRadius(1.85),
      'circle-blur': 1,
      'circle-opacity': 0.2,
    },
  });
  map.addLayer({
    id: 'incident-cluster-disc',
    type: 'circle',
    source: SRC_INCIDENTS,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#04070a',
      'circle-radius': clusterRadius(1),
      'circle-opacity': 0.72,
    },
  });
  map.addLayer({
    id: LAYER_CLUSTER_RING,
    type: 'circle',
    source: SRC_INCIDENTS,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': clusterRadius(1),
      'circle-stroke-color': CLUSTER_SEVERITY_COLOR,
      'circle-stroke-width': 1.3,
      'circle-stroke-opacity': 0.85,
    },
  });

  /* ----------------------- spawn pings + selection ---------------------- */
  map.addLayer({
    id: 'spawn-ping',
    type: 'circle',
    source: SRC_SPAWN,
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': 6,
      'circle-stroke-color': SEVERITY_COLOR,
      'circle-stroke-width': 1.4,
      'circle-stroke-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'focus-halo',
    type: 'circle',
    source: SRC_FOCUS,
    paint: {
      'circle-color': '#4fd8ff',
      'circle-radius': 22,
      'circle-blur': 1.1,
      'circle-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'focus-ring',
    type: 'circle',
    source: SRC_FOCUS,
    paint: {
      'circle-color': 'rgba(0,0,0,0)',
      'circle-radius': 13,
      'circle-stroke-color': '#4fd8ff',
      'circle-stroke-width': 1.4,
      'circle-stroke-opacity': 0.95,
    },
  });
}

function clusterRadius(scale: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['get', 'point_count'],
    2,
    11 * scale,
    10,
    16 * scale,
    40,
    22 * scale,
    150,
    30 * scale,
  ];
}

export function setSourceData(
  map: MapLibreMap,
  id: string,
  data: GeoJSON.GeoJSON,
): void {
  const source = map.getSource(id);
  if (source && 'setData' in source) {
    (source as maplibregl.GeoJSONSource).setData(data);
  }
}
