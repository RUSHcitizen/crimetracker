# Crime Tracker

A public-safety **incident visualization** system: a full-screen holographic map of
Washington State with a dense technical HUD, fed by a pluggable ingestion pipeline and a
realtime WebSocket stream.

It runs on real published agency data, and only on real published agency data. Seattle
Fire 911 dispatch, SPD calls for service, SPD offence reports, WSDOT statewide roadway
incidents, National Weather Service warnings and USGS seismic events are catalogued and
one setting away; any other portal dataset can be connected from configuration; archived
public scanner calls are wired in as an audio source; and an optional overlay shows
WSDOT's public roadway cameras beside the incidents.

There is **no simulation engine**. The system has no way to generate an incident of its
own, so an empty map means the publishers had nothing to report — not that a mode is set
wrongly. Click any incident for a short plain-language brief, which the browser can read
aloud.

```
npm install
npm run dev          # http://localhost:5173
```

---

## What this is, and what it is not

* It **is** a visualization and analysis tool for publicly accessible incident data.
* It is **not** a dispatch system, and not a prediction system.
* Pattern Detection describes concentrations in reports **already received**. It is
  labelled `ANALYTICAL INFERENCE` everywhere it appears, and it forecasts nothing.
* Every incident carries its source kind (`public-feed` / `audio` / `manual`) and every
  field carries provenance, so `SOURCE INFORMATION` and `AI-INFERRED` values are never
  shown as the same thing. There is no `simulation` kind and no `simulated` provenance
  origin — the vocabulary for a fabricated record does not exist in the codebase.
* It consumes **publicly accessible** data only. There is no support — and no code path —
  for encrypted feeds, credentialed private sources, rate-limit evasion, or any form of
  access-control circumvention. `server/src/sources/policy.ts` enforces this at runtime.

---

## 1. Installation

Requires **Node.js ≥ 22.5** (the server uses the built-in `node:sqlite`, so there is no
native build step).

```bash
git clone <this repo>
cd crimetracker
npm install
cp .env.example .env     # optional — every value has a working default
```

## 2. Development

```bash
npm run dev
```

Starts two processes:

| Process | Port | What |
| --- | --- | --- |
| API + WebSocket | 8787 | Fastify, SQLite, ingestion pipeline |
| Web client | 5173 | Vite dev server, proxies `/api` and `/ws` to the API |

Open **http://localhost:5173**. Within a second or two you should see a populated map,
a live event stream, and at least one detected pattern.

Other scripts:

```bash
npm test           # the full test suite
npm run typecheck  # tsc across all three workspaces
npm run build      # production build
npm start          # serve the production API
npm run prepare:geo # regenerate the bundled map geometry from us-atlas
npm run sources     # list catalogued feeds and the portals you can add
npm run probe:source -- <id>      # check a feed mapping against live data
npm run probe:openmhz -- <system> # check a radio system before wiring it up
```

### Keyboard

| Key | Action |
| --- | --- |
| `/` | command search |
| `A` | analytics |
| `P` | toggle pattern detection |
| `C` | toggle the public roadway-camera overlay |
| `V` | toggle reading each selected incident aloud |
| `[` / `]` | collapse the left / right panel |
| `Esc` | close the overlay, or clear the selection |

## 3. Briefs and voice

Agency data is written for dispatchers, not readers: `BURGLARY - IN PROGRESS`,
`1500 BLOCK OF 3RD AVE`, `EventCategory: Collision`. Selecting an incident shows a short
plain-language brief at the top of the detail panel, and the browser can read it aloud.

```
A traffic report at I-5 southbound at milepost 157, 5 minutes ago. Reported as:
Collision blocking the right lane of southbound I-5 near Boeing Access Rd. Note that
the position is approximate, to about block level, and the category was inferred from
the text rather than stated by the source. Severity 2 of 5, low.
Source: WSDOT Highway Alerts.
```

Two generators, and the interface never confuses them:

| | Chip | When |
| --- | --- | --- |
| Composed locally from the record's fields | `COMPOSED` (amber) | the default — no key, no network |
| Written by a language model | `AI-WRITTEN` (violet) | when `AI_PROVIDER=openai-compatible` is configured |

Violet is this interface's colour for inference everywhere, so a model-written brief reads
as one at a glance. The model is given an allow-listed view of the record — never the raw
publisher payload, which can carry internal codes and identifiers, and never the
coordinates — and is instructed to rephrase rather than add. If it is unreachable, returns
nothing, or starts writing something other than a brief, the composed version is shown
instead: an accurate sentence beats a plausible fabrication.

