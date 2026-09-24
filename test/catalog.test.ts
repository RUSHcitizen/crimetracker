import { describe, expect, it } from 'vitest';
import { AU_KM, GM, RADIUS, RAD } from '../src/lib/astro/constants';
import { periodDays } from '../src/lib/astro/kepler';
import { length } from '../src/lib/astro/vec';
import { buildCatalog } from '../src/lib/data/catalog';
import { World } from '../src/lib/sim/world';

const catalog = buildCatalog();
const world = new World(catalog);
const JD = 2461000.5;

describe('catalogue integrity', () => {
  it('has unique ids and a resolvable parent for every object', () => {
    const ids = new Set<string>();
    for (const o of catalog) {
      expect(ids.has(o.id), `duplicate id ${o.id}`).toBe(false);
      ids.add(o.id);
    }
    for (const o of catalog) {
      if (o.parent === null) continue;
      expect(ids.has(o.parent), `${o.id} has unknown parent ${o.parent}`).toBe(true);
    }
  });

  it('places every object at a finite position', () => {
    for (const o of catalog) {
      const r = world.resolve(o, JD);
      if (r.unplaced) continue;
      for (const c of r.position) expect(Number.isFinite(c), `${o.id} position`).toBe(true);
      for (const c of r.velocity) expect(Number.isFinite(c), `${o.id} velocity`).toBe(true);
    }
  });

  it('keeps every moon inside its planet’s sphere of influence and outside its surface', () => {
    for (const o of catalog) {
      if (o.kind !== 'moon' || o.parent === null) continue;
      const local = length(world.localState(o, JD).position);
      const parent = catalog.find((p) => p.id === o.parent)!;
      expect(local, `${o.id} is inside ${o.parent}`).toBeGreaterThan(parent.radiusKm ?? 0);
      if (parent.soiKm) {
        expect(local, `${o.id} is outside ${o.parent}'s SOI`).toBeLessThan(parent.soiKm);
      }
    }
  });

  it('reproduces published orbital periods for the moons people know', () => {
    const expected: Record<string, number> = {
      phobos: 0.3189, deimos: 1.2624,
      io: 1.769, europa: 3.551, ganymede: 7.155, callisto: 16.689,
      mimas: 0.942, enceladus: 1.370, tethys: 1.888, dione: 2.737,
      rhea: 4.518, titan: 15.945, iapetus: 79.33,
      miranda: 1.413, ariel: 2.520, umbriel: 4.144, titania: 8.706, oberon: 13.463,
      triton: 5.877, proteus: 1.122, nereid: 360.1,
      charon: 6.387, hydra: 38.2,
    };
    for (const [id, days] of Object.entries(expected)) {
      const o = catalog.find((x) => x.id === id);
      expect(o, `${id} missing from catalogue`).toBeDefined();
      const eph = o!.ephemeris;
      expect(eph.kind).toBe('elements');
      if (eph.kind !== 'elements') return;
      const p = periodDays(eph.elements)!;
      // 1.5% covers the published-vs-derived difference from rounding the semi-major axis.
      expect(Math.abs(p - days) / days, `${id}: got ${p.toFixed(4)} d, expected ${days} d`).toBeLessThan(0.015);
    }
  });

  it('keeps the retrograde moons retrograde in the ecliptic frame', () => {
    for (const id of ['triton', 'phoebe', 'ananke', 'carme', 'pasiphae', 'sinope']) {
      const o = catalog.find((x) => x.id === id)!;
      const eph = o.ephemeris;
      if (eph.kind !== 'elements') throw new Error(`${id} is not element-based`);
      expect(eph.elements.i * RAD, id).toBeGreaterThan(90);
    }
  });

  it('gives every object a provenance tier and a non-empty limitations note', () => {
    for (const o of catalog) {
      expect(['computed', 'live', 'catalog', 'simulated']).toContain(o.provenance.tier);
      expect(o.provenance.limitations.length, `${o.id}`).toBeGreaterThan(20);
      expect(o.provenance.accuracy.length, `${o.id}`).toBeGreaterThan(20);
    }
  });
});
