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
  buildPollUrl,
  describeMapping,
  extractRecords,
  findCatalogSource,
  mapRecord,
  normalizeIncident,
} from '../shared/src/index.ts';

const id = process.argv[2];

if (!id) {
  console.log('\nCatalogued sources:\n');
  for (const source of SOURCE_CATALOG) {
    console.log(`  ${source.id.padEnd(24)} ${source.name}`);
    console.log(`  ${''.padEnd(24)} ${source.agency} · lag: ${source.latency} · precision: ${source.precision}`);
    console.log(`  ${''.padEnd(24)} ${source.docsUrl}\n`);
  }
  console.log('Probe one with:  npm run probe:source -- <id>\n');
  process.exit(0);
}

const source = findCatalogSource(id);
if (!source) {
  console.error(`Unknown source "${id}". Known: ${SOURCE_CATALOG.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const url = buildPollUrl(source, { limit: 5 });
console.log(`\n${source.name}  (${source.agency})`);
console.log(`GET ${url}\n`);

const response = await fetch(url, {
  headers: {
    accept: 'application/json',
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

console.log(
  unresolved === 0 && incident.coordinates
    ? '\nMapping looks healthy.\n'
    : `\n${unresolved} field(s) did not resolve${incident.coordinates ? '' : ' and no position was produced'} — ` +
      'compare the raw keys above with the mapping in shared/src/catalog.ts.\n',
);
