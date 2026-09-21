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

/**
 * Hosts that are never fetched, regardless of what an upstream record says.
 *
 * Loopback, link-local and the RFC1918 ranges. A feed hands us URLs to fetch
 * *server-side*, which makes this a server-side request forgery surface: a compromised
 * or merely careless publisher could name `169.254.169.254` or an address inside the
 * deployment's own network and have us fetch it. Where `assertPublicUrl` deliberately
 * permits loopback — so a developer can point a source at a local stub — this does not.
 */
const PRIVATE_IPV4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host) || host === 'localhost') return true;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return true;
  }
  if (PRIVATE_IPV4.test(host)) return true;
  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  return false;
}

/**
 * Validate a URL that came from *external data* and will be fetched by the server.
 *
 * Stricter than `assertPublicUrl` in two ways, both because the URL is attacker-influenced
 * rather than operator-supplied: https only with no loopback exception, and the host must
 * be on an allow-list the operator controls. Which hosts this process can be made to
 * connect to is not a decision a feed record gets to make.
 */
export function assertFetchableMediaUrl(
  rawUrl: unknown,
  allowedHosts: readonly string[],
): URL {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    throw new SourcePolicyError('Media URL is missing or implausible.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SourcePolicyError(`Media URL is not a valid URL: ${truncate(rawUrl)}`);
  }

  if (url.protocol !== 'https:') {
    throw new SourcePolicyError(`Refusing non-https media URL "${truncate(url.href)}".`);
  }
  if (url.username || url.password) {
    throw new SourcePolicyError('Refusing a media URL carrying credentials.');
  }
  if (isPrivateHost(url.hostname)) {
    throw new SourcePolicyError(
      `Refusing media URL pointing at a private or loopback address: ${url.hostname}`,
    );
  }
  if (!hostAllowed(url.hostname, allowedHosts)) {
    throw new SourcePolicyError(
      `Media host "${url.hostname}" is not in the configured allow-list.`,
    );
  }
  return url;
}

/** Exact host, or a subdomain of an allowed suffix. Never a lookalike suffix match. */
export function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const suffix = entry.trim().toLowerCase();
    if (!suffix) return false;
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}
