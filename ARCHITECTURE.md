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

* **`SimulationSource`** — the default. A scenario-driven generator producing fictional
  incidents across Washington. Always labelled `SIMULATION`.
* **`PublicSafetyFeedSource`** — a generic, *configuration-driven* poller for publicly
  accessible structured incident feeds (JSON / GeoJSON over HTTPS). The field mapping is
  declared in config, so connecting a new open-data endpoint is a config change, not a
  code change. Disabled unless configured.
* **`PublicAudioSource`** — optional. Pulls a **publicly accessible** audio stream into a
  rolling buffer → `SpeechToText` → `IncidentExtractor`. Disabled by default.

The app never depends on a specific provider: the registry owns a list of `DataSource`s
and the pipeline only knows the interface.

### Legal / ethical boundaries (enforced in code, not just docs)

`server/src/sources/policy.ts` rejects any source URL that is not `https:` (or explicit
loopback for local development), and the audio source refuses to start without an
explicit `PUBLIC_AUDIO_ACK=1` acknowledgement. There is no support — and no code path —
for encrypted feeds, credentialed private feeds, or access-control circumvention.

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
