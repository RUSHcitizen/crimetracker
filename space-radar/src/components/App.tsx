import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AU_KM } from '../lib/astro/constants';
import type { CloseApproach } from '../lib/data/types';
import {
  fetchCloseApproaches,
  fetchProbeVector,
  fetchSatellites,
  fetchSpaceWeather,
  type FeedStatus,
  type SpaceWeather,
} from '../lib/data/live';
import { discover, type Discovery } from '../lib/discover';
import type { Mission, MissionProgress } from '../lib/missions';
import { Engine, type Telemetry } from '../lib/render/engine';
import { sound } from '../lib/sound';
import type { Layers } from '../lib/render/scene';
import { DataSheet } from './DataSheet';
import { DiscoveryCard } from './Discovery';
import { LayersSheet } from './LayersSheet';
import { loadProgress, MissionsSheet, saveProgress, useMissionWatcher } from './MissionsSheet';
import { ObjectPanel } from './ObjectPanel';
import { SandboxSheet } from './SandboxSheet';
import { SearchSheet } from './SearchSheet';
import { TimeBar } from './TimeBar';
import { TopStrip } from './TopStrip';
import {
  IconData,
  IconGravity,
  IconHome,
  IconLayers,
  IconMissions,
  IconSandbox,
  IconSearch,
  IconSurprise,
  IconTime,
  IconZoomIn,
  IconZoomOut,
} from './icons';

/**
 * The application shell.
 *
 * Holds the engine, the sheet that is open, and the live-data state. Everything else is
 * downstream of a `Telemetry` snapshot that arrives eight times a second — the renderer
 * runs far faster than that, and deliberately does not drag the component tree along with
 * it.
 */

type SheetId = 'search' | 'missions' | 'sandbox' | 'layers' | 'data' | null;

