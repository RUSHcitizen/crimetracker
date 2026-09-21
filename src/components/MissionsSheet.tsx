import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  buildMissions,
  checkMission,
  loadProgress,
  saveProgress,
  type Mission,
  type MissionProgress,
} from '../lib/missions';
import type { Engine } from '../lib/render/engine';
import { Sheet } from './Sheet';
import { IconCheck } from './icons';

/**
 * Missions.
 *
 * Each one is a question answered by measuring the live simulation, so starting a mission
 * closes the sheet and leaves you to actually go and look. Completion is verified against
 * a fresh measurement at the moment you make the selection — which is what lets the
 * time-travel missions work at all, since their answers change as the clock moves.
 *
 * Progress is a list of ids in localStorage. No account, and nothing lost if it is cleared.
 */

export function MissionsSheet(props: {
  engine: Engine;
  onClose: () => void;
  progress: MissionProgress;
  onProgress: (p: MissionProgress) => void;
}) {
  const missions = useMemo(
    () => buildMissions(props.engine.world, props.engine.clock.jd),
    [props.engine, props.progress.active],
  );
  const [revealed, setRevealed] = useState<string | null>(null);
  const [hintFor, setHintFor] = useState<string | null>(null);

  const done = new Set(props.progress.completed);
  const completedCount = missions.filter((m) => done.has(m.id)).length;

  const start = (m: Mission) => {
    props.onProgress({ ...props.progress, active: m.id });
    props.onClose();
  };

  const reset = () => {
    props.onProgress({ completed: [], active: null });
    setRevealed(null);
  };

  return (
    <Sheet
      title="MISSIONS"
      note={`${completedCount}/${missions.length} COMPLETE`}
      onClose={props.onClose}
    >
      <div class="prose" style={{ borderBottom: '1px solid var(--hairline)' }}>
        <p>
          Each mission is a question about the <strong>current state of the simulation</strong>, not a
          stored answer. Start one, then go and find the object. Selecting it completes the mission.
        </p>
      </div>

      {missions.map((m) => {
        const isDone = done.has(m.id);
        const isActive = props.progress.active === m.id;
        return (
          <div class={`mission ${isDone ? 'done' : ''}`} key={m.id}>
            <div class="mcode">
              <span>{m.code}</span>
              <span class="stars" aria-label={`Difficulty ${m.difficulty} of 3`}>
                {[1, 2, 3].map((n) => <i key={n} class={n <= m.difficulty ? 'on' : ''} />)}
              </span>
              {m.requiresTimeTravel ? <span style={{ color: 'var(--accent)' }}>TIME TRAVEL</span> : null}
              {isDone ? (
                <span style={{ color: 'var(--good)', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <IconCheck style={{ width: 11, height: 11 }} /> COMPLETE
                </span>
              ) : null}
              {isActive && !isDone ? <span style={{ color: 'var(--accent)' }}>ACTIVE</span> : null}
            </div>

            <div class="mtitle">{m.title}</div>
            <div class="mbrief">{m.brief}</div>

            {hintFor === m.id ? (
              <div class="mbrief" style={{ marginTop: 7, color: 'var(--accent)' }}>HINT: {m.hint}</div>
            ) : null}

            {revealed === m.id || isDone ? (
              <div class="reveal">{m.reveal(props.engine.world, props.engine.clock.jd)}</div>
            ) : null}

            <div class="mrow">
              {!isDone ? (
                <button class="btn primary" onClick={() => start(m)}>
                  {isActive ? 'RESUME' : 'START'}
                </button>
              ) : (
                <button class="btn" onClick={() => setRevealed(revealed === m.id ? null : m.id)}>
                  {revealed === m.id ? 'HIDE' : 'SHOW ANSWER'}
                </button>
              )}
              {!isDone ? (
                <button class="btn" onClick={() => setHintFor(hintFor === m.id ? null : m.id)}>
                  {hintFor === m.id ? 'HIDE HINT' : 'HINT'}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {completedCount > 0 ? (
        <div style={{ padding: 12 }}>
          <button class="btn" onClick={reset}>RESET PROGRESS</button>
        </div>
      ) : null}
    </Sheet>
  );
}

/** Watches the current selection and completes the active mission when it matches. */
export function useMissionWatcher(
  engine: Engine | null,
  selectedId: string | null,
  progress: MissionProgress,
  onComplete: (mission: Mission) => void,
): void {
  useEffect(() => {
    if (!engine || !progress.active || !selectedId) return;
    if (progress.completed.includes(progress.active)) return;

    const mission = buildMissions(engine.world, engine.clock.jd).find((m) => m.id === progress.active);
    if (!mission) return;

    if (checkMission(mission, engine.world, engine.clock.jd, selectedId)) onComplete(mission);
  }, [engine, selectedId, progress.active, progress.completed.length]);
}

export { loadProgress, saveProgress };
