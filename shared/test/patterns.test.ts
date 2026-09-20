import { describe, expect, it } from 'vitest';
import { detectPatterns, DEFAULT_PATTERN_OPTIONS } from '../src/patterns.js';
import { haversineKm, offsetCoordinates } from '../src/geo.js';
import { createRng } from '../src/rng.js';
import type { Incident, IncidentType } from '../src/index.js';

const NOW = Date.parse('2026-09-20T12:00:00.000Z');

function incident(
  id: string,
  minutesAgo: number,
  coords: { lat: number; lon: number } | null,
  type: IncidentType = 'theft',
  severity: 1 | 2 | 3 | 4 | 5 = 3,
): Incident {
  return {
    id,
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
    ingestedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    source: { id: 'test', name: 'Test', kind: 'simulation', url: null },
    incidentType: type,
    severity,
    description: `incident ${id}`,
    location: { label: 'somewhere', approximate: true, precision: 'area', area: 'Test' },
    coordinates: coords,
    confidence: 0.8,
    transcript: null,
    status: 'normalized',
    provenance: {},
    tags: [],
  };
}

/** A tight run of reports around one point — the thing the feature exists to find. */
function burst(count: number, center: { lat: number; lon: number }, spreadKm: number, type: IncidentType = 'burglary') {
  const rng = createRng('burst-seed');
  return Array.from({ length: count }, (_, i) =>
    incident(
      `burst-${i}`,
      rng.float(1, 30),
      offsetCoordinates(center, rng.float(0, spreadKm), rng.float(0, 360)),
      type,
    ),
  );
}

const SEATTLE = { lat: 47.6062, lon: -122.3321 };
const SPOKANE = { lat: 47.6588, lon: -117.426 };

