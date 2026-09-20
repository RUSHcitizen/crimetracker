import { describe, expect, it, vi } from 'vitest';
import { assertAudioAcknowledged, assertPublicUrl, SourcePolicyError } from '../src/sources/policy.js';
import { dotPath, extractRecords, mapRecord, PublicSafetyFeedSource } from '../src/sources/publicFeed.js';
import { PublicAudioSource } from '../src/sources/audio.js';
import { RollingAudioBuffer } from '../src/audio/buffer.js';
import { NullSpeechToText } from '../src/audio/stt.js';
import { HeuristicExtractor } from '../src/extraction/heuristic.js';
import type { FeedFieldMap } from '../src/config.js';
import type { RawIncident } from '@crimetracker/shared';
import type { SourceContext } from '../src/sources/types.js';

const MAP: FeedFieldMap = {
  id: 'id',
  timestamp: 'timestamp',
  type: 'type',
  description: 'description',
  location: 'address',
  lat: 'latitude',
  lon: 'longitude',
};

function testContext(): SourceContext & { emitted: RawIncident[]; states: string[] } {
  const emitted: RawIncident[] = [];
  const states: string[] = [];
  return {
    emitted,
    states,
    emit: (raw) => emitted.push(raw),
    emitMany: (raws) => emitted.push(...raws),
    log: () => {},
    setState: (state) => states.push(state),
    signal: new AbortController().signal,
  };
}

describe('source policy', () => {
  it('accepts a plain https endpoint', () => {
    expect(assertPublicUrl('https://data.example.gov/incidents.json').host).toBe('data.example.gov');
  });

  it('refuses non-http protocols', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(SourcePolicyError);
    expect(() => assertPublicUrl('ftp://example.com/feed')).toThrow(SourcePolicyError);
  });

  it('refuses plain http to a non-loopback host', () => {
    expect(() => assertPublicUrl('http://data.example.gov/feed')).toThrow(/Use https/);
  });

  it('allows plain http to loopback for local development', () => {
    expect(assertPublicUrl('http://127.0.0.1:9000/feed').port).toBe('9000');
    expect(assertPublicUrl('http://localhost:9000/feed').hostname).toBe('localhost');
  });

  it('refuses a URL carrying credentials — that implies a non-public feed', () => {
    expect(() => assertPublicUrl('https://user:secret@example.gov/feed')).toThrow(
      /publicly accessible/,
    );
  });

  it('refuses malformed URLs', () => {
    expect(() => assertPublicUrl('not a url')).toThrow(SourcePolicyError);
    expect(() => assertPublicUrl('')).toThrow(SourcePolicyError);
  });

  it('requires an explicit acknowledgement before any audio is processed', () => {
    expect(() => assertAudioAcknowledged(false)).toThrow(/PUBLIC_AUDIO_ACK/);
    expect(() => assertAudioAcknowledged(true)).not.toThrow();
  });
});

