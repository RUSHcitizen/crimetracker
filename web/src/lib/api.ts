import type { Incident, IncidentType, AppMode } from '@crimetracker/shared';

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

export async function setServerMode(mode: AppMode): Promise<AppMode | null> {
  try {
    const response = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { mode: AppMode };
    return data.mode;
  } catch {
    return null;
  }
}