/** Re-measure the panel stack whenever the object panel appears or disappears. */
const selectedIdForInsets = (t: Telemetry | null): string | null => t?.selected?.id ?? null;

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  const [engine, setEngine] = useState<Engine | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [sheet, setSheet] = useState<SheetId>(null);
  const [showTime, setShowTime] = useState(true);

  const [feeds, setFeeds] = useState<FeedStatus[]>([]);
  const [weather, setWeather] = useState<SpaceWeather | null>(null);
  const [approaches, setApproaches] = useState<CloseApproach[]>([]);

  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [progress, setProgress] = useState<MissionProgress>({ completed: [], active: null });
  const [justCompleted, setJustCompleted] = useState<Mission | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---------------------------------------------------------------- engine

  useEffect(() => {
    if (!stageRef.current || !glRef.current || !overlayRef.current) return;

    const e = new Engine(stageRef.current, glRef.current, overlayRef.current);
    engineRef.current = e;
    setEngine(e);
    setTelemetry(e.telemetry());
    let lastSelection: string | null = null;
    e.onSelect((obj) => {
      if (obj && obj.id !== lastSelection) sound.play('select');
      lastSelection = obj?.id ?? null;
    });
    const unsubscribe = e.subscribe(setTelemetry);
    e.start();

    // A dramatic but short opening move: start out past Neptune, settle onto the inner
    // system. The destination is a *fit*, not a fixed distance, so a portrait phone and a
    // wide desktop window both end up with Mars on screen.
    e.rig.setDistance(70 * AU_KM, true);
    requestAnimationFrame(() =>
      e.rig.flyTo({
        distanceKm: e.rig.distanceToFit(1.75 * AU_KM),
        durationMs: 2600,
        elevation: 0.52,
      }),
    );

    setProgress(loadProgress());

    const onVisibility = () => {
      if (document.hidden) e.stop();
      else {
        e.clock.resync(performance.now());
        e.start();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      e.dispose();
      engineRef.current = null;
    };
  }, []);

  // The panels can cover more than half a phone screen. Measure them and tell the engine,
  // which shifts the camera projection so whatever you flew to is not hidden behind them.
  useEffect(() => {
    if (!engine || !bottomRef.current) return;
    const el = bottomRef.current;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      // On desktop the stack is a floating card in the corner, so it hides a column, not
      // a band — offsetting the whole projection for it would push the system off-centre
      // for no reason. Only treat it as an inset when it actually spans the viewport.
      const spansViewport = rect.width > window.innerWidth * 0.85;
      const h = spansViewport ? rect.height : 0;
      engine.setInsets(spansViewport ? 46 : 0, h);
      // The side rail is anchored to this too, so it can never end up underneath the
      // panel stack — and it stays within thumb reach as the stack grows.
      document.documentElement.style.setProperty('--bottom-h', `${Math.round(rect.height)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [engine, selectedIdForInsets(telemetry), showTime]);

  // ------------------------------------------------------------ live data

  useEffect(() => {
    if (!engine) return;
    const controller = new AbortController();

    // Each feed is independent: one being unreachable must not hold up the others, and
    // none of them are required for the app to work.
    void (async () => {
      const [sats, cad, swpc] = await Promise.all([
        fetchSatellites('stations', controller.signal),
        fetchCloseApproaches(controller.signal),
        fetchSpaceWeather(controller.signal),
      ]);
      if (controller.signal.aborted) return;

      if (sats.objects.length > 0) {
        // Live element sets replace the demonstration shells entirely — showing both would
        // be confusing and would double the satellite count for no gain.
        engine.removeObjects((o) => o.tags.includes('demo'));
        engine.addObjects(sats.objects);
      }
      setApproaches(cad.approaches);
      setWeather(swpc.weather);
      setFeeds([sats.status, cad.status, swpc.status]);

      if (!sats.status.ok) {
        engine.setDataNotice('No live element sets — showing labelled demonstration orbits.');
      }
    })();

    // Probe vectors are a nice-to-have upgrade, fetched one at a time so a slow Horizons
    // never blocks the rest.
    void (async () => {
      for (const id of ['voyager-1', 'voyager-2', 'new-horizons', 'parker-solar-probe']) {
        if (controller.signal.aborted) return;
        const patch = await fetchProbeVector(id, controller.signal);
        if (!patch) continue;
        const existing = engine.world.get(patch.id);
        if (!existing) continue;
        engine.addObjects([
          {
            ...existing,
            ephemeris: { kind: 'state', state: patch.state, epoch: patch.epoch },
            provenance: patch.provenance,
            status: `${existing.status ?? ''} · JPL VECTOR`.replace(/^ · /, ''),
          },
        ]);
      }
    })();

    return () => controller.abort();
  }, [engine]);

  // ------------------------------------------------------------- missions

  useMissionWatcher(
    engine,
    telemetry?.selected?.id ?? null,
    progress,
    useCallback(
      (mission: Mission) => {
        setProgress((prev) => {
          if (prev.completed.includes(mission.id)) return prev;
          const next = { completed: [...prev.completed, mission.id], active: null };
          saveProgress(next);
          return next;
        });
        setJustCompleted(mission);
        sound.play('complete');
      },
      [],
    ),
  );

  useEffect(() => {
    if (!justCompleted) return;
    const timer = setTimeout(() => setJustCompleted(null), 9000);
    return () => clearTimeout(timer);
  }, [justCompleted]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5200);
    return () => clearTimeout(timer);
  }, [notice]);


  const updateProgress = useCallback((p: MissionProgress) => {
    setProgress(p);
    saveProgress(p);
  }, []);

  // ------------------------------------------------------------ commands

  const surprise = useCallback(() => {
    if (!engine) return;
    const found = discover(engine.world, engine.clock.jd, discovery?.objectId ?? null);
    if (!found) return;
    setDiscovery(found);
    setSheet(null);
    sound.play('discover');
    engine.flyTo(found.objectId, found.distanceKm ? { distanceKm: found.distanceKm } : {});
  }, [engine, discovery]);

  /**
   * First visit only: fire one discovery once the opening camera move has landed.
   *
   * Not a landing page and not a tutorial — the app is already running behind it. It is
   * there because the core loop of this thing is "press the button, find something
   * strange, press it again", and the fastest way to teach that is to do it once.
   */
  useEffect(() => {
    if (!engine) return;
    let seen = true;
    try {
      seen = localStorage.getItem('space-radar.seen.v1') === 'yes';
    } catch {
      seen = true;
    }
    if (seen) return;

    const timer = setTimeout(() => {
      surprise();
      try {
        localStorage.setItem('space-radar.seen.v1', 'yes');
      } catch {
        /* not persisting just means it happens again next time */
      }
    }, 3400);
    return () => clearTimeout(timer);
  }, [engine, surprise]);

  const pick = useCallback(
    (id: string) => {
      if (!engine) return;
      engine.flyTo(id);
      setSheet(null);
      sound.play('select');
    },
    [engine],
  );

  // Keyboard shortcuts for desktop. Never the only way to do anything.
  useEffect(() => {
    if (!engine) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      switch (e.key.toLowerCase()) {
        case '/': e.preventDefault(); setSheet('search'); break;
        case 'r': surprise(); break;
        case 'l': engine.goLive(); break;
        case 'h': engine.goHome(); break;
        case 'escape': setSheet(null); break;
        case 't': if (telemetry?.selected) engine.setTracked(telemetry.trackedId ? null : telemetry.selected.id); break;
        case 'c': if (telemetry?.selected) engine.setChase(!telemetry.chase); break;
        case '+': case '=': engine.zoom(0.7); break;
        case '-': engine.zoom(1.4); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, surprise, telemetry]);

  const toggleLayer = useCallback(
    (key: keyof Layers, value: boolean) => engine?.setLayer(key, value),
    [engine],
  );

  const selected = telemetry?.selected ?? null;
  const missionCount = useMemo(() => progress.completed.length, [progress.completed]);

  return (
    <>
      <div class="stage" ref={stageRef}>
        <canvas ref={glRef} />
        <canvas class="overlay" ref={overlayRef} />
      </div>

      {telemetry ? <TopStrip telemetry={telemetry} feeds={feeds} /> : null}

      <div class="sidebar">
        <button class="icon-btn" onClick={() => engine?.zoom(0.62)} aria-label="Zoom in"><IconZoomIn /></button>
        <button class="icon-btn" onClick={() => engine?.zoom(1.6)} aria-label="Zoom out"><IconZoomOut /></button>
        <button class="icon-btn" onClick={() => engine?.goHome()} aria-label="Go to Earth"><IconHome /></button>
        <button
          class="icon-btn"
          aria-pressed={telemetry?.layers.gravity ?? false}
          onClick={() => toggleLayer('gravity', !(telemetry?.layers.gravity ?? false))}
          aria-label="Toggle gravity layer"
        >
          <IconGravity />
        </button>
        <button
          class="icon-btn"
          aria-pressed={showTime}
          onClick={() => setShowTime((v) => !v)}
          aria-label="Toggle time controls"
        >
          <IconTime />
        </button>
        <button class="icon-btn" onClick={() => setSheet('data')} aria-label="Data sources"><IconData /></button>
      </div>

      <div class="bottom" ref={bottomRef}>
        {notice ? (
          <div class="notice" role="status" onClick={() => setNotice(null)}>
            {notice}
          </div>
        ) : null}

      {justCompleted ? (
        <div class="discovery" style={{ borderLeftColor: 'var(--good)' }} role="status">
          <div class="dh" style={{ color: 'var(--good)' }}>{justCompleted.code} COMPLETE — {justCompleted.title}</div>
          <div class="dd">
            {engine ? justCompleted.reveal(engine.world, engine.clock.jd) : ''}
          </div>
          <div class="drow">
            <button class="btn primary" onClick={() => { setJustCompleted(null); setSheet('missions'); }}>
              NEXT MISSION
            </button>
            <button class="btn" onClick={() => setJustCompleted(null)} style={{ marginLeft: 'auto' }}>CLOSE</button>
          </div>
        </div>
      ) : discovery ? (
        <DiscoveryCard
          discovery={discovery}
          onAgain={surprise}
          onDismiss={() => setDiscovery(null)}
          onTrack={() => {
            engine?.setTracked(discovery.objectId);
            setDiscovery(null);
          }}
        />
      ) : null}

        {selected && telemetry ? (
          <ObjectPanel
            readout={selected}
            telemetry={telemetry}
            onClose={() => engine?.select(null)}
            onTrack={() => {
              const next = telemetry.trackedId === selected.id ? null : selected.id;
              engine?.setTracked(next);
              sound.play(next ? 'lock' : 'release');
            }}
            onChase={() => {
              const next = !(telemetry.chase && telemetry.trackedId === selected.id);
              engine?.setChase(next);
              sound.play(next ? 'lock' : 'release', next ? 1.3 : 1);
            }}
            onToggleTrajectory={() => toggleLayer('trajectory', !telemetry.layers.trajectory)}
            onTimeTravel={() => {
              setShowTime(true);
              const result = engine?.timeTravelForSelection();
              if (result) {
                sound.play('zoom');
                setNotice(`TIME TRAVEL — ${result.description}`);
              }
            }}
          />
        ) : null}

        {showTime && telemetry ? (
          <TimeBar
            telemetry={telemetry}
            onSeekOffset={(d) => engine?.clock.seekOffset(d)}
            onNudge={(d) => engine?.clock.nudge(d)}
            onSetRate={(r) => engine?.clock.setRate(r)}
            onLive={() => engine?.goLive()}
          />
        ) : null}

        <nav class="dock" aria-label="Primary">
          <button aria-pressed={sheet === 'search'} onClick={() => setSheet(sheet === 'search' ? null : 'search')}>
            <IconSearch /> SEARCH
          </button>
          <button onClick={surprise}>
            <IconSurprise /> SURPRISE
          </button>
          <button aria-pressed={sheet === 'missions'} onClick={() => setSheet(sheet === 'missions' ? null : 'missions')}>
            <IconMissions /> MISSIONS
            {missionCount > 0 ? <span class="badge">{missionCount}</span> : null}
          </button>
          <button aria-pressed={sheet === 'sandbox'} onClick={() => setSheet(sheet === 'sandbox' ? null : 'sandbox')}>
            <IconSandbox /> WHAT IF
          </button>
          <button aria-pressed={sheet === 'layers'} onClick={() => setSheet(sheet === 'layers' ? null : 'layers')}>
            <IconLayers /> LAYERS
          </button>
        </nav>
      </div>

      {engine && sheet === 'search' ? (
        <SearchSheet engine={engine} onClose={() => setSheet(null)} onPick={pick} />
      ) : null}

      {engine && sheet === 'missions' ? (
        <MissionsSheet
          engine={engine}
          onClose={() => setSheet(null)}
          progress={progress}
          onProgress={updateProgress}
        />
      ) : null}

      {engine && sheet === 'sandbox' ? (
        <SandboxSheet engine={engine} onClose={() => setSheet(null)} selectedId={selected?.id ?? null} />
      ) : null}

      {telemetry && sheet === 'layers' ? (
        <LayersSheet layers={telemetry.layers} onToggle={toggleLayer} onClose={() => setSheet(null)} />
      ) : null}

      {sheet === 'data' ? (
        <DataSheet
          feeds={feeds}
          weather={weather}
          approaches={approaches}
          onClose={() => setSheet(null)}
          onPickApproach={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}
