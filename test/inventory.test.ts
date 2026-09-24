import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/lib/data/catalog';
import {
  makeDemoSatellites,
  makeHildas,
  makeKuiperBelt,
  makeMainBelt,
  makeNearEarth,
  makeTrojans,
} from '../src/lib/data/populations';
import { particleObject } from '../src/lib/data/particle';

/**
 * A census, asserted rather than described. If someone trims a population or drops a
 * dataset, this fails loudly instead of the sky quietly getting emptier.
 */
describe('inventory', () => {
  const catalog = buildCatalog();
  const clouds = [makeNearEarth(), makeMainBelt(), makeHildas(), makeTrojans(), makeKuiperBelt()];
  const demo = makeDemoSatellites();
  const particles = clouds.reduce((n, c) => n + c.elements.length, 0);

  it('carries a substantial catalogue of real objects', () => {
    const real = catalog.filter((o) => o.provenance.tier !== 'simulated');
    expect(real.length).toBeGreaterThanOrEqual(175);
  });

  it('covers every class of object the app claims to show', () => {
    const kinds = new Set(catalog.map((o) => o.kind));
    for (const k of ['star', 'planet', 'dwarf', 'moon', 'spacecraft', 'asteroid', 'comet', 'interstellar']) {
      expect(kinds.has(k as never), `missing kind ${k}`).toBe(true);
    }
    // Satellites of six different planets, not just one system.
    const parents = new Set(catalog.filter((o) => o.kind === 'moon').map((o) => o.parent));
    expect(parents.size).toBeGreaterThanOrEqual(6);
  });

  it('offers well over 600 selectable objects in total', () => {
    const total = catalog.length + demo.length + particles;
    expect(total).toBeGreaterThan(5_000);
  });

  it('builds a valid object for any particle, with honest provenance', () => {
    for (const cloud of clouds) {
      for (const index of [0, 1, Math.floor(cloud.elements.length / 2), cloud.elements.length - 1]) {
        const o = particleObject(cloud, index)!;
        expect(o).not.toBeNull();
        expect(o.provenance.tier).toBe('simulated');
        expect(o.status).toContain('SIMULATED');
        expect(o.ephemeris.kind).toBe('elements');
      }
    }
    expect(particleObject(clouds[0]!, 999_999)).toBeNull();
  });

  it('keeps every simulated body clearly marked as such', () => {
    for (const o of [...demo, ...clouds.flatMap((c) => [particleObject(c, 0)!])]) {
      expect(o.provenance.tier).toBe('simulated');
      expect(`${o.status}`.toUpperCase()).toContain('SIMULATED');
    }
  });

  it('reports the census', () => {
    const byTier: Record<string, number> = {};
    for (const o of catalog) byTier[o.provenance.tier] = (byTier[o.provenance.tier] ?? 0) + 1;
    // eslint-disable-next-line no-console
    console.log(
      `catalogue ${catalog.length} (${JSON.stringify(byTier)}) · demo satellites ${demo.length} · ` +
        `particles ${particles} · TOTAL SELECTABLE ${catalog.length + demo.length + particles}`,
    );
    expect(catalog.length).toBeGreaterThan(0);
  });
});
