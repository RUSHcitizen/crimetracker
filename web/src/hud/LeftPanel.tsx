import { useMemo } from 'react';
import {
  formatRelative,
  INCIDENT_TYPE_META,
  INCIDENT_TYPES,
  SEVERITY_LABEL,
  type Incident,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { useFilteredIncidents, useTypeCounts } from '../state/selectors.js';
import { Chip, EmptyState, Meter, Panel, Section, SeverityDot } from '../components/primitives.js';
import { WA_PLACES } from '../lib/places.js';

const TIME_WINDOWS = [
  { minutes: 15, label: '15M' },
  { minutes: 60, label: '1H' },
  { minutes: 360, label: '6H' },
  { minutes: 720, label: '12H' },
  { minutes: 1440, label: '24H' },
  { minutes: 10080, label: '7D' },
] as const;

/** Active incidents, categories, and every filter control. */
export function LeftPanel() {
  const incidents = useFilteredIncidents();
  const counts = useTypeCounts(incidents);
  const filters = useTracker((s) => s.filters);
  const sources = useTracker((s) => s.sources);
  const selectedId = useTracker((s) => s.selectedId);
  const select = useTracker((s) => s.select);
  const setFilters = useTracker((s) => s.setFilters);
  const toggleType = useTracker((s) => s.toggleType);
  const toggleSource = useTracker((s) => s.toggleSource);
  const resetFilters = useTracker((s) => s.resetFilters);
  const total = useTracker((s) => s.incidents.length);

  const active = useMemo(() => incidents.slice(0, 90), [incidents]);
  const filtersActive =
    filters.types.size > 0 ||
    filters.minSeverity > 1 ||
    filters.sources.size > 0 ||
    filters.query.length > 0 ||
    filters.geo !== null ||
    filters.viewportOnly;

  return (
    <Panel
      title="Active Incidents"
      count={`${incidents.length}/${total}`}
      actions={
        filtersActive ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={resetFilters}>
            CLEAR
          </button>
        ) : null
      }
      className="panel--left"
    >
      <div className="panel__body">
        {/* ------------------------- time window ------------------------- */}
        <Section title="Time Window">
          <div className="segbar">
            {TIME_WINDOWS.map((window) => (
              <button
                key={window.minutes}
                type="button"
                className="segbar__seg"
                aria-pressed={filters.sinceMinutes === window.minutes}
                onClick={() => setFilters({ sinceMinutes: window.minutes })}
              >
                {window.label}
              </button>
            ))}
          </div>
        </Section>

        {/* -------------------------- severity --------------------------- */}
        <Section title={`Minimum Severity — ${SEVERITY_LABEL[filters.minSeverity as 1]}`}>
          <input
            className="slider"
            type="range"
            min={1}
            max={5}
            step={1}
            value={filters.minSeverity}
            style={{ '--pct': `${((filters.minSeverity - 1) / 4) * 100}%` } as React.CSSProperties}
            onChange={(event) => setFilters({ minSeverity: Number(event.target.value) })}
            aria-label="Minimum severity"
          />
          <div className="sevscale">
            {[1, 2, 3, 4, 5].map((level) => (
              <span
                key={level}
                className="sevscale__tick"
                style={{
                  background: `var(--sev-${level})`,
                  opacity: level >= filters.minSeverity ? 0.95 : 0.16,
                }}
              />
            ))}
          </div>
        </Section>

        {/* ------------------------- geographic -------------------------- */}
        <Section title="Geographic Filter">
          <div className="field">
            <span className="micro">AREA</span>
            <select
              className="select"
              value={filters.geo?.label ?? ''}
              onChange={(event) => {
                const place = WA_PLACES.find((p) => p.label === event.target.value);
                setFilters({
                  geo: place
                    ? { label: place.label, lat: place.lat, lon: place.lon, radiusKm: filters.geo?.radiusKm ?? 15 }
                    : null,
                });
              }}
              aria-label="Geographic area filter"
            >
              <option value="">ENTIRE STATE</option>
              {WA_PLACES.map((place) => (
                <option key={place.label} value={place.label}>
                  {place.label.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          {filters.geo && (
            <div className="georadius">
              <span className="micro">RADIUS {filters.geo.radiusKm} KM</span>
              <input
                className="slider"
                type="range"
                min={2}
                max={80}
                step={1}
                value={filters.geo.radiusKm}
                style={{ '--pct': `${((filters.geo.radiusKm - 2) / 78) * 100}%` } as React.CSSProperties}
                onChange={(event) =>
                  setFilters({
                    geo: filters.geo ? { ...filters.geo, radiusKm: Number(event.target.value) } : null,
                  })
                }
                aria-label="Geographic radius"
              />
            </div>
          )}
          <button
            type="button"
            className="btn btn--sm btn--block"
            aria-pressed={filters.viewportOnly}
            onClick={() => setFilters({ viewportOnly: !filters.viewportOnly })}
            style={{ marginTop: 6 }}
          >
            LOCK TO VIEWPORT
          </button>
        </Section>

        {/* -------------------------- categories ------------------------- */}
        <Section title="Incident Categories">
          <div className="typegrid">
            {INCIDENT_TYPES.map((type) => {
              const meta = INCIDENT_TYPE_META[type];
              const count = counts.get(type) ?? 0;
              const on = filters.types.has(type);
              return (
                <button
                  key={type}
                  type="button"
                  className={`typechip typechip--${meta.accent}`}
                  aria-pressed={on}
                  onClick={() => toggleType(type)}
                  title={`${meta.label} — ${count} in view`}
                >
                  <span className="typechip__glyph">{meta.glyph}</span>
                  <span className="typechip__label truncate">{meta.label}</span>
                  <span className="typechip__count mono">{count}</span>
                </button>
              );
            })}
          </div>
        </Section>

        {/* --------------------------- sources --------------------------- */}
        <Section title="Data Sources">
          {sources.length === 0 && <EmptyState>NO SOURCES REGISTERED</EmptyState>}
          {sources.map((source) => {
            const on = filters.sources.size === 0 || filters.sources.has(source.id);
            return (
              <button
                key={source.id}
                type="button"
                className="sourcerow"
                aria-pressed={filters.sources.has(source.id)}
                onClick={() => toggleSource(source.id)}
                title={source.note}
              >
                <span
                  className={`dot ${source.state === 'online' ? 'dot--pulse' : ''}`}
                  style={{ color: stateColor(source.state) }}
                />
                <span className="sourcerow__name truncate" style={{ opacity: on ? 1 : 0.45 }}>
                  {source.name}
                </span>
                <span className="sourcerow__kind micro">{source.kind}</span>
                <span className="sourcerow__count mono">{source.eventsIngested}</span>
              </button>
            );
          })}
          <p className="sourcenote micro">
            Map geometry: US Census Bureau cartographic boundaries (public domain), bundled
            locally. No third-party basemap or tile server is used.
          </p>
        </Section>

        {/* ----------------------- active incidents ---------------------- */}
        <div className="panel__section-title" style={{ padding: '8px 10px 0' }}>
          Feed — Newest First
        </div>
        <div className="incidentlist">
          {active.length === 0 && <EmptyState>NO INCIDENTS MATCH THE CURRENT FILTERS</EmptyState>}
          {active.map((incident) => (
            <IncidentRow
              key={incident.id}
              incident={incident}
              selected={incident.id === selectedId}
              onSelect={() => select(incident.id)}
            />
          ))}
          {incidents.length > active.length && (
            <div className="listmore micro">
              +{incidents.length - active.length} MORE — NARROW THE FILTERS TO SEE THEM
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function IncidentRow({
  incident,
  selected,
  onSelect,
}: {
  incident: Incident;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = INCIDENT_TYPE_META[incident.incidentType];
  return (
    <button
      type="button"
      className="row incidentrow"
      aria-current={selected}
      onClick={onSelect}
      style={{ '--row-accent': `var(--sev-${incident.severity})` } as React.CSSProperties}
    >
      <div className="incidentrow__top">
        <SeverityDot severity={incident.severity} />
        <span className="incidentrow__type">{meta.label}</span>
        <span className="incidentrow__time mono">{formatRelative(incident.timestamp)}</span>
      </div>
      <div className="incidentrow__loc truncate">{incident.location.label}</div>
      <div className="incidentrow__meta">
        {incident.location.approximate && <Chip tone="ghost">APPROX</Chip>}
        {!incident.coordinates && <Chip tone="ghost">NO POSITION</Chip>}
        <span className="incidentrow__conf">
          <Meter value={incident.confidence} tone={`var(--sev-${incident.severity})`} />
        </span>
      </div>
    </button>
  );
}

function stateColor(state: string): string {
  switch (state) {
    case 'online':
      return 'var(--green)';
    case 'connecting':
      return 'var(--amber)';
    case 'degraded':
      return 'var(--amber)';
    case 'error':
      return 'var(--crimson)';
    default:
      return 'var(--text-ghost)';
  }
}
