-- Crime Tracker storage schema.
--
-- Deliberately plain SQL so the same shape ports to Postgres/PostGIS later: the only
-- SQLite-specific things here are the pragmas and the lack of a geometry type (we store
-- lat/lon columns and do distance filtering in the query layer).

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  url           TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id             TEXT PRIMARY KEY,
  timestamp      TEXT NOT NULL,          -- ISO 8601 UTC, incident time
  timestamp_ms   INTEGER NOT NULL,       -- denormalized for fast range scans
  ingested_at    TEXT NOT NULL,
  source_id      TEXT NOT NULL REFERENCES sources(id),
  source_kind    TEXT NOT NULL,
  incident_type  TEXT NOT NULL,
  severity       INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
  description    TEXT NOT NULL,
  location_label TEXT NOT NULL,
  location_area  TEXT,
  approximate    INTEGER NOT NULL,       -- 0/1
  precision      TEXT NOT NULL,
  lat            REAL,                   -- NULL when no trustworthy position exists
  lon            REAL,
  confidence     REAL NOT NULL,
  transcript     TEXT,
  status         TEXT NOT NULL,
  tags           TEXT NOT NULL DEFAULT '[]',  -- JSON array
  raw            TEXT,                        -- JSON, retained for audit
  search_blob    TEXT NOT NULL DEFAULT ''     -- lowercased haystack for keyword search
);

CREATE INDEX IF NOT EXISTS idx_incidents_time     ON incidents (timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_type     ON incidents (incident_type, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_source   ON incidents (source_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents (severity, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_geo      ON incidents (lat, lon);
CREATE INDEX IF NOT EXISTS idx_incidents_area     ON incidents (location_area);

-- Field-level provenance: what was reported by the source vs inferred by a model.
CREATE TABLE IF NOT EXISTS incident_provenance (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  origin      TEXT NOT NULL,
  confidence  REAL,
  note        TEXT,
  PRIMARY KEY (incident_id, field)
);

-- One row per extractor invocation, kept so an inference can be audited after the fact.
CREATE TABLE IF NOT EXISTS extractions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  extractor_id TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  confidence   REAL NOT NULL,
  result       TEXT NOT NULL,   -- JSON ExtractionResult
  notes        TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_extractions_incident ON extractions (incident_id);

-- Snapshot of detected concentrations, so the analytics view has history.
CREATE TABLE IF NOT EXISTS clusters (
  id           TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  center_lat   REAL NOT NULL,
  center_lon   REAL NOT NULL,
  radius_km    REAL NOT NULL,
  count        INTEGER NOT NULL,
  dominant_type TEXT NOT NULL,
  confidence   REAL NOT NULL,
  span_minutes INTEGER NOT NULL,
  payload      TEXT NOT NULL,   -- JSON PatternCluster
  PRIMARY KEY (id, detected_at)
);

CREATE INDEX IF NOT EXISTS idx_clusters_time ON clusters (detected_at DESC);
