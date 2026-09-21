# Crime Tracker — Architecture

Crime Tracker is a **public-safety incident visualization system**. It ingests incident
reports from pluggable sources, normalizes them into a single validated `Incident` model,
stores them locally, streams them to the browser over WebSocket, and renders them on a
full-screen holographic map with a technical HUD.

It is **not** a dispatch system, not a prediction system, and it never presents simulated
data as real. Every incident carries its `source.kind` (`simulation` / `public-feed` /
`audio`) and every field carries provenance (`source` vs `ai-inferred` vs `derived`).

---

## 1. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (ESM) everywhere | one model shared by server + client |
| Server | Fastify 5 + `@fastify/websocket` | small, fast, first-class WS |
| Database | `node:sqlite` (built into Node ≥ 22.5) | zero native build step, real SQL, easy to swap |
| Validation | Zod | untrusted input is parsed, never trusted |
| Client | React 19 + Vite 7 | fast HMR, modern |
| Map | MapLibre GL JS 5 | GPU rendering, native clustering, no vendor lock-in |
| State | Zustand (+ selector subscriptions) | avoids global re-renders at 1000s of incidents |
| Tests | Vitest | one runner across all workspaces |

Workspaces:

```
shared/   isomorphic model, validation, normalization, geo math, pattern detection
server/   ingestion pipeline, sources, extraction, database, HTTP + WS API
web/      map, HUD, realtime client
```

`shared/` is imported by both sides, so the browser and the server agree bit-for-bit on
what a valid incident is.

---

## 2. Data pipeline

```
          PUBLIC DATA / SIMULATION / PUBLIC AUDIO
                          |
                    [ DataSource ]           sources/*.ts — pluggable adapters
                          |  RawIncident
                    [ INGESTION ]            pipeline/ingest.ts
                          |
                 [ TRANSCRIPTION ]           audio/* (optional, off by default)
                          |  transcript
                 [ AI EXTRACTION ]           extraction/* (provider-agnostic, off by default)
                          |  ExtractionResult (+ provenance)
                  [ NORMALIZATION ]          shared/normalize.ts — validate & clamp
                          |  Incident
                    [ DATABASE ]             db/ — SQLite, WAL
                          |
                  [ REALTIME HUB ]           pipeline/hub.ts — fan-out
                          |
              WebSocket /ws  +  REST /api/*
                          |
                   FRONTEND MAP + HUD
```

Every stage is synchronous-in-order per incident and non-blocking across incidents, so a
slow extractor never stalls ingestion of other sources.

### `DataSource` interface

```ts
interface DataSource {
  readonly descriptor: SourceDescriptor;      // id, name, kind, legalNote
  status(): SourceStatus;                      // connection, lastEventAt, counters, error
  start(ctx: SourceContext): Promise<void>;    // ctx.emit(raw), ctx.log(), ctx.setStatus()
  stop(): Promise<void>;
}
```

Implementations shipped:

* **`PublicSafetyFeedSource`** — a generic, *configuration-driven* poller for publicly
  accessible structured incident feeds (JSON / GeoJSON over HTTPS). The field mapping is
  declared in config, so connecting a new open-data endpoint is a config change, not a
  code change. Disabled unless configured.
* **`CatalogFeedSource`** — the normal way to connect real data. Drives an entry from
  `shared/src/catalog.ts`, which names a published agency dataset along with what its
  coordinates actually mean, how far behind it runs, and how to ask it for *newest since
  X* in its own dialect. Selected by id (`SOURCES=seattle-fire-911`), or by an ad-hoc
  spec (`socrata:<host>/<dataset>`, `arcgis:<layer url>`, `geojson:<url>`) for a dataset
  nobody has catalogued. Where a publisher issues an access key it is held per source,
  appended per request, and kept out of the descriptor, the logs and every error message.
