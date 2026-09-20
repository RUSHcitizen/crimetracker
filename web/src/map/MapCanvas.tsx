import { useEffect, useRef } from 'react';
import maplibregl, { Map as MapLibreMap, type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Incident } from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { useFilteredIncidents } from '../state/selectors.js';
import { WA_PLACES } from '../lib/places.js';
import { buildMapStyle, INITIAL_VIEW, MAX_BOUNDS } from './style.js';
import {
  incidentsToGeoJson,
  installIncidentLayers,
  LAYER_CLUSTER_RING,
  LAYER_POINT,
  patternsToGeoJson,
  setSourceData,
  SRC_FOCUS,
  SRC_INCIDENTS,
  SRC_PATTERNS,
  SRC_SPAWN,
} from './incidentLayers.js';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** How long a newly-arrived incident keeps its expanding ring. */
const PING_MS = 2600;

interface ClusterLabel {
  lngLat: [number, number];
  text: string;
  el: HTMLDivElement;
}

interface PlaceLabel {
  readonly lngLat: [number, number];
  /** Minimum zoom at which this place is worth showing. */
  readonly minZoom: number;
  readonly el: HTMLDivElement;
}

/**
 * The map.
 *
 * Owns the MapLibre instance imperatively and reads from the store — React renders the
 * HUD, but never re-renders the map. Every data change is a `setData` call on an existing
 * source, so panning and zooming stay at frame rate regardless of incident count.
 */