**Neither generator adds facts.** Every clause traces to a field of the incident. No cause,
no suspect, no outcome, no severity the record did not carry — those would be assertions
about real events and, often, about real people.

**Voice** uses the browser's own speech synthesis, so nothing is sent anywhere to be
voiced and there are no audio assets in this project. It is off until you ask for it:
`▶ SPEAK` reads the current brief once, `AUTO` reads each incident as you select it.
Changing selection stops the previous one mid-sentence rather than queueing a backlog.

## 4. Configuring data sources

Sources implement one interface (`server/src/sources/types.ts`):

```ts
interface DataSource {
  readonly descriptor: SourceDescriptor;
  status(): SourceStatus;
  start(ctx: SourceContext): Promise<void>;
  stop(): Promise<void>;
}
```

`server/src/sources/registry.ts` is the only place that names concrete adapters, so adding
a provider is one new file plus one registry entry.

### Real data: the source catalogue

`shared/src/catalog.ts` ships a catalogue of real datasets published by the agencies
themselves. Connecting one is an id, not a field-mapping exercise:

```bash
npm run sources                          # list what is catalogued
npm run probe:source -- seattle-fire-911 # check the mapping against live data
```

```bash
SOURCES=seattle-fire-911,seattle-police-calls npm run dev
```

| id | What it is | Lag | Position | Key |
| --- | --- | --- | --- | --- |
| `seattle-fire-911` | Seattle Fire 911 dispatch — live calls | minutes | street address | — |
| `seattle-police-calls` | SPD calls for service | hours | **blurred by SPD to block level** | — |
| `seattle-crime-reports` | SPD offence reports (NIBRS) | days, revised | area | — |
| `wsdot-highway-alerts` | Statewide roadway incidents: collisions, closures, debris, police activity | minutes | route + milepost | `WSDOT_ACCESS_CODE` |
| `nws-alerts-wa` | NWS warnings, watches and advisories for WA | seconds | polygon centroid, or none | — |
| `usgs-earthquakes-wa` | Seismic events inside the WA bounding box | minutes | epicentre estimate | — |

`wsdot-highway-alerts` is the broadest genuinely real-time public incident feed for
Washington and the one worth turning on first if you want a map that moves. It needs a
free access code from <https://wsdot.wa.gov/traffic/api/>; the same code enables the
camera overlay below. The key is read server-side, appended per request, kept out of the
source descriptor the browser receives, and stripped from logs and error messages.

### Any other published dataset

The catalogue is a convenience, not a ceiling. Rather than shipping a list of dataset ids
that quietly rot — agencies retire and re-publish datasets constantly — any portal dataset
can be connected from configuration:

```bash
SOURCES=socrata:data.cityoftacoma.org/abcd-1234@occurred_date
SOURCES=arcgis:https://services.arcgis.com/<org>/ArcGIS/rest/services/<layer>/FeatureServer/0
SOURCES=geojson:https://example.gov/incidents.geojson
```

`npm run sources` lists the Washington portals that publish public-safety data
(`data.seattle.gov`, `data.wa.gov`, `data.kingcounty.gov`, `data.cityoftacoma.org`,
`data.bellevuewa.gov`, `geo.wa.gov`). Find the dataset on the portal, then:

```bash
npm run probe:source -- socrata:data.cityoftacoma.org/abcd-1234
```

Column names for an ad-hoc source are resolved against a list of conventions used across
US open-data portals, which covers most public-safety datasets on the first try. Anything
that does not resolve is reported by the probe rather than silently dropped. Positions
from an unmapped feed are treated as **area-level**: we do not know whether the publisher
rounds, blurs or geocodes, and claiming anything finer would assert a precision nobody
stated.

Three things the adapter takes seriously:

* **Precision is the publisher's, not a guess.** Seattle PD deliberately blurs the
  coordinates it releases. The catalogue records that, so those incidents render as
  `APPROXIMATE LOCATION` at block level and are never drawn as precise points.
* **Lag is stated.** "An offence report filed last week" and "a call dispatched two
  minutes ago" must not look identical on a live map, so each source carries its
  publication lag into the HUD.
