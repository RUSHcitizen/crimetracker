import { centroid, haversineKm, radiusKm, round, type Coordinates } from './geo.js';
import { shortId } from './id.js';
import { INCIDENT_TYPE_META, type IncidentType } from './taxonomy.js';
import type { Incident, PatternCluster } from './types.js';

export interface PatternOptions {
  /** Neighbourhood radius in kilometres. */
  readonly epsKm: number;
  /**
   * The window under examination. Only incidents reported within this many minutes of
   * `now` are considered, so a reported cluster always describes "the last N minutes".
   */
  readonly windowMinutes: number;
  /** Minimum incidents for a concentration to be reported. */
  readonly minPoints: number;
  /** Clusters scoring below this are discarded. */
  readonly minConfidence: number;
  readonly now?: number;
}

export const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  // Tight on purpose. A wide neighbourhood smears a whole city centre into one blob and
  // then reports "the city is busy", which is true and useless. At ~1 km a cluster has
  // to be a genuinely localised run of reports to qualify.
  epsKm: 0.9,
  windowMinutes: 45,
  minPoints: 5,
  // The bar is high because this drives an alert. A dozen weak concentrations on screen
  // is noise; one strong one is information.
  minConfidence: 0.6,
};

interface Point {
  readonly incident: Incident;
  readonly coords: Coordinates;
  readonly t: number;
}

/**
 * Detect spatial concentrations in incidents **already received** within a recent window.
 *
 * This is descriptive statistics over past reports, not a forecast. The `confidence`
 * score describes how strongly the data clumps; the UI is required to present the result
 * as an analytical inference.
 *
 * Design note — why the window comes first:
 *
 * An obvious implementation makes time part of the DBSCAN neighbourhood test ("near in
 * space AND within N minutes"). That chains transitively: on a busy feed, A links to B
 * links to C until a single "cluster" spans hours, which is a steady background rate
 * rather than a concentration. So the window is applied as a filter *before* clustering,
 * and the clustering itself is purely spatial. A reported cluster then always fits
 * inside the window by construction, and `spanMinutes` is a real measurement rather than
 * an artefact of chaining.
 */
export function detectPatterns(
  incidents: readonly Incident[],
  options: Partial<PatternOptions> = {},
): PatternCluster[] {
  const opts = { ...DEFAULT_PATTERN_OPTIONS, ...options };
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.windowMinutes * 60_000;

  const points: Point[] = [];
  for (const incident of incidents) {
    // Incidents without a trustworthy position cannot participate: we will not guess
    // where they were in order to make a cluster look better.
    if (!incident.coordinates) continue;
    const t = Date.parse(incident.timestamp);
    if (!Number.isFinite(t) || t < cutoff || t > now + 60_000) continue;
    points.push({ incident, coords: incident.coordinates, t });
  }
  if (points.length < opts.minPoints) return [];

  const neighbours = buildNeighbourIndex(points, opts.epsKm);

  const UNVISITED = -1;
  const NOISE = -2;
  const labels = new Array<number>(points.length).fill(UNVISITED);
  let clusterId = 0;

  for (let i = 0; i < points.length; i += 1) {
    if (labels[i] !== UNVISITED) continue;
    const seeds = neighbours(i);
    // `minPoints` counts the point itself.
    if (seeds.length + 1 < opts.minPoints) {
      labels[i] = NOISE;
      continue;
    }
    labels[i] = clusterId;
    const queue = [...seeds];
    for (let q = 0; q < queue.length; q += 1) {
      const idx = queue[q] as number;
      if (labels[idx] === NOISE) labels[idx] = clusterId;
      if (labels[idx] !== UNVISITED) continue;
      labels[idx] = clusterId;
      const more = neighbours(idx);
      if (more.length + 1 >= opts.minPoints) {
        for (const m of more) if (labels[m] === UNVISITED || labels[m] === NOISE) queue.push(m);
      }
    }
    clusterId += 1;
  }

  const clusters: PatternCluster[] = [];
  for (let id = 0; id < clusterId; id += 1) {
    const members = points.filter((_, i) => labels[i] === id);
    if (members.length < opts.minPoints) continue;
    const cluster = buildCluster(members, opts, now);
    if (cluster && cluster.confidence >= opts.minConfidence) clusters.push(cluster);
  }

  // Strongest first — the HUD only ever surfaces the top few.
  return clusters.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
}

/**
 * Spatial hash so a neighbourhood query inspects the 3x3 cells around a point instead of
 * the whole window. Without it the scan is O(n^2), and a busy statewide feed makes every
 * pass cost hundreds of milliseconds.
 *
 * Two properties make this exact rather than approximate:
 *   1. a cell's longitude width depends only on its ROW, never on a point's exact
 *      latitude, so indexing a point and probing for it always agree;
 *   2. cells are sized `epsKm * 1.05`, which guarantees any point within `epsKm` is at
 *      most one cell away on each axis — so the 3x3 probe cannot miss a neighbour.
 */