describe('detectPatterns', () => {
  it('finds nothing in an empty or tiny set', () => {
    expect(detectPatterns([], { now: NOW })).toEqual([]);
    expect(detectPatterns([incident('a', 5, SEATTLE)], { now: NOW })).toEqual([]);
  });

  it('finds nothing when incidents are spread across the state', () => {
    const scattered = [
      incident('a', 5, SEATTLE),
      incident('b', 6, SPOKANE),
      incident('c', 7, { lat: 46.6021, lon: -120.5059 }),
      incident('d', 8, { lat: 48.7519, lon: -122.4787 }),
      incident('e', 9, { lat: 45.6387, lon: -122.6615 }),
    ];
    expect(detectPatterns(scattered, { now: NOW })).toEqual([]);
  });

  it('detects a tight spatio-temporal concentration', () => {
    const clusters = detectPatterns(burst(8, SEATTLE, 0.9), { now: NOW });
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.count).toBe(8);
    expect(cluster.dominantType).toBe('burglary');
    expect(cluster.typeShare).toBe(1);
    expect(cluster.radiusKm).toBeLessThanOrEqual(1.2);
    expect(cluster.confidence).toBeGreaterThan(0.45);
    expect(haversineKm(cluster.center, SEATTLE)).toBeLessThan(1.5);
  });

  it('separates two concentrations that are far apart', () => {
    const clusters = detectPatterns([...burst(6, SEATTLE, 0.8), ...burst(6, SPOKANE, 0.8).map((i) => ({ ...i, id: `s-${i.id}` }))], {
      now: NOW,
    });
    expect(clusters).toHaveLength(2);
    const centers = clusters.map((c) => c.center);
    expect(Math.max(...centers.map((c) => haversineKm(c, SEATTLE)))).toBeGreaterThan(100);
  });

  it('ignores incidents without coordinates', () => {
    const withNulls = [...burst(8, SEATTLE, 0.9), ...Array.from({ length: 20 }, (_, i) => incident(`null-${i}`, 5, null))];
    const clusters = detectPatterns(withNulls, { now: NOW });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(8);
  });

  it('does not group incidents that are close in space but far apart in time', () => {
    // Same block, but spread over 10 hours — not a concentration.
    const spread = Array.from({ length: 8 }, (_, i) =>
      incident(`t-${i}`, i * 75, offsetCoordinates(SEATTLE, 0.2, i * 45)),
    );
    const clusters = detectPatterns(spread, { now: NOW, windowMinutes: 60 });
    expect(clusters).toEqual([]);
  });

  it('respects minPoints', () => {
    expect(detectPatterns(burst(4, SEATTLE, 0.5), { now: NOW, minPoints: 6 })).toEqual([]);
    expect(detectPatterns(burst(7, SEATTLE, 0.5), { now: NOW, minPoints: 6 })).toHaveLength(1);
  });

  it('excludes incidents older than the lookback window', () => {
    const old = burst(8, SEATTLE, 0.5).map((i) => ({
      ...i,
      timestamp: new Date(NOW - 8 * 60 * 60_000).toISOString(),
    }));
    expect(detectPatterns(old, { now: NOW, windowMinutes: 180 })).toEqual([]);
  });

  it('scores a tighter, larger, more repetitive cluster higher', () => {
    // Scoring only, so the alert threshold is taken out of the comparison.
    const scoreOnly = { now: NOW, minConfidence: 0 };
    const tight = detectPatterns(burst(12, SEATTLE, 0.25), scoreOnly)[0];
    const loose = detectPatterns(
      burst(8, SEATTLE, 0.8).map((incidentRecord, i) => ({
        ...incidentRecord,
        incidentType: (['theft', 'traffic', 'medical'] as IncidentType[])[i % 3]!,
      })),
      scoreOnly,
    )[0];
    expect(tight).toBeDefined();
    expect(loose).toBeDefined();
    expect(tight!.confidence).toBeGreaterThan(loose!.confidence);
    // And only the strong one clears the alert threshold.
    expect(tight!.confidence).toBeGreaterThanOrEqual(DEFAULT_PATTERN_OPTIONS.minConfidence);
  });

  it('refuses a chain that spans longer than the configured window', () => {
    // Reports every 10 minutes along one block: each links to its neighbour, so DBSCAN
    // would chain them into a single 2-hour "cluster". That is a steady background rate,
    // not a concentration, so it must not be reported.
    const chain = Array.from({ length: 13 }, (_, i) =>
      incident(`chain-${i}`, 130 - i * 10, offsetCoordinates(SEATTLE, 0.15, i * 27)),
    );
    expect(detectPatterns(chain, { now: NOW, windowMinutes: 45, minPoints: 5 })).toEqual([]);

    // The same reports compressed into 30 minutes *are* a concentration.
    const compressed = Array.from({ length: 13 }, (_, i) =>
      incident(`fast-${i}`, 30 - i * 2, offsetCoordinates(SEATTLE, 0.15, i * 27)),
    );
    const found = detectPatterns(compressed, { now: NOW, windowMinutes: 45, minPoints: 5 });
    expect(found).toHaveLength(1);
    expect(found[0]!.spanMinutes).toBeLessThanOrEqual(45);
  });

  it('never reports a cluster whose span exceeds the window', () => {
    const rng2 = createRng('span-guard');
    const many = Array.from({ length: 800 }, (_, i) =>
      incident(
        `s-${i}`,
        rng2.float(0, 44),
        offsetCoordinates(SEATTLE, rng2.float(0, 4), rng2.float(0, 360)),
      ),
    );
    for (const cluster of detectPatterns(many, { now: NOW })) {
      expect(cluster.spanMinutes).toBeLessThanOrEqual(DEFAULT_PATTERN_OPTIONS.windowMinutes);
    }
  });

  it('reports a rationale and explicit bounds for every cluster', () => {
    const cluster = detectPatterns(burst(9, SEATTLE, 0.7), { now: NOW })[0]!;
    expect(cluster.rationale.length).toBeGreaterThan(0);
    expect(cluster.incidentIds).toHaveLength(cluster.count);
    expect(new Date(cluster.firstAt).getTime()).toBeLessThanOrEqual(new Date(cluster.lastAt).getTime());
    expect(cluster.spanMinutes).toBeGreaterThanOrEqual(1);
    expect(cluster.confidence).toBeGreaterThanOrEqual(0);
    expect(cluster.confidence).toBeLessThanOrEqual(1);
  });

  it('produces a stable id for the same set of incidents', () => {
    const points = burst(8, SEATTLE, 0.6);
    const a = detectPatterns(points, { now: NOW })[0]!;
    const b = detectPatterns([...points].reverse(), { now: NOW })[0]!;
    expect(a.id).toBe(b.id);
  });

  it('returns clusters strongest-first', () => {
    const mixed = [
      ...burst(12, SEATTLE, 0.3),
      ...burst(7, SPOKANE, 0.5, 'traffic').map((i) => ({ ...i, id: `s-${i.id}` })),
    ];
    const clusters = detectPatterns(mixed, { now: NOW });
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < clusters.length; i += 1) {
      expect(clusters[i - 1]!.confidence).toBeGreaterThanOrEqual(clusters[i]!.confidence);
    }
  });

  /**
   * The spatial grid is an optimization, so it must not change results. This compares it
   * against an exhaustive O(n²) reference over randomized input.
   */
  it('matches a brute-force reference implementation', () => {
    const rng = createRng('reference-check');
    const points: Incident[] = [];
    for (let i = 0; i < 400; i += 1) {
      const anchor = rng.bool(0.5) ? SEATTLE : SPOKANE;
      points.push(
        incident(
          `r-${i}`,
          rng.float(0, 44),
          offsetCoordinates(anchor, rng.float(0, 12), rng.float(0, 360)),
          rng.pick(['theft', 'burglary', 'assault', 'traffic'] as IncidentType[]),
        ),
      );
    }

    const actual = detectPatterns(points, { now: NOW });
    const expected = bruteForce(points, NOW);

    expect(actual.map((c) => c.id).sort()).toEqual(expected.map((c) => c.id).sort());
    for (const cluster of actual) {
      const match = expected.find((c) => c.id === cluster.id)!;
      expect(cluster.count).toBe(match.count);
      expect(cluster.incidentIds).toEqual(match.incidentIds);
    }
  });

  it('stays fast on a large window', () => {
    const rng = createRng('perf');
    const many = Array.from({ length: 3000 }, (_, i) =>
      incident(
        `p-${i}`,
        rng.float(0, 44),
        offsetCoordinates(rng.bool(0.5) ? SEATTLE : SPOKANE, rng.float(0, 30), rng.float(0, 360)),
      ),
    );
    const started = performance.now();
    detectPatterns(many, { now: NOW });
    // Generous bound: the point is to catch a regression back to O(n²), not to benchmark.
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

/** Exhaustive DBSCAN over the same inputs, used only as a test oracle. */
function bruteForce(incidents: readonly Incident[], now: number) {
  const opts = DEFAULT_PATTERN_OPTIONS;
  const pts = incidents
    .filter((i) => i.coordinates && now - Date.parse(i.timestamp) <= opts.windowMinutes * 60_000)
    .map((i) => ({ i, c: i.coordinates!, t: Date.parse(i.timestamp) }));

  const nb = (index: number) =>
    pts
      .map((_, j) => j)
      .filter((j) => j !== index && haversineKm(pts[index]!.c, pts[j]!.c) <= opts.epsKm);

  const labels = new Array<number>(pts.length).fill(-1);
  let id = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (labels[i] !== -1) continue;
    const seeds = nb(i);
    if (seeds.length + 1 < opts.minPoints) {
      labels[i] = -2;
      continue;
    }
    labels[i] = id;
    const queue = [...seeds];
    for (let q = 0; q < queue.length; q += 1) {
      const idx = queue[q]!;
      if (labels[idx] === -2) labels[idx] = id;
      if (labels[idx] !== -1) continue;
      labels[idx] = id;
      const more = nb(idx);
      if (more.length + 1 >= opts.minPoints) {
        for (const m of more) if (labels[m] === -1 || labels[m] === -2) queue.push(m);
      }
    }
    id += 1;
  }

  // Re-run the real scorer over the brute-force membership so only grouping is compared.
  const out: { id: string; count: number; incidentIds: string[] }[] = [];
  for (let c = 0; c < id; c += 1) {
    const members = pts.filter((_, i) => labels[i] === c);
    if (members.length < opts.minPoints) continue;
    const cluster = detectPatterns(
      members.map((m) => m.i),
      { now, minConfidence: 0 },
    )[0];
    if (cluster) out.push({ id: cluster.id, count: members.length, incidentIds: members.map((m) => m.i.id).sort() });
  }
  return out.filter((c) => {
    const real = detectPatterns(
      incidents.filter((i) => c.incidentIds.includes(i.id)),
      { now, minConfidence: 0 },
    )[0];
    return real ? real.confidence >= opts.minConfidence : false;
  });
}
