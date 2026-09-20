import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatRelative,
  INCIDENT_TYPE_META,
  INCIDENT_TYPES,
  type Incident,
  type IncidentType,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { searchIncidents } from '../lib/api.js';
import { findPlaces, type Place } from '../lib/places.js';
import { Chip } from '../components/primitives.js';

/**
 * Command search.
 *
 * Searches locally-held incidents instantly, and queries the server in parallel so the
 * full stored history is reachable — not just what the client is holding. Results drive
 * the map directly: choosing a place sets the geographic filter and flies there, choosing
 * an incident selects it.
 */
export function CommandSearch() {
  const open = useTracker((s) => s.ui.searchOpen);
  const setUi = useTracker((s) => s.setUi);
  const incidents = useTracker((s) => s.incidents);
  const select = useTracker((s) => s.select);
  const setFilters = useTracker((s) => s.setFilters);
  const toggleType = useTracker((s) => s.toggleType);

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Incident[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setQuery('');
      setRemote([]);
    }
  }, [open]);

  // Server-side search, debounced. Aborted on every keystroke so only the latest lands.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchIncidents({ q: query.trim(), limit: 40 }, controller.signal)
        .then(setRemote)
        .catch(() => setRemote([]));
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, open]);

  const places = useMemo(() => findPlaces(query), [query]);
  const types = useMemo(() => matchingTypes(query), [query]);

  const local = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return incidents
      .filter((incident) =>
        `${incident.description} ${incident.location.label} ${incident.incidentType} ${incident.source.name}`
          .toLowerCase()
          .includes(q),
      )
      .slice(0, 12);
  }, [incidents, query]);

  // Merge local + remote, de-duplicated, local first (they are already on screen).
  const results = useMemo(() => {
    const seen = new Set(local.map((i) => i.id));
    return [...local, ...remote.filter((i) => !seen.has(i.id))].slice(0, 24);
  }, [local, remote]);

  if (!open) return null;

  const close = () => setUi({ searchOpen: false });

  return (
    <div className="search" role="dialog" aria-label="Search incidents">
      <div className="search__scrim" onClick={close} />
      <div className="search__panel">
        <div className="search__field">
          <span className="search__prompt mono">&gt;</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close();
              if (event.key === 'Enter' && results[0]) {
                select(results[0].id);
                close();
              }
            }}
            placeholder="Search type, location, source or keyword"
            aria-label="Search query"
          />
          <span className="search__hint micro">ESC TO CLOSE</span>
        </div>

        <div className="search__results">
          {query.trim().length < 2 && (
            <div className="search__hintblock">
              <span className="micro">TRY: SEATTLE · ROBBERY · SHOTS FIRED · I-5 · SIMULATION</span>
            </div>
          )}

          {types.length > 0 && (
            <div className="search__group">
              <div className="search__grouptitle">CATEGORIES</div>
              {types.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="search__row"
                  onClick={() => {
                    toggleType(type);
                    close();
                  }}
                >
                  <Chip tone="cyan">{INCIDENT_TYPE_META[type].glyph}</Chip>
                  <span className="search__rowmain">Filter to {INCIDENT_TYPE_META[type].label}</span>
                  <span className="micro">CATEGORY</span>
                </button>
              ))}
            </div>
          )}

          {places.length > 0 && (
            <div className="search__group">
              <div className="search__grouptitle">LOCATIONS</div>
              {places.map((place) => (
                <PlaceRow
                  key={place.label}
                  place={place}
                  onPick={() => {
                    setFilters({
                      geo: {
                        label: place.label,
                        lat: place.lat,
                        lon: place.lon,
                        radiusKm: place.radiusKm,
                      },
                    });
                    close();
                  }}
                />
              ))}
            </div>
          )}

          {results.length > 0 && (
            <div className="search__group">
              <div className="search__grouptitle">
                INCIDENTS
                <span className="micro"> · {results.length} MATCHES</span>
              </div>
              {results.map((incident) => (
                <button
                  key={incident.id}
                  type="button"
                  className="search__row"
                  onClick={() => {
                    select(incident.id);
                    close();
                  }}
                  style={{ '--row-accent': `var(--sev-${incident.severity})` } as React.CSSProperties}
                >
                  <span
                    className="search__sev"
                    style={{ background: `var(--sev-${incident.severity})` }}
                  />
                  <span className="search__rowmain truncate">{incident.description}</span>
                  <span className="search__rowmeta truncate micro">{incident.location.label}</span>
                  <span className="mono micro">{formatRelative(incident.timestamp)}</span>
                </button>
              ))}
            </div>
          )}

          {query.trim().length >= 2 &&
            results.length === 0 &&
            places.length === 0 &&
            types.length === 0 && (
              <div className="search__hintblock">
                <span className="micro">NO MATCHES</span>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function PlaceRow({ place, onPick }: { place: Place; onPick: () => void }) {
  return (
    <button type="button" className="search__row" onClick={onPick}>
      <Chip tone="cyan">GEO</Chip>
      <span className="search__rowmain">{place.label}</span>
      <span className="search__rowmeta micro">{place.county} COUNTY</span>
      <span className="mono micro">{place.radiusKm} KM</span>
    </button>
  );
}

function matchingTypes(query: string): IncidentType[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return INCIDENT_TYPES.filter((type) => {
    const meta = INCIDENT_TYPE_META[type];
    return (
      meta.label.toLowerCase().includes(q) ||
      type.includes(q) ||
      meta.keywords.some((keyword) => keyword.includes(q))
    );
  }).slice(0, 4);
}
