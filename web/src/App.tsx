import { useEffect, useRef } from 'react';
import { MapCanvas } from './map/MapCanvas.js';
import { TopBar } from './hud/TopBar.js';
import { LeftPanel } from './hud/LeftPanel.js';
import { RightPanel } from './hud/RightPanel.js';
import { BottomStream } from './hud/BottomStream.js';
import { PatternOverlay, PatternToggle } from './hud/PatternOverlay.js';
import { StatsView } from './hud/StatsView.js';
import { CommandSearch } from './hud/CommandSearch.js';
import { RealtimeClient } from './lib/realtime.js';
import { useTracker } from './state/store.js';
import { playTone } from './lib/sound.js';

export default function App() {
  const ui = useTracker((s) => s.ui);
  const setUi = useTracker((s) => s.setUi);
  const connection = useTracker((s) => s.connection);
  const snapshotReceived = useTracker((s) => s.snapshotReceived);
  const mode = useTracker((s) => s.mode);
  const clientRef = useRef<RealtimeClient | null>(null);

  /* --------------------------- realtime link ---------------------------- */
  useEffect(() => {
    const client = new RealtimeClient();
    clientRef.current = client;
    client.connect();
    return () => client.disconnect();
  }, []);

  /* ------------------- arrival sound (opt-in, off by default) ----------- */
  useEffect(() => {
    let lastSeen = 0;
    return useTracker.subscribe((state, prev) => {
      if (state.recentArrivals === prev.recentArrivals) return;
      if (!state.ui.soundEnabled) return;
      const newest = Math.max(0, ...state.recentArrivals.values());
      if (newest > lastSeen) {
        lastSeen = newest;
        playTone('arrive', true);
      }
    });
  }, []);

  /* ----------------------------- shortcuts ------------------------------ */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'SELECT' || target?.isContentEditable;

      if (event.key === 'Escape') {
        const state = useTracker.getState();
        if (state.ui.searchOpen) state.setUi({ searchOpen: false });
        else if (state.ui.statsOpen) state.setUi({ statsOpen: false });
        else state.select(null);
        return;
      }
      if (typing) return;

      switch (event.key.toLowerCase()) {
        case '/':
          event.preventDefault();
          useTracker.getState().setUi({ searchOpen: true });
          break;
        case 'a':
          useTracker.getState().setUi({ statsOpen: !useTracker.getState().ui.statsOpen });
          break;
        case 'p':
          useTracker
            .getState()
            .setUi({ patternsVisible: !useTracker.getState().ui.patternsVisible });
          break;
        case '[':
          useTracker.getState().setUi({ leftOpen: !useTracker.getState().ui.leftOpen });
          break;
        case ']':
          useTracker.getState().setUi({ rightOpen: !useTracker.getState().ui.rightOpen });
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const booting = !snapshotReceived && connection !== 'closed';

  return (
    <>
      <MapCanvas />

      <div className="hud">
        <TopBar />

        <div className="hud__left">
          {ui.leftOpen ? (
            <LeftPanel />
          ) : (
            <button
              type="button"
              className="edgetab edgetab--left"
              onClick={() => setUi({ leftOpen: true })}
            >
              INCIDENTS
            </button>
          )}
        </div>

        <div className="hud__center">
          <PatternOverlay />
          <PatternToggle />
          <div className="hud__centerfoot">
            <MapControls />
            <ModeBanner mode={mode} />
          </div>
        </div>

        <div className="hud__right">
          {ui.rightOpen ? (
            <RightPanel />
          ) : (
            <button
              type="button"
              className="edgetab edgetab--right"
              onClick={() => setUi({ rightOpen: true })}
            >
              DETAIL
            </button>
          )}
        </div>

        <div className="hud__bottom">
          <BottomStream />
        </div>
      </div>

      <StatsView />
      <CommandSearch />

      {booting && <BootScreen connection={connection} />}

      <div className="ambient" aria-hidden="true">
        <span className="ambient__sweep" />
      </div>
    </>
  );
}

/** Map zoom/reset controls, styled as part of the HUD rather than MapLibre's defaults. */
function MapControls() {
  const setUi = useTracker((s) => s.setUi);
  const ui = useTracker((s) => s.ui);
  const resetFilters = useTracker((s) => s.resetFilters);

  return (
    <div className="mapctl">
      <button
        type="button"
        className="mapctl__btn"
        onClick={() => setUi({ patternsVisible: !ui.patternsVisible })}
        title="Toggle pattern detection (P)"
        aria-pressed={ui.patternsVisible}
      >
        ◈
      </button>
      <button
        type="button"
        className="mapctl__btn"
        onClick={() => setUi({ soundEnabled: !ui.soundEnabled })}
        title={ui.soundEnabled ? 'Mute interface sound' : 'Enable interface sound (off by default)'}
        aria-pressed={ui.soundEnabled}
      >
        {ui.soundEnabled ? '♪' : '✕'}
      </button>
      <button type="button" className="mapctl__btn" onClick={resetFilters} title="Reset all filters">
        ⟲
      </button>
    </div>
  );
}

/**
 * A standing, unmissable statement of what the operator is looking at. In simulation
 * mode this must never be subtle.
 */
function ModeBanner({ mode }: { mode: 'live' | 'simulation' }) {
  return (
    <div className={`modebanner modebanner--${mode}`}>
      <span className="modebanner__bar" />
      <span className="modebanner__text">
        {mode === 'simulation'
          ? 'SIMULATION — ALL INCIDENTS SHOWN ARE FICTIONAL AND GENERATED LOCALLY'
          : 'LIVE — INCIDENTS FROM CONFIGURED PUBLIC SOURCES'}
      </span>
    </div>
  );
}

function BootScreen({ connection }: { connection: string }) {
  return (
    <div className="boot">
      <div className="boot__inner">
        <div className="boot__mark">CRIME TRACKER</div>
        <div className="boot__bar">
          <span />
        </div>
        <div className="boot__status micro">
          {connection === 'open' ? 'RECEIVING SNAPSHOT' : 'ESTABLISHING LINK'}
        </div>
      </div>
    </div>
  );
}
