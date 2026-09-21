import {
  catalogIds,
  findCatalogSource,
  parseOpenMhzSpec,
  type AppMode,
  type SourceStatus,
} from '@crimetracker/shared';
import type { Config } from '../config.js';
import { NullSpeechToText, WhisperHttpSpeechToText } from '../audio/stt.js';
import type { IncidentExtractor } from '../extraction/types.js';
import { PublicAudioSource } from './audio.js';
import { SourcePolicyError } from './policy.js';
import { CatalogFeedSource } from './catalogFeed.js';
import { OpenMhzCallSource } from './openmhz.js';
import { PublicSafetyFeedSource } from './publicFeed.js';
import { SimulationSource } from './simulation.js';
import type { DataSource } from './types.js';

/**
 * The mode a source belongs to.
 *
 * This is derived from the adapter's own kind rather than configured separately, so a
 * simulated source can never be counted as a live one by mistake.
 */
export function modeOfSource(source: DataSource): AppMode {
  return source.descriptor.kind === 'simulation' ? 'simulation' : 'live';
}

/**
 * Builds every configured source, regardless of the starting mode.
 *
 * All of them are registered with the pipeline, which then starts only those belonging
 * to the active mode. Building them up front is what makes the runtime LIVE/SIMULATION
 * switch real rather than cosmetic.
 *
 * The application knows only the `DataSource` interface; this is the one place where
 * concrete adapters are named, so adding a provider is an edit here plus a new file.
 */
export function buildSources(config: Config, extractor: IncidentExtractor): {
  sources: DataSource[];
  warnings: string[];
} {
  const sources: DataSource[] = [];
  const warnings: string[] = [];

  sources.push(
    new SimulationSource({
      intervalSeconds: config.simulation.intervalSeconds,
      seed: config.simulation.seed,
      backfill: config.simulation.backfill,
      backfillHours: config.simulation.backfillHours,
    }),
  );

  /*
   * Speech-to-text is built once and shared: the OpenMHz source and the live-stream
   * source both need it, and whether a *real* one is configured decides whether either
   * can produce anything at all.
   */
  const stt = buildSpeechToText(config);
  const transcriptionAvailable = !(stt instanceof NullSpeechToText);

  // Catalogued real feeds, selected by id — the normal way to connect live data.
  for (const id of config.sources) {
    // Radio call archives are their own adapter: they poll discrete recordings and run
    // each through transcription, rather than mapping columns onto an incident.
    const openMhz = parseOpenMhzSpec(id, config.openmhz.apiBase);
    if (openMhz) {
      if (!config.openmhz.acknowledged) {
        warnings.push(
          `${id}: requires OPENMHZ_ACK=1, confirming the recordings are lawfully and ` +
            'publicly accessible and that you are permitted to process them.',
        );
        continue;
      }
      if (!transcriptionAvailable) {
        // Built anyway, so the HUD shows the source and states why it is inert. A
        // missing source is indistinguishable from a broken one.
        warnings.push(
          `${id}: no speech-to-text configured (STT_PROVIDER), so radio calls cannot ` +
            'become incidents. The source will run inert.',
        );
      }
      try {
        sources.push(
          new OpenMhzCallSource({
            system: openMhz,
            acknowledged: config.openmhz.acknowledged,
            stt,
            transcriptionAvailable,
            extractor,
            pollSeconds: config.openmhz.pollSeconds,
            maxCallsPerPoll: config.openmhz.maxCallsPerPoll,
            minCallSeconds: config.openmhz.minCallSeconds,
            audioHosts: config.openmhz.audioHosts,
          }),
        );
      } catch (error) {
        warnings.push(describe(id, error));
      }
      continue;
    }

    const catalogSource = findCatalogSource(id, config.catalogOverrideUrl);
    if (!catalogSource) {
      // A bare number here is almost always a talkgroup list written with commas, which
      // `SOURCES` split in half. Saying so beats "unknown source: 1104".
      const hint = /^\d+$/.test(id)
        ? ` Talkgroups in an OpenMHz spec are joined with "+", not "," — SOURCES is ` +
          'itself comma-separated, e.g. openmhz:psern025/1103+1104.'
        : '';
      warnings.push(
        `Unknown source "${id}". Available ids: ${catalogIds().join(', ')}.${hint}`,
      );
      continue;
    }
    // A publisher that issues an access key cannot be polled without it. Skipping with a
    // warning beats starting a source that will only ever return 401.
    const apiKey = catalogSource.keyEnv ? config.sourceKeys[catalogSource.keyEnv] : undefined;
    if (catalogSource.keyEnv && !apiKey) {
      warnings.push(
        `${catalogSource.id}: requires ${catalogSource.keyEnv}. Request a free key at ` +
          `${catalogSource.docsUrl} and set it in the environment.`,
      );
      continue;
    }

    try {
      sources.push(
        new CatalogFeedSource({
          source: catalogSource,
          pollSeconds: config.feed.pollSeconds,
          apiKey: apiKey ?? null,
        }),
      );
    } catch (error) {
      warnings.push(describe(catalogSource.id, error));
    }
  }

  // Generic escape hatch for a feed that is not in the catalogue.
  if (config.feed.enabled) {
    try {
      sources.push(
        new PublicSafetyFeedSource({
          name: config.feed.name,
          url: config.feed.url,
          pollSeconds: config.feed.pollSeconds,
          itemsPath: config.feed.itemsPath,
          map: config.feed.map,
        }),
      );
    } catch (error) {
      warnings.push(describe('public feed', error));
    }
  }

  if (config.audio.enabled) {
    try {
      if (!transcriptionAvailable) {
        warnings.push(
          'public-audio: no speech-to-text configured (STT_PROVIDER), so segments will be discarded.',
        );
      }

      sources.push(
        new PublicAudioSource({
          name: 'Public Audio Stream',
          url: config.audio.url,
          acknowledged: config.audio.acknowledged,
          segmentSeconds: config.audio.segmentSeconds,
          stt,
          extractor,
        }),
      );
    } catch (error) {
      warnings.push(describe('public audio', error));
    }
  } else if (config.audio.url && !config.audio.acknowledged) {
    warnings.push(
      'public-audio: PUBLIC_AUDIO_URL is set but PUBLIC_AUDIO_ACK is not 1 — source disabled.',
    );
  }

  if (!sources.some((source) => modeOfSource(source) === 'live')) {
    warnings.push(
      'No live source is configured, so LIVE mode is unavailable. Set SOURCES to one or ' +
        'more catalogued feeds (run `npm run sources` to list them), or FEED_URL for an ' +
        'endpoint that is not catalogued. See .env.example.',
    );
  }

  return { sources, warnings };
}

/** The configured speech-to-text provider, or the inert one. */
function buildSpeechToText(config: Config) {
  return config.audio.stt.provider === 'whisper-http' && config.audio.stt.baseUrl
    ? new WhisperHttpSpeechToText({
        baseUrl: config.audio.stt.baseUrl,
        model: config.audio.stt.model,
        apiKey: config.audio.stt.apiKey,
      })
    : new NullSpeechToText();
}

function describe(label: string, error: unknown): string {
  if (error instanceof SourcePolicyError) return `${label}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

export function statusesOf(sources: readonly DataSource[]): SourceStatus[] {
  return sources.map((source) => source.status());
}
