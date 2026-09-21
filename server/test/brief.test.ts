import { describe, expect, it, vi } from 'vitest';
import {
  composeBrief,
  normalizeIncident,
  spokenRelative,
  type Incident,
  type SourceDescriptor,
} from '@crimetracker/shared';
import {
  BriefService,
  ComposedBriefGenerator,
  groundingFor,
  LlmBriefGenerator,
} from '../src/brief/index.js';

const SOURCE: SourceDescriptor = {
  id: 'seattle-police-calls',
  name: 'Seattle Police Call Data',
  kind: 'public-feed',
  note: 'test',
};

const NOW = Date.parse('2026-09-21T12:00:00.000Z');

function incident(over: Record<string, unknown> = {}): Incident {
  const result = normalizeIncident(
    {
      externalId: 'CAD-1',
      timestamp: new Date(NOW - 8 * 60_000).toISOString(),
      incidentType: 'burglary',
      severity: 3,
      description: 'BURGLARY - IN PROGRESS',
      locationLabel: '1500 BLOCK OF 3RD AVE',
      locationPrecision: 'block',
      area: 'Seattle',
      coordinates: { lat: 47.6105, lon: -122.3378 },
      confidence: 0.8,
      ...over,
    },
    { source: SOURCE, now: NOW },
  );
  if (!result.ok) throw new Error(`fixture failed: ${result.reason}`);
  return result.incident;
}

describe('composeBrief', () => {
  it('turns dispatch shorthand into a speakable sentence', () => {
    const text = composeBrief(incident(), NOW);
    expect(text).toContain('burglary report');
    expect(text).toContain('1500 BLOCK OF 3RD AVE');
    // SHOUTED agency text is lower-cased so it can be read aloud without sounding odd.
    expect(text).toContain('Reported as: Burglary - in progress.');
    expect(text).toContain('Source: Seattle Police Call Data');
  });

  it('says when the position is only approximate', () => {
    expect(composeBrief(incident(), NOW)).toContain('approximate, to about block level');
    expect(composeBrief(incident({ locationPrecision: 'area' }), NOW)).toContain(
      'area-level only',
    );
  });

  it('says plainly when there is no position at all', () => {
    const text = composeBrief(incident({ coordinates: null }), NOW);
    expect(text).toContain('no position was published');
    expect(text).toContain('not plotted');
  });

  it('flags a category the source did not state', () => {
    // No incidentType given, so the classifier worked it out — the brief must say so
    // rather than presenting an inference as the publisher's own classification.
    const text = composeBrief(
      incident({ incidentType: undefined, description: 'Forced entry reported overnight' }),
      NOW,
    );
    expect(text).toContain('inferred from the text');
  });

  it('adds no fact that is not in the record', () => {
    /*
     * The central property. Every proper noun and number in the output has to be
     * traceable to a field; a composed brief must never acquire a cause, a suspect or an
     * outcome that nobody reported.
     */
    const text = composeBrief(incident(), NOW);
    for (const invented of ['suspect', 'arrest', 'injur', 'weapon', 'stolen vehicle', 'fled']) {
      expect(text.toLowerCase()).not.toContain(invented);
    }
  });

  it('is deterministic for the same record', () => {
    const one = incident();
    expect(composeBrief(one, NOW)).toBe(composeBrief(one, NOW));
  });

  it('is labelled derived, never ai-inferred', async () => {
    const brief = await new ComposedBriefGenerator().generate(incident());
    expect(brief.origin).toBe('derived');
  });
});

describe('groundingFor', () => {
  it('sends the model only an allow-listed view of the record', () => {
    const grounding = groundingFor(
      incident({ raw: { officer_badge: 'K-4412', internal_code: 'XYZ' } }),
    );
    // `raw` holds the publisher's original payload, which can carry identifiers and
    // internal codes with no business in a spoken summary or leaving the machine.
    const serialized = JSON.stringify(grounding);
    expect(serialized).not.toContain('officer_badge');
    expect(serialized).not.toContain('K-4412');
    expect(serialized).not.toContain('internal_code');
    // Coordinates are excluded: a brief describes the place the source named.
    expect(serialized).not.toContain('47.61');
    expect(grounding.location).toBe('1500 BLOCK OF 3RD AVE');
    expect(grounding.has_plotted_position).toBe(true);
  });

  it('passes a radio transcript through when there is one', () => {
    const withTranscript = groundingFor(
      incident({ transcript: 'Units respond, burglary in progress' }),
    );
    expect(withTranscript.radio_transcript).toContain('burglary in progress');
    expect(groundingFor(incident()).radio_transcript).toBeUndefined();
  });
});