* **`OpenMhzCallSource`** — optional. Polls a public radio-call archive (OpenMHz), which
  publishes *discrete* recordings rather than a stream: each call carries an exact
  timestamp and a talkgroup, so deduplication is exact, only genuinely new audio is ever
  fetched, and the talkgroup supplies the one non-inferred place signal radio traffic
  offers. Call → `SpeechToText` → `IncidentExtractor` → incident, with coordinates always
  `null`. Requires an explicit acknowledgement and a real speech-to-text provider; without
  the latter it runs inert and says so rather than manufacturing incidents out of
  timestamps. Unit radio identifiers (`srcList`) are discarded at the adapter boundary.
* **`PublicAudioSource`** — optional. Pulls a **publicly accessible** audio stream into a
  rolling buffer → `SpeechToText` → `IncidentExtractor`. Disabled by default. Where a
  source offers discrete archived calls, prefer `OpenMhzCallSource`: a stream has to guess
  where one transmission ends and the next begins, and an archive does not.

The app never depends on a specific provider: the registry owns a list of `DataSource`s
and the pipeline only knows the interface.

**There are no modes.** Every registered source is started, because every source reads
published public-safety data. The system has no generator, so there is nothing to switch
between, no `MODE` setting and no endpoint that would put it into producing records of its
own. An empty map means the publishers had nothing to report.

The vocabulary is gone too: `SOURCE_KINDS` has no `simulation` and `PROVENANCE_ORIGINS`
has no `simulated`. Reintroducing a generator would have to reintroduce those first, in
the open, rather than a fabricated record quietly passing validation.

### Briefs

`shared/src/brief.ts` composes a short plain-language account of an incident from its own
fields, deterministically — the same function on both runtimes, so a brief is worded
identically wherever it is generated. `server/src/brief/` adds a model-backed generator
for the same job and a bounded per-incident cache.

The constraint on both is that a brief **adds no facts**: every clause traces to a field
of the incident. The model is given an allow-listed projection rather than the record —
no raw publisher payload, no coordinates — and unusable output falls back to the composed
brief. The two are labelled differently wherever they appear (`AI-WRITTEN` in violet,
`COMPOSED` in amber), because a fluent sentence about a real incident, read aloud, is
exactly the kind of output that gets taken as established fact.

### Not incidents: the camera overlay

`shared/src/cameras.ts` and `server/src/cameras/directory.ts` provide public roadway
camera positions and image URLs as a **separate resource** from incidents — a different
endpoint, a different client collection, a different map layer and a different colour.
Cameras never enter the incident store, the statistics or the pattern detector, because a
camera is a view of a road and an incident is a report that something happened; a design
that blurred the two would be the interface lying about what the data is.

The images are loaded by the viewer's browser straight from the agency and are never
recorded, proxied or analysed. Image URLs are validated against a host allow-list before
the browser is pointed at them. There is no path from this module to an image analyser
and none should be added — see the README's *Out of scope*.

### Legal / ethical boundaries (enforced in code, not just docs)

`server/src/sources/policy.ts` rejects any source URL that is not `https:` (or explicit
loopback for local development), refuses URLs carrying credentials, and the audio sources
refuse to start without an explicit acknowledgement (`PUBLIC_AUDIO_ACK=1`,
`OPENMHZ_ACK=1`).

It draws a second, stricter line for URLs that arrive *inside external data* and are
fetched server-side — call audio named by a feed record. `assertFetchableMediaUrl` drops
the loopback exception, requires an operator-controlled host allow-list, and refuses
loopback, link-local and RFC1918 addresses outright. An operator-supplied URL and an
attacker-influenced one are not the same kind of input and are not checked the same way. Ad-hoc source
specs are held to the same rule before they are even built into a source. There is no
support — and no code path — for encrypted feeds, credentialed private feeds, or
access-control circumvention. A publisher's own freely-issued access code (WSDOT) is the
one credential the system carries, and it is used exactly as that agency intends: to
identify a consumer of public traveller data, not to reach anything non-public.

---

## 3. The `Incident` model

