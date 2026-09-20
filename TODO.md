# Crime Tracker — Implementation Plan

Status key: `[x]` done · `[~]` in progress · `[ ]` todo

## Phase 1 — Project setup + architecture
- [x] npm workspaces (`shared`, `server`, `web`), TS project references, Vitest
- [x] `ARCHITECTURE.md`, `TODO.md`
- [x] `.env.example`, config loader, `.gitignore`

## Phase 3 — Incident data model  *(built before the UI so both sides share it)*
- [x] `shared/taxonomy.ts` — incident types, severity scale, status lifecycle
- [x] `shared/schema.ts` — Zod schemas for raw + normalized incidents
- [x] `shared/normalize.ts` — validation, coordinate rejection, provenance
- [x] `shared/geo.ts` — haversine, bbox, WA region bounds

## Phase 4 — Simulation engine
- [x] WA place table (cities + neighbourhoods, real public coordinates)
- [x] Scenario-weighted generator: type, severity, description, transcript, confidence
- [x] Arrival process over time (Poisson-ish, diurnal weighting), burst scenarios
- [x] Processing-state progression (`received` → `transcribing` → … → `verified`)

## Phase 10 — Data source adapter architecture
- [x] `DataSource` interface + registry + status reporting
- [x] `SimulationSource`
- [x] `PublicSafetyFeedSource` (config-driven JSON/GeoJSON poller)
- [x] `policy.ts` — https-only, no credentialed/private feeds

## Database
- [x] SQLite schema (`sources`, `incidents`, `incident_provenance`, `extractions`, `clusters`)
- [x] Repository layer + filtered queries + stats aggregates

## Phase 5 — Realtime event system
- [x] Ingestion pipeline (normalize → persist → broadcast → re-run patterns)
- [x] `RealtimeHub` with snapshot + batched deltas
- [x] REST API (`/api/incidents`, `/api/stats`, `/api/patterns`, `/api/sources`, `/api/mode`)

## Phase 2 — Full-screen futuristic map UI
- [x] Offline MapLibre style (no third-party tiles), WA county geometry asset
- [x] Procedural graticule + glow/scan overlays
- [x] Clustered incident source, severity + type visualization
- [x] New-incident spawn animation

## Phase 6 — Incident detail HUD
- [x] Top bar, left panel, right panel, bottom event stream
- [x] Detail panel: transcript, extracted info, `APPROXIMATE LOCATION`, `AI-INFERRED`

## Phase 7 — Filtering / search
- [x] Type / severity / source / time-window filters
- [x] Geographic filter (place + radius) and map-bounds filter
- [x] Command search over type, location, source, keyword, time

## Phase 8 — Statistics
- [x] Analytics overlay: today, last hour, by category, by area, activity histogram, clusters

## Phase 9 — Pattern detection ("Spider Sense")
- [x] Spatio-temporal clustering + confidence scoring in `shared/patterns.ts`
- [x] Cinematic map emphasis + `PATTERN DETECTED` readout, labelled as inference
- [x] `VIEW CLUSTER` action wired to the map

## Phase 11 — Optional public-audio transcription pipeline
- [x] `AudioBuffer` → `SpeechToText` interface → transcript → extractor → incident
- [x] `PublicAudioSource`, disabled by default, explicit acknowledgement required

## Phase 12 — AI extraction
- [x] `IncidentExtractor` interface
- [x] `HeuristicExtractor` (default, local)
- [x] `OpenAICompatibleExtractor` (OpenAI / Ollama / vLLM / LM Studio)
- [x] Provenance tagging so inference is never shown as fact

## Phase 13 — Polish
- [x] Design tokens, angular panel chrome, scanlines, typography, transitions
- [x] Responsive: desktop → laptop → tablet → phone panel collapse
- [x] Optional sound system, **off by default**, generated (WebAudio) tones only

## Phase 14 — Testing + performance
- [x] Tests: normalization, coordinate validation, simulation, extraction, patterns, API, geo
- [x] Ring-buffered client state, selector subscriptions, GPU clustering
- [x] `README.md`
