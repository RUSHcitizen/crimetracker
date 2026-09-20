import { useEffect, useRef, useState } from 'react';
import {
  formatKm,
  formatPercent,
  formatRelative,
  INCIDENT_TYPE_META,
  type PatternCluster,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { playTone } from '../lib/sound.js';

/**
 * Pattern Detection.
 *
 * This surfaces unusual concentrations in incidents the system has **already received** —
 * several reports close together in space and time, or a repeated incident type in one
 * area. It is descriptive, not predictive, and the panel says so in its own chrome: the
 * whole block is violet (the reserved "inference" colour) and carries a standing
 * ANALYTICAL INFERENCE label.
 */
export function PatternOverlay() {
  const patterns = useTracker((s) => s.patterns);
  const visible = useTracker((s) => s.ui.patternsVisible);
  const soundEnabled = useTracker((s) => s.ui.soundEnabled);
  const setUi = useTracker((s) => s.setUi);
  const focusPattern = useTracker((s) => s.focusPattern);
  const focusedPatternId = useTracker((s) => s.focusedPatternId);

  const [index, setIndex] = useState(0);
  const knownIds = useRef<Set<string>>(new Set());

  // Announce genuinely new concentrations once, and never on a re-render.
  useEffect(() => {
    const fresh = patterns.filter((p) => !knownIds.current.has(p.id));
    if (fresh.length > 0) {
      playTone('pattern', soundEnabled);
      for (const p of fresh) knownIds.current.add(p.id);
      setIndex(0);
    }
    // Forget clusters that have aged out, so a recurrence re-announces.
    const live = new Set(patterns.map((p) => p.id));
    for (const id of knownIds.current) if (!live.has(id)) knownIds.current.delete(id);
  }, [patterns, soundEnabled]);

  useEffect(() => {
    if (index >= patterns.length) setIndex(0);
  }, [patterns.length, index]);

  if (!visible || patterns.length === 0) return null;
  const pattern = patterns[Math.min(index, patterns.length - 1)];
  if (!pattern) return null;

  return (
    <div className="pattern" role="status" aria-live="polite">
      <div className="pattern__frame">
        <span className="pattern__scan" aria-hidden="true" />

        <header className="pattern__head">
          <span className="pattern__sigil" aria-hidden="true">
            <svg viewBox="0 0 22 22" width="16" height="16">
              <path
                d="M11 1.6 19.5 6.4v9.2L11 20.4 2.5 15.6V6.4z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <path d="M11 5.8v10.4M6.3 8.5l9.4 5M15.7 8.5l-9.4 5" stroke="currentColor" strokeWidth="0.8" opacity="0.7" />
            </svg>
          </span>
          <span className="pattern__title">PATTERN DETECTED</span>
          <span className="pattern__id mono">{pattern.id}</span>
          <button
            type="button"
            className="pattern__close"
            onClick={() => setUi({ patternsVisible: false })}
            title="Hide pattern detection"
          >
            ×
          </button>
        </header>

        <div className="pattern__body">
          <PatternLine value={String(pattern.count)} unit="related reports" />
          <PatternLine value={`within ${formatKm(pattern.radiusKm)}`} unit="of one another" />
          <PatternLine
            value={`over ${pattern.spanMinutes} minutes`}
            unit={`last report ${formatRelative(pattern.lastAt)} ago`}
          />
          <PatternLine
            value={INCIDENT_TYPE_META[pattern.dominantType].label}
            unit={`${formatPercent(pattern.typeShare)} of the cluster`}
          />
        </div>

        <div className="pattern__conf">
          <span className="label">CONFIDENCE</span>
          <div className="pattern__confbar">
            <span className="pattern__conffill" style={{ width: `${pattern.confidence * 100}%` }} />
          </div>
          <span className="pattern__confval mono">{formatPercent(pattern.confidence)}</span>
        </div>

        <ul className="pattern__why">
          {pattern.rationale.map((reason) => (
            <li key={reason} className="micro">
              {reason}
            </li>
          ))}
        </ul>

        <footer className="pattern__foot">
          <button
            type="button"
            className={`btn btn--violet ${focusedPatternId === pattern.id ? 'btn--on' : ''}`}
            onClick={() => focusPattern(pattern.id)}
          >
            VIEW CLUSTER
          </button>
          {patterns.length > 1 && (
            <div className="pattern__pips" role="tablist" aria-label="Detected patterns">
              {patterns.slice(0, 6).map((p, i) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  className="pattern__pip"
                  onClick={() => setIndex(i)}
                  title={`${p.count} reports · ${formatPercent(p.confidence)} confidence`}
                />
              ))}
            </div>
          )}
        </footer>

        <div className="pattern__disclaimer">
          ANALYTICAL INFERENCE — a concentration in reports already received. This is not a
          prediction, and not a confirmed event.
        </div>
      </div>
    </div>
  );
}

function PatternLine({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="pattern__line">
      <span className="pattern__value">{value}</span>
      <span className="pattern__unit">{unit}</span>
    </div>
  );
}

/** Small toggle shown when pattern detection has been dismissed. */
export function PatternToggle() {
  const visible = useTracker((s) => s.ui.patternsVisible);
  const count = useTracker((s) => s.patterns.length);
  const setUi = useTracker((s) => s.setUi);
  if (visible || count === 0) return null;
  return (
    <button
      type="button"
      className="btn btn--sm pattern__restore"
      onClick={() => setUi({ patternsVisible: true })}
    >
      {count} PATTERN{count === 1 ? '' : 'S'} DETECTED
    </button>
  );
}

export type { PatternCluster };
