import { haversineKm } from './geo.js';
import { INCIDENT_TYPE_META, SEVERITY_LABEL } from './taxonomy.js';
import type { SqlDriver } from './storage.js';
import type {
  ExtractionResult,
  Incident,
  IncidentQuery,
  PatternCluster,
  ProvenanceField,
  ProvenanceMap,
  SourceDescriptor,
  Stats,
  StatsBucket,
  TimeBucket,
} from './types.js';

interface IncidentRow {
  id: string;
  timestamp: string;
  timestamp_ms: number;
  ingested_at: string;
  source_id: string;
  source_kind: string;
  incident_type: string;
  severity: number;
  description: string;
  location_label: string;
  location_area: string | null;
  approximate: number;
  precision: string;
  lat: number | null;
  lon: number | null;
  confidence: number;
  transcript: string | null;
  status: string;
  tags: string;
  raw: string | null;
  source_name: string;
  source_url: string | null;
}

/**
 * The only module that speaks SQL.
 *
 * It talks to a `SqlDriver` rather than any particular database client, so the same
 * queries run against `node:sqlite` on a server and a Durable Object's embedded SQLite on
 * Cloudflare. Everything above works with `Incident` objects, so moving to
 * Postgres/PostGIS means reimplementing this file and nothing else.
 */
export class IncidentRepository {
  readonly #db: SqlDriver;
  readonly #sourceCache = new Map<string, SourceDescriptor>();

  /**
   * Takes a `SqlDriver` rather than a concrete database handle, so the same queries run
   * against `node:sqlite` on a server and against a Durable Object's SQLite on Workers.
   */
  constructor(db: SqlDriver) {
    this.#db = db;
  }

  /* ------------------------------- sources -------------------------------- */