* **Polling is incremental.** Each adapter speaks its publisher's dialect for *newest
  since X* (Socrata `$where`/`$order`, ArcGIS `where`/`orderByFields` with `outSR=4326`,
  USGS `starttime`), so a poll fetches new records rather than re-downloading the
  dataset. Where a publisher documents no such parameter — WSDOT does not — the dedup set
  does the work instead. `429` backs off; `401`/`403` says which variable to check rather
  than retrying into a wall.

Column names drift — publishers rename fields without notice. Each mapping therefore
lists candidate paths, and `npm run probe:source` prints which one actually resolved
against a live record plus the incident that would be stored. Run it before trusting a
feed.

Check each dataset's own terms and rate limits before pointing a continuous poller at it.

### Public roadway cameras

An optional overlay of still images that WSDOT publishes for road conditions, shown beside
incidents so you can see what the weather and traffic near a reported event look like. Off
unless `WSDOT_ACCESS_CODE` is set; toggle with `C` or the `CAM` control.

The scope is deliberate, and it is the whole feature:

* Positions and image URLs only. The images are loaded by the viewer's browser straight
  from the agency, exactly as on the agency's own traveller-information site. Nothing is
  proxied, recorded or re-hosted here.
* Cameras are **not incidents**. They are held in a separate collection, never written to
  the incident store, never counted in the statistics, and never seen by the pattern
  detector. They are drawn as small square teal markers so they cannot be mistaken at a
  glance for a report that something happened.
* The use notice ships with the picture — rendered in the card, not buried in these docs.
* The browser is told to fetch these URLs, so the hosts it can be pointed at are an
  allow-list (`CAMERA_IMAGE_HOSTS`), not something an upstream record decides. Cameras
  whose image lives elsewhere, or that are outside the region, or that the agency has
  retired, are dropped and *counted* — the tally appears under the source list, because an
  overlay that silently loses half its cameras looks identical to one that is simply
  sparse.
* The directory is fetched rarely (`CAMERAS_REFRESH_MINUTES`, default 6 hours): the list
  of cameras an agency operates changes over months. A failed refresh serves the previous
  copy marked stale rather than emptying the overlay.

What this is **not** is any form of camera analysis. See section 11.

### Police radio (OpenMHz)

Archived public scanner calls, as a first-class source. OpenMHz aggregates recordings made
by community-run receivers and publishes them as discrete *calls* — each one a clip with a
talkgroup, a start time and a duration. Point at a system by the id in its page URL:

```bash
SOURCES=openmhz:psern025 OPENMHZ_ACK=1 npm run dev
#   https://openmhz.com/system/psern025   ->   openmhz:psern025
```

Narrow to specific talkgroups with `+` (not `,` — `SOURCES` is itself comma-separated):

```bash
SOURCES=openmhz:psern025/1103+1104
```

Check what a system actually carries before wiring it up. This downloads no audio and
transcribes nothing; it is purely a shape check:

```bash
npm run probe:openmhz -- psern025
```

**Nothing here decodes anything.** A receiver captures what is broadcast in the clear;
encrypted talkgroups produce no intelligible audio and are not published. So this reads
already-public recordings of already-unencrypted traffic, and the rule in section 11
stands untouched. The practical consequence is worth stating plainly: much of Puget Sound
law-enforcement dispatch *is* encrypted and will simply not appear, so what a given system
carries varies enormously. The probe tells you before you build on it.

**It needs speech-to-text.** Set `STT_PROVIDER=whisper-http` and `STT_BASE_URL` (section
5 — a local Whisper server works and keeps the audio on your machine). Without it the
source registers, reports `degraded`, explains why, and fetches nothing: a talkgroup and a
timestamp are not an incident, and manufacturing one from them is exactly what this
project exists not to do.

What comes out is explicit about which parts are real:

| Field | Origin |
| --- | --- |
| timestamp | **source** — the recorder's own call start time |
| transcript | **source** — verbatim, stored unedited |
| location label | **derived** from the talkgroup's own metadata, or **ai-inferred** if a model read an address out of the transcript |
| type, severity, description | **ai-inferred** from the transcript |
| coordinates | **always `null`** |

That last row is not a limitation to route around. A transcript cannot establish a
position, so a radio-only deployment produces a full incident stream over an empty map,
and the HUD says so rather than filling it with invented points.

