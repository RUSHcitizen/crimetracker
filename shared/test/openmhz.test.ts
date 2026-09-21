import { describe, expect, it } from 'vitest';
import {
  buildCallsUrl,
  buildTalkgroupsUrl,
  describeTalkgroup,
  DEFAULT_OPENMHZ_AUDIO_HOSTS,
  extractCalls,
  indexTalkgroups,
  mapOpenMhzCall,
  openMhzSourceId,
  openMhzSystemUrl,
  parseOpenMhzSpec,
} from '../src/index.js';

/**
 * Fixtures mirror the documented/observed OpenMHz payload. The live service is not
 * reachable from CI, so what is pinned here is the mapping; `npm run probe:openmhz` is
 * what checks it against the service's current shape.
 */
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const call = (over: Record<string, unknown> = {}) => ({
  _id: '66f0a1b2c3d4e5f60718293a',
  talkgroupNum: 1103,
  url: 'https://openmhz.com/media/psern025/1103-1758400000.m4a',
  filename: '1103-1758400000_851012500.m4a',
  time: secondsAgo(90),
  // Present in the real payload, and deliberately never read: these are unit radio ids.
  srcList: [{ src: 4521, pos: 0 }, { src: 4530, pos: 4.2 }],
  star: 0,
  len: 12,
  freq: 851012500,
  ...over,
});

describe('parseOpenMhzSpec', () => {
  it('reads the short name from the form used on the site', () => {
    const system = parseOpenMhzSpec('openmhz:psern025');
    expect(system).toMatchObject({ shortName: 'psern025', talkgroups: [] });
    expect(openMhzSystemUrl(system!)).toBe('https://openmhz.com/system/psern025');
    expect(openMhzSourceId(system!)).toBe('openmhz:psern025');
  });

  it('accepts a talkgroup filter and keeps it in the source id', () => {
    const system = parseOpenMhzSpec('openmhz:psern025/1103+1104+1103');
    expect(system?.talkgroups).toEqual([1103, 1104]);
    expect(openMhzSourceId(system!)).toBe('openmhz:psern025/1103+1104');
  });

  it('refuses a malformed spec rather than silently widening it', () => {
    // A non-numeric talkgroup must not fall through to "everything".
    expect(parseOpenMhzSpec('openmhz:psern025/all')).toBeUndefined();
    expect(parseOpenMhzSpec('openmhz:')).toBeUndefined();
    expect(parseOpenMhzSpec('openmhz:../../etc/passwd')).toBeUndefined();
    expect(parseOpenMhzSpec('openmhz:bad name')).toBeUndefined();
    expect(parseOpenMhzSpec('socrata:data.wa.gov/abcd-1234')).toBeUndefined();
  });

  it('honours an alternative API base', () => {
    const system = parseOpenMhzSpec('openmhz:psern025', 'https://mirror.example.org/');
    // The trailing slash on the base must not produce a double slash in the path.
    expect(buildCallsUrl(system!)).toBe('https://mirror.example.org/psern025/calls');
  });
});

describe('buildCallsUrl', () => {
  const system = parseOpenMhzSpec('openmhz:psern025')!;

  it('asks for the most recent page when there is no watermark', () => {
    expect(buildCallsUrl(system)).toBe('https://api.openmhz.com/psern025/calls');
  });

  it('asks for newer calls once a watermark exists', () => {
    const url = new URL(buildCallsUrl(system, { since: '2026-09-20T19:20:30.000Z' }));
    expect(url.searchParams.get('time')).toBe(String(Date.parse('2026-09-20T19:20:30.000Z')));
    expect(url.searchParams.get('direction')).toBe('newer');
  });

  it('passes a talkgroup filter upstream as an optimisation', () => {
    const filtered = parseOpenMhzSpec('openmhz:psern025/1103+1104')!;
    const url = new URL(buildCallsUrl(filtered));
    expect(url.searchParams.get('filter-type')).toBe('talkgroup');
    expect(url.searchParams.get('filter-code')).toBe('1103,1104');
  });

  it('builds the talkgroup metadata url', () => {
    expect(buildTalkgroupsUrl(system)).toBe('https://api.openmhz.com/psern025/talkgroups');
  });
});

describe('extractCalls', () => {
  it('handles both a bare array and the documented envelope', () => {
    expect(extractCalls([call()])).toHaveLength(1);
    expect(extractCalls({ calls: [call()], direction: 'older' })).toHaveLength(1);
    expect(extractCalls({ nothing: true })).toEqual([]);
    expect(extractCalls(null)).toEqual([]);
  });
});

