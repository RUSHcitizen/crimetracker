import { useEffect, useState } from 'react';
import { formatClock, formatRelative } from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { setServerMode } from '../lib/api.js';
import { Chip } from '../components/primitives.js';

/**
 * The header rail: identity, mode, clock, data-source health, link state.
 *
 * The mode indicator is the most important element on the screen — it is the difference
 * between "these are fictional records" and "these came from a real feed" — so it gets
 * the strongest treatment in the bar.
 */
export function TopBar() {
  const mode = useTracker((s) => s.mode);
  const connection = useTracker((s) => s.connection);
  const sources = useTracker((s) => s.sources);
  const stats = useTracker((s) => s.stats);
  const lastFrameAt = useTracker((s) => s.lastFrameAt);
  const setMode = useTracker((s) => s.setMode);
  const ui = useTracker((s) => s.ui);
  const setUi = useTracker((s) => s.setUi);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const online = sources.filter((s) => s.state === 'online').length;
  const erroring = sources.filter((s) => s.state === 'error').length;
  const ingested = sources.reduce((sum, s) => sum + s.eventsIngested, 0);

  const linkTone =
    connection === 'open' ? 'green' : connection === 'connecting' ? 'amber' : 'crimson';
  const linkLabel =
    connection === 'open' ? 'LINK OK' : connection === 'connecting' ? 'LINKING' : 'LINK LOST';

  const toggleMode = async () => {
    const next = mode === 'simulation' ? 'live' : 'simulation';
    const applied = await setServerMode(next);
    if (applied) setMode(applied);
  };

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="19" height="19">
            <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
            <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.85" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <path d="M12 0.6v4M12 19.4v4M0.6 12h4M19.4 12h4" stroke="currentColor" strokeWidth="1" />
          </svg>
        </span>
        <h1 className="topbar__title">
          CRIME<span>TRACKER</span>
        </h1>
        <span className="topbar__version micro">v0.1</span>
      </div>

      <button
        type="button"
        className={`modeswitch modeswitch--${mode}`}
        onClick={() => void toggleMode()}
        title={
          mode === 'simulation'
            ? 'Simulation mode: every incident shown is fictional. Click to request live mode.'
            : 'Live mode: incidents come from configured public sources. Click to return to simulation.'
        }
      >
        <span className="modeswitch__dot dot dot--pulse" />
        <span className="modeswitch__label">{mode === 'simulation' ? 'SIMULATION' : 'LIVE'}</span>
        <span className="modeswitch__sub micro">
          {mode === 'simulation' ? 'FICTIONAL DATA' : 'PUBLIC SOURCES'}
        </span>
      </button>

      <div className="topbar__spacer" />

      <div className="topbar__readouts">
        <div className="topbar__readout">
          <span className="label">SOURCES</span>
          <span className="mono topbar__value">
            {online}/{sources.length}
            {erroring > 0 && <em className="topbar__err"> {erroring} ERR</em>}
          </span>
        </div>
        <div className="topbar__divider" />
        <div className="topbar__readout">
          <span className="label">INGESTED</span>
          <span className="mono topbar__value">{ingested.toLocaleString()}</span>
        </div>
        <div className="topbar__divider" />
        <div className="topbar__readout">
          <span className="label">LAST HOUR</span>
          <span className="mono topbar__value">{stats?.lastHour ?? '—'}</span>
        </div>
        <div className="topbar__divider" />
        <div className="topbar__readout">
          <span className="label">FRAME</span>
          <span className="mono topbar__value">
            {lastFrameAt ? formatRelative(lastFrameAt) : '—'}
          </span>
        </div>
      </div>

      <div className="topbar__status">
        <Chip tone={linkTone}>
          <span className={`dot ${connection === 'open' ? 'dot--pulse' : ''}`} />
          {linkLabel}
        </Chip>
      </div>

      <div className="topbar__clock">
        <span className="topbar__time mono">{formatClock(now)}</span>
        <span className="micro">{now.toISOString().slice(0, 10)}</span>
      </div>

      <div className="topbar__actions">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          aria-pressed={ui.searchOpen}
          onClick={() => setUi({ searchOpen: !ui.searchOpen })}
          title="Search incidents (/)"
        >
          SEARCH
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          aria-pressed={ui.statsOpen}
          onClick={() => setUi({ statsOpen: !ui.statsOpen })}
          title="Analytics (A)"
        >
          ANALYTICS
        </button>
      </div>
    </header>
  );
}