export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const labelPool = useRef<ClusterLabel[]>([]);
  const placesRef = useRef<HTMLDivElement>(null);
  const placePool = useRef<PlaceLabel[]>([]);

  const incidents = useFilteredIncidents();
  const incidentsRef = useRef<readonly Incident[]>(incidents);
  incidentsRef.current = incidents;

  /* --------------------------- create the map --------------------------- */
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildMapStyle(),
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: INITIAL_VIEW.minZoom,
      maxZoom: INITIAL_VIEW.maxZoom,
      maxBounds: MAX_BOUNDS,
      attributionControl: false,
      // A dark instrument display should not fade to white on load.
      fadeDuration: 120,
      dragRotate: false,
      pitchWithRotate: false,
      touchZoomRotate: true,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    // No attribution control: this style uses no third-party tiles, and the credit for
    // the bundled boundary geometry lives in the source panel where it belongs.

    map.on('load', () => {
      installIncidentLayers(map);
      placePool.current = buildPlaceLabels(placesRef.current);
      readyRef.current = true;
      // Push whatever the store already holds.
      pushIncidents(map, incidentsRef.current);
      pushPatterns(map);
      publishBounds(map);
      positionPlaceLabels(map, placePool);
    });

    /* ------------------------------ interaction ------------------------- */
    const onPointClick = (event: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(event.point, { layers: [LAYER_POINT] });
      const id = features[0]?.properties?.id;
      if (typeof id === 'string') useTracker.getState().select(id);
    };

    const onClusterClick = (event: MapMouseEvent) => {
      const features = map.queryRenderedFeatures(event.point, { layers: [LAYER_CLUSTER_RING] });
      const feature = features[0];
      if (!feature) return;
      const clusterId = feature.properties?.cluster_id;
      const source = map.getSource(SRC_INCIDENTS) as GeoJSONSource | undefined;
      if (!source || typeof clusterId !== 'number') return;
      void source.getClusterExpansionZoom(clusterId).then((zoom) => {
        const geometry = feature.geometry as GeoJSON.Point;
        map.easeTo({
          center: geometry.coordinates as [number, number],
          zoom: Math.min(zoom + 0.4, INITIAL_VIEW.maxZoom),
          duration: 620,
        });
      });
    };

    const setPointer = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const clearPointer = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', LAYER_POINT, onPointClick);
    map.on('click', LAYER_CLUSTER_RING, onClusterClick);
    map.on('mouseenter', LAYER_POINT, setPointer);
    map.on('mouseleave', LAYER_POINT, clearPointer);
    map.on('mouseenter', LAYER_CLUSTER_RING, setPointer);
    map.on('mouseleave', LAYER_CLUSTER_RING, clearPointer);
    map.on('moveend', () => {
      publishBounds(map);
      syncClusterLabels(map, labelsRef.current, labelPool);
      positionPlaceLabels(map, placePool);
    });
    map.on('move', () => {
      positionClusterLabels(map, labelPool);
      positionPlaceLabels(map, placePool);
    });
    map.on('idle', () => syncClusterLabels(map, labelsRef.current, labelPool));

    // Clicking empty map clears the selection.
    map.on('click', (event) => {
      const hits = map.queryRenderedFeatures(event.point, {
        layers: [LAYER_POINT, LAYER_CLUSTER_RING],
      });
      if (hits.length === 0) useTracker.getState().select(null);
    });

    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /* --------------------- keep sources in sync with state ---------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    pushIncidents(map, incidents);
    syncClusterLabels(map, labelsRef.current, labelPool);
  }, [incidents]);

  useEffect(() => {
    const unsubscribe = useTracker.subscribe((state, prev) => {
      const map = mapRef.current;
      if (!map || !readyRef.current) return;
      if (state.patterns !== prev.patterns || state.ui.patternsVisible !== prev.ui.patternsVisible) {
        pushPatterns(map);
      }
    });
    return unsubscribe;
  }, []);

  /* --------------------- selection: focus ring + camera ----------------- */
  useEffect(() => {
    const unsubscribe = useTracker.subscribe((state, prev) => {
      if (state.selectedId === prev.selectedId) return;
      const map = mapRef.current;
      if (!map || !readyRef.current) return;

      const incident = state.selectedId ? state.byId.get(state.selectedId) : null;
      if (!incident?.coordinates) {
        setSourceData(map, SRC_FOCUS, EMPTY);
        return;
      }
      setSourceData(map, SRC_FOCUS, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Point',
              coordinates: [incident.coordinates.lon, incident.coordinates.lat],
            },
          },
        ],
      });
      map.easeTo({
        center: [incident.coordinates.lon, incident.coordinates.lat],
        zoom: Math.max(map.getZoom(), 10.5),
        duration: 900,
        essential: true,
      });
    });
    return unsubscribe;
  }, []);

  /* -------------------- pattern focus: frame the cluster ---------------- */
  useEffect(() => {
    const unsubscribe = useTracker.subscribe((state, prev) => {
      if (state.focusedPatternId === prev.focusedPatternId || !state.focusedPatternId) return;
      const map = mapRef.current;
      const pattern = state.patterns.find((p) => p.id === state.focusedPatternId);
      if (!map || !pattern) return;
      // Fit the cluster's radius with margin, so the whole emphasis ring is on screen.
      const dLat = Math.max(pattern.radiusKm, 0.5) / 110.574;
      const dLon =
        Math.max(pattern.radiusKm, 0.5) /
        (111.32 * Math.max(0.02, Math.cos((pattern.center.lat * Math.PI) / 180)));
      map.fitBounds(
        [
          [pattern.center.lon - dLon * 2.6, pattern.center.lat - dLat * 2.6],
          [pattern.center.lon + dLon * 2.6, pattern.center.lat + dLat * 2.6],
        ],
        { duration: 1100, padding: 90, essential: true },
      );
    });
    return unsubscribe;
  }, []);

  /* ------------------ animation loop: spawn pings + pulse --------------- */
  useEffect(() => {
    let frame = 0;
    let lastSpawnKey = '';

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const map = mapRef.current;
      if (!map || !readyRef.current) return;

      const now = Date.now();
      const state = useTracker.getState();

      /* --- newly arrived incidents get an expanding ring --- */
      const arrivals: GeoJSON.Feature<GeoJSON.Point>[] = [];
      let newest = 0;
      for (const [id, at] of state.recentArrivals) {
        const age = now - at;
        if (age > PING_MS) continue;
        const incident = state.byId.get(id);
        if (!incident?.coordinates) continue;
        newest = Math.max(newest, at);
        arrivals.push({
          type: 'Feature',
          properties: { sev: incident.severity, phase: age / PING_MS },
          geometry: {
            type: 'Point',
            coordinates: [incident.coordinates.lon, incident.coordinates.lat],
          },
        });
      }

      const key = `${arrivals.length}:${newest}`;
      if (key !== lastSpawnKey) {
        lastSpawnKey = key;
        setSourceData(map, SRC_SPAWN, { type: 'FeatureCollection', features: arrivals });
      }

      if (arrivals.length > 0 && map.getLayer('spawn-ping')) {
        // Radius and opacity are driven by each feature's own `phase`, so several pings
        // can be mid-flight at once without extra layers.
        map.setPaintProperty('spawn-ping', 'circle-radius', [
          'interpolate',
          ['linear'],
          ['get', 'phase'],
          0,
          4,
          1,
          46,
        ]);
        map.setPaintProperty('spawn-ping', 'circle-stroke-opacity', [
          'interpolate',
          ['linear'],
          ['get', 'phase'],
          0,
          0.95,
          0.75,
          0.25,
          1,
          0,
        ]);
        map.setPaintProperty('spawn-ping', 'circle-stroke-width', [
          'interpolate',
          ['linear'],
          ['get', 'phase'],
          0,
          2.2,
          1,
          0.5,
        ]);
      }

      /* --- pattern rings breathe, so analysis reads as *live* --- */
      if (map.getLayer('pattern-ring')) {
        const pulse = 0.55 + 0.25 * Math.sin(now / 620);
        map.setPaintProperty('pattern-ring', 'line-opacity', pulse);
        map.setPaintProperty('pattern-glow', 'line-opacity', 0.12 + 0.12 * Math.sin(now / 620));
      }

      /* --- selection reticle breathes too --- */
      if (map.getLayer('focus-ring') && state.selectedId) {
        map.setPaintProperty('focus-ring', 'circle-radius', 12 + 2.4 * Math.sin(now / 380));
      }

      state.pruneArrivals();
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  /* ------------------------------ resize -------------------------------- */
  useEffect(() => {
    const onResize = () => mapRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div className="mapstage">
      <div ref={containerRef} className="mapstage__canvas" aria-label="Incident map" role="region" />
      <div ref={placesRef} className="mapstage__places" aria-hidden="true" />
      <div ref={labelsRef} className="mapstage__labels" aria-hidden="true" />
      <div className="mapstage__frame" aria-hidden="true">
        <span className="mapstage__corner mapstage__corner--tl" />
        <span className="mapstage__corner mapstage__corner--tr" />
        <span className="mapstage__corner mapstage__corner--bl" />
        <span className="mapstage__corner mapstage__corner--br" />
      </div>
    </div>
  );
}

/* ------------------------------- helpers -------------------------------- */

function pushIncidents(map: MapLibreMap, incidents: readonly Incident[]): void {
  setSourceData(map, SRC_INCIDENTS, incidentsToGeoJson(incidents));
}

function pushPatterns(map: MapLibreMap): void {
  const state = useTracker.getState();
  setSourceData(
    map,
    SRC_PATTERNS,
    state.ui.patternsVisible ? patternsToGeoJson(state.patterns) : EMPTY,
  );
}

function publishBounds(map: MapLibreMap): void {
  const bounds = map.getBounds();
  useTracker
    .getState()
    .setViewportBounds([
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ]);
}

/**
 * Cluster counts are DOM labels rather than MapLibre symbols.
 *
 * That keeps the map free of any glyph server (so the style stays fully offline) and lets
 * the numbers use the same tracked monospace as the rest of the HUD. The set is rebuilt
 * only on `moveend`/`idle` and capped, then merely repositioned during movement.
 */
function syncClusterLabels(
  map: MapLibreMap,
  container: HTMLDivElement | null,
  pool: { current: ClusterLabel[] },
): void {
  if (!container || !map.getLayer(LAYER_CLUSTER_RING)) return;

  const features = map
    .queryRenderedFeatures({ layers: [LAYER_CLUSTER_RING] })
    .slice(0, 80);

  // Grow the pool as needed; elements are reused across syncs.
  while (pool.current.length < features.length) {
    const el = document.createElement('div');
    el.className = 'cluster-label';
    container.appendChild(el);
    pool.current.push({ lngLat: [0, 0], text: '', el });
  }

  features.forEach((feature, index) => {
    const entry = pool.current[index];
    if (!entry) return;
    const geometry = feature.geometry as GeoJSON.Point;
    const count = Number(feature.properties?.point_count ?? 0);
    entry.lngLat = geometry.coordinates as [number, number];
    const text = count > 999 ? `${(count / 1000).toFixed(1)}K` : String(count);
    if (entry.text !== text) {
      entry.text = text;
      entry.el.textContent = text;
    }
    entry.el.style.display = '';
  });

  for (let i = features.length; i < pool.current.length; i += 1) {
    const entry = pool.current[i];
    if (entry) entry.el.style.display = 'none';
  }

  positionClusterLabels(map, pool);
}

/**
 * Static place markers.
 *
 * Without them the state outline is hard to read — a tick and a name at each major city
 * gives the map somewhere to anchor, still with no tile server involved. Larger places
 * appear first as you zoom out.
 */
function buildPlaceLabels(container: HTMLDivElement | null): PlaceLabel[] {
  if (!container) return [];
  container.replaceChildren();
  return WA_PLACES.map((place) => {
    const el = document.createElement('div');
    el.className = 'place-label';
    const tick = document.createElement('span');
    tick.className = 'place-label__tick';
    const name = document.createElement('span');
    name.className = 'place-label__name';
    name.textContent = place.label.toUpperCase();
    el.append(tick, name);
    container.appendChild(el);
    // The radius we assigned each place doubles as a rough prominence score.
    const minZoom = place.radiusKm >= 13 ? 0 : place.radiusKm >= 9 ? 7.1 : 8.2;
    return { lngLat: [place.lon, place.lat], minZoom, el };
  });
}

function positionPlaceLabels(map: MapLibreMap, pool: { current: PlaceLabel[] }): void {
  const zoom = map.getZoom();
  for (const entry of pool.current) {
    if (zoom < entry.minZoom) {
      entry.el.style.opacity = '0';
      continue;
    }
    const point = map.project(entry.lngLat);
    entry.el.style.opacity = '';
    entry.el.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
  }
}

function positionClusterLabels(map: MapLibreMap, pool: { current: ClusterLabel[] }): void {
  for (const entry of pool.current) {
    if (entry.el.style.display === 'none') continue;
    const point = map.project(entry.lngLat);
    entry.el.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0) translate(-50%, -50%)`;
  }
}