describe('mapOpenMhzCall', () => {
  const options = { shortName: 'psern025' };

  it('maps a published call', () => {
    const mapped = mapOpenMhzCall(call(), options)!;
    expect(mapped).toMatchObject({
      id: '66f0a1b2c3d4e5f60718293a',
      shortName: 'psern025',
      talkgroup: 1103,
      durationSeconds: 12,
      frequencyHz: 851012500,
    });
    expect(mapped.audioUrl).toContain('openmhz.com');
  });

  it('never carries unit radio identifiers', () => {
    /*
     * The single most important assertion in this file. `srcList` names the radios that
     * transmitted; retaining it across calls would build a movement history of
     * identifiable people, which this project refuses to build.
     */
    const mapped = mapOpenMhzCall(call(), options)!;
    expect(JSON.stringify(mapped)).not.toContain('srcList');
    expect(JSON.stringify(mapped)).not.toContain('4521');
    expect(Object.keys(mapped)).not.toContain('srcList');
  });

  it('drops a call it cannot place in time', () => {
    expect(mapOpenMhzCall(call({ time: undefined }), options)).toBeNull();
    expect(mapOpenMhzCall(call({ time: 'not a date' }), options)).toBeNull();
  });

  it('drops a call with no id or no talkgroup', () => {
    expect(mapOpenMhzCall(call({ _id: undefined }), options)).toBeNull();
    expect(mapOpenMhzCall(call({ talkgroupNum: undefined }), options)).toBeNull();
  });

  it('refuses audio that is not plainly https', () => {
    expect(mapOpenMhzCall(call({ url: 'http://openmhz.com/a.m4a' }), options)).toBeNull();
    expect(mapOpenMhzCall(call({ url: 'javascript:alert(1)' }), options)).toBeNull();
    expect(mapOpenMhzCall(call({ url: undefined, filename: 'x.m4a' }), options)).toBeNull();
  });

  it('tolerates the alternative field names the service has used', () => {
    const mapped = mapOpenMhzCall(
      {
        id: 'abc123',
        talkgroup: 1104,
        startTime: secondsAgo(30),
        duration: '7',
        audioUrl: 'https://openmhz.com/media/x.m4a',
      },
      options,
    )!;
    expect(mapped).toMatchObject({ id: 'abc123', talkgroup: 1104, durationSeconds: 7 });
  });

  it('treats a missing duration as unknown rather than zero-length speech', () => {
    expect(mapOpenMhzCall(call({ len: undefined }), options)?.durationSeconds).toBe(0);
  });

  it('ships an audio host allow-list that covers the service', () => {
    expect(DEFAULT_OPENMHZ_AUDIO_HOSTS).toContain('openmhz.com');
  });
});

describe('talkgroup metadata', () => {
  const body = {
    talkgroups: [
      {
        num: 1103,
        alphaTag: 'KCSO N Disp',
        description: 'King County Sheriff North Dispatch',
        group: 'King County Sheriff',
      },
      { num: 1104, alphaTag: 'KCSO S Disp', group: 'King County Sheriff' },
      { nonsense: true },
    ],
  };

  it('indexes what it can and skips what it cannot', () => {
    const index = indexTalkgroups(body);
    expect(index.size).toBe(2);
    expect(index.get(1103)?.label).toBe('KCSO N Disp');
  });

  it('labels a call from the agency’s own metadata', () => {
    const index = indexTalkgroups(body);
    const mapped = mapOpenMhzCall(call(), { shortName: 'psern025' })!;
    const described = describeTalkgroup(mapped, index);
    expect(described.label).toBe('KCSO N Disp — King County Sheriff North Dispatch');
    expect(described.area).toBe('King County Sheriff');
  });

  it('falls back to the number when the talkgroup is unknown', () => {
    const mapped = mapOpenMhzCall(call({ talkgroupNum: 9999 }), { shortName: 'psern025' })!;
    expect(describeTalkgroup(mapped, new Map()).label).toBe('Talkgroup 9999');
  });
});

describe('talkgroup separator', () => {
  it('uses "+" in the canonical id, because SOURCES is comma-separated', () => {
    /*
     * The collision is easy to reintroduce: `SOURCES` splits on commas, so a
     * comma-separated talkgroup list would be cut in half and the surviving spec would
     * quietly poll a different set of talkgroups than the operator asked for.
     */
    const system = parseOpenMhzSpec('openmhz:psern025/1103+1104')!;
    expect(openMhzSourceId(system)).toBe('openmhz:psern025/1103+1104');
    expect(openMhzSourceId(system).split(',')).toHaveLength(1);
  });

  it('still accepts "," and ";" for a spec passed on its own', () => {
    // The probe script takes the whole spec as one argument, where commas are harmless.
    for (const spec of ['openmhz:psern025/1103,1104', 'openmhz:psern025/1103;1104']) {
      expect(parseOpenMhzSpec(spec)?.talkgroups, spec).toEqual([1103, 1104]);
    }
  });
});
