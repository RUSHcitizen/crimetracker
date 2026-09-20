import { catalogIds, findCatalogSource, type AppMode, type SourceStatus } from '@crimetracker/shared';
import type { Config } from '../config.js';
import { NullSpeechToText, WhisperHttpSpeechToText } from '../audio/stt.js';
import type { IncidentExtractor } from '../extraction/types.js';
import { PublicAudioSource } from './audio.js';
import { SourcePolicyError } from './policy.js';
import { CatalogFeedSource } from './catalogFeed.js';
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

  // Catalogued real feeds, selected by id — the normal way to connect live data.
  for (const id of config.sources) {
    const catalogSource = findCatalogSource(id, config.catalogOverrideUrl);
    if (!catalogSource) {
      warnings.push(
        `Unknown source "${id}". Available ids: ${catalogIds().join(', ')}.`,
      );
      continue;
    }
    try {
      sources.push(
        new CatalogFeedSource({
          source: catalogSource,
          pollSeconds: config.feed.pollSeconds,
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
      const stt =
        config.audio.stt.provider === 'whisper-http' && config.audio.stt.baseUrl
          ? new WhisperHttpSpeechToText({
              baseUrl: config.audio.stt.baseUrl,
              model: config.audio.stt.model,
              apiKey: config.audio.stt.apiKey,
            })
          : new NullSpeechToText();

      if (stt instanceof NullSpeechToText) {
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
      'No live source is configured, so LIVE mode is unavailable. Set FEED_URL (and see ' +
        '.env.example) to connect a publicly accessible feed.',
    );
  }

  return { sources, warnings };
}

function describe(label: string, error: unknown): string {
  if (error instanceof SourcePolicyError) return `${label}: ${error.message}`;
  return `${label}: ${error instanceof Error ? error.message : String(error)}`;
}

export function statusesOf(sources: readonly DataSource[]): SourceStatus[] {
  return sources.map((source) => source.status());
}
