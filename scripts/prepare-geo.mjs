/**
 * Builds the offline map geometry bundled with the web app.
 *
 * Source: the `us-atlas` package (US Census cartographic boundaries, public domain).
 * Output: plain GeoJSON in `web/src/geo/`, committed to the repo so the app renders with
 * **no third-party tile server** — which is both the aesthetic we want and one fewer
 * external dependency at runtime.
 *
 * Run with: npm run prepare:geo
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { feature, mesh } from 'topojson-client';

const WA_FIPS = '53';
// States (and the stretch of British Columbia we imply with the nation outline) that
// frame Washington on screen.
const NEIGHBOUR_FIPS = new Set(['41', '16', '30', '06', '32', '49', '56']);

const OUT_DIR = new URL('../web/src/geo/', import.meta.url);
mkdirSync(OUT_DIR, { recursive: true });

const counties = JSON.parse(readFileSync('node_modules/us-atlas/counties-10m.json', 'utf8'));

/** Drop coordinate precision — 4 decimals is ~11 m, far more than a state-scale map needs. */
function quantize(geometry, digits = 4) {
  const factor = 10 ** digits;
  const round = (n) => Math.round(n * factor) / factor;
  const walk = (coords) =>
    typeof coords[0] === 'number' ? [round(coords[0]), round(coords[1])] : coords.map(walk);
  return { ...geometry, coordinates: walk(geometry.coordinates) };
}

function write(name, collection) {
  const path = new URL(name, OUT_DIR);
  const json = JSON.stringify(collection);
  writeFileSync(path, json);
  console.log(`${name}: ${collection.features.length} features, ${(json.length / 1024).toFixed(0)} KB`);
}

/* --- Washington counties -------------------------------------------------- */
const allCounties = feature(counties, counties.objects.counties);
const waCounties = {
  type: 'FeatureCollection',
  features: allCounties.features
    .filter((f) => String(f.id).padStart(5, '0').startsWith(WA_FIPS))
    .map((f) => ({
      type: 'Feature',
      id: f.id,
      properties: { name: f.properties.name, fips: String(f.id).padStart(5, '0') },
      geometry: quantize(f.geometry),
    }))
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name)),
};
write('wa-counties.geo.json', waCounties);

/* --- Washington outline + internal county mesh ---------------------------- */
const states = JSON.parse(readFileSync('node_modules/us-atlas/states-10m.json', 'utf8'));
const allStates = feature(states, states.objects.states);

const waState = {
  type: 'FeatureCollection',
  features: allStates.features
    .filter((f) => String(f.id).padStart(2, '0') === WA_FIPS)
    .map((f) => ({
      type: 'Feature',
      properties: { name: f.properties.name },
      geometry: quantize(f.geometry),
    })),
};
write('wa-state.geo.json', waState);

// Interior county borders only (shared arcs), so the hairlines inside the state can be
// drawn at a different weight from the coastline.
const countyMesh = mesh(counties, counties.objects.counties, (a, b) => {
  if (a === b) return false;
  const aWa = String(a.id).padStart(5, '0').startsWith(WA_FIPS);
  const bWa = String(b.id).padStart(5, '0').startsWith(WA_FIPS);
  return aWa && bWa;
});
write('wa-county-mesh.geo.json', {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: quantize(countyMesh) }],
});

/* --- Neighbouring states (drawn dim, for context) ------------------------- */
const neighbours = {
  type: 'FeatureCollection',
  features: allStates.features
    .filter((f) => NEIGHBOUR_FIPS.has(String(f.id).padStart(2, '0')))
    .map((f) => ({
      type: 'Feature',
      properties: { name: f.properties.name },
      geometry: quantize(f.geometry, 3),
    })),
};
write('neighbour-states.geo.json', neighbours);
