# Crime Tracker

A public-safety **incident visualization** system: a full-screen holographic map of
Washington State with a dense technical HUD, fed by a pluggable ingestion pipeline and a
realtime WebSocket stream.

It ships with a simulation engine, so it is fully functional with nothing connected — and
it never presents simulated data as real.

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
* Every incident carries its source kind (`simulation` / `public-feed` / `audio`) and
  every field carries provenance, so `SOURCE INFORMATION` and `AI-INFERRED` values are
  never shown as the same thing.
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
```

### Keyboard

| Key | Action |
| --- | --- |
| `/` | command search |
| `A` | analytics |
| `P` | toggle pattern detection |
| `[` / `]` | collapse the left / right panel |
| `Esc` | close the overlay, or clear the selection |

## 3. Simulation mode

Simulation is the default (`MODE=simulation`). The engine generates fictional incidents
across Washington with realistic timing, categories, severities, descriptions, radio-style
transcripts, confidence values and processing states.

* Incidents arrive continuously (`SIM_INTERVAL_SECONDS`, diurnally weighted, Poisson
  inter-arrival times).
* Roughly 6% of ticks produce a **burst** — a tight run of related reports in one place —
  which is what Pattern Detection is there to find.
* Startup backfills `SIM_BACKFILL` incidents over `SIM_BACKFILL_HOURS`, so the interface
  is never empty on open.
* Some records deliberately arrive **without a usable position**, because real feeds do.
  They are listed and counted, and simply not plotted.
* Set `SIM_SEED` for a byte-identical run, which is useful for demos and screenshots.

The `SIMULATION` indicator in the top bar, the standing banner over the map, and the
`FICTIONAL RECORD` chip on every incident detail make the mode unmissable.

```bash
SIM_INTERVAL_SECONDS=4 SIM_BACKFILL=6000 npm run dev   # a much busier state
```

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

### Public safety feed

`PublicSafetyFeedSource` is a configuration-driven poller for publicly accessible JSON or
GeoJSON incident feeds. Connecting an open-data endpoint is a config change, not code:

```bash
FEED_URL=https://data.example.gov/resource/incidents.json
FEED_POLL_SECONDS=60
FEED_ITEMS_PATH=          # blank = the body is the array, or a GeoJSON FeatureCollection
FEED_MAP_ID=incident_number
FEED_MAP_TIMESTAMP=reported_datetime
FEED_MAP_TYPE=call_type
FEED_MAP_DESCRIPTION=description
FEED_MAP_LOCATION=block_address
FEED_MAP_LAT=latitude
FEED_MAP_LON=longitude
```

Rules the adapter enforces: the URL must be `https` (or loopback for local development),
it must carry no credentials, `429` triggers back-off rather than retries, and every
record goes through the same normalizer and schema validation as anything else.

Only connect feeds whose terms permit this use, and respect their rate limits.

### Live vs simulation

The mode governs **which sources actually run**, not just a label. Every configured
source is registered at startup, and the pipeline starts only those belonging to the
active mode: in live mode the simulation engine is genuinely stopped, so a simulated
incident cannot arrive while the interface reads LIVE.

Switching is refused when nothing could serve the requested mode — `POST /api/mode`
answers `409` with a reason, the indicator keeps showing the mode still in force, and the
top bar states why. A LIVE label the server did not agree to would defeat the point of
the indicator.

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

## 6. Optional public-audio pipeline

```
PUBLIC AUDIO → AUDIO BUFFER → SPEECH-TO-TEXT → TRANSCRIPT → INCIDENT EXTRACTION
```

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
                │                      ├── alarms     (simulation + feed polling)
                │                      └── WebSockets (hibernated fan-out)
                └── everything else ──► static assets (web/dist)
```

Why it is shaped this way:

* **One Durable Object owns the tracker.** A Worker is stateless and short-lived, so the
  incident store, the clock and the connected sockets all live in a single object. That
  restores the ordering and consistency guarantees the single-process Node server had.
* **The store is the same code.** `IncidentRepository` talks to a `SqlDriver`, so the
  identical queries run against `node:sqlite` on a server and the Durable Object's
  embedded SQLite on Cloudflare. Normalization, pattern detection and the simulation
  engine are runtime-neutral and shared verbatim.
* **Alarms replace `setInterval`.** A Durable Object alarm survives eviction, so the
  simulation and feed polling keep running when nobody is connected. A five-minute cron
  nudges the room awake as a backstop.
* **WebSocket hibernation** means idle clients cost nothing and the object can be evicted
  without dropping them.
* **Same origin** for the page, the API and the socket: no CORS, no API host in the
  client bundle, and cross-origin WebSocket upgrades are refused.

Run it locally against the real Workers runtime — no Cloudflare account needed:

```bash
npm run dev:worker        # builds the client, then serves on http://127.0.0.1:8788
```

Configuration lives in `wrangler.jsonc` under `vars` (mode, simulation rate, pattern
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
| `GET /api/stats` | aggregates and the activity timeline |
| `GET /api/patterns` | detected concentrations, with a standing disclaimer |
| `GET /api/sources` | adapter health |
| `POST /api/mode` | switch live / simulation |
| `WS /ws` | snapshot on connect, then batched deltas |

## 9. Testing

```bash
npm test
```

210 tests covering incident normalization, coordinate validation and rejection, timestamp
parsing, provenance rules, the simulation generator, the heuristic and OpenAI-compatible
extractors, source policy and feed mapping, the audio buffer, pattern detection
(including an equivalence check against a brute-force reference implementation and a
performance bound), the repository and statistics, mode switching (that a stopped source really produces
nothing), WebSocket origin enforcement, the realtime hub's batching, a live WebSocket
round-trip, the REST API including its input-validation behaviour, and the Worker's
configuration loader.

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
  returns booleans, not endpoints.
* Sound is off by default and, when enabled, uses WebAudio-generated tones only — there
  are no audio assets in this project.

## 11. Attribution

Boundary geometry: US Census Bureau cartographic boundary files (public domain), via the
`us-atlas` package. Everything else — the interface, the simulation engine, the pattern
detection and the visual design — is original to this project.
