/**
 * Verify an OpenMHz system against live data.
 *
 * OpenMHz is a volunteer-run service whose payload has changed shape before, and this
 * sandbox cannot reach it, so the field mapping here is written against recorded shapes
 * and candidate paths. This fetches one real page and prints what actually resolved: the
 * raw keys present, which candidate matched each field, how many calls are on which
 * talkgroup, and whether the audio URLs are on a host the fetch policy will allow.
 *
 * It downloads no audio and transcribes nothing — it is purely a shape check.
 *
 *   npm run probe:openmhz -- psern025
 *   npm run probe:openmhz -- psern025/1103,1104
 */
import {
  buildCallsUrl,
  buildTalkgroupsUrl,
  describeTalkgroup,
  DEFAULT_OPENMHZ_AUDIO_HOSTS,
  extractCalls,
  extractTalkgroups,
  indexTalkgroups,
  mapOpenMhzCall,
  openMhzSystemUrl,
  parseOpenMhzSpec,
} from '../shared/src/index.ts';
import { hostAllowed } from '../server/src/sources/policy.ts';

const arg = process.argv[2];

if (!arg) {
  console.log(`
Usage:  npm run probe:openmhz -- <system>[/<talkgroup,talkgroup>]

The system id is the last path segment of its page on openmhz.com, so
  https://openmhz.com/system/psern025   ->   npm run probe:openmhz -- psern025

Note that many Puget Sound law-enforcement talkgroups are encrypted and simply do not
appear in any archive. Nothing here decodes anything; a system with no clear traffic will
report zero calls, which is the honest answer rather than a fault.
`);
  process.exit(0);
}

const system = parseOpenMhzSpec(`openmhz:${arg}`);
if (!system) {
  console.error(`"${arg}" is not a valid system id (or talkgroup list).`);
  process.exit(1);
}

console.log(`\nOpenMHz system: ${system.shortName}`);
console.log(`Page:  ${openMhzSystemUrl(system)}`);
if (system.talkgroups.length > 0) {
  console.log(`Filtering to talkgroups: ${system.talkgroups.join(', ')}`);
}

const headers = {
  accept: 'application/json',
  'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
};

/* ---------------------------- talkgroup metadata ---------------------------- */

let talkgroups = new Map<number, ReturnType<typeof indexTalkgroups> extends Map<number, infer V> ? V : never>();
const tgUrl = buildTalkgroupsUrl(system);
console.log(`\nGET ${tgUrl}`);
try {
  const response = await fetch(tgUrl, { headers });
  if (!response.ok) {
    console.log(`  HTTP ${response.status} — calls will be labelled by talkgroup number.`);
  } else {
    const body = await response.json();
    const records = extractTalkgroups(body);
    talkgroups = indexTalkgroups(body);
    console.log(`  ${records.length} talkgroup record(s), ${talkgroups.size} mapped.`);
    if (records.length > 0 && talkgroups.size === 0) {
      console.log('  NONE MAPPED — the talkgroup shape has changed. Raw keys:');
      console.log(`    ${Object.keys(records[0] ?? {}).join(', ')}`);
    }
  }
} catch (error) {
  console.log(`  unreachable: ${String(error)}`);
}

/* --------------------------------- calls ----------------------------------- */

const callsUrl = buildCallsUrl(system);
console.log(`\nGET ${callsUrl}`);

const response = await fetch(callsUrl, { headers });
if (!response.ok) {
  console.error(`Request failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}

const body = await response.json();
const records = extractCalls(body);
console.log(`Returned ${records.length} call record(s).\n`);

if (records.length === 0) {
  console.error(
    'No calls returned. Either this system has no recent clear traffic, the short name is\n' +
      'wrong, or the response envelope has changed. Top-level keys were:\n  ' +
      Object.keys((body ?? {}) as object).join(', '),
  );
  process.exit(1);
}

console.log('Raw keys on the first record:');
console.log(`  ${Object.keys((records[0] ?? {}) as object).join(', ')}\n`);

const mapped = records
  .map((record) => mapOpenMhzCall(record, { shortName: system.shortName }))
  .filter((call): call is NonNullable<typeof call> => call !== null);

console.log(`Mapped ${mapped.length} of ${records.length}.`);
if (mapped.length === 0) {
  console.error('\nNothing mapped — compare the raw keys above with shared/src/openmhz.ts.');
  process.exit(1);
}

/* --------------------------- audio host policy ----------------------------- */

const hosts = new Map<string, number>();
for (const call of mapped) {
  try {
    const host = new URL(call.audioUrl).hostname;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  } catch {
    hosts.set('(unparseable)', (hosts.get('(unparseable)') ?? 0) + 1);
  }
}

console.log('\nAudio hosts seen:');
let blocked = 0;
for (const [host, count] of hosts) {
  const allowed = hostAllowed(host, DEFAULT_OPENMHZ_AUDIO_HOSTS);
  if (!allowed) blocked += count;
  console.log(`  ${allowed ? 'ALLOWED' : 'BLOCKED'}  ${host.padEnd(40)} ${count} call(s)`);
}
if (blocked > 0) {
  console.log(
    `\n  ${blocked} call(s) would be refused by the fetch policy. If the host above is\n` +
      '  legitimately OpenMHz, add it to OPENMHZ_AUDIO_HOSTS.',
  );
}

/* ------------------------------ what you'd get ------------------------------ */

const byTalkgroup = new Map<number, number>();
for (const call of mapped) {
  byTalkgroup.set(call.talkgroup, (byTalkgroup.get(call.talkgroup) ?? 0) + 1);
}

console.log('\nBusiest talkgroups in this page:');
for (const [num, count] of [...byTalkgroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const label = describeTalkgroup(
    { ...mapped[0]!, talkgroup: num },
    talkgroups,
  ).label;
  console.log(`  ${String(num).padEnd(8)} ${String(count).padStart(3)} call(s)  ${label}`);
}

const newest = mapped[0]!;
const span = mapped.map((c) => Date.parse(c.startedAt));
const shortCalls = mapped.filter((c) => c.durationSeconds > 0 && c.durationSeconds < 2).length;

console.log('\nNewest call:');
console.log(`  id          ${newest.id}`);
console.log(`  talkgroup   ${newest.talkgroup}  ${describeTalkgroup(newest, talkgroups).label}`);
console.log(`  started     ${newest.startedAt}`);
console.log(`  duration    ${newest.durationSeconds}s`);
console.log(`  audio       ${newest.audioUrl}`);

console.log(
  `\nPage spans ${new Date(Math.min(...span)).toISOString()} → ` +
    `${new Date(Math.max(...span)).toISOString()}.`,
);
console.log(`${shortCalls} call(s) under 2s would be skipped as squelch blips.`);
console.log(
  '\nMapping looks healthy. To ingest, you still need speech-to-text configured\n' +
    '(STT_PROVIDER=whisper-http + STT_BASE_URL) — without it the source runs inert,\n' +
    'because a talkgroup and a timestamp are not an incident.\n',
);
