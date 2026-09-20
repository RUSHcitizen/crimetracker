/**
 * Verify a catalogued feed against live data.
 *
 * Open-data publishers rename columns without notice, so a mapping that was right when it
 * was written can silently resolve to nothing later. This fetches one page from the real
 * endpoint and prints, field by field, which candidate path matched and what it produced —
 * then runs the record through the actual normalizer so you see the incident the app would
 * store, including whether it got a usable position.
 *
 *   npm run probe:source              # list catalogued sources
 *   npm run probe:source -- seattle-fire-911
 */
import {
  SOURCE_CATALOG,
  WA_DATA_PORTALS,
  buildPollUrl,
  describeMapping,
  extractRecords,
  findCatalogSource,
  mapRecord,
  normalizeIncident,
  redactPollUrl,
} from '../shared/src/index.ts';

const id = process.argv[2];

if (!id) {
  const pad = 26;
  console.log('\nCatalogued sources:\n');
  for (const source of SOURCE_CATALOG) {
    const key = source.keyEnv ? `  · requires ${source.keyEnv}` : '';
    console.log(`  ${source.id.padEnd(pad)} ${source.name}`);
    console.log(
      `  ${''.padEnd(pad)} ${source.agency} · lag: ${source.latency} · precision: ${source.precision}${key}`,
    );
    console.log(`  ${''.padEnd(pad)} ${source.docsUrl}\n`);
  }

  console.log('Run several at once:   SOURCES=seattle-fire-911,nws-alerts-wa MODE=live npm run dev\n');

  console.log('Any other dataset can be connected without editing code:\n');
  console.log('  socrata:<portal-host>/<dataset-id>[@time_column]');
  console.log('  arcgis:<https FeatureServer layer url>[@TIME_FIELD]');
  console.log('  geojson:<https url>[@time_field]\n');
  console.log('Washington portals that publish public-safety data:\n');
  for (const portal of WA_DATA_PORTALS) {
    console.log(`  ${portal.host.padEnd(pad)} ${portal.name}`);
    console.log(`  ${''.padEnd(pad)} ${portal.example}\n`);
  }
  console.log(
    'Find the dataset id on the portal, then probe it before trusting it:\n' +
      '  npm run probe:source -- socrata:data.cityoftacoma.org/abcd-1234\n',
  );
  process.exit(0);
}

const source = findCatalogSource(id);
if (!source) {
  console.error(
    `Unknown source "${id}".\n` +
      `Catalogued: ${SOURCE_CATALOG.map((s) => s.id).join(', ')}\n` +
      'Or use an ad-hoc spec: socrata:<host>/<dataset-id>, arcgis:<layer url>, geojson:<url>.\n' +
      'Run `npm run sources` for the full list.',
  );
  process.exit(1);
}

// A publisher that issues a key cannot be probed without one.
const apiKey = source.keyEnv ? process.env[source.keyEnv] ?? '' : '';
if (source.keyEnv && !apiKey) {
  console.error(
    `\n${source.name} requires an access key.\n` +
      `Request a free one at ${source.docsUrl}, then:\n\n` +
      `  ${source.keyEnv}=<your-key> npm run probe:source -- ${source.id}\n`,
  );
  process.exit(1);
}

const url = buildPollUrl(source, { limit: 5, apiKey });
console.log(`\n${source.name}  (${source.agency})`);
// Never print the key, even to a terminal — these get pasted into issues.
console.log(`GET ${redactPollUrl(source, url)}\n`);

const response = await fetch(url, {
  headers: {
    accept: 'application/json, application/geo+json;q=0.9, */*;q=0.1',
    'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
  },
});

if (!response.ok) {
  console.error(`Request failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}

const body = await response.json();
const records = extractRecords(body, '');
console.log(`Returned ${records.length} record(s).\n`);

if (records.length === 0) {
  console.error('No records returned — the dataset may be empty, renamed or moved.');
  process.exit(1);
}

const record = records[0];
console.log('Raw keys present:');
const props = record?.properties ?? record?.attributes ?? record;
console.log('  ' + Object.keys(props ?? {}).join(', ') + '\n');

console.log('Field mapping:');
let unresolved = 0;
for (const { field, matched, value } of describeMapping(props, source.map)) {
  const shown = value === undefined ? '—' : String(value).slice(0, 52);
  if (matched === null) unresolved += 1;
  console.log(
    `  ${field.padEnd(12)} ${(matched ?? 'NO MATCH').padEnd(34)} ${shown}`,
  );
}

const raw = mapRecord(record, source.map);
if (!raw) {
  console.error('\nThis record could not be mapped at all — the mapping needs updating.');
  process.exit(1);
}

const result = normalizeIncident(
  { ...raw, locationPrecision: source.precision, area: source.area },
  { source: { id: source.id, name: source.name, kind: 'public-feed', note: source.note } },
);

console.log('\nNormalized incident:');
if (!result.ok) {
  console.error(`  REJECTED: ${result.reason}`);
  process.exit(1);
}
const incident = result.incident;
console.log(`  type        ${incident.incidentType}`);
console.log(`  severity    ${incident.severity}`);
console.log(`  time        ${incident.timestamp}`);
console.log(`  location    ${incident.location.label}`);
console.log(
  `  position    ${incident.coordinates ? `${incident.coordinates.lat}, ${incident.coordinates.lon}` : 'NOT DETERMINED'}` +
    `  (${incident.location.precision}${incident.location.approximate ? ', approximate' : ''})`,
);
console.log(`  confidence  ${incident.confidence}`);
if (result.warnings.length > 0) console.log(`  warnings    ${result.warnings.join(', ')}`);

/*
 * Some feeds carry their position in the feature's geometry rather than in a column, so
 * an unresolved lat/lon is expected for them and is not a fault. What matters is whether
 * a position came out the other end.
 */
const geometryPositioned = incident.coordinates != null && unresolved > 0;

console.log(
  unresolved === 0 && incident.coordinates
    ? '\nMapping looks healthy.\n'
    : geometryPositioned
      ? `\n${unresolved} field(s) resolved from geometry rather than columns — expected for ` +
        'this publisher. Position was produced.\n'
      : `\n${unresolved} field(s) did not resolve${incident.coordinates ? '' : ' and no position was produced'} — ` +
        'compare the raw keys above with the mapping in shared/src/catalog.ts.\n',
);
