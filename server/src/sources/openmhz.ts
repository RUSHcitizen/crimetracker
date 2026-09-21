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
  type OpenMhzSystem,
  type RadioCall,
  type RawIncident,
  type SourceDescriptor,
  type TalkgroupInfo,
} from '@crimetracker/shared';
import type { SpeechToText } from '../audio/types.js';
import type { IncidentExtractor } from '../extraction/types.js';
import { assertFetchableMediaUrl, assertPublicUrl, SourcePolicyError } from './policy.js';
import { SourceStatusTracker, type DataSource, type SourceContext } from './types.js';

export interface OpenMhzSourceOptions {
  readonly system: OpenMhzSystem;
  /** Explicit operator acknowledgement, as for every audio path in this project. */
  readonly acknowledged: boolean;
  readonly stt: SpeechToText;
  /** False when no real speech-to-text is configured; the source then explains itself. */
  readonly transcriptionAvailable: boolean;
  readonly extractor: IncidentExtractor;
  readonly pollSeconds: number;
  /** Calls transcribed per poll. Bounds both the upstream load and the STT bill. */
  readonly maxCallsPerPoll?: number;
  /** Calls shorter than this are skipped — squelch blips transcribe to nothing. */
  readonly minCallSeconds?: number;
  readonly audioHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * Archived public radio calls from OpenMHz → transcript → extraction → incident.
 *
 * Off unless the operator both names a system and sets `OPENMHZ_ACK=1`.
 *
 * Being a good citizen is part of the design, not an afterthought. OpenMHz is a
 * volunteer-run service, so: only genuinely new calls are fetched, audio is never
 * re-downloaded, transcription is sequential and capped per poll, very short calls are
 * skipped before they cost anyone anything, and `429` backs off hard rather than
 * retrying. Check the service's own terms before pointing a continuous poller at it.
 *
 * What comes out is honest about what it is. The transcript is source-held; every field
 * a model read out of it — type, severity, description, place name — is `ai-inferred`
 * and labelled as such in the HUD. The talkgroup label is `derived`, because it comes
 * from the system's own metadata. And the coordinates are always `null`: a transcript
 * cannot establish a position, and this pipeline has no path that would let it invent
 * one.
 */
export class OpenMhzCallSource implements DataSource {
  readonly descriptor: SourceDescriptor;
  readonly #tracker: SourceStatusTracker;
  readonly #options: OpenMhzSourceOptions;
  readonly #fetch: typeof fetch;
  readonly #audioHosts: readonly string[];
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #seen = new Set<string>();
  #talkgroups: ReadonlyMap<number, TalkgroupInfo> = new Map();
  #talkgroupsLoadedAt = 0;
  /** Newest call start accepted so far, for incremental polling. */
  #watermark: string | null = null;
  #backoffUntil = 0;

  constructor(options: OpenMhzSourceOptions) {
    if (!options.acknowledged) {
      throw new SourcePolicyError(
        'The OpenMHz source requires OPENMHZ_ACK=1, confirming the recordings are ' +
          'lawfully and publicly accessible and that you are permitted to process them.',
      );
    }
    // The API base is operator-supplied, so the ordinary policy applies to it.
    assertPublicUrl(options.system.apiBase);

    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#audioHosts = options.audioHosts ?? DEFAULT_OPENMHZ_AUDIO_HOSTS;

    const scope =
      options.system.talkgroups.length > 0
        ? `talkgroups ${options.system.talkgroups.join(', ')}`
        : 'all published talkgroups';

    this.descriptor = {
      id: openMhzSourceId(options.system),
      name: `OpenMHz ${options.system.shortName}`,
      kind: 'audio',
      note:
        `Archived public radio calls from the ${options.system.shortName} system on ` +
        `OpenMHz (${scope}), transcribed and parsed locally. Recordings are of traffic ` +
        'broadcast in the clear; encrypted talkgroups are not carried and are not ' +
        'decoded. Type, description and any place name are AI-inferred from the ' +
        'transcript and never carry coordinates. Unit radio identifiers are discarded.',
      url: openMhzSystemUrl(options.system),
    };
    this.#tracker = new SourceStatusTracker(this.descriptor, true);
  }

  status() {
    return this.#tracker.snapshot();
  }

