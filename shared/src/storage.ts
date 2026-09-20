/**
 * The storage seam.
 *
 * Crime Tracker runs on Node (`node:sqlite`) and on Cloudflare (a Durable Object's
 * embedded SQLite). Both are SQLite, but their client APIs differ, so the repository
 * talks to this minimal driver instead of either one directly. That keeps a single
 * source of truth for the schema and every query.
 */

export type SqlParam = string | number | null;

export interface SqlDriver {
  /** Rows for a SELECT. */
  all<T>(sql: string, ...params: SqlParam[]): T[];
  /** First row of a SELECT, or `undefined`. */
  get<T>(sql: string, ...params: SqlParam[]): T | undefined;
  /** A write. Returns how many rows it changed. */
  run(sql: string, ...params: SqlParam[]): { changes: number };
  /** A statement with no bindings, used for DDL. */
  exec(sql: string): void;
}

/**
 * Schema as a list of individual statements.
 *
 * Kept as data rather than a `.sql` file so both runtimes apply exactly the same DDL —
 * a Worker cannot read a file off disk at runtime, and two hand-maintained copies would
 * drift.
 *
 * Deliberately plain SQL so the shape ports to Postgres/PostGIS later: the only
 * SQLite-specific parts are the pragmas (applied separately, since a Durable Object
 * manages its own) and the lack of a geometry type — lat/lon are columns and distance
 * filtering happens in the query layer.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sources (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     kind          TEXT NOT NULL,
     note          TEXT NOT NULL DEFAULT '',
     url           TEXT,
     first_seen_at TEXT NOT NULL,
     last_seen_at  TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS incidents (
     id             TEXT PRIMARY KEY,
     timestamp      TEXT NOT NULL,
     timestamp_ms   INTEGER NOT NULL,
     ingested_at    TEXT NOT NULL,
     source_id      TEXT NOT NULL REFERENCES sources(id),
     source_kind    TEXT NOT NULL,
     incident_type  TEXT NOT NULL,
     severity       INTEGER NOT NULL CHECK (severity BETWEEN 1 AND 5),
     description    TEXT NOT NULL,
     location_label TEXT NOT NULL,
     location_area  TEXT,
     approximate    INTEGER NOT NULL,
     precision      TEXT NOT NULL,
     lat            REAL,
     lon            REAL,
     confidence     REAL NOT NULL,
     transcript     TEXT,
     status         TEXT NOT NULL,
     tags           TEXT NOT NULL DEFAULT '[]',
     raw            TEXT,
     search_blob    TEXT NOT NULL DEFAULT ''
   )`,

  `CREATE INDEX IF NOT EXISTS idx_incidents_time     ON incidents (timestamp_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_type     ON incidents (incident_type, timestamp_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_source   ON incidents (source_id, timestamp_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents (severity, timestamp_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_geo      ON incidents (lat, lon)`,
  `CREATE INDEX IF NOT EXISTS idx_incidents_area     ON incidents (location_area)`,

  `CREATE TABLE IF NOT EXISTS incident_provenance (
     incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
     field       TEXT NOT NULL,
     origin      TEXT NOT NULL,
     confidence  REAL,
     note        TEXT,
     PRIMARY KEY (incident_id, field)
   )`,

  `CREATE TABLE IF NOT EXISTS extractions (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
     extractor_id TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     confidence   REAL NOT NULL,
     result       TEXT NOT NULL,
     notes        TEXT NOT NULL DEFAULT '[]'
   )`,

  `CREATE INDEX IF NOT EXISTS idx_extractions_incident ON extractions (incident_id)`,

  `CREATE TABLE IF NOT EXISTS clusters (
     id            TEXT NOT NULL,
     detected_at   TEXT NOT NULL,
     center_lat    REAL NOT NULL,
     center_lon    REAL NOT NULL,
     radius_km     REAL NOT NULL,
     count         INTEGER NOT NULL,
     dominant_type TEXT NOT NULL,
     confidence    REAL NOT NULL,
     span_minutes  INTEGER NOT NULL,
     payload       TEXT NOT NULL,
     PRIMARY KEY (id, detected_at)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_clusters_time ON clusters (detected_at DESC)`,
];

/** Apply the schema through any driver. Safe to call on every start. */
export function applySchema(driver: SqlDriver): void {
  for (const statement of SCHEMA_STATEMENTS) driver.exec(statement);
}