```ts
{
  id, timestamp, ingestedAt,
  source:   { id, name, kind, url? },
  incidentType, severity (1–5), description,
  location: { label, approximate, precision, area? },
  coordinates: { lat, lon } | null,     // null when undeterminable — never invented
  confidence: 0–1,
  transcript: string | null,
  status: 'received'|'transcribing'|'extracting'|'normalized'|'verified'|'unresolved',
  provenance: { [field]: { origin: 'source'|'ai-inferred'|'derived', confidence?, note? } },
  tags, raw
}
```

Rules that the normalizer enforces (`shared/src/normalize.ts`):

1. Coordinates are validated numerically and rejected if outside the configured region;
   an invalid coordinate becomes `null`, never a guess.
2. A location known only by name is stored with `approximate: true` and the UI must
   render `APPROXIMATE LOCATION`.
3. Anything produced by the AI extractor is recorded in `provenance` with
   `origin: 'ai-inferred'` and rendered with an `AI-INFERRED` chip. A model output can
   never silently overwrite a source-provided field.
4. Timestamps must parse and must not be implausibly far in the future.
5. Free text is length-clamped and control characters stripped before storage.

---

## 4. Storage

SQLite via `node:sqlite`, WAL mode. Tables: `sources`, `incidents`, `incident_provenance`,
`extractions`, `clusters`. Indexes on `(timestamp)`, `(incident_type)`, `(lat, lon)`,
`(source_id)`. JSON columns hold the raw payload and tags. The repository layer is the
only thing that touches SQL, so swapping to Postgres/PostGIS later means reimplementing
one module.

---

## 5. Realtime

A single `RealtimeHub` owns connected WebSocket clients. On connect a client receives a
`snapshot` (recent incidents, stats, patterns, source status, mode). Thereafter it
receives deltas: `incident`, `incident:update`, `patterns`, `stats`, `source`, `mode`.
Outbound frames are batched on a 100 ms tick so a burst of ingestion is one paint.

## 6. Pattern Detection ("Spider Sense")

`shared/src/patterns.ts` is pure and therefore testable and runnable on either side. It
runs a spatio-temporal DBSCAN-style scan over the recent window:

* group incidents within `epsKm` (haversine) **and** `windowMinutes` of each other,
* require `minPoints`,
* score `confidence` from density, temporal tightness, type repetition and sample size.

Output is a `PatternCluster` with centroid, radius, span, dominant type and a
human-readable rationale. It is explicitly labelled **ANALYTICAL INFERENCE** in the UI —
it describes concentrations in data already received, it does not forecast anything.

## 7. AI extraction

```ts
interface IncidentExtractor {
  readonly id: string;
  extract(input: { transcript: string; receivedAt: string }): Promise<ExtractionResult>;
}
```

* `HeuristicExtractor` — dependency-free keyword/regex extractor, always available, used
  as the default and as a fallback when a remote provider fails.
* `OpenAICompatibleExtractor` — targets any OpenAI-compatible `/chat/completions`
  endpoint (OpenAI, Ollama, vLLM, LM Studio, …) via `AI_BASE_URL` + `AI_MODEL`. The API
  key lives only in the server environment and is never sent to the browser.

Extractor output is validated by the same Zod schema as any other untrusted input, and
its fields are tagged `ai-inferred`.

## 8. Frontend

* **`MapCanvas`** — MapLibre with a hand-authored *offline* style: no third-party tiles.
  Washington county geometry ships as a local GeoJSON asset, and the grid/graticule is
  generated procedurally. Incidents live in **one** clustered GeoJSON source, so
  thousands of incidents cost a handful of GPU layers, not thousands of DOM nodes.
* **HUD** — `TopBar`, `LeftPanel`, `RightPanel`, `BottomPanel`, `PatternOverlay`,
  `StatsView`, `CommandSearch`, all absolutely positioned above the map and driven by
  narrow Zustand selectors.
* **Realtime client** — one WebSocket with exponential backoff; incoming incidents are
  appended to a ring buffer capped at `MAX_INCIDENTS` to bound memory.
