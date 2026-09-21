import { useEffect, useRef } from 'react';
import { MapCanvas } from './map/MapCanvas.js';
import { TopBar } from './hud/TopBar.js';
import { LeftPanel } from './hud/LeftPanel.js';
import { RightPanel } from './hud/RightPanel.js';
import { BottomStream } from './hud/BottomStream.js';
import { PatternOverlay, PatternToggle } from './hud/PatternOverlay.js';
import { CameraCard, CameraNotice, CameraToggle } from './hud/CameraOverlay.js';
import { PositionNotice } from './hud/PositionNotice.js';
import { StatsView } from './hud/StatsView.js';
import { CommandSearch } from './hud/CommandSearch.js';
import { RealtimeClient } from './lib/realtime.js';
import { useTracker } from './state/store.js';
import { playTone } from './lib/sound.js';
import { stopSpeaking } from './lib/speech.js';

export default function App() {
  const ui = useTracker((s) => s.ui);
  const setUi = useTracker((s) => s.setUi);
  const connection = useTracker((s) => s.connection);
  const snapshotReceived = useTracker((s) => s.snapshotReceived);
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
        stopSpeaking();
        if (state.ui.searchOpen) state.setUi({ searchOpen: false });
        else if (state.ui.statsOpen) state.setUi({ statsOpen: false });
        else if (state.selectedCameraId) state.selectCamera(null);
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
        case 'c': {
          const state = useTracker.getState();
          const next = !state.ui.camerasVisible;
          state.setUi({ camerasVisible: next });
          if (next) void state.loadCameras();
          else state.selectCamera(null);
          break;
        }
        case 'v': {
          const state = useTracker.getState();
          const next = !state.ui.voiceEnabled;
          state.setUi({ voiceEnabled: next });
          // Turning it off mid-sentence must actually stop the sentence.
          if (!next) stopSpeaking();
          break;
        }
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
          <CameraNotice />
          <PositionNotice />
          <div className="hud__centerfoot">
            <MapControls />
            <SourceBanner />
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

      <CameraCard />
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
      <CameraToggle />
    </div>
  );
}

/**
 * A standing statement of what the operator is looking at.
 *
 * It says "public sources" rather than naming a mode because there is no other mode: the
 * system ingests published public-safety data and has no way to invent an incident. The
 * banner exists so that is never in question at a glance.
 */
function SourceBanner() {
  const sources = useTracker((s) => s.sources);
  const named = sources
    .filter((source) => source.state === 'online')
    .map((source) => source.name)
    .slice(0, 3)
    .join(' · ');

  return (
    <div className="modebanner modebanner--live">
      <span className="modebanner__bar" />
      <span className="modebanner__text">
        {named
          ? `LIVE — ${named.toUpperCase()}`
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
