import { useEffect, useRef } from 'react';
import {
  formatClock,
  INCIDENT_TYPE_META,
  STATUS_LABEL,
  type Incident,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { useFilteredIncidents } from '../state/selectors.js';
import { Chip, SeverityDot } from '../components/primitives.js';

/**
 * The live event stream.
 *
 * Newest first, capped at a fixed number of rows: this is a monitor, not an archive, and
 * a bounded list keeps the DOM small no matter how long the session runs.
 */
const STREAM_ROWS = 40;

export function BottomStream() {
  const incidents = useFilteredIncidents();
  const selectedId = useTracker((s) => s.selectedId);
  const select = useTracker((s) => s.select);
  const recentArrivals = useTracker((s) => s.recentArrivals);
  const sources = useTracker((s) => s.sources);
  const bottomOpen = useTracker((s) => s.ui.bottomOpen);
  const setUi = useTracker((s) => s.setUi);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = incidents.slice(0, STREAM_ROWS);

  // Keep the newest event in view when it lands.
  useEffect(() => {
    scrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
  }, [rows[0]?.id]);

  const processing = incidents.filter(
    (i) => i.status === 'transcribing' || i.status === 'extracting',
  ).length;
  const awaitingPosition = incidents.filter((i) => !i.coordinates).length;

  if (!bottomOpen) {
    return (
      <div className="stream stream--collapsed">
        <button type="button" className="btn btn--sm" onClick={() => setUi({ bottomOpen: true })}>
          ▲ LIVE EVENT STREAM · {incidents.length}
        </button>
      </div>
    );
  }

  return (
    <section className="stream panel">
      <div className="panel__inner">
        <header className="panel__head">
          <h2 className="panel__title">Live Event Stream</h2>
          <span className="panel__count">{incidents.length}</span>
          <span className="panel__head-spacer" />

          <div className="stream__status">
            <Chip tone={processing > 0 ? 'cyan' : 'ghost'}>
              {processing > 0 && <span className="dot dot--pulse" />}
              EXTRACTION {processing > 0 ? `${processing} ACTIVE` : 'IDLE'}
            </Chip>
            <Chip tone={awaitingPosition > 0 ? 'amber' : 'ghost'}>
              {awaitingPosition} WITHOUT POSITION
            </Chip>
            <Chip tone="ghost">
              {sources.filter((s) => s.state === 'online').length} FEEDS ONLINE
            </Chip>
          </div>

          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setUi({ bottomOpen: false })}
            title="Collapse the event stream"
          >
            ▼
          </button>
        </header>

        <div className="stream__track" ref={scrollRef}>
          {rows.length === 0 && (
            <div className="stream__idle micro">AWAITING EVENTS — NOTHING MATCHES THE CURRENT FILTERS</div>
          )}
          {rows.map((incident) => (
            <StreamCard
              key={incident.id}
              incident={incident}
              isNew={recentArrivals.has(incident.id)}
              selected={incident.id === selectedId}
              onSelect={() => select(incident.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function StreamCard({
  incident,
  isNew,
  selected,
  onSelect,
}: {
  incident: Incident;
  isNew: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = INCIDENT_TYPE_META[incident.incidentType];
  const processing = incident.status === 'transcribing' || incident.status === 'extracting';

  return (
    <button
      type="button"
      className={`streamcard ${isNew ? 'streamcard--new' : ''}`}
      aria-selected={selected}
      onClick={onSelect}
      style={{ '--row-accent': `var(--sev-${incident.severity})` } as React.CSSProperties}
    >
      <span className="streamcard__rail" />
      <span className="streamcard__time mono">{formatClock(incident.timestamp)}</span>
      <span className="streamcard__type">
        <SeverityDot severity={incident.severity} />
        {meta.label}
      </span>
      <span className="streamcard__desc truncate">{incident.description}</span>
      <span className="streamcard__foot">
        <span className="streamcard__loc truncate micro">{incident.location.label}</span>
        <span className={`streamcard__status micro ${processing ? 'streamcard__status--live' : ''}`}>
          {STATUS_LABEL[incident.status]}
        </span>
      </span>
      {processing && <span className="scanbar streamcard__scan" />}
    </button>
  );
}