function buildNeighbourIndex(points: readonly Point[], epsKm: number): (index: number) => number[] {
  const cellKm = epsKm * 1.05;
  const latCell = cellKm / 110.574;
  const lonCellForRow = (row: number): number => {
    const rowLat = (row + 0.5) * latCell;
    return cellKm / (111.32 * Math.max(0.02, Math.cos((rowLat * Math.PI) / 180)));
  };
  const keyOf = (row: number, col: number): string => `${row}:${col}`;
  const rowOf = (lat: number) => Math.floor(lat / latCell);

  const grid = new Map<string, number[]>();
  points.forEach((point, index) => {
    const row = rowOf(point.coords.lat);
    const col = Math.floor(point.coords.lon / lonCellForRow(row));
    const bucket = grid.get(keyOf(row, col));
    if (bucket) bucket.push(index);
    else grid.set(keyOf(row, col), [index]);
  });

  return (index: number): number[] => {
    const a = points[index] as Point;
    const out: number[] = [];
    const row = rowOf(a.coords.lat);

    for (let dRow = -1; dRow <= 1; dRow += 1) {
      const probeRow = row + dRow;
      // Each row has its own column width, so the base column is derived per row.
      const baseCol = Math.floor(a.coords.lon / lonCellForRow(probeRow));
      for (let dCol = -1; dCol <= 1; dCol += 1) {
        const bucket = grid.get(keyOf(probeRow, baseCol + dCol));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === index) continue;
          if (haversineKm(a.coords, (points[j] as Point).coords) > epsKm) continue;
          out.push(j);
        }
      }
    }
    return out;
  };
}

function buildCluster(members: Point[], opts: PatternOptions, now: number): PatternCluster | null {
  const coords = members.map((m) => m.coords);
  const center = centroid(coords);
  if (!center) return null;

  const times = members.map((m) => m.t).sort((a, b) => a - b);
  const firstMs = times[0] as number;
  const lastMs = times[times.length - 1] as number;
  const spanMinutes = Math.max(1, Math.round((lastMs - firstMs) / 60_000));
  const radius = Math.max(0.05, radiusKm(center, coords));

  const typeCounts = new Map<IncidentType, number>();
  let severitySum = 0;
  for (const m of members) {
    typeCounts.set(m.incident.incidentType, (typeCounts.get(m.incident.incidentType) ?? 0) + 1);
    severitySum += m.incident.severity;
  }
  let dominantType: IncidentType = members[0]!.incident.incidentType;
  let dominantCount = 0;
  for (const [type, count] of typeCounts) {
    if (count > dominantCount) {
      dominantType = type;
      dominantCount = count;
    }
  }
  const typeShare = dominantCount / members.length;
  const severityMean = severitySum / members.length;

  /* --- scoring ------------------------------------------------------------- */
  // Each component is 0–1 and describes one way the data stands out.
  // A cluster at the threshold already counts for something, and one at ~2.5x the
  // threshold saturates. The previous curve needed 3.5x to saturate, which under-scored
  // exactly the small tight runs this feature exists to surface.
  const sizeScore = clamp01((members.length - opts.minPoints) / (opts.minPoints * 1.5) + 0.45);
  // A cluster whose radius approaches the neighbourhood size is a smear, not a hotspot.
  const densityScore = clamp01(1 - radius / (opts.epsKm * 1.6));
  const temporalScore = clamp01(1 - spanMinutes / opts.windowMinutes);
  const repetitionScore = clamp01((typeShare - 1 / 3) * 1.5);
  const severityScore = clamp01((severityMean - 1) / 4);
  // Recency: a concentration that stopped half an hour ago matters less right now.
  const ageMinutes = (now - lastMs) / 60_000;
  const recencyScore = clamp01(1 - ageMinutes / opts.windowMinutes);

  const confidence = round(
    clamp01(
      sizeScore * 0.28 +
        densityScore * 0.22 +
        temporalScore * 0.18 +
        repetitionScore * 0.14 +
        severityScore * 0.1 +
        recencyScore * 0.08,
    ),
    2,
  );

  const rationale: string[] = [
    `${members.length} reports within ${radius < 1 ? `${Math.round(radius * 1000)} m` : `${radius.toFixed(1)} km`}`,
    `clustered over ${spanMinutes} min`,
  ];
  if (typeShare >= 0.5) {
    rationale.push(
      `${Math.round(typeShare * 100)}% ${INCIDENT_TYPE_META[dominantType].label.toLowerCase()}`,
    );
  }
  if (severityMean >= 3.5) rationale.push(`mean severity ${severityMean.toFixed(1)}`);
  if (ageMinutes < 10) rationale.push('activity ongoing');

  const ids = members.map((m) => m.incident.id).sort();

  return {
    id: shortId('PTN', ids.join('|')),
    center,
    radiusKm: round(radius, 2),
    count: members.length,
    incidentIds: ids,
    dominantType,
    typeShare: round(typeShare, 2),
    firstAt: new Date(firstMs).toISOString(),
    lastAt: new Date(lastMs).toISOString(),
    spanMinutes,
    severityMean: round(severityMean, 2),
    confidence,
    rationale,
    detectedAt: new Date(now).toISOString(),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