  upsertSource(descriptor: SourceDescriptor): void {
    const now = new Date().toISOString();
    this.#db.run(`INSERT INTO sources (id, name, kind, note, url, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           note = excluded.note,
           url = excluded.url,
           last_seen_at = excluded.last_seen_at`, descriptor.id,
        descriptor.name,
        descriptor.kind,
        descriptor.note,
        descriptor.url ?? null,
        now,
        now,
    );
    this.#sourceCache.set(descriptor.id, descriptor);
  }

  /* ------------------------------ incidents ------------------------------- */

  insertIncident(incident: Incident): void {
    const searchBlob = [
      incident.incidentType,
      INCIDENT_TYPE_META[incident.incidentType].label,
      incident.description,
      incident.location.label,
      incident.location.area ?? '',
      incident.source.name,
      incident.transcript ?? '',
      incident.tags.join(' '),
      SEVERITY_LABEL[incident.severity],
    ]
      .join(' \u0001 ')
      .toLowerCase();

    this.#db.run(`INSERT INTO incidents (
           id, timestamp, timestamp_ms, ingested_at, source_id, source_kind, incident_type,
           severity, description, location_label, location_area, approximate, precision,
           lat, lon, confidence, transcript, status, tags, raw, search_blob
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           incident_type = excluded.incident_type,
           severity      = excluded.severity,
           description   = excluded.description,
           location_label= excluded.location_label,
           location_area = excluded.location_area,
           approximate   = excluded.approximate,
           precision     = excluded.precision,
           lat           = excluded.lat,
           lon           = excluded.lon,
           confidence    = excluded.confidence,
           transcript    = excluded.transcript,
           status        = excluded.status,
           tags          = excluded.tags,
           search_blob   = excluded.search_blob`, incident.id,
        incident.timestamp,
        Date.parse(incident.timestamp),
        incident.ingestedAt,
        incident.source.id,
        incident.source.kind,
        incident.incidentType,
        incident.severity,
        incident.description,
        incident.location.label,
        incident.location.area,
        incident.location.approximate ? 1 : 0,
        incident.location.precision,
        incident.coordinates?.lat ?? null,
        incident.coordinates?.lon ?? null,
        incident.confidence,
        incident.transcript,
        incident.status,
        JSON.stringify(incident.tags),
        incident.raw === undefined ? null : safeJson(incident.raw),
        searchBlob,
    );

    const stmtSql = `INSERT INTO incident_provenance (incident_id, field, origin, confidence, note)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(incident_id, field) DO UPDATE SET
         origin = excluded.origin, confidence = excluded.confidence, note = excluded.note`;
    for (const [field, entry] of Object.entries(incident.provenance)) {
      if (!entry) continue;
      this.#db.run(stmtSql, incident.id, field, entry.origin, entry.confidence ?? null, entry.note ?? null);
    }
  }

  insertExtraction(incidentId: string, result: ExtractionResult): void {
    this.#db.run(`INSERT INTO extractions (incident_id, extractor_id, created_at, confidence, result, notes)
         VALUES (?, ?, ?, ?, ?, ?)`, incidentId,
        result.extractorId,
        new Date().toISOString(),
        result.confidence,
        JSON.stringify(result),
        JSON.stringify(result.notes),
    );
  }

  getIncident(id: string): Incident | null {
    const row = this.#db.get(`${SELECT_INCIDENT} WHERE i.id = ?`, id) as IncidentRow | undefined;
    if (!row) return null;
    return this.#hydrate(row, this.#provenanceFor([row.id]));
  }

  queryIncidents(query: IncidentQuery = {}): Incident[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.types?.length) {
      where.push(`i.incident_type IN (${query.types.map(() => '?').join(',')})`);
      params.push(...query.types);
    }
    if (query.sources?.length) {
      where.push(`i.source_id IN (${query.sources.map(() => '?').join(',')})`);
      params.push(...query.sources);
    }
    if (query.minSeverity != null) {
      where.push('i.severity >= ?');
      params.push(query.minSeverity);
    }
    if (query.sinceMinutes != null) {
      where.push('i.timestamp_ms >= ?');
      params.push(Date.now() - query.sinceMinutes * 60_000);
    }
    if (query.from) {
      where.push('i.timestamp_ms >= ?');
      params.push(Date.parse(query.from));
    }
    if (query.to) {
      where.push('i.timestamp_ms <= ?');
      params.push(Date.parse(query.to));
    }
    if (query.bbox) {
      const [west, south, east, north] = query.bbox;
      where.push('i.lon BETWEEN ? AND ? AND i.lat BETWEEN ? AND ?');
      params.push(Math.min(west, east), Math.max(west, east), Math.min(south, north), Math.max(south, north));
    }
    if (query.q) {
      // Simple contains-match over the precomputed haystack. Bound-parameterised, so the
      // user's text is never concatenated into SQL.
      for (const term of query.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
        where.push('i.search_blob LIKE ? ESCAPE \'\\\'');
        params.push(`%${escapeLike(term)}%`);
      }
    }
    if (query.near) {
      // Cheap bounding-box prefilter; exact haversine filtering happens below.
      const dLat = query.near.radiusKm / 111.32;
      const dLon = query.near.radiusKm / (111.32 * Math.max(0.05, Math.cos((query.near.lat * Math.PI) / 180)));
      where.push('i.lat BETWEEN ? AND ? AND i.lon BETWEEN ? AND ?');
      params.push(query.near.lat - dLat, query.near.lat + dLat, query.near.lon - dLon, query.near.lon + dLon);
    }

    const limit = Math.min(query.limit ?? 500, 5000);
    const offset = query.offset ?? 0;
    const sql = `${SELECT_INCIDENT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.timestamp_ms DESC LIMIT ? OFFSET ?`;
    // Over-fetch when a radius filter will drop rows after the SQL pass.
    params.push(query.near ? limit * 3 : limit, offset);

    let rows = this.#db.all(sql, ...params) as unknown as IncidentRow[];
    if (query.near) {
      const near = query.near;
      rows = rows
        .filter(
          (r) =>
            r.lat != null &&
            r.lon != null &&
            haversineKm({ lat: r.lat, lon: r.lon }, { lat: near.lat, lon: near.lon }) <= near.radiusKm,
        )
        .slice(0, limit);
    }

    const provenance = this.#provenanceFor(rows.map((r) => r.id));
    return rows.map((row) => this.#hydrate(row, provenance));
  }

  countIncidents(): number {
    const row = this.#db.get('SELECT COUNT(*) AS n FROM incidents') as { n: number };
    return row.n;
  }

  deleteOlderThan(cutoffMs: number): number {
    const result = this.#db.run('DELETE FROM incidents WHERE timestamp_ms < ?', cutoffMs);
    return Number(result.changes ?? 0);
  }

  /* -------------------------------- clusters ------------------------------- */

  recordClusters(clusters: readonly PatternCluster[]): void {
    if (clusters.length === 0) return;
    const stmtSql = `INSERT INTO clusters (id, detected_at, center_lat, center_lon, radius_km, count,
                             dominant_type, confidence, span_minutes, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, detected_at) DO NOTHING`;
    for (const cluster of clusters) {
      this.#db.run(
        stmtSql,
        cluster.id,
        cluster.detectedAt,
        cluster.center.lat,
        cluster.center.lon,
        cluster.radiusKm,
        cluster.count,
        cluster.dominantType,
        cluster.confidence,
        cluster.spanMinutes,
        JSON.stringify(cluster),
      );
    }
  }

  /* --------------------------------- stats --------------------------------- */

  computeStats(activeClusters: number, timelineMinutes = 24 * 60, buckets = 48): Stats {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const scalar = (sql: string, ...params: (string | number)[]): number => {
      const row = this.#db.get(sql, ...params) as { n: number } | undefined;
      return row?.n ?? 0;
    };

    const total = scalar('SELECT COUNT(*) AS n FROM incidents');
    const today = scalar('SELECT COUNT(*) AS n FROM incidents WHERE timestamp_ms >= ?', startOfDay.getTime());
    const lastHour = scalar('SELECT COUNT(*) AS n FROM incidents WHERE timestamp_ms >= ?', now - 3_600_000);
    const last15 = scalar('SELECT COUNT(*) AS n FROM incidents WHERE timestamp_ms >= ?', now - 900_000);
    const withoutCoordinates = scalar('SELECT COUNT(*) AS n FROM incidents WHERE lat IS NULL');

    const windowStart = now - timelineMinutes * 60_000;

    /*
     * The distributions above use a fixed window, but the timeline adapts: if the
     * database only holds six hours of history there is no point rendering eighteen
     * hours of empty buckets. The span is reported alongside so the axis can be
     * labelled truthfully.
     */
    const oldestRow = this.#db.get('SELECT MIN(timestamp_ms) AS n FROM incidents') as
      | { n: number | null }
      | undefined;
    const oldest = oldestRow?.n ?? null;
    const timelineStart =
      oldest != null && oldest > windowStart ? Math.min(oldest, now - 30 * 60_000) : windowStart;

    const byType = (
      this.#db.all(`SELECT incident_type AS key, COUNT(*) AS count FROM incidents
           WHERE timestamp_ms >= ? GROUP BY incident_type ORDER BY count DESC`, windowStart) as unknown as { key: string; count: number }[]
    ).map<StatsBucket>((r) => ({
      key: r.key,
      label: INCIDENT_TYPE_META[r.key as keyof typeof INCIDENT_TYPE_META]?.label ?? r.key,
      count: r.count,
    }));

    const byArea = (
      this.#db.all(`SELECT COALESCE(location_area, 'Unspecified') AS key, COUNT(*) AS count FROM incidents
           WHERE timestamp_ms >= ? GROUP BY key ORDER BY count DESC LIMIT 12`, windowStart) as unknown as { key: string; count: number }[]
    ).map<StatsBucket>((r) => ({ key: r.key, label: r.key, count: r.count }));

    const bySeverity = (
      this.#db.all(`SELECT severity AS key, COUNT(*) AS count FROM incidents
           WHERE timestamp_ms >= ? GROUP BY severity ORDER BY key DESC`, windowStart) as unknown as { key: number; count: number }[]
    ).map<StatsBucket>((r) => ({
      key: String(r.key),
      label: SEVERITY_LABEL[r.key as 1 | 2 | 3 | 4 | 5] ?? String(r.key),
      count: r.count,
    }));

    const bySource = (
      this.#db.all(`SELECT i.source_id AS key, s.name AS label, COUNT(*) AS count
           FROM incidents i JOIN sources s ON s.id = i.source_id
           WHERE i.timestamp_ms >= ? GROUP BY i.source_id ORDER BY count DESC`, windowStart) as unknown as { key: string; label: string; count: number }[]
    ).map<StatsBucket>((r) => ({ key: r.key, label: r.label, count: r.count }));

    const bucketMs = (now - timelineStart) / buckets;
    const timelineRows = this.#db.all(`SELECT CAST((timestamp_ms - ?) / ? AS INTEGER) AS bucket,
                COUNT(*) AS count, SUM(severity) AS severity_sum
         FROM incidents WHERE timestamp_ms >= ? GROUP BY bucket`, timelineStart, bucketMs, timelineStart) as unknown as {
      bucket: number;
      count: number;
      severity_sum: number;
    }[];
    const byBucket = new Map(timelineRows.map((r) => [r.bucket, r]));
    const timeline: TimeBucket[] = [];
    for (let i = 0; i < buckets; i += 1) {
      const row = byBucket.get(i);
      timeline.push({
        t: new Date(timelineStart + i * bucketMs).toISOString(),
        count: row?.count ?? 0,
        severitySum: row?.severity_sum ?? 0,
      });
    }

    const confidences = (
      this.#db.all('SELECT confidence FROM incidents WHERE timestamp_ms >= ? ORDER BY confidence', windowStart) as unknown as { confidence: number }[]
    ).map((r) => r.confidence);
    const medianConfidence =
      confidences.length === 0
        ? 0
        : (confidences[Math.floor(confidences.length / 2)] as number);

    return {
      generatedAt: new Date(now).toISOString(),
      total,
      today,
      lastHour,
      last15Minutes: last15,
      byType,
      byArea,
      bySeverity,
      bySource,
      timeline,
      timelineStart: new Date(timelineStart).toISOString(),
      timelineEnd: new Date(now).toISOString(),
      timelineBucketMinutes: Math.max(1, Math.round(bucketMs / 60_000)),
      activeClusters,
      medianConfidence: Math.round(medianConfidence * 100) / 100,
      withoutCoordinates,
    };
  }

  /* -------------------------------- internals ------------------------------ */

  #provenanceFor(ids: readonly string[]): Map<string, ProvenanceMap> {
    const out = new Map<string, ProvenanceMap>();
    if (ids.length === 0) return out;
    // Chunked to stay under the tightest bound-parameter limit of any runtime we target.
    // Cloudflare's embedded SQLite caps a statement at ~100 variables — far lower than
    // node:sqlite's ~32k — and exceeding it fails the whole query with
    // "too many SQL variables".
    for (let i = 0; i < ids.length; i += PROVENANCE_CHUNK) {
      const chunk = ids.slice(i, i + PROVENANCE_CHUNK);
      const rows = this.#db.all(`SELECT incident_id, field, origin, confidence, note FROM incident_provenance
           WHERE incident_id IN (${chunk.map(() => '?').join(',')})`, ...chunk) as unknown as {
        incident_id: string;
        field: string;
        origin: string;
        confidence: number | null;
        note: string | null;
      }[];
      for (const row of rows) {
        const existing = out.get(row.incident_id) ?? {};
        existing[row.field as ProvenanceField] = {
          origin: row.origin as never,
          ...(row.confidence != null ? { confidence: row.confidence } : {}),
          ...(row.note ? { note: row.note } : {}),
        };
        out.set(row.incident_id, existing);
      }
    }
    return out;
  }

  #hydrate(row: IncidentRow, provenance: Map<string, ProvenanceMap>): Incident {
    return {
      id: row.id,
      timestamp: row.timestamp,
      ingestedAt: row.ingested_at,
      source: {
        id: row.source_id,
        name: row.source_name,
        kind: row.source_kind as never,
        url: row.source_url,
      },
      incidentType: row.incident_type as never,
      severity: row.severity as never,
      description: row.description,
      location: {
        label: row.location_label,
        approximate: row.approximate === 1,
        precision: row.precision as never,
        area: row.location_area,
      },
      coordinates: row.lat != null && row.lon != null ? { lat: row.lat, lon: row.lon } : null,
      confidence: row.confidence,
      transcript: row.transcript,
      status: row.status as never,
      provenance: provenance.get(row.id) ?? {},
      tags: parseJsonArray(row.tags),
    };
  }
}

/** Bound parameters per provenance lookup. See `#provenanceFor`. */
const PROVENANCE_CHUNK = 90;

const SELECT_INCIDENT = `
  SELECT i.*, s.name AS source_name, s.url AS source_url
  FROM incidents i JOIN sources s ON s.id = i.source_id`;

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    // Keep the audit copy bounded — a pathological upstream payload must not bloat the DB.
    return json && json.length <= 20_000 ? json : null;
  } catch {
    return null;
  }
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (m) => `\\${m}`);
}
