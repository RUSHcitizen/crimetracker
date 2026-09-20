import { validateCoordinates, WASHINGTON_BBOX, type BBox, type Coordinates } from './geo.js';
import { sanitizeText, TEXT_LIMITS } from './schema.js';

/**
 * Public roadway cameras, as a situational overlay.
 *
 * This is deliberately the *whole* of what this project does with cameras, and the
 * boundary is a design decision rather than a missing feature:
 *
 *  - **In scope.** Still images that a transport agency publishes for public display of
 *    road conditions, shown on the map beside incidents so an operator can see what the
 *    weather and traffic near a reported event look like. The images are fetched by the
 *    viewer's browser straight from the agency, exactly as they are on the agency's own
 *    traveller-information site, and nothing is stored or re-hosted here.
 *
 *  - **Out of scope, permanently.** Reading cameras that were never published for public
 *    view — an unsecured private device is someone's system, and connecting to it is
 *    unauthorised access however easy it is. Equally out of scope is analysing any camera
 *    image to infer that a crime is occurring, or to identify, count, track or describe
 *    the people and vehicles in it. That is not observation, it is accusation: a model's
 *    guess about an identifiable person, rendered next to real dispatch records as though
 *    it were of the same kind. This module produces positions and image URLs. It has no
 *    path to an image analyser, and none should be added.
 *
 * Agencies rotate these cameras in and out of service, so a directory is refreshed
 * periodically rather than pinned.
 */

/** Shown wherever a camera image is displayed. Not optional, and not a tooltip. */
export const CAMERA_USE_NOTICE =
  'Public roadway camera published by the operating agency for traffic and weather ' +
  'conditions. Images are live from the agency and are not recorded, analysed, or used ' +
  'to identify people or vehicles.';

export interface CameraSite {
  readonly id: string;
  readonly title: string;
  readonly coordinates: Coordinates;
  /** Fetched by the browser directly from the agency; never proxied or stored. */
  readonly imageUrl: string;
  readonly roadway: string | null;
  readonly direction: string | null;
  readonly region: string | null;
  readonly owner: string;
}

export interface CameraDirectory {
  readonly provider: string;
  readonly attribution: string;
  readonly docsUrl: string;
  readonly notice: string;
  readonly fetchedAt: string;
  readonly cameras: readonly CameraSite[];
}

/**
 * Hosts a camera image may be loaded from.
 *
 * The browser is told to load these URLs, so the list of hosts it can be sent to is not
 * something an upstream record gets to decide. A camera whose image lives anywhere else is
 * dropped, and the count of dropped records is reported rather than hidden.
 */
export const DEFAULT_CAMERA_IMAGE_HOSTS: readonly string[] = ['wsdot.wa.gov', 'wsdot.com'];

export interface CameraMapOptions {
  /** Region a camera must fall inside. `null` disables the check. */
  readonly region?: BBox | null;
  readonly imageHosts?: readonly string[];
}

export interface CameraMapResult {
  readonly cameras: CameraSite[];
  /** Records rejected, by reason — surfaced so a silent empty overlay is impossible. */
  readonly rejected: { total: number; inactive: number; position: number; imageHost: number };
}

/**
 * Project WSDOT's `GetCamerasAsJson` response onto `CameraSite`.
 *
 * The shape is documented by WSDOT, but as with every external feed it is treated as
 * untrusted: the position is validated against the region, the image URL is checked
 * against the host allow-list, and every string is sanitised before it can reach the DOM.
 */
export function mapWsdotCameras(body: unknown, options: CameraMapOptions = {}): CameraMapResult {
  const region = options.region === undefined ? WASHINGTON_BBOX : options.region;
  const hosts = options.imageHosts ?? DEFAULT_CAMERA_IMAGE_HOSTS;
  const records = Array.isArray(body) ? body : [];

  const cameras: CameraSite[] = [];
  const seen = new Set<string>();
  const rejected = { total: 0, inactive: 0, position: 0, imageHost: 0 };

  for (const record of records) {
    if (!record || typeof record !== 'object') {
      rejected.total += 1;
      continue;
    }
    const row = record as Record<string, unknown>;

    // WSDOT keeps retired cameras in the payload flagged inactive.
    if (row.IsActive === false || row.IsActive === 'false') {
      rejected.total += 1;
      rejected.inactive += 1;
      continue;
    }

    const location = (row.CameraLocation ?? {}) as Record<string, unknown>;
    const coordinates = validateCoordinates(
      {
        lat: firstNumber(row.DisplayLatitude, location.Latitude),
        lon: firstNumber(row.DisplayLongitude, location.Longitude),
      },
      region,
    );
    if (!coordinates) {
      rejected.total += 1;
      rejected.position += 1;
      continue;
    }

    const imageUrl = safeImageUrl(row.ImageURL, hosts);
    if (!imageUrl) {
      rejected.total += 1;
      rejected.imageHost += 1;
      continue;
    }

    // Publishers emit numeric ids routinely; `sanitizeText` only accepts strings, so a
    // finite number is coerced rather than silently dropping the whole camera.
    const id = text(row.CameraID, 48) || text(imageUrl, 48);
    if (!id || seen.has(id)) {
      rejected.total += 1;
      continue;
    }
    seen.add(id);

    const roadway = text(location.RoadName, 24) || null;
    const milepost = firstNumber(location.MilePost);
    const fallbackTitle = roadway
      ? `${roadway}${milepost == null ? '' : ` MP ${milepost}`}`
      : 'Roadway camera';

    cameras.push({
      id,
      // First field that carries anything: `??` is wrong here because publishers send
      // empty strings far more often than nulls.
      title:
        text(row.Title, TEXT_LIMITS.locationLabel) ||
        text(row.Description, TEXT_LIMITS.locationLabel) ||
        text(location.Description, TEXT_LIMITS.locationLabel) ||
        fallbackTitle,
      coordinates,
      imageUrl,
      roadway,
      direction: text(location.Direction, 8) || null,
      region: text(row.Region, 32) || null,
      owner: text(row.CameraOwner, 64) || 'WSDOT',
    });
  }

  return { cameras, rejected };
}

/**
 * A cache-busted image URL.
 *
 * Agencies serve these stills with long cache headers even though the picture changes
 * every minute or two, so a viewer left open would otherwise show a frozen frame. The
 * bucket is coarse on purpose: every viewer within the same interval shares one URL, so
 * refreshing does not multiply requests against the agency.
 */
export function cameraImageUrl(camera: CameraSite, now: number, intervalMs = 60_000): string {
  const bucket = Math.floor(now / Math.max(1000, intervalMs));
  const separator = camera.imageUrl.includes('?') ? '&' : '?';
  return `${camera.imageUrl}${separator}t=${bucket}`;
}

/** Sanitise a field that a publisher may send as either a string or a number. */
function text(value: unknown, maxLength: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return sanitizeText(String(value), maxLength);
  }
  return sanitizeText(value, maxLength);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function safeImageUrl(value: unknown, hosts: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // https only, no credentials, and only a host the operator has allowed. A record that
  // points somewhere else is a record we refuse to send a browser to.
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const allowed = hosts.some((suffix) => {
    const clean = suffix.toLowerCase();
    return host === clean || host.endsWith(`.${clean}`);
  });
  return allowed ? url.toString() : null;
}
