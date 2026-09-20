import { useEffect, useMemo, useState } from 'react';
import {
  containsPoint,
  haversineKm,
  INCIDENT_TYPE_META,
  type Incident,
} from '@crimetracker/shared';
import { useTracker, type Filters } from './store.js';

/**
 * Apply the active filters to an incident.
 *
 * Kept as a plain function so the map layer, the list and the statistics panel all agree
 * on what "visible" means without duplicating the logic.
 */
export function matchesFilters(
  incident: Incident,
  filters: Filters,
  now: number,
  viewport: readonly [number, number, number, number] | null,
): boolean {
  if (filters.types.size > 0 && !filters.types.has(incident.incidentType)) return false;
  if (incident.severity < filters.minSeverity) return false;
  if (filters.sources.size > 0 && !filters.sources.has(incident.source.id)) return false;

  if (filters.sinceMinutes > 0) {
    const age = now - Date.parse(incident.timestamp);
    if (age > filters.sinceMinutes * 60_000) return false;
  }

  if (filters.geo) {
    if (!incident.coordinates) return false;
    const distance = haversineKm(incident.coordinates, {
      lat: filters.geo.lat,
      lon: filters.geo.lon,
    });
    if (distance > filters.geo.radiusKm) return false;
  }

  if (filters.viewportOnly && viewport) {
    if (!incident.coordinates) return false;
    const [west, south, east, north] = viewport;
    if (!containsPoint({ west, south, east, north }, incident.coordinates)) return false;
  }

  if (filters.query) {
    const haystack = `${incident.incidentType} ${INCIDENT_TYPE_META[incident.incidentType].label} ${
      incident.description
    } ${incident.location.label} ${incident.location.area ?? ''} ${incident.source.name} ${
      incident.transcript ?? ''
    }`.toLowerCase();
    for (const term of filters.query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!haystack.includes(term)) return false;
    }
  }

  return true;
}

/**
 * A coarse clock that advances every 30 seconds.
 *
 * The time-window filter needs a current `now`; without this the cutoff is frozen at the
 * moment of the last memo, so incidents age out of a "last 15 minutes" window only when
 * something *else* changes. On a quiet feed they would linger indefinitely.
 */
const CLOCK_INTERVAL_MS = 30_000;

function useCoarseClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The filtered incident list.
 *
 * Memoized on `version` rather than the array identity so unrelated store updates
 * (connection state, hover, UI toggles) never re-run the filter over thousands of rows.
 */
export function useFilteredIncidents(): Incident[] {
  const incidents = useTracker((s) => s.incidents);
  const version = useTracker((s) => s.version);
  const filters = useTracker((s) => s.filters);
  const viewport = useTracker((s) => (s.filters.viewportOnly ? s.viewportBounds : null));
  const now = useCoarseClock();

  return useMemo(() => {
    return incidents.filter((incident) => matchesFilters(incident, filters, now, viewport));
    // `incidents` is intentionally keyed through `version`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filters, viewport, now]);
}

export function useSelectedIncident(): Incident | null {
  const selectedId = useTracker((s) => s.selectedId);
  const byId = useTracker((s) => s.byId);
  return selectedId ? byId.get(selectedId) ?? null : null;
}

/** Live counts by type over the filtered set, for the category list. */
export function useTypeCounts(incidents: readonly Incident[]): Map<string, number> {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const incident of incidents) {
      counts.set(incident.incidentType, (counts.get(incident.incidentType) ?? 0) + 1);
    }
    return counts;
  }, [incidents]);
}