Being a good citizen is part of the adapter, not a footnote: OpenMHz is volunteer-run, so
only genuinely new calls are fetched, audio is never re-downloaded, transcription is
sequential and capped per poll (`OPENMHZ_MAX_CALLS_PER_POLL`), clips under
`OPENMHZ_MIN_CALL_SECONDS` are skipped before they cost anyone anything, and `429` backs
off hard. Read the service's terms before pointing a continuous poller at it.

Two things the adapter refuses to do. It **discards `srcList`** — the radio identifiers of
the units that transmitted — because a radio ID is a persistent handle on a specific unit
and keeping it across calls would build exactly the movement history of identifiable
people that section 11 rules out. And it **will not fetch call audio from an arbitrary
host**: those URLs arrive inside feed records and are fetched server-side, so they go
through an allow-list (`OPENMHZ_AUDIO_HOSTS`) that also refuses private and loopback
addresses outright.

One thing to weigh before you expose a deployment: **transcripts are verbatim radio
traffic**, and dispatch traffic routinely contains names, addresses, plate numbers and
medical details about private individuals. Storing them is what makes the provenance model
work — you can see exactly what the model read. But it means your database holds that
material, so think about who can reach it.

### Generic feed

For a source not in the catalogue, `FEED_URL` plus a field mapping still works — see
`.env.example`. `CT_CATALOG_OVERRIDE_URL` points a catalogued source at a mirror or a
local stub without forking the entry.

### No modes

Every registered source is started, because every source reads published public-safety
data. There is nothing to switch between, no `MODE` setting, and no `POST /api/mode`
endpoint — a request to put this system into generating its own records does not exist.

If nothing is configured the server says so on startup and the map stays empty, which is
the honest outcome. The top bar names the sources actually online rather than a mode.

## 5. Configuring AI extraction

Extraction is provider-agnostic (`server/src/extraction/types.ts`):

```ts
interface IncidentExtractor {
  readonly id: string;
  extract(input: { transcript: string; receivedAt: string }): Promise<ExtractionResult>;
}
```

| Provider | Setting | Notes |
| --- | --- | --- |
| `heuristic` | default | Local keyword/regex parser. No network, no key, no data leaves the machine. |
| `openai-compatible` | `AI_BASE_URL` + `AI_MODEL` | OpenAI, Ollama, vLLM, LM Studio, … |

```bash
# OpenAI
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_API_KEY=sk-...

# Ollama, entirely local
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_MODEL=llama3.1
```

A remote provider is wrapped in `FallbackExtractor`, so a timeout or a malformed response
degrades to the local parser instead of breaking ingestion.

Three rules the extraction layer will not bend:

1. **An extractor never returns coordinates.** Prose cannot establish a position, so the
   model is not permitted to supply one and its output is discarded if it tries.
2. **Model output never overwrites a source-held field.** It fills gaps only.
3. **Everything it produces is tagged `ai-inferred`** and rendered in violet under
   `EXTRACTED INFORMATION`, separately from `SOURCE INFORMATION`.

The API key is read from the server environment and is never sent to the browser.

## 6. Optional public-audio pipeline (police radio)

```
PUBLIC AUDIO → AUDIO BUFFER → SPEECH-TO-TEXT → TRANSCRIPT → INCIDENT EXTRACTION
```

**Read this before enabling it.** Most large Washington agencies — Seattle PD and King
County among them — now encrypt their primary dispatch channels. Encrypted traffic is
permanently out of scope: this project will not decode it and there is no setting that
makes it try. What is available is whatever an agency still broadcasts in the clear, which
in this region is considerably less than people expect.

Where lawful unencrypted audio does exist, point this at a stream you are permitted to
process. Aggregator sites generally forbid automated capture in their terms; an archive
API you have access to, or your own receiver, is the usual lawful route.

Structured feeds are preferred over audio wherever a source offers both: a dispatch record
carries a time, a type and a position, while a transcript carries none of those reliably.

Disabled by default. It requires **both** a stream URL and an explicit acknowledgement,
so pointing it anywhere is always deliberate:

```bash
PUBLIC_AUDIO_URL=https://example.org/public-stream.mp3
PUBLIC_AUDIO_ACK=1          # confirms the stream is lawfully and publicly accessible
STT_PROVIDER=whisper-http
STT_BASE_URL=https://api.openai.com/v1
STT_MODEL=whisper-1
STT_API_KEY=sk-...
```