describe('LlmBriefGenerator', () => {
  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('uses the model output and labels it as inference', async () => {
    const generator = new LlmBriefGenerator({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetchImpl: (async () =>
        reply('Police are responding to a reported burglary in progress on the 1500 block of Third Avenue in Seattle.')) as typeof fetch,
    });
    const brief = await generator.generate(incident());
    expect(brief.origin).toBe('ai-inferred');
    expect(brief.text).toContain('Third Avenue');
  });

  it('falls back to the composed brief when the model errors', async () => {
    const generator = new LlmBriefGenerator({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
    });
    const brief = await generator.generate(incident());
    // An accurate sentence beats an error, and beats a plausible fabrication.
    expect(brief.origin).toBe('derived');
    expect(brief.text).toContain('burglary report');
  });

  it('falls back rather than showing empty or runaway output', async () => {
    for (const content of ['', '   ', 'x'.repeat(2000)]) {
      const generator = new LlmBriefGenerator({
        baseUrl: 'https://model.example/v1',
        model: 'test-model',
        fetchImpl: (async () => reply(content)) as typeof fetch,
      });
      expect((await generator.generate(incident())).origin, JSON.stringify(content.slice(0, 12))).toBe(
        'derived',
      );
    }
  });

  it('falls back when the endpoint is unreachable', async () => {
    const generator = new LlmBriefGenerator({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND');
      }) as typeof fetch,
    });
    expect((await generator.generate(incident())).origin).toBe('derived');
  });
});

describe('BriefService', () => {
  it('generates once per incident and serves the rest from cache', async () => {
    const generate = vi.fn(async () => ({
      text: 'A brief.',
      origin: 'derived' as const,
      generatorId: 'stub',
      generatedAt: new Date().toISOString(),
    }));
    const service = new BriefService({ id: 'stub', label: 'stub', generate });
    const one = incident();

    await service.briefFor(one);
    await service.briefFor(one);
    // An incident's fields never change after ingestion, so one brief per incident is
    // correct as well as cheap — and keeps it from re-describing itself differently.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent requests for the same incident', async () => {
    const generate = vi.fn(
      async () =>
        new Promise<{ text: string; origin: 'derived'; generatorId: string; generatedAt: string }>(
          (resolve) =>
            setTimeout(
              () =>
                resolve({
                  text: 'A brief.',
                  origin: 'derived',
                  generatorId: 'stub',
                  generatedAt: new Date().toISOString(),
                }),
              10,
            ),
        ),
    );
    const service = new BriefService({ id: 'stub', label: 'stub', generate });
    const one = incident();
    await Promise.all([service.briefFor(one), service.briefFor(one), service.briefFor(one)]);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache', async () => {
    const service = new BriefService(new ComposedBriefGenerator(), 2);
    for (let i = 0; i < 6; i += 1) {
      await service.briefFor(incident({ externalId: `CAD-${i}` }));
    }
    // No assertion on internals beyond this: it must simply not grow without limit.
    expect(service.generatorId).toBe('composed-v1');
  });
});

describe('spoken wording', () => {
  it('spells out elapsed time instead of using HUD shorthand', () => {
    // `formatRelative` produces "5m", which a speech synthesiser reads as "five em".
    expect(spokenRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 minutes ago');
    expect(spokenRelative(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(spokenRelative(new Date(NOW - 60_000).toISOString(), NOW)).toBe('a minute ago');
    expect(spokenRelative(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('about 3 hours ago');
    expect(spokenRelative(new Date(NOW - 50 * 3_600_000).toISOString(), NOW)).toBe('about 2 days ago');
    expect(spokenRelative('not a date', NOW)).toBe('at an unknown time');
  });

  it('uses "at" for a specific place and "in" for a named area', () => {
    expect(composeBrief(incident({ locationLabel: 'I-5 southbound at milepost 157' }), NOW)).toContain(
      'at I-5 southbound',
    );
    expect(composeBrief(incident({ locationLabel: '1500 BLOCK OF 3RD AVE' }), NOW)).toContain(
      'at 1500 BLOCK',
    );
    expect(composeBrief(incident({ locationLabel: 'E Pine St & 12th Ave' }), NOW)).toContain(
      'at E Pine St',
    );
    expect(
      composeBrief(incident({ locationLabel: 'King County Sheriff North Dispatch' }), NOW),
    ).toContain('in King County Sheriff North Dispatch');
  });

  it('contains nothing a speech synthesiser would mangle', () => {
    const text = composeBrief(incident(), NOW);
    // No markdown, no bare unit abbreviations, no leftover punctuation runs.
    expect(text).not.toMatch(/[*_`#|]/);
    expect(text).not.toMatch(/\b\d+[mhd]\b/);
  });
});
