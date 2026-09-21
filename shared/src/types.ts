import type { Coordinates } from './geo.js';
import type {
  IncidentStatus,
  IncidentType,
  LocationPrecision,
  ProvenanceOrigin,
  SeverityLevel,
  SourceKind,
} from './taxonomy.js';

/** Identity of the adapter that produced an incident. */
export interface SourceRef {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly url?: string | null;
}

export interface IncidentLocation {
  /** Human-readable place description, e.g. "12th Ave & E Pine St, Seattle". */
  readonly label: string;
  /** True when the position is a neighbourhood/area rather than a precise point. */
  readonly approximate: boolean;
  readonly precision: LocationPrecision;
  /** Coarse administrative area used for grouping and statistics. */
  readonly area: string | null;
}

/** Field-level record of how a value came to exist. */
export interface ProvenanceEntry {
  readonly origin: ProvenanceOrigin;
  readonly confidence?: number;
  readonly note?: string;
}

/** Fields whose provenance we track individually. */
export type ProvenanceField =
  | 'incidentType'
  | 'severity'
  | 'description'
  | 'location'
  | 'coordinates'
  | 'timestamp'
  | 'transcript';

export type ProvenanceMap = Partial<Record<ProvenanceField, ProvenanceEntry>>;

/** The normalized, validated incident. This is the only shape the UI ever sees. */
export interface Incident {
  readonly id: string;
  /** When the incident occurred / was reported, ISO 8601 UTC. */
  readonly timestamp: string;
  /** When this system accepted it, ISO 8601 UTC. */
  readonly ingestedAt: string;
  readonly source: SourceRef;
  readonly incidentType: IncidentType;
  readonly severity: SeverityLevel;
  readonly description: string;
  readonly location: IncidentLocation;
  /** `null` when a trustworthy position could not be determined. Never invented. */
  readonly coordinates: Coordinates | null;
  /** Overall confidence in the record, 0–1. */
  readonly confidence: number;
  readonly transcript: string | null;
  readonly status: IncidentStatus;
  readonly provenance: ProvenanceMap;
  readonly tags: readonly string[];
  /** Original payload, retained for audit. Never rendered as fact. */
  readonly raw?: unknown;
}

/**
 * What a `DataSource` hands to the pipeline. Deliberately loose: every field is
 * optional and untrusted, and `normalizeIncident` is responsible for making it safe.
 */
export interface RawIncident {
  readonly externalId?: string | null;
  readonly timestamp?: unknown;
  readonly incidentType?: unknown;
  readonly severity?: unknown;
  readonly description?: unknown;
  readonly locationLabel?: unknown;
  readonly locationPrecision?: unknown;
  readonly area?: unknown;
  readonly coordinates?: unknown;
  readonly confidence?: unknown;
  readonly transcript?: unknown;
  readonly status?: unknown;
  readonly tags?: unknown;
  readonly provenance?: ProvenanceMap;
  readonly raw?: unknown;
}

export interface SourceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  /** One line describing what this source is and its legal basis for use. */
  readonly note: string;
  readonly url?: string | null;
}

export type ConnectionState = 'idle' | 'connecting' | 'online' | 'degraded' | 'error' | 'stopped';

export interface SourceStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceKind;
  readonly note: string;
  readonly state: ConnectionState;
  readonly enabled: boolean;
  readonly lastEventAt: string | null;
  readonly eventsIngested: number;
  readonly eventsRejected: number;
  readonly message: string | null;
  readonly url?: string | null;
}

/** A spatio-temporal concentration found in data already received. Not a prediction. */
export interface PatternCluster {
  readonly id: string;
  readonly center: Coordinates;
  readonly radiusKm: number;
  readonly count: number;
  readonly incidentIds: readonly string[];
  readonly dominantType: IncidentType;
  /** Share of the cluster that is `dominantType`, 0–1. */
  readonly typeShare: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly spanMinutes: number;
  readonly severityMean: number;
  /** 0–1. An analytical score, not a probability that anything will happen. */
  readonly confidence: number;
  readonly rationale: readonly string[];
  readonly detectedAt: string;
}

export interface StatsBucket {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export interface TimeBucket {
  /** ISO timestamp of the bucket start. */
  readonly t: string;
  readonly count: number;
  readonly severitySum: number;
}

export interface Stats {
  readonly generatedAt: string;
  readonly total: number;
  readonly today: number;
  readonly lastHour: number;
  readonly last15Minutes: number;
  readonly byType: readonly StatsBucket[];
  readonly byArea: readonly StatsBucket[];
  readonly bySeverity: readonly StatsBucket[];
  readonly bySource: readonly StatsBucket[];
  readonly timeline: readonly TimeBucket[];
  /** Actual span the timeline covers, ISO. Narrower than the window when history is short. */
  readonly timelineStart: string;
  readonly timelineEnd: string;
  readonly timelineBucketMinutes: number;
  readonly activeClusters: number;
  readonly medianConfidence: number;
  readonly withoutCoordinates: number;
}

export interface IncidentQuery {
  readonly types?: readonly IncidentType[];
  readonly minSeverity?: number;
  readonly sources?: readonly string[];
  readonly sinceMinutes?: number;
  readonly from?: string;
  readonly to?: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly near?: { lat: number; lon: number; radiusKm: number };
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Structured output of an `IncidentExtractor`. Everything here is AI-inferred. */
export interface ExtractionResult {
  readonly incidentType: IncidentType | null;
  readonly severity: SeverityLevel | null;
  readonly description: string | null;
  readonly locationLabel: string | null;
  readonly locationPrecision: LocationPrecision | null;
  readonly area: string | null;
  /** Extractors may only return coordinates they were explicitly given. */
  readonly coordinates: Coordinates | null;
  readonly confidence: number;
  readonly extractorId: string;
  readonly notes: readonly string[];
}

/* ------------------------------ realtime frames ------------------------------ */

export interface SnapshotFrame {
  readonly type: 'snapshot';
  readonly serverTime: string;
  readonly incidents: readonly Incident[];
  readonly patterns: readonly PatternCluster[];
  readonly stats: Stats;
  readonly sources: readonly SourceStatus[];
}

export interface IncidentsFrame {
  readonly type: 'incidents';
  readonly incidents: readonly Incident[];
}

export interface IncidentUpdateFrame {
  readonly type: 'incident:update';
  readonly incidents: readonly Incident[];
}

export interface PatternsFrame {
  readonly type: 'patterns';
  readonly patterns: readonly PatternCluster[];
}

export interface StatsFrame {
  readonly type: 'stats';
  readonly stats: Stats;
}

export interface SourcesFrame {
  readonly type: 'sources';
  readonly sources: readonly SourceStatus[];
}

export interface PulseFrame {
  readonly type: 'pulse';
  readonly serverTime: string;
}

export type ServerFrame =
  | SnapshotFrame
  | IncidentsFrame
  | IncidentUpdateFrame
  | PatternsFrame
  | StatsFrame
  | SourcesFrame
  | PulseFrame;
