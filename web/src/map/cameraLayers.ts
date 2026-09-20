import type { Map as MapLibreMap } from 'maplibre-gl';
import type { CameraSite } from '@crimetracker/shared';

/**
 * Public roadway cameras as a map overlay.
 *
 * Deliberately quiet: small, cool, low-contrast markers that read as *context* rather
 * than as events. An incident is a report that something happened; a camera is a place
 * you can look at the road. Making them visually similar would be the interface telling
 * a lie about what the data is.
 */

export const SRC_CAMERAS = 'cameras';
export const LAYER_CAMERA = 'camera-point';

/**
 * Below this zoom the markers are hidden.
 *
 * A statewide view of ~2,000 camera sites is a field of dots that tells you nothing and
 * buries the incidents underneath it. The HUD says so rather than leaving the toggle
 * looking broken.
 */
export const CAMERA_MIN_ZOOM = 7.2;

export interface CameraProperties {
  id: string;
  title: string;
}

export function camerasToGeoJson(
  cameras: readonly CameraSite[],
): GeoJSON.FeatureCollection<GeoJSON.Point, CameraProperties> {
  return {
    type: 'FeatureCollection',
    features: cameras.map((camera, index) => ({
      type: 'Feature',
      id: index,
      properties: { id: camera.id, title: camera.title },
      geometry: { type: 'Point', coordinates: [camera.coordinates.lon, camera.coordinates.lat] },
    })),
  };
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Install the camera source and layers.
 *
 * Added before the incident layers in draw order would bury them; instead these go on top
 * but stay visually recessive, and they only carry data once the operator enables the
 * overlay.
 */
export function installCameraLayers(map: MapLibreMap): void {
  map.addSource(SRC_CAMERAS, { type: 'geojson', data: EMPTY });

  // A dim square: distinct in silhouette from every circular incident marker, so the two
  // are never confused at a glance.
  map.addLayer({
    id: 'camera-glow',
    type: 'circle',
    source: SRC_CAMERAS,
    minzoom: CAMERA_MIN_ZOOM,
    paint: {
      'circle-color': '#6fe3d0',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 11],
      'circle-blur': 1.2,
      'circle-opacity': 0.16,
    },
  });
  map.addLayer({
    id: LAYER_CAMERA,
    type: 'circle',
    source: SRC_CAMERAS,
    minzoom: CAMERA_MIN_ZOOM,
    paint: {
      'circle-color': '#08121a',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.6, 14, 5],
      'circle-stroke-color': '#6fe3d0',
      'circle-stroke-width': 1.1,
      'circle-stroke-opacity': 0.7,
      'circle-opacity': 0.85,
    },
  });
}
