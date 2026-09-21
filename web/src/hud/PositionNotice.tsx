import { useFilteredIncidents } from '../state/selectors.js';

/**
 * Says so when nothing on screen can be plotted.
 *
 * A radio-derived deployment is the case that makes this necessary: a transcript never
 * establishes a position, so an OpenMHz-only live run produces a full incident stream
 * over an entirely empty map. That is the correct behaviour — inventing coordinates to
 * fill the map is the one thing this project must never do — but without a word of
 * explanation it reads as a broken map rather than an honest one.
 */
export function PositionNotice() {
  const incidents = useFilteredIncidents();
  if (incidents.length === 0) return null;

  const plottable = incidents.reduce((n, incident) => n + (incident.coordinates ? 1 : 0), 0);
  if (plottable > 0) return null;

  return (
    <div className="posnotice micro" role="status">
      {incidents.length} INCIDENT{incidents.length === 1 ? '' : 'S'} — NONE CARRY A POSITION.
      <span className="posnotice__detail">
        {' '}
        Radio transcripts and area-level reports are listed and counted, never plotted at a
        coordinate nobody published.
      </span>
    </div>
  );
}
