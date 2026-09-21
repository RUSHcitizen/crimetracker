import { describe, expect, it, vi } from 'vitest';
import { parseOpenMhzSpec, type RawIncident } from '@crimetracker/shared';
import { OpenMhzCallSource } from '../src/sources/openmhz.js';
import { assertFetchableMediaUrl, hostAllowed, SourcePolicyError } from '../src/sources/policy.js';
import { HeuristicExtractor } from '../src/extraction/heuristic.js';
import type { SpeechToText, TranscriptionResult } from '../src/audio/types.js';
import type { SourceContext } from '../src/sources/types.js';

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const CALL = {
  _id: 'call-0001',
  talkgroupNum: 1103,
  url: 'https://openmhz.com/media/psern025/1103-a.m4a',
  time: secondsAgo(90),
  srcList: [{ src: 4521, pos: 0 }],
  len: 14,
  freq: 851012500,
};

const TALKGROUPS = {
  talkgroups: [
    {
      num: 1103,
      alphaTag: 'KCSO N Disp',
      description: 'King County Sheriff North Dispatch',
      group: 'King County Sheriff',
    },
  ],
};

/** A transcript that a heuristic extractor can actually get something out of. */
class StubStt implements SpeechToText {
  readonly id = 'stub-stt';
  readonly label = 'stub';
  calls = 0;
  constructor(private readonly text: string | null = 'Units respond, burglary in progress at 1425 4th Avenue') {}
  async transcribe(): Promise<TranscriptionResult | null> {
    this.calls += 1;
    if (!this.text) return null;
    return { text: this.text, confidence: 0.6, providerId: this.id, durationMs: 10 };
  }
}

function testContext() {
  const emitted: RawIncident[] = [];
  const states: string[] = [];
  const logs: string[] = [];
  const ctx: SourceContext = {
    emit: (raw) => emitted.push(raw),
    emitMany: (raws) => emitted.push(...raws),
    log: (_level, message) => logs.push(message),
    setState: (state) => states.push(state),
    signal: new AbortController().signal,
  };
  return { ctx, emitted, states, logs };
}

/** Serves the calls endpoint, the talkgroups endpoint and the audio, in one stub. */
function stubFetch(
  over: {
    calls?: unknown;
    talkgroups?: unknown;
    callsStatus?: number;
    audioStatus?: number;
    audioBytes?: number;
    onRequest?: (url: string) => void;
  } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    over.onRequest?.(url);

    if (url.includes('/talkgroups')) {
      return new Response(JSON.stringify(over.talkgroups ?? TALKGROUPS), { status: 200 });
    }
    if (url.includes('/calls')) {
      return new Response(JSON.stringify(over.calls ?? { calls: [CALL] }), {
        status: over.callsStatus ?? 200,
      });
    }
    // Audio.
    const size = over.audioBytes ?? 2048;
    return new Response(new Uint8Array(size), {
      status: over.audioStatus ?? 200,
      headers: { 'content-type': 'audio/mp4', 'content-length': String(size) },
    });
  }) as typeof fetch;
}

function build(
  spec: string,
  over: Partial<ConstructorParameters<typeof OpenMhzCallSource>[0]> = {},
) {
  const system = parseOpenMhzSpec(spec)!;
  return new OpenMhzCallSource({
    system,
    acknowledged: true,
    stt: new StubStt(),
    transcriptionAvailable: true,
    extractor: new HeuristicExtractor(),
    pollSeconds: 3600,
    fetchImpl: stubFetch(),
    ...over,
  });
}

