import type { StyleSpecification } from 'maplibre-gl';
import { WASHINGTON_BBOX } from '@crimetracker/shared';
import { buildGraticule, toneOf } from './geometry.js';

import waCounties from '../geo/wa-counties.geo.json';
import waState from '../geo/wa-state.geo.json';
import waCountyMesh from '../geo/wa-county-mesh.geo.json';
import neighbourStates from '../geo/neighbour-states.geo.json';

/**
 * A completely offline MapLibre style.
 *
 * There is no tile server and no third-party basemap: the map is drawn from ~75 KB of
 * bundled Census boundary geometry plus a procedural graticule. That is both the look we
 * want — a wireframe instrument display rather than a photographic map — and one fewer
 * runtime dependency.
 *
 * No `glyphs` URL is declared and no symbol layers exist, because all map text is
 * rendered as DOM overlays in the HUD's own typography.
 */

const C = {
  void: '#04070a',
  neighbourFill: '#070b0f',
  neighbourLine: '#16232c',
  countyFill: '#0b1620',
  countyFillAlt: '#0f1e2a',
  mesh: '#3d7f99',
  outline: '#4fd8ff',
  grid: '#2a5d70',
  gridMajor: '#3a7f96',
} as const;

/** County polygons with a deterministic tone so the landmass has subtle depth. */
function tonedCounties(): GeoJSON.FeatureCollection {
  const source = waCounties as unknown as GeoJSON.FeatureCollection;
  return {
    type: 'FeatureCollection',
    features: source.features.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        tone: toneOf(String(feature.properties?.name ?? '')),
      },
    })),
  };
}

export function buildMapStyle(): StyleSpecification {
  return {
    version: 8,
    name: 'crime-tracker-holo',
    sources: {
      graticule: {
        type: 'geojson',
        data: buildGraticule(WASHINGTON_BBOX, 0.5, 2) as GeoJSON.GeoJSON,
      },
      // Finer grids that fade in as you zoom, so a close-up never becomes an empty
      // black field. Three tiers cover state scale down to neighbourhood scale.
      graticuleFine: {
        type: 'geojson',
        data: buildGraticule(WASHINGTON_BBOX, 0.05, 2) as GeoJSON.GeoJSON,
      },
      graticuleUltra: {
        type: 'geojson',
        data: buildGraticule(WASHINGTON_BBOX, 0.0125, 4) as GeoJSON.GeoJSON,
      },
      neighbours: { type: 'geojson', data: neighbourStates as unknown as GeoJSON.GeoJSON },
      counties: { type: 'geojson', data: tonedCounties() as GeoJSON.GeoJSON },
      countyMesh: { type: 'geojson', data: waCountyMesh as unknown as GeoJSON.GeoJSON },
      waState: { type: 'geojson', data: waState as unknown as GeoJSON.GeoJSON },
    },
    layers: [
      { id: 'void', type: 'background', paint: { 'background-color': C.void } },

      /* --- neighbouring states, kept very dim so WA reads as the subject --- */
      {
        id: 'neighbour-fill',
        type: 'fill',
        source: 'neighbours',
        paint: { 'fill-color': C.neighbourFill, 'fill-opacity': 0.9 },
      },
      {
        id: 'neighbour-line',
        type: 'line',
        source: 'neighbours',
        paint: { 'line-color': C.neighbourLine, 'line-width': 0.8, 'line-opacity': 0.75 },
      },

      /* --- Washington landmass -------------------------------------------- */
      {
        id: 'county-fill',
        type: 'fill',
        source: 'counties',
        paint: {
          // Alternating tone gives the state internal structure without labels.
          'fill-color': [
            'interpolate',
            ['linear'],
            ['get', 'tone'],
            0,
            C.countyFill,
            1,
            C.countyFillAlt,
          ],
          'fill-opacity': 0.95,
          'fill-outline-color': '#1b3d4c',
        },
      },
      {
        id: 'county-mesh',
        type: 'line',
        source: 'countyMesh',
        paint: {
          'line-color': C.mesh,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 9, 1, 13, 1.3],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 9, 0.62, 13, 0.4],
        },
      },

      /* --- state outline: a wide blurred pass under a crisp one ------------ */
      {
        id: 'wa-glow',
        type: 'line',
        source: 'waState',
        paint: {
          'line-color': C.outline,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 7, 10, 16],
          'line-blur': ['interpolate', ['linear'], ['zoom'], 5, 6, 10, 14],
          'line-opacity': 0.2,
        },
      },

      /* --- graticule over the landmass: the grid reads as an overlay on the
             display, not as terrain underneath it ------------------------- */
      {
        id: 'graticule-minor',
        type: 'line',
        source: 'graticule',
        filter: ['==', ['get', 'major'], 0],
        paint: {
          'line-color': C.grid,
          'line-width': 0.5,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 8, 0.4, 12, 0.18],
        },
      },
      {
        id: 'graticule-major',
        type: 'line',
        source: 'graticule',
        filter: ['==', ['get', 'major'], 1],
        paint: {
          'line-color': C.gridMajor,
          'line-width': 0.8,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.45, 9, 0.55, 13, 0.26],
        },
      },
      {
        id: 'graticule-ultra',
        type: 'line',
        source: 'graticuleUltra',
        minzoom: 11.5,
        paint: {
          'line-color': C.grid,
          'line-width': 0.5,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0, 13, 0.24, 16, 0.3],
        },
      },
      {
        id: 'graticule-fine',
        type: 'line',
        source: 'graticuleFine',
        minzoom: 8.5,
        paint: {
          'line-color': C.grid,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 0.8],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10.5, 0.45, 14, 0.5],
        },
      },
      {
        id: 'graticule-fine-major',
        type: 'line',
        source: 'graticuleFine',
        minzoom: 8.5,
        filter: ['==', ['get', 'major'], 1],
        paint: {
          'line-color': C.gridMajor,
          'line-width': 0.9,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 11, 0.5, 15, 0.55],
        },
      },
      {
        id: 'wa-outline',
        type: 'line',
        source: 'waState',
        paint: {
          'line-color': C.outline,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 9, 1.6, 13, 2],
          'line-opacity': 0.66,
        },
      },
    ],
  };
}

/** Initial camera: the whole state, slightly pitched so it reads as a table display. */
export const INITIAL_VIEW = {
  center: [-120.6, 47.32] as [number, number],
  zoom: 6.2,
  bearing: 0,
  pitch: 0,
  minZoom: 4.5,
  maxZoom: 16,
} as const;

export const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-131, 41.5],
  [-110, 52.5],
];