Incidents derived this way never carry coordinates — a transcript cannot establish a
position — so they are stored with an approximate, text-only location and shown with
`APPROXIMATE LOCATION` and `AI-INFERRED`.

Structured data is always preferred over audio where a source offers both.

## 7. Production build

```bash
npm run build
npm start                 # API on $PORT, default 8787
```

`npm run build` compiles `shared` and `server` to `dist/` and builds the client to
`web/dist/`. Serve `web/dist` from any static host and point it at the API, or put both
behind one reverse proxy so `/api` and `/ws` are same-origin.

Set `DATABASE_PATH` to a persistent volume and `RETENTION_HOURS` to bound growth
(incidents older than the retention window are pruned at startup).

## 7b. Deploying to Cloudflare

The deployed configuration runs on **real data out of the box**: `wrangler.jsonc` sets
`SOURCES` to the three catalogued sources that need no credential (`seattle-fire-911`,
`nws-alerts-wa`, `usgs-earthquakes-wa`), so a fresh deployment shows real incidents with
nothing further to set up.

Briefs on the Worker are the composed kind. A per-click model call inside a Durable Object
competes with ingestion for the same subrequest budget, so model-written briefs are a
Node-server feature for now; the wording of a composed brief is identical on both, because
both call the same function in `shared`.

To add statewide roadway incidents and the camera overlay, both of which need WSDOT's
free access code:

```bash
npx wrangler secret put WSDOT_ACCESS_CODE
# then add wsdot-highway-alerts to SOURCES in wrangler.jsonc
```

There is no mode to configure. The Worker ingests the sources in `SOURCES` and has no
other behaviour available to it.

Radio (`openmhz:`) is a Node-server source. Transcribing call audio does not fit a Durable
Object's CPU and subrequest budget, so the Worker registers such a source in an error
state naming the Node server rather than dropping it silently.

The project also runs on Cloudflare Workers, with no Node server at all:

```bash
npx wrangler login        # once, or set CLOUDFLARE_API_TOKEN
npm run deploy            # builds the client, then `wrangler deploy`
```

### Continuous deployment (Workers Builds)