describe('feed record mapping', () => {
  it('resolves dot paths and misses safely', () => {
    expect(dotPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
    expect(dotPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(dotPath(null, 'a')).toBeUndefined();
    expect(dotPath({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('finds records in a bare array, a GeoJSON collection and common wrappers', () => {
    expect(extractRecords([{ a: 1 }], '')).toHaveLength(1);
    expect(extractRecords({ type: 'FeatureCollection', features: [{}, {}] }, '')).toHaveLength(2);
    expect(extractRecords({ results: [{}, {}, {}] }, '')).toHaveLength(3);
    expect(extractRecords({ payload: { rows: [{}] } }, 'payload.rows')).toHaveLength(1);
    expect(extractRecords({ nothing: true }, '')).toEqual([]);
  });

  it('maps a flat JSON record', () => {
    const raw = mapRecord(
      {
        id: 'CAD-1',
        timestamp: '2026-09-20T11:00:00Z',
        type: 'Theft',
        description: 'Theft from vehicle',
        address: '300 block of Pike St',
        latitude: 47.61,
        longitude: -122.33,
      },
      MAP,
    );
    expect(raw?.externalId).toBe('CAD-1');
    expect(raw?.coordinates).toEqual({ lat: 47.61, lon: -122.33 });
    expect(raw?.locationLabel).toBe('300 block of Pike St');
  });

  it('maps a GeoJSON feature, reading position from the geometry', () => {
    const raw = mapRecord(
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122.33, 47.61] },
        properties: { id: 'F-1', timestamp: '2026-09-20T11:00:00Z', description: 'Burglary' },
      },
      MAP,
    );
    // GeoJSON is [lon, lat]; the coordinate validator is what enforces the order.
    expect(raw?.coordinates).toEqual([-122.33, 47.61]);
    expect(raw?.externalId).toBe('F-1');
  });

  it('rejects a record with neither a description nor a type', () => {
    expect(mapRecord({ id: 'x', timestamp: 1 }, MAP)).toBeNull();
    expect(mapRecord(null, MAP)).toBeNull();
    expect(mapRecord('a string', MAP)).toBeNull();
  });

  it('clamps an absurdly long external id', () => {
    const raw = mapRecord({ id: 'x'.repeat(500), description: 'Theft' }, MAP);
    expect(raw!.externalId!.length).toBeLessThanOrEqual(48);
  });
});

describe('PublicSafetyFeedSource', () => {
  const options = {
    name: 'Test Feed',
    url: 'https://data.example.gov/incidents.json',
    pollSeconds: 60,
    itemsPath: '',
    map: MAP,
  };

  it('refuses to construct against a non-public URL', () => {
    expect(() => new PublicSafetyFeedSource({ ...options, url: 'http://data.example.gov/x' })).toThrow(
      SourcePolicyError,
    );
  });

  it('emits mapped records on a successful poll', async () => {
    const source = new PublicSafetyFeedSource({
      ...options,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            { id: 'a', timestamp: '2026-09-20T11:00:00Z', description: 'Theft on Pike St' },
            { id: 'b', timestamp: '2026-09-20T11:05:00Z', description: 'Burglary on Main St' },
          ]),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    const ctx = testContext();
    await source.start(ctx);
    await source.stop();
    expect(ctx.emitted).toHaveLength(2);
    expect(source.status().eventsIngested).toBe(2);
    expect(source.status().state).toBe('stopped');
  });

  it('de-duplicates records that reappear across polls', async () => {
    const body = JSON.stringify([{ id: 'a', timestamp: '2026-09-20T11:00:00Z', description: 'Theft' }]);
    const source = new PublicSafetyFeedSource({
      ...options,
      pollSeconds: 60,
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    });
    const ctx = testContext();
    await source.start(ctx);
    // Second poll returns the same record.
    await source.start(ctx);
    await source.stop();
    expect(ctx.emitted).toHaveLength(1);
  });

  it('backs off on a rate limit instead of hammering the upstream', async () => {
    const source = new PublicSafetyFeedSource({
      ...options,
      fetchImpl: async () => new Response('slow down', { status: 429 }),
    });
    const ctx = testContext();
    await source.start(ctx);
    await source.stop();
    expect(ctx.emitted).toHaveLength(0);
    expect(ctx.states).toContain('degraded');
  });

  it('reports an error state rather than throwing when the feed is unreachable', async () => {
    const source = new PublicSafetyFeedSource({
      ...options,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const ctx = testContext();
    await expect(source.start(ctx)).resolves.toBeUndefined();
    await source.stop();
    expect(ctx.states).toContain('error');
  });

  it('counts records it could not map as rejections', async () => {
    const source = new PublicSafetyFeedSource({
      ...options,
      fetchImpl: async () =>
        new Response(JSON.stringify([{ id: 'a' }, { id: 'b', description: 'Theft' }]), {
          headers: { 'content-type': 'application/json' },
        }),
    });
    const ctx = testContext();
    await source.start(ctx);
    await source.stop();
    expect(source.status().eventsIngested).toBe(1);
    expect(source.status().eventsRejected).toBe(1);
  });

  it('identifies itself as a public-feed source with the upstream host in its note', () => {
    const source = new PublicSafetyFeedSource(options);
    expect(source.descriptor.kind).toBe('public-feed');
    expect(source.descriptor.note).toContain('data.example.gov');
  });
});

describe('RollingAudioBuffer', () => {
  it('emits a segment once enough audio has accumulated', () => {
    const buffer = new RollingAudioBuffer(2, 100, 'audio/mpeg');
    expect(buffer.push(new Uint8Array(120))).toBeNull();
    const segment = buffer.push(new Uint8Array(120));
    expect(segment).not.toBeNull();
    expect(segment!.bytes.byteLength).toBe(240);
    expect(segment!.mimeType).toBe('audio/mpeg');
    expect(buffer.pendingBytes).toBe(0);
  });

  it('flushes a short tail', () => {
    const buffer = new RollingAudioBuffer(10, 100, 'audio/mpeg');
    buffer.push(new Uint8Array(50));
    const segment = buffer.flush();
    expect(segment!.bytes.byteLength).toBe(50);
    expect(buffer.flush()).toBeNull();
  });

  it('drops the oldest audio rather than growing without bound', () => {
    const buffer = new RollingAudioBuffer(1000, 100, 'audio/mpeg', 500);
    for (let i = 0; i < 20; i += 1) buffer.push(new Uint8Array(100));
    expect(buffer.pendingBytes).toBeLessThanOrEqual(500);
  });
});

describe('PublicAudioSource', () => {
  const base = {
    name: 'Public Audio',
    url: 'https://audio.example.org/stream',
    segmentSeconds: 30,
    stt: new NullSpeechToText(),
    extractor: new HeuristicExtractor(),
  };

  it('refuses to construct without the operator acknowledgement', () => {
    expect(() => new PublicAudioSource({ ...base, acknowledged: false })).toThrow(/PUBLIC_AUDIO_ACK/);
  });

  it('refuses to construct against a non-public stream URL', () => {
    expect(
      () => new PublicAudioSource({ ...base, acknowledged: true, url: 'https://user:pw@audio.example.org/s' }),
    ).toThrow(SourcePolicyError);
  });

  it('constructs as an audio-kind source when both conditions are met', () => {
    const source = new PublicAudioSource({ ...base, acknowledged: true });
    expect(source.descriptor.kind).toBe('audio');
    expect(source.status().state).toBe('idle');
  });
});

describe('NullSpeechToText', () => {
  it('produces nothing, keeping the pipeline wired but inert', async () => {
    await expect(new NullSpeechToText().transcribe()).resolves.toBeNull();
  });
});