describe('OpenMhzCallSource', () => {
  it('turns a call into an incident with honest provenance', async () => {
    const source = build('openmhz:psern025');
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(1);
    const raw = emitted[0]!;

    // The call's own recorded start time is source-held, not inferred.
    expect(raw.timestamp).toBe(CALL.time);
    expect(raw.provenance?.timestamp?.origin).toBe('source');
    expect(raw.provenance?.transcript?.origin).toBe('source');
    // Everything a model read out of the transcript is flagged as inference.
    expect(raw.provenance?.incidentType?.origin).toBe('ai-inferred');
    expect(raw.provenance?.location?.origin).toBe('ai-inferred');
    // A transcript can never establish a position.
    expect(raw.coordinates).toBeNull();
    expect(raw.transcript).toContain('burglary');
  });

  it('never stores unit radio identifiers', async () => {
    const source = build('openmhz:psern025');
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    const serialized = JSON.stringify(emitted[0]);
    expect(serialized).not.toContain('srcList');
    expect(serialized).not.toContain('4521');
  });

  it('labels the location from talkgroup metadata when nothing is extracted', async () => {
    const source = build('openmhz:psern025', {
      // Speech with no address and no recognisable incident wording.
      stt: new StubStt('copy that, show me clear'),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    const raw = emitted[0]!;
    expect(raw.locationLabel).toBe('KCSO N Disp — King County Sheriff North Dispatch');
    // Talkgroup metadata is the source's own, so it is derived — not an AI inference.
    expect(raw.provenance?.location?.origin).toBe('derived');
    expect(raw.area).toBe('King County Sheriff');
  });

  it('emits nothing when a clip produces no intelligible speech', async () => {
    const source = build('openmhz:psern025', { stt: new StubStt(null) });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(0);
    expect(source.status().eventsRejected).toBeGreaterThan(0);
  });

  it('filters talkgroups client-side, whatever the API does with the query', async () => {
    const source = build('openmhz:psern025/1104', {
      // The stub deliberately ignores `filter-code` and returns talkgroup 1103 anyway.
      fetchImpl: stubFetch({ calls: { calls: [CALL] } }),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(0);
  });

  it('skips squelch blips before fetching any audio', async () => {
    const stt = new StubStt();
    const requested: string[] = [];
    const source = build('openmhz:psern025', {
      stt,
      minCallSeconds: 2,
      fetchImpl: stubFetch({
        calls: { calls: [{ ...CALL, _id: 'blip', len: 0.4 }] },
        onRequest: (url) => requested.push(url),
      }),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(0);
    expect(stt.calls).toBe(0);
    expect(requested.some((u) => u.endsWith('.m4a'))).toBe(false);
  });

  it('caps how many calls one poll transcribes', async () => {
    const stt = new StubStt();
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...CALL,
      _id: `call-${i}`,
      time: secondsAgo(100 + i),
    }));
    const source = build('openmhz:psern025', {
      stt,
      maxCallsPerPoll: 3,
      fetchImpl: stubFetch({ calls: { calls: many } }),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    // Read before stopping: a stopped source reports no current message.
    const status = source.status();
    await source.stop();

    // Bounds the upstream load and the transcription bill on a busy system.
    expect(emitted).toHaveLength(3);
    expect(stt.calls).toBe(3);
    expect(status.message).toContain("beyond this poll's cap");
  });

  it('keeps the newest calls when it has to drop some', async () => {
    const many = [
      { ...CALL, _id: 'old', time: secondsAgo(900) },
      { ...CALL, _id: 'new', time: secondsAgo(30) },
      { ...CALL, _id: 'mid', time: secondsAgo(300) },
    ];
    const source = build('openmhz:psern025', {
      maxCallsPerPoll: 1,
      fetchImpl: stubFetch({ calls: { calls: many } }),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted[0]?.externalId).toBe('new');
  });

  it('does not re-fetch a call it has already handled', async () => {
    const stt = new StubStt();
    const source = build('openmhz:psern025', {
      stt,
      pollSeconds: 0.01,
      fetchImpl: stubFetch(),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await source.stop();

    // The stub returns the same call on every poll.
    expect(emitted).toHaveLength(1);
    expect(stt.calls).toBe(1);
  });

  it('asks only for newer calls on the second poll', async () => {
    const requested: string[] = [];
    const source = build('openmhz:psern025', {
      pollSeconds: 0.01,
      fetchImpl: stubFetch({ onRequest: (url) => requested.push(url) }),
    });
    const { ctx } = testContext();
    await source.start(ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await source.stop();

    const callPages = requested.filter((u) => u.includes('/calls'));
    expect(callPages.length).toBeGreaterThan(1);
    expect(new URL(callPages[0]!).searchParams.has('time')).toBe(false);
    expect(new URL(callPages[1]!).searchParams.get('direction')).toBe('newer');
  });

  it('backs off hard when rate limited', async () => {
    const requested: string[] = [];
    const source = build('openmhz:psern025', {
      pollSeconds: 0.01,
      fetchImpl: stubFetch({ callsStatus: 429, onRequest: (url) => requested.push(url) }),
    });
    const { ctx, states } = testContext();
    await source.start(ctx);
    const status = source.status();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await source.stop();

    expect(states).toContain('degraded');
    expect(status.message).toContain('Rate limited');
    // A published rate limit is a rule, not an obstacle: no retry storm.
    expect(requested.filter((u) => u.includes('/calls'))).toHaveLength(1);
  });

  it('refuses call audio pointed somewhere other than the allow-list', async () => {
    const stt = new StubStt();
    const source = build('openmhz:psern025', {
      stt,
      fetchImpl: stubFetch({
        calls: { calls: [{ ...CALL, url: 'https://evil.example.com/pwn.m4a' }] },
      }),
    });
    const { ctx, emitted, logs } = testContext();
    await source.start(ctx);
    await source.stop();

    expect(emitted).toHaveLength(0);
    expect(stt.calls).toBe(0);
    expect(logs.join('\n')).toContain('refusing call audio');
  });

  it('runs inert, and says so, without speech-to-text', async () => {
    const stt = new StubStt();
    const requested: string[] = [];
    const source = build('openmhz:psern025', {
      stt,
      transcriptionAvailable: false,
      fetchImpl: stubFetch({ onRequest: (url) => requested.push(url) }),
    });
    const { ctx, emitted } = testContext();
    await source.start(ctx);
    const status = source.status();
    await source.stop();

    // A talkgroup and a timestamp are not an incident, so nothing is manufactured —
    // and nothing is fetched from the service either.
    expect(emitted).toHaveLength(0);
    expect(requested).toHaveLength(0);
    expect(status.state).toBe('degraded');
    expect(status.message).toContain('STT_PROVIDER');
  });

  it('refuses to exist without an explicit acknowledgement', () => {
    expect(() => build('openmhz:psern025', { acknowledged: false })).toThrow(SourcePolicyError);
  });

  it('describes itself honestly in the HUD', () => {
    const source = build('openmhz:psern025/1103');
    expect(source.descriptor.kind).toBe('audio');
    expect(source.descriptor.url).toBe('https://openmhz.com/system/psern025');
    expect(source.descriptor.note).toContain('broadcast in the clear');
    expect(source.descriptor.note).toContain('not decoded');
    expect(source.descriptor.note).toContain('AI-inferred');
  });
});

describe('assertFetchableMediaUrl', () => {
  const hosts = ['openmhz.com', 'amazonaws.com'];

  it('accepts an allowed host and its subdomains', () => {
    expect(assertFetchableMediaUrl('https://openmhz.com/a.m4a', hosts).hostname).toBe('openmhz.com');
    expect(assertFetchableMediaUrl('https://media.openmhz.com/a.m4a', hosts).hostname).toBe(
      'media.openmhz.com',
    );
  });

  it('refuses a lookalike suffix', () => {
    expect(() => assertFetchableMediaUrl('https://notopenmhz.com/a.m4a', hosts)).toThrow(
      SourcePolicyError,
    );
  });

  it('refuses private and loopback addresses even if allow-listed', () => {
    /*
     * These URLs arrive inside feed records and are fetched server-side, so this is a
     * server-side request forgery surface. Unlike `assertPublicUrl`, there is no
     * loopback exception here.
     */
    for (const url of [
      'https://127.0.0.1/a.m4a',
      'https://localhost/a.m4a',
      'https://10.0.0.5/a.m4a',
      'https://192.168.1.1/a.m4a',
      'https://172.16.0.1/a.m4a',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/a.m4a',
      'https://thing.internal/a.m4a',
    ]) {
      expect(() => assertFetchableMediaUrl(url, [...hosts, '0.1', 'localhost', 'internal', '254', 'com']), url).toThrow(
        SourcePolicyError,
      );
    }
  });

  it('refuses non-https, credentialed and non-string inputs', () => {
    expect(() => assertFetchableMediaUrl('http://openmhz.com/a.m4a', hosts)).toThrow();
    expect(() => assertFetchableMediaUrl('https://u:p@openmhz.com/a.m4a', hosts)).toThrow();
    expect(() => assertFetchableMediaUrl(null, hosts)).toThrow();
    expect(() => assertFetchableMediaUrl('not a url', hosts)).toThrow();
  });

  it('matches hosts exactly or by dotted suffix', () => {
    expect(hostAllowed('openmhz.com', hosts)).toBe(true);
    expect(hostAllowed('a.b.openmhz.com', hosts)).toBe(true);
    expect(hostAllowed('openmhz.com.evil.net', hosts)).toBe(false);
    expect(hostAllowed('openmhz.com', [])).toBe(false);
  });
});