Connect the repository in the Cloudflare dashboard and leave the defaults:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` (or `npm run build:web` — the Worker does not need the Node server built) |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(leave empty — the repository root)* |

`wrangler.jsonc` sits at the repository root for this reason. Workers Builds runs the
deploy command from the root; with the config nested under `worker/`, wrangler finds no
config, falls back to auto-detection, sees an npm workspace root and fails with *"The
Cloudflare application detection logic has been run in the root of a workspace instead of
targeting a specific project."* Keeping the config at the root makes the default commands
work with no dashboard configuration. `main` and `assets.directory` inside it are
resolved relative to the config file.

That publishes one Worker that serves everything from a single origin:

```
  request ──► Worker (worker/src/index.ts)
                ├── /api/*, /ws  ──► Durable Object "TrackerRoom"
                │                      ├── SQLite     (incident store)
                │                      ├── alarms     (feed polling)
                │                      └── WebSockets (hibernated fan-out)
                └── everything else ──► static assets (web/dist)
```

Why it is shaped this way:

* **One Durable Object owns the tracker.** A Worker is stateless and short-lived, so the
  incident store, the clock and the connected sockets all live in a single object. That
  restores the ordering and consistency guarantees the single-process Node server had.
* **The store is the same code.** `IncidentRepository` talks to a `SqlDriver`, so the
  identical queries run against `node:sqlite` on a server and the Durable Object's
  embedded SQLite on Cloudflare. Normalization, pattern detection and brief composition
  engine are runtime-neutral and shared verbatim.
* **Alarms replace `setInterval`.** A Durable Object alarm survives eviction, so the
  feed polling keeps running when nobody is connected. A five-minute cron
  nudges the room awake as a backstop.
* **WebSocket hibernation** means idle clients cost nothing and the object can be evicted
  without dropping them.
* **Same origin** for the page, the API and the socket: no CORS, no API host in the
  client bundle, and cross-origin WebSocket upgrades are refused.

Run it locally against the real Workers runtime — no Cloudflare account needed:

```bash
npm run dev:worker        # builds the client, then serves on http://127.0.0.1:8788
```

Configuration lives in `wrangler.jsonc` under `vars` (sources, pattern
thresholds, `FEED_URL` and its field mapping). Secrets never go there:

```bash
npx wrangler secret put AI_API_KEY
```

Locally, put secrets in `.dev.vars` at the repository root (gitignored; see
`.dev.vars.example`).

The optional public-audio pipeline is **not** part of the Cloudflare build: it needs a
long-lived streaming connection, which a Worker request does not provide. Structured
feeds — the preferred source anyway — work identically on both runtimes.

## 8. Architecture

Full detail in [`ARCHITECTURE.md`](./ARCHITECTURE.md). In short:

```
shared/   isomorphic model, validation, normalization, geo math, pattern detection
server/   sources, ingestion pipeline, extraction, SQLite, HTTP + WS API
web/      MapLibre map, HUD, realtime client
```

```
 PUBLIC DATA / SIMULATION / PUBLIC AUDIO
               ↓  DataSource
          INGESTION
               ↓
   TRANSCRIPTION → AI EXTRACTION        (optional, off by default)
               ↓
       NORMALIZATION  ← validation, coordinate rejection, provenance
               ↓
          INCIDENT → SQLite
               ↓
      REALTIME HUB → WebSocket /ws + REST /api/*
               ↓
        FRONTEND MAP + HUD
```

### The map has no tile server

The basemap is ~75 KB of US Census cartographic boundary geometry (public domain) bundled
into the client, plus a procedurally generated graticule. There is no third-party
basemap, no tile requests, and no API key — which is both the wireframe look the project
wants and one fewer runtime dependency. Regenerate it with `npm run prepare:geo`.

Incidents live in a single clustered GeoJSON source rendered by MapLibre on the GPU, so
thousands of incidents cost a handful of layers rather than thousands of DOM nodes.

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | mode, uptime, ingestion counters |
| `GET /api/config` | the non-secret client configuration |
| `GET /api/incidents` | filter by type, severity, source, time, bbox, radius, keyword |
| `GET /api/incidents/:id` | one incident with full provenance |
| `GET /api/incidents/:id/brief` | plain-language brief, with its origin (`derived` / `ai-inferred`) |
| `GET /api/stats` | aggregates and the activity timeline |
| `GET /api/patterns` | detected concentrations, with a standing disclaimer |
| `GET /api/sources` | adapter health |
| `GET /api/cameras` | public roadway-camera directory, with attribution and use notice |
| `WS /ws` | snapshot on connect, then batched deltas |

## 9. Testing

```bash
npm test
```

339 tests covering incident normalization, coordinate validation and rejection, timestamp
parsing, provenance rules, the heuristic and OpenAI-compatible
extractors, source policy and feed mapping, the audio buffer, pattern detection
(including an equivalence check against a brute-force reference implementation and a
performance bound), the repository and statistics, mode switching (that a stopped source really produces
nothing), WebSocket origin enforcement, the realtime hub's batching, a live WebSocket
round-trip, the REST API including its input-validation behaviour, and the Worker's
configuration loader, the real-source catalogue (mapping against recorded response shapes
for every publisher, incremental poll URLs in each dialect, rate-limit back-off, polygon
centroids, ASP.NET timestamps, and that no catalogued source ever claims exact positions),
ad-hoc source specs and their rejection rules, publisher access keys (that only declared
variables are read, that a keyed source without its key is skipped rather than started,
and that the key never reaches the descriptor, the public config, a log or an error
message), the camera directory (host allow-list, region filter, retired cameras, cache
and stale-on-failure behaviour), the OpenMHz radio adapter (call mapping against recorded
shapes, the acknowledgement and speech-to-text gates, client-side talkgroup filtering,
squelch-blip and per-poll caps, rate-limit back-off, watermarking and dedup, the
server-side fetch allow-list and its SSRF refusals, and that unit radio identifiers never
reach storage), the brief generators (that a composed brief states the caveats the record
carries and invents nothing, that the model is handed only an allow-listed view with the
raw publisher payload and coordinates withheld, that unusable model output falls back to
the composed brief rather than being shown, and that briefs are generated once per
incident), and that the vocabulary for a fabricated incident no longer exists.

## 10. Security notes

* All external data — feeds, model output, transcripts, query parameters — is parsed with
  Zod, length-clamped, and stripped of control and bidi characters before storage.
* Coordinates are validated and range-checked; anything that fails becomes `null` rather
  than a guess. Null island and out-of-region points are rejected.
* Search terms are bound parameters, and `LIKE` metacharacters are escaped.
* WebSocket upgrades are checked against the same origin allow-list as CORS. CORS does
  not cover WebSockets, so without this any page could open a socket to the local server
  and read the stream. Requests with no `Origin` header (curl, tests, native clients) are
  allowed.
* No API key, base URL or credential is ever sent to the browser; `GET /api/config`
  returns booleans, not endpoints. A publisher access key is appended per request, never
  stored in the catalogue, never placed in the source descriptor that is broadcast over
  the WebSocket, and stripped from any log line or error message — network errors quote
  the full request URL, so this is not theoretical.
* Only the key variables the configured sources actually declare are read from the
  environment, so an unrelated secret sitting beside them is never collected.
* Camera image URLs are checked against a host allow-list before the browser is told to
  load them. What hosts a viewer's browser can be pointed at is not a decision an upstream
  record gets to make.
* Media URLs that arrive inside feed records and are fetched *server-side* — OpenMHz call
  audio — go through `assertFetchableMediaUrl`, which is stricter than the ordinary source
  policy: https only with no loopback exception, no credentials, an operator-controlled
  host allow-list, and an outright refusal of loopback, link-local and RFC1918 addresses.
  A feed that could name `169.254.169.254` or an address inside the deployment's own
  network is a server-side request forgery surface, and it is treated as one.
* Sound is off by default and, when enabled, uses WebAudio-generated tones only — there
  are no audio assets in this project. Spoken briefs use the browser's own speech
  synthesis, so nothing is sent anywhere to be voiced, and they are off until asked for.
* A language model is handed an allow-listed projection of an incident, never the record
  itself: the publisher's raw payload and the coordinates are withheld, and model output
  is length-clamped and sanitised before it can reach the DOM.

## 11. Out of scope

Some things this project deliberately does not do, and will not be extended to do:

* **Decode encrypted radio.** No workaround, no setting, no exception. The OpenMHz source
  in section 4 is not a qualification of this: a community receiver captures what is
  broadcast in the clear, encrypted talkgroups yield no intelligible audio and are never
  published, and this project reads the resulting public archive. Nothing in it attempts
  decryption, and no configuration can make it try.
* **Analyse camera or CCTV footage to infer crimes.** Two separate problems. The feeds
  usually described as "open cameras" are unsecured private devices whose owners never
  intended public access, and reaching them is unauthorised access however easy it is.
  And inferring criminality about identifiable people from video produces accusations,
  not observations — the opposite of a system built to keep source fact and inference
  visibly apart.

  The roadway-camera overlay in section 4 is the legitimate subset and the whole of it:
  stills an agency publishes for public display of road conditions, shown as-is. There is
  no path from `shared/src/cameras.ts` to an image analyser, no annotation drawn over a
  frame, and no description generated from one. A still shown as published is an
  observation; the same still with a model's guess written across it is an accusation
  about whoever happens to be in shot.
* **Identify or track individuals.** Nothing here is keyed to a person, and the incident
  model has no field for one. Concretely: OpenMHz call metadata carries `srcList`, the
  radio identifiers of the units that transmitted, and this project drops it at the
  adapter boundary. A radio ID is a persistent handle on a specific unit; retaining it
  across calls would be a movement history of identifiable people, which is not a feature
  worth having at any price. A test asserts it never reaches storage.
* **Predict crime.** Pattern Detection describes concentrations in reports already
  received, and says so wherever it appears.

## 12. Attribution

Boundary geometry: US Census Bureau cartographic boundary files (public domain), via the
`us-atlas` package.

Incident data, where configured, is published by and belongs to the originating agency:
City of Seattle Open Data (Seattle Fire Department, Seattle Police Department), the
Washington State Department of Transportation, NOAA / the National Weather Service, and
the U.S. Geological Survey Earthquake Hazards Program. Each catalogue entry carries the
attribution the publisher asks for and it is shown in the source panel. Roadway camera
imagery remains WSDOT's and is displayed from their servers, not copied. Check each
dataset's own terms before running a continuous poller against it.

Radio recordings, where configured, are hosted by [OpenMHz](https://openmhz.com) and were
made by volunteer operators running trunk-recorder. It is a community service on a
hobbyist budget — poll it gently, and read its terms.

Incident data, when live sources are enabled, comes from the publishing agency and carries
its attribution in the source panel — for the catalogued sources, the City of Seattle Open
Data portal and the Seattle Police and Fire Departments.

Everything else — the interface, the pattern detection and the
visual design — is original to this project.
