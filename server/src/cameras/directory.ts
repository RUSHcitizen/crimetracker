import {
  CAMERA_USE_NOTICE,
  mapWsdotCameras,
  type BBox,
  type CameraDirectory,
  type CameraSite,
} from '@crimetracker/shared';
import { assertPublicUrl } from '../sources/policy.js';

export interface CameraDirectoryOptions {
  readonly url: string;
  readonly accessCode: string;
  readonly region: BBox | null;
  readonly imageHosts: readonly string[];
  readonly refreshMinutes: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface CameraListing {
  readonly directory: CameraDirectory;
  /**
   * True only when a refresh failed and the previous copy is being served.
   *
   * Kept distinct from `message`: records filtered out by the region or host checks are
   * worth reporting, but they do not make a freshly-fetched directory stale, and saying
   * so would teach an operator to ignore the word.
   */
  readonly stale: boolean;
  readonly message: string | null;
}

/**
 * The public roadway-camera directory.
 *
 * Cameras are positions and image URLs, not incidents: they are never written to the
 * incident store, never clustered, and never fed to the pattern detector. The list is
 * essentially static — agencies add and retire sites over months — so it is fetched once
 * and refreshed slowly, which keeps this from becoming a poller hammering an agency for
 * data that has not changed.
 *
 * A refresh failure never propagates: the last good directory is served with `stale` set,
 * because an overlay that empties itself on a transient network error is worse than one
 * that says how old it is.
 */
export class WsdotCameraDirectory {
  readonly #options: CameraDirectoryOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cached: CameraDirectory | null = null;
  #fetchedAtMs = 0;
  #message: string | null = null;
  #failed = false;
  #inFlight: Promise<void> | null = null;

  constructor(options: CameraDirectoryOptions) {
    // Same policy as every other outbound source: https, public, no credentials in the URL.
    assertPublicUrl(options.url);
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async list(): Promise<CameraListing> {
    const ttlMs = this.#options.refreshMinutes * 60_000;
    const age = this.#now() - this.#fetchedAtMs;
    if (!this.#cached || age > ttlMs) await this.#refresh();

    if (!this.#cached) {
      return {
        directory: this.#empty(),
        stale: false,
        message: this.#message ?? 'Camera directory unavailable.',
      };
    }
    return { directory: this.#cached, stale: this.#failed, message: this.#message };
  }

  /** Coalesces concurrent callers onto one upstream request. */
  async #refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#fetchDirectory().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #fetchDirectory(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 25_000);
    const url = new URL(this.#options.url);
    url.searchParams.set('AccessCode', this.#options.accessCode);

    try {
      const response = await this.#fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'CrimeTracker/0.1 (public incident visualization)',
        },
      });

      if (!response.ok) {
        this.#failed = true;
        this.#message =
          response.status === 401 || response.status === 403
            ? `Camera directory rejected the access code (HTTP ${response.status}).`
            : `Camera directory returned HTTP ${response.status}.`;
        // Keep whatever we had; the caller is told it is stale.
        if (!this.#cached) this.#fetchedAtMs = this.#now();
        return;
      }

      const body: unknown = await response.json();
      const { cameras, rejected } = mapWsdotCameras(body, {
        region: this.#options.region,
        imageHosts: this.#options.imageHosts,
      });

      this.#cached = {
        provider: 'WSDOT',
        attribution: 'Washington State Department of Transportation',
        docsUrl: 'https://wsdot.wa.gov/traffic/api/',
        notice: CAMERA_USE_NOTICE,
        fetchedAt: new Date(this.#now()).toISOString(),
        cameras,
      };
      this.#fetchedAtMs = this.#now();
      this.#failed = false;
      // Rejections are reported rather than swallowed: an overlay that silently drops
      // half the cameras looks identical to one that is simply sparse.
      this.#message =
        rejected.total > 0
          ? `${rejected.total} camera record(s) not shown ` +
            `(${rejected.inactive} inactive, ${rejected.position} without a usable position, ` +
            `${rejected.imageHost} with an image host outside the allow-list).`
          : null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.#failed = true;
      // The URL in a fetch error carries the access code.
      this.#message = `Camera directory fetch failed: ${this.#redact(detail)}`;
      if (!this.#cached) this.#fetchedAtMs = this.#now();
    } finally {
      clearTimeout(timeout);
    }
  }

  #redact(text: string): string {
    const code = this.#options.accessCode;
    return code ? text.split(code).join('REDACTED') : text;
  }

  #empty(): CameraDirectory {
    return {
      provider: 'WSDOT',
      attribution: 'Washington State Department of Transportation',
      docsUrl: 'https://wsdot.wa.gov/traffic/api/',
      notice: CAMERA_USE_NOTICE,
      fetchedAt: new Date(this.#now()).toISOString(),
      cameras: [] as readonly CameraSite[],
    };
  }
}
