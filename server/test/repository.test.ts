import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Incident, SourceDescriptor } from '@crimetracker/shared';
import { normalizeIncident } from '@crimetracker/shared';
import { openDatabase, type Database } from '../src/db/database.js';
import { IncidentRepository } from '../src/db/repository.js';
import { SimulationGenerator } from '../src/sim/generator.js';

const SOURCE: SourceDescriptor = {
  id: 'repo-test',
  name: 'Repo Test',
  kind: 'simulation',
  note: 'unit test',
};

let db: Database;
let repo: IncidentRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = new IncidentRepository(db);
  repo.upsertSource(SOURCE);
});

afterEach(() => {
  db.close();
});

function seed(count: number, seedName = 'repo'): Incident[] {
  const generator = new SimulationGenerator({ seed: seedName });
  const now = Date.now();
  const incidents: Incident[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = normalizeIncident(generator.generate(new Date(now - i * 60_000)), {
      source: SOURCE,
      now,
    });
    if (!result.ok) continue;
    repo.insertIncident(result.incident);
    incidents.push(result.incident);
  }
  return incidents;
}

describe('IncidentRepository', () => {
  it('round-trips an incident with its provenance intact', () => {
    const [incident] = seed(1);
    const loaded = repo.getIncident(incident!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.description).toBe(incident!.description);
    expect(loaded!.coordinates).toEqual(incident!.coordinates);
    expect(loaded!.location.approximate).toBe(incident!.location.approximate);
    expect(loaded!.tags).toEqual(incident!.tags);
    expect(Object.keys(loaded!.provenance).sort()).toEqual(Object.keys(incident!.provenance).sort());
  });

  it('stores a null position as null rather than zero', () => {
    const result = normalizeIncident(
      { timestamp: new Date().toISOString(), description: 'Theft with no position' },
      { source: SOURCE },
    );
    if (!result.ok) throw new Error(result.reason);
    repo.insertIncident(result.incident);
    expect(repo.getIncident(result.incident.id)!.coordinates).toBeNull();
  });

  it('upserts on a repeated id instead of duplicating', () => {
    const [incident] = seed(1);
    repo.insertIncident({ ...incident!, description: 'updated description', severity: 5 });
    expect(repo.countIncidents()).toBe(1);
    const loaded = repo.getIncident(incident!.id)!;
    expect(loaded.description).toBe('updated description');
    expect(loaded.severity).toBe(5);
  });

  it('returns null for an unknown id', () => {
    expect(repo.getIncident('nope')).toBeNull();
  });

  it('prunes by age', () => {
    seed(60);
    const removed = repo.deleteOlderThan(Date.now() - 30 * 60_000);
    expect(removed).toBeGreaterThan(0);
    expect(repo.countIncidents()).toBeLessThan(60);
  });

  it('computes stats over the stored set', () => {
    seed(200);
    const stats = repo.computeStats(3);
    expect(stats.total).toBe(repo.countIncidents());
    expect(stats.activeClusters).toBe(3);
    expect(stats.byType.reduce((sum, b) => sum + b.count, 0)).toBeLessThanOrEqual(stats.total);
    expect(stats.bySource.some((b) => b.key === SOURCE.id)).toBe(true);
    expect(stats.medianConfidence).toBeGreaterThan(0);
    expect(stats.timeline).toHaveLength(48);
    // Buckets run oldest → newest.
    for (let i = 1; i < stats.timeline.length; i += 1) {
      expect(stats.timeline[i]!.t > stats.timeline[i - 1]!.t).toBe(true);
    }
  });

  it('reports zeroed stats on an empty database', () => {
    const stats = repo.computeStats(0);
    expect(stats.total).toBe(0);
    expect(stats.medianConfidence).toBe(0);
    expect(stats.timeline).toHaveLength(48);
  });

  it('orders query results newest-first and honours limit/offset', () => {
    seed(50);
    const page = repo.queryIncidents({ limit: 10 });
    expect(page).toHaveLength(10);
    for (let i = 1; i < page.length; i += 1) {
      expect(page[i - 1]!.timestamp >= page[i]!.timestamp).toBe(true);
    }
    const next = repo.queryIncidents({ limit: 10, offset: 10 });
    expect(next.map((i) => i.id)).not.toEqual(page.map((i) => i.id));
  });

  it('escapes LIKE metacharacters in keyword search', () => {
    seed(30);
    // A bare wildcard must not behave as "match everything".
    expect(repo.queryIncidents({ q: '%' })).toHaveLength(0);
    expect(repo.queryIncidents({ q: '_' })).toHaveLength(0);
  });

  it('requires every term of a multi-word query to match', () => {
    const result = normalizeIncident(
      {
        timestamp: new Date().toISOString(),
        description: 'Reported burglary at a warehouse',
        locationLabel: '900 block of Marine View Dr, Everett',
        area: 'Everett',
      },
      { source: SOURCE },
    );
    if (!result.ok) throw new Error(result.reason);
    repo.insertIncident(result.incident);

    expect(repo.queryIncidents({ q: 'burglary everett' })).toHaveLength(1);
    expect(repo.queryIncidents({ q: 'burglary spokane' })).toHaveLength(0);
  });

  it('records clusters idempotently', () => {
    const cluster = {
      id: 'PTN-TEST',
      center: { lat: 47.6, lon: -122.3 },
      radiusKm: 1.2,
      count: 5,
      incidentIds: ['a', 'b'],
      dominantType: 'theft' as const,
      typeShare: 0.8,
      firstAt: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      spanMinutes: 20,
      severityMean: 2.4,
      confidence: 0.7,
      rationale: ['because'],
      detectedAt: new Date().toISOString(),
    };
    repo.recordClusters([cluster]);
    repo.recordClusters([cluster]);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM clusters').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('bounds the retained raw payload', () => {
    const result = normalizeIncident(
      {
        timestamp: new Date().toISOString(),
        description: 'Theft',
        raw: { blob: 'x'.repeat(100_000) },
      },
      { source: SOURCE },
    );
    if (!result.ok) throw new Error(result.reason);
    repo.insertIncident(result.incident);
    const row = db.prepare('SELECT raw FROM incidents WHERE id = ?').get(result.incident.id) as {
      raw: string | null;
    };
    expect(row.raw).toBeNull();
  });
});

describe('database path resolution', () => {
  it('resolves a relative path against the repository root, not the cwd', async () => {
    const { resolveDatabasePath } = await import('../src/db/database.js');
    const resolved = resolveDatabasePath('./data/crimetracker.db');
    expect(resolved.endsWith('/data/crimetracker.db')).toBe(true);
    expect(resolved.includes('/server/')).toBe(false);
    // Same answer regardless of where the process happens to be running.
    const previous = process.cwd();
    try {
      process.chdir('server');
      expect(resolveDatabasePath('./data/crimetracker.db')).toBe(resolved);
    } finally {
      process.chdir(previous);
    }
  });

  it('leaves absolute paths and :memory: alone', async () => {
    const { resolveDatabasePath } = await import('../src/db/database.js');
    expect(resolveDatabasePath('/var/lib/ct.db')).toBe('/var/lib/ct.db');
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
  });
});