  async start(ctx: SourceContext): Promise<void> {
    this.#stopped = false;

    if (!this.#options.transcriptionAvailable) {
      /*
       * Without transcription a call is a talkgroup and a timestamp. Emitting an incident
       * from that would be manufacturing a record of an event nobody has established —
       * precisely what this project exists not to do. So the source runs inert and says
       * why, rather than quietly producing empty incidents or vanishing from the HUD.
       */
      const reason =
        'No speech-to-text configured (STT_PROVIDER), so calls cannot be turned into ' +
        'incidents. Nothing will be fetched.';
      this.#tracker.setState('degraded', reason);
      ctx.setState('degraded', reason);
      return;
    }

    this.#tracker.setState('connecting', `Contacting OpenMHz (${this.#options.system.shortName})`);
    ctx.setState('connecting', `Contacting OpenMHz (${this.#options.system.shortName})`);
    await this.#poll(ctx);
    this.#schedule(ctx);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#tracker.setState('stopped', null);
  }

  #schedule(ctx: SourceContext): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.#poll(ctx).finally(() => this.#schedule(ctx));
    }, this.#options.pollSeconds * 1000);
    this.#timer.unref?.();
  }

  async #poll(ctx: SourceContext): Promise<void> {
    if (this.#stopped) return;
    if (Date.now() < this.#backoffUntil) return;

    try {
      await this.#ensureTalkgroups(ctx);

      const response = await this.#request(buildCallsUrl(this.#options.system, {
        since: this.#watermark,
      }));

      if (response.status === 429) {
        // A published rate limit is a rule, not an obstacle.
        this.#backoffUntil = Date.now() + Math.max(120_000, this.#options.pollSeconds * 6000);
        const reason = 'Rate limited by OpenMHz — backing off';
        this.#tracker.setState('degraded', reason);
        ctx.setState('degraded', reason);
        return;
      }
      if (!response.ok) {
        this.#tracker.setState('error', `HTTP ${response.status}`);
        ctx.setState('error', `HTTP ${response.status}`);
        return;
      }

      const records = extractCalls(await response.json());
      const fresh = this.#selectFresh(records);

      let emitted = 0;
      for (const call of fresh.queue) {
        if (this.#stopped) break;
        // Sequential on purpose: one clip at a time is gentle on the archive and on
        // whatever is doing the transcription.
        const raw = await this.#processCall(ctx, call);
        if (raw) {
          ctx.emit(raw);
          this.#tracker.recordEvent();
          emitted += 1;
        } else {
          this.#tracker.recordRejection();
        }
      }

      const summary = this.#summarise(records.length, fresh, emitted);
      this.#tracker.setState('online', summary);
      ctx.setState('online', summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.#tracker.setState('error', message);
      ctx.setState('error', message);
      ctx.log('warn', `openmhz ${this.#options.system.shortName} poll failed: ${message}`);
    }
  }

  /**
   * Choose which calls to actually fetch audio for.
   *
   * Everything filtered here costs nobody anything: already seen, not on a requested
   * talkgroup, or too short to contain speech.
   */
  #selectFresh(records: readonly unknown[]): {
    queue: RadioCall[];
    skippedShort: number;
    deferred: number;
  } {
    const wanted = this.#options.system.talkgroups;
    const minSeconds = this.#options.minCallSeconds ?? 2;
    const cap = Math.max(1, this.#options.maxCallsPerPoll ?? 6);

    const candidates: RadioCall[] = [];
    let skippedShort = 0;
    let newestMs = this.#watermark ? Date.parse(this.#watermark) : 0;

    for (const record of records) {
      const call = mapOpenMhzCall(record, { shortName: this.#options.system.shortName });
      if (!call) continue;
      if (this.#seen.has(call.id)) continue;
      // The client-side talkgroup filter is the guarantee; the query parameter is only a
      // bandwidth optimisation, so a filter the API ignores changes nothing here.
      if (wanted.length > 0 && !wanted.includes(call.talkgroup)) {
        this.#seen.add(call.id);
        continue;
      }

      this.#seen.add(call.id);
      newestMs = Math.max(newestMs, Date.parse(call.startedAt));

      if (call.durationSeconds > 0 && call.durationSeconds < minSeconds) {
        skippedShort += 1;
        continue;
      }
      candidates.push(call);
    }

    if (newestMs > 0) this.#watermark = new Date(newestMs).toISOString();

    // Bound the dedup set so a long-running poller cannot grow without limit.
    if (this.#seen.size > 20_000) this.#seen = new Set([...this.#seen].slice(-10_000));

    // Newest first, then capped: on a busy system the recent traffic is what matters, and
    // the rest is dropped rather than queued into an ever-growing backlog.
    candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return {
      queue: candidates.slice(0, cap),
      skippedShort,
      deferred: Math.max(0, candidates.length - cap),
    };
  }

  async #processCall(ctx: SourceContext, call: RadioCall): Promise<RawIncident | null> {
    let audioUrl: URL;
    try {
      // The URL came from an external record and is about to be fetched server-side.
      audioUrl = assertFetchableMediaUrl(call.audioUrl, this.#audioHosts);
    } catch (error) {
      ctx.log('warn', `openmhz: refusing call audio — ${String(error)}`);
      return null;
    }

    const response = await this.#request(audioUrl.toString(), 'audio/*');
    if (!response.ok) return null;

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) return null;

    const transcription = await this.#options.stt.transcribe({
      id: call.id,
      bytes,
      mimeType: response.headers.get('content-type') ?? 'audio/mp4',
      startedAt: call.startedAt,
      durationSeconds: call.durationSeconds,
    });
    // No intelligible speech: an empty or unintelligible clip is not an incident.
    if (!transcription) return null;

    const talkgroup = describeTalkgroup(call, this.#talkgroups);

    const extraction = await this.#options.extractor.extract({
      transcript: transcription.text,
      receivedAt: call.startedAt,
      areaHint: talkgroup.area,
    });

    const inferred = (note: string) => ({
      origin: 'ai-inferred' as const,
      confidence: extraction.confidence,
      note,
    });

    return {
      externalId: call.id,
      // The call's own start time, from the recorder — not a model's reading of it.
      timestamp: call.startedAt,
      incidentType: extraction.incidentType ?? undefined,
      severity: extraction.severity ?? undefined,
      description: extraction.description ?? transcription.text.slice(0, 280),
      // The talkgroup name is the fallback place label: it is what the agency called the
      // channel, not a guess about where the call was.
      locationLabel: extraction.locationLabel ?? talkgroup.label,
      locationPrecision: extraction.locationPrecision ?? 'unknown',
      area: extraction.area ?? talkgroup.area ?? undefined,
      // A transcript never establishes a position. Never invent one.
      coordinates: null,
      confidence: Math.min(transcription.confidence, extraction.confidence || 0.3),
      transcript: transcription.text,
      status: 'extracting',
      tags: ['radio', 'openmhz', this.#options.system.shortName, `tg-${call.talkgroup}`],
      provenance: {
        timestamp: { origin: 'source', note: 'call start time' },
        transcript: { origin: 'source', note: transcription.providerId },
        ...(extraction.incidentType ? { incidentType: inferred(extraction.extractorId) } : {}),
        ...(extraction.severity ? { severity: inferred(extraction.extractorId) } : {}),
        ...(extraction.description ? { description: inferred(extraction.extractorId) } : {}),
        location: extraction.locationLabel
          ? inferred(extraction.extractorId)
          : { origin: 'derived', note: 'talkgroup metadata' },
      },
      /*
       * Audit payload. Note what is *not* here: `srcList`, the radio identifiers of the
       * units that transmitted. Keeping those would make this a movement history of
       * identifiable people, which this project does not build.
       */
      raw: {
        callId: call.id,
        system: call.shortName,
        talkgroup: call.talkgroup,
        talkgroupLabel: talkgroup.label,
        durationSeconds: call.durationSeconds,
        sttProvider: transcription.providerId,
        extractor: extraction.extractorId,
        extractionNotes: extraction.notes,
      },
    };
  }

  /** Talkgroup metadata changes rarely; fetch it once and refresh it slowly. */
  async #ensureTalkgroups(ctx: SourceContext): Promise<void> {
    if (this.#talkgroups.size > 0 && Date.now() - this.#talkgroupsLoadedAt < 6 * 3_600_000) {
      return;
    }
    try {
      const response = await this.#request(buildTalkgroupsUrl(this.#options.system));
      if (!response.ok) return;
      const index = indexTalkgroups(await response.json());
      if (index.size > 0) {
        this.#talkgroups = index;
        this.#talkgroupsLoadedAt = Date.now();
      }
    } catch (error) {
      // Not fatal: without it, calls are labelled by talkgroup number instead of name.
      ctx.log('warn', `openmhz: talkgroup metadata unavailable (${String(error)})`);
    }
  }

  async #request(url: string, accept = 'application/json'): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 30_000);
    try {
      return await this.#fetch(url, {
        signal: controller.signal,
        headers: { accept, 'user-agent': 'CrimeTracker/0.1 (public incident visualization)' },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  #summarise(
    returned: number,
    fresh: { queue: RadioCall[]; skippedShort: number; deferred: number },
    emitted: number,
  ): string {
    if (returned === 0) return 'No calls returned';
    if (fresh.queue.length === 0) {
      return fresh.skippedShort > 0
        ? `No new speech (${fresh.skippedShort} call(s) too short)`
        : 'No new calls since last poll';
    }
    const parts = [`${emitted} incident(s) from ${fresh.queue.length} new call(s)`];
    if (fresh.skippedShort > 0) parts.push(`${fresh.skippedShort} too short`);
    if (fresh.deferred > 0) parts.push(`${fresh.deferred} beyond this poll's cap`);
    return parts.join(', ');
  }
}
