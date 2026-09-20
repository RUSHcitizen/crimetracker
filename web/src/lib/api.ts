import type { CameraSite, Incident, IncidentType, AppMode } from '@crimetracker/shared';

/**
 * REST helpers. Everything is same-origin (the dev server proxies to the API), so no
 * base URL, host or key is ever present in the client bundle.
 */

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

export interface SearchParams {
  q?: string;
  types?: readonly IncidentType[];
  sinceMinutes?: number;
  near?: { lat: number; lon: number; radiusKm: number };
  limit?: number;
}

export async function searchIncidents(
  params: SearchParams,
  signal?: AbortSignal,
): Promise<Incident[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.types?.length) query.set('types', params.types.join(','));
  if (params.sinceMinutes) query.set('sinceMinutes', String(params.sinceMinutes));
  if (params.near) {
    query.set('lat', String(params.near.lat));
    query.set('lon', String(params.near.lon));
    query.set('radiusKm', String(params.near.radiusKm));
  }
  query.set('limit', String(params.limit ?? 60));
  const data = await getJson<{ incidents: Incident[] }>(`/api/search?${query}`, signal);
  return data.incidents;
}

export async function fetchIncident(id: string, signal?: AbortSignal): Promise<Incident | null> {
  try {
    const data = await getJson<{ incident: Incident }>(
      `/api/incidents/${encodeURIComponent(id)}`,
      signal,
    );
    return data.incident;
  } catch {
    return null;
  }
}

export type ModeChange =
  | { ok: true; mode: AppMode }
  | { ok: false; reason: string; mode: AppMode | null };

/**
 * Request a mode change.
 *
 * The server refuses (409) when nothing could serve the requested mode. That refusal is
 * returned rather than swallowed: showing a LIVE label the server did not agree to would
 * defeat the point of the indicator.
 */
export async function setServerMode(mode: AppMode): Promise<ModeChange> {
  try {
    const response = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = (await response.json().catch(() => null)) as
      | { mode?: AppMode; reason?: string }
      | null;

    if (response.ok && data?.mode) return { ok: true, mode: data.mode };
    return {
      ok: false,
      reason: data?.reason ?? `Mode change refused (HTTP ${response.status}).`,
      mode: data?.mode ?? null,
    };
  } catch {
    return { ok: false, reason: 'Could not reach the server.', mode: null };
  }
}

export interface CameraResponse {
  readonly configured: boolean;
  readonly cameras: readonly CameraSite[];
  readonly count: number;
  readonly provider?: string;
  readonly attribution?: string;
  readonly docsUrl?: string;
  readonly notice?: string;
  readonly fetchedAt?: string;
  readonly stale?: boolean;
  readonly message?: string | null;
  readonly reason?: string;
}

/**
 * Fetch the public roadway-camera directory.
 *
 * Positions and image URLs only. The images themselves are loaded by the browser straight
 * from the agency when a camera is opened, so nothing is proxied or cached here — and
 * nothing is fetched at all until the operator turns the overlay on.
 */
export async function fetchCameras(signal?: AbortSignal): Promise<CameraResponse> {
  return getJson<CameraResponse>('/api/cameras', signal);
}
