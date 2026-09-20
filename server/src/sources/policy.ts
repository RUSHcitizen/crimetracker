/**
 * Hard boundaries on what this application will connect to.
 *
 * Crime Tracker consumes **publicly accessible** information only. These checks are
 * deliberately in code rather than documentation so a misconfiguration fails loudly
 * instead of quietly doing something it should not.
 */

export class SourcePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcePolicyError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface PolicyOptions {
  /** Allow plain http for loopback addresses (local development servers). */
  readonly allowLoopbackHttp?: boolean;
}

/**
 * Validate a source URL.
 *
 * Rejects:
 *  - non-HTTP(S) schemes (no `file:`, no custom stream protocols);
 *  - plain `http:` to anything other than loopback;
 *  - URLs carrying credentials, which would imply a non-public feed.
 */
export function assertPublicUrl(rawUrl: string, options: PolicyOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourcePolicyError(`Source URL is not a valid URL: ${truncate(rawUrl)}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SourcePolicyError(
      `Only http(s) sources are supported; refusing protocol "${url.protocol}".`,
    );
  }

  if (url.username || url.password) {
    throw new SourcePolicyError(
      'Source URL carries credentials. Crime Tracker only consumes publicly accessible ' +
        'data and will not authenticate to a restricted feed.',
    );
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === 'http:' && !(isLoopback && options.allowLoopbackHttp !== false)) {
    throw new SourcePolicyError(
      `Refusing plain http for non-loopback host "${url.hostname}". Use https.`,
    );
  }

  return url;
}

/**
 * The audio pipeline additionally requires an explicit operator acknowledgement, so that
 * pointing it anywhere is always a deliberate act.
 */
export function assertAudioAcknowledged(acknowledged: boolean): void {
  if (!acknowledged) {
    throw new SourcePolicyError(
      'The public-audio pipeline requires PUBLIC_AUDIO_ACK=1, confirming the stream is ' +
        'lawfully and publicly accessible and that you are permitted to process it.',
    );
  }
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
