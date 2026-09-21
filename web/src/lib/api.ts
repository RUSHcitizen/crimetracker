import type { CameraSite, Incident, IncidentType } from '@crimetracker/shared';

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

export interface IncidentBrief {
  readonly text: string;
  /** `derived` = composed from the record; `ai-inferred` = written by a model. */
  readonly origin: 'derived' | 'ai-inferred';
  readonly generatorId: string;
  readonly generatedAt: string;
}

/** Fetch the spoken-form brief for one incident. Generated on demand and cached server-side. */
export async function fetchBrief(id: string, signal?: AbortSignal): Promise<IncidentBrief> {
  const data = await getJson<{ brief: IncidentBrief }>(
    `/api/incidents/${encodeURIComponent(id)}/brief`,
    signal,
  );
  return data.brief;
}
