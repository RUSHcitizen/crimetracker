import { AU_KM, C_KM_S, RADIUS } from '../astro/constants';
import { periodDays } from '../astro/kepler';
import { nowJd } from '../astro/time';
import { formatDistanceInline } from '../format';
import { distance, length, sub, type Vec3 } from '../astro/vec';
import { buildCatalog } from '../data/catalog';
import { cloudPositions, makeDemoSatellites, makeKuiperBelt, makeMainBelt, makeTrojans, type ParticleCloud } from '../data/populations';
import type { Provenance, ResolvedObject, SpaceObject } from '../data/types';
import { Clock } from '../sim/clock';
import { World } from '../sim/world';
import { CameraRig, scaleBand } from './camera';
import { GestureController } from './input';
import { Overlay } from './overlay';
import { SpaceScene, type Layers } from './scene';

/**
 * The engine.
 *
 * Owns the frame loop and every piece of mutable state the app has: what time it is,
 * where the camera is, what is selected, what is being tracked. The UI never touches
 * three.js — it calls methods here and reads a `Telemetry` snapshot that is published at a
 * fixed, modest rate.
 *
 * That rate split is the whole performance story on a phone: the renderer runs as fast as
 * the device allows, while Preact re-renders about eight times a second. Driving a
 * component tree at 60 Hz with numbers that change in the fourth decimal is what makes
 * dashboards like this stutter.
 */

const TELEMETRY_HZ = 8;

export interface ObjectReadout {
  id: string;
  name: string;
  subtitle?: string;
  kind: string;
  status?: string;
  color: string;
  provenance: Provenance;
  facts: { label: string; value: string }[];
  parentName: string | null;
  distanceFromEarthKm: number;
  distanceFromSunKm: number;
  speedKmS: number;
  /** Speed relative to the parent body — what matters for something in orbit. */
  localSpeedKmS: number;
  signalDelaySec: number;
  orbitalPeriodDays: number | null;
  altitudeKm: number | null;
  apoapsisKm: number | null;
  periapsisKm: number | null;
  eccentricity: number | null;
  inclinationDeg: number | null;
  unplaced: boolean;
  phaseUnknown: boolean;
  soiKm: number | null;
}

export interface Telemetry {
  jd: number;
  offsetDays: number;
  live: boolean;
  rate: number;
  band: ReturnType<typeof scaleBand>;
  cameraDistanceKm: number;
  /** How wide the view is across the screen, km. The honest scale readout. */
  spanKm: number;
  selected: ObjectReadout | null;
  trackedId: string | null;
  chase: boolean;
  fps: number;
  visibleCount: number;
  totalCount: number;
  /** Nearest catalogue objects to the tracked body, for the chase readout. */
  neighbours: { id: string; name: string; km: number; color: string }[];
  layers: Layers;
  /** Set when the live data layer has something to say. */
  dataNotice: string | null;
}

export interface SandboxOverlay {
  id: string;
  points: Vec3[];
  color: string;
  dashed?: boolean;
}

export class Engine {
  readonly world: World;
  readonly clock = new Clock();
  readonly rig = new CameraRig();

  private scene: SpaceScene;
  private overlay: Overlay;
  private gestures: GestureController;
  private clouds: ParticleCloud[];
  private cloudCache = new Map<string, { jd: number; data: Float32Array }>();

  private raf = 0;
  private running = false;
  private lastTelemetry = 0;
  private frameTimes: number[] = [];
  private resolved: ResolvedObject[] = [];

  private _selectedId: string | null = null;
  private _trackedId: string | null = null;
  private _chase = false;
  private _overlays: SandboxOverlay[] = [];
  private _dataNotice: string | null = null;
  private _hoverId: string | null = null;
  /** Viewport pixels hidden behind UI. Set by the shell as panels open and close. */
  private insets = { top: 0, bottom: 0 };
  private overlayInsets = { top: 0, bottom: 0, right: 58 };

  layers: Layers = {
    orbits: true,
    labels: true,
    belts: true,
    satellites: true,
    gravity: false,
    grid: true,
    stars: true,
    trajectory: true,
  };

  private listeners = new Set<(t: Telemetry) => void>();
  private onSelectCb: ((o: SpaceObject | null) => void) | null = null;

  constructor(
    private container: HTMLElement,
    glCanvas: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
  ) {
    this.world = new World([...buildCatalog(), ...makeDemoSatellites()]);
    this.clouds = [makeMainBelt(), makeTrojans(), makeKuiperBelt()];

    this.scene = new SpaceScene(glCanvas);
    this.overlay = new Overlay(overlayCanvas);

    this.gestures = new GestureController(container, {
      onInteractStart: () => this.rig.cancelTransition(),
      onRotate: (dAz, dEl) => this.rig.rotateBy(dAz, dEl),
      onZoom: (f) => this.rig.zoomBy(f),
      onPan: (dx, dy) => {
        // Panning breaks the lock: you asked to look somewhere else.
        if (this._trackedId) this.setTracked(null);
        this.rig.panBy(dx * 1.9, dy * 1.9);
      },
      onTap: (x, y) => {
        const hit = this.overlay.pick(x, y);
        this.select(hit ? hit.object.id : null);
      },
      onHover: (x, y) => {
        // Pointer devices only — there is no hover on a touchscreen, and the app never
        // depends on this. It exists so a mouse gets the feedback a finger gets from the
        // thing it is touching.
        const hit = x < 0 ? null : this.overlay.pick(x, y, 26);
        const id = hit ? hit.object.id : null;
        if (id !== this._hoverId) {
          this._hoverId = id;
          this.container.style.cursor = id ? 'pointer' : '';
        }
      },
      onDoubleTap: (x, y) => {
        const hit = this.overlay.pick(x, y);
        if (hit) {
          this.select(hit.object.id);
          this.flyTo(hit.object.id);
        } else {
          this.rig.zoomBy(0.45);
        }
      },
    });

    // Start looking at the inner Solar System from slightly above the ecliptic.
    this.rig.snapFocus([0, 0, 0]);
    // Fit out to Mars, so the whole inner system is on screen on a portrait phone.
    this.rig.setDistance(this.rig.distanceToFit(1.75 * AU_KM), true);

    this.observeResize();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private resizeObserver: ResizeObserver | null = null;

  private observeResize(): void {
    const apply = () => {
      const rect = this.container.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      // Cap the device pixel ratio: a 3x phone display at full resolution costs more than
      // it returns for hairlines and points.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.scene.resize(w, h, dpr);
      this.overlay.resize(w, h, dpr);
      this.rig.aspect = w / h;
      this.rig.fovDeg = this.scene.camera.fov;
    };
    apply();
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(this.container);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.resync(performance.now());
    const loop = (t: number) => {
      if (!this.running) return;
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.gestures.dispose();
    this.resizeObserver?.disconnect();
    this.scene.dispose();
  }

  subscribe(fn: (t: Telemetry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onSelect(fn: (o: SpaceObject | null) => void): void {
    this.onSelectCb = fn;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private frame(now: number): void {
    const jd = this.clock.tick(now);

    this.resolved = this.world.resolveAll(jd);

    // Keep the camera glued to whatever is being tracked.
    const tracked = this._trackedId
      ? this.resolved.find((r) => r.object.id === this._trackedId)
      : undefined;
    const followPoint = tracked && !tracked.unplaced ? tracked.position : null;
    this.rig.update(now, followPoint);

    const trail = tracked && this.layers.trajectory ? this.trailFor(tracked.object, jd) : [];

    this.scene.sync({
      jd,
      insetTop: this.insets.top,
      insetBottom: this.insets.bottom,
      viewportHeight: this.container.clientHeight,
      focus: this.rig.focus,
      renderScale: this.rig.renderScale,
      cameraDistanceKm: this.rig.distance,
      eye: this.rig.eye,
      resolved: this.resolved,
      clouds: this.clouds,
      cloudPositionsFor: (cloud, atJd) => this.cloudPositionsFor(cloud, atJd),
      selectedId: this._selectedId,
      trackedId: this._trackedId,
      layers: this.layers,
      overlays: this._overlays,
      trail,
    });

    this.scene.render();

    this.overlay.insets = this.overlayInsets;
    this.overlay.project(this.scene.camera, this.scene.projected);
    this.overlay.clear();
    const earth = this.resolved.find((r) => r.object.id === 'earth');
    this.overlay.draw({
      selectedId: this._selectedId,
      trackedId: this._trackedId,
      hoverId: this._hoverId,
      chase: this._chase,
      time: now,
      // Fewer labels on a small screen, and fewer again when zoomed right out.
      labelBudget: this.labelBudget(),
      showLabels: this.layers.labels,
      soiLabel: this.layers.gravity
        ? (m) => `SOI ${formatDistanceInline(m.object.object.soiKm ?? 0)}`
        : null,
      gravityHint: this.layers.gravity ? this.gravityHint() : null,
      distanceLabel: (m) => {
        if (!earth) return null;
        const o = m.object.object;
        if (o.id !== this._selectedId && o.id !== this._trackedId) return null;
        // "EARTH · 0 km" is not a reading, it is a subtraction against itself.
        if (o.id === 'earth') return null;
        const km = distance(m.object.position, earth.position);
        return km > 0.005 * AU_KM ? `${(km / AU_KM).toFixed(3)} AU` : `${Math.round(km).toLocaleString('en-US')} km`;
      },
    });

    this.recordFps(now);
    if (now - this.lastTelemetry > 1000 / TELEMETRY_HZ) {
      this.lastTelemetry = now;
      this.publish();
    }
  }

  /**
   * What to say when GRAVITY is on.
   *
   * Turning on a layer and seeing nothing change is the worst outcome — it reads as a
   * broken toggle. Spheres of influence are only legible across a narrow band of zoom, so
   * outside it the layer says what it is showing and which way to go.
   */
  private gravityHint(): string | null {
    const drawable = this.resolved.filter((r) => {
      const soi = r.object.soiKm;
      if (!soi || r.unplaced) return false;
      const ratio = soi / this.rig.distance;
      return ratio >= 0.05 && ratio <= 8;
    });
    if (drawable.length > 0) {
      return 'GRAVITY — dashed rings are spheres of influence: r = a·(m/M)^⅖';
    }
    const anyCloser = this.resolved.some(
      (r) => r.object.soiKm && !r.unplaced && r.object.soiKm / this.rig.distance > 8,
    );
    return anyCloser
      ? 'GRAVITY — no sphere of influence fits this view. Zoom out.'
      : 'GRAVITY — spheres of influence are too small to draw here. Zoom in on a planet.';
  }

  private labelBudget(): number {
    const w = this.container.clientWidth;
    const base = w < 480 ? 7 : w < 900 ? 11 : 16;
    return this.rig.distance > 60 * AU_KM ? Math.max(4, base - 3) : base;
  }

  private recordFps(now: number): void {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 0 && now - this.frameTimes[0]! > 1000) this.frameTimes.shift();
  }

  /** Particle positions are shared between frames when time has not moved far. */
  private cloudPositionsFor(cloud: ParticleCloud, jd: number): Float32Array {
    const cached = this.cloudCache.get(cloud.id);
    // A belt asteroid moves ~0.002 AU in a day; refreshing every 0.4 days is invisible
    // while cutting the per-frame Kepler solves from thousands to zero most frames.
    if (cached && Math.abs(cached.jd - jd) < 0.4) return cached.data;

    const data = cached?.data ?? new Float32Array(cloud.elements.length * 3);
    cloudPositions(cloud, jd, data, 1);
    this.cloudCache.set(cloud.id, { jd, data });
    return data;
  }

  /**
   * The trajectory trail.
   *
   * Sampled from the ephemeris backwards in time rather than accumulated from past frames.
   * Accumulating breaks the moment you scrub, jump or reverse time — the trail would be a
   * record of where the camera has been, not where the object has.
   */
  private trailFor(obj: SpaceObject, jd: number): Vec3[] {
    const eph = obj.ephemeris;
    let spanDays: number;

    if (eph.kind === 'elements') {
      const p = periodDays(eph.elements);
      spanDays = p ? p * 0.55 : 900;
    } else if (eph.kind === 'luna') {
      spanDays = 27.3 * 0.6;
    } else if (eph.kind === 'planet') {
      spanDays = 200;
    } else if (eph.kind === 'tle') {
      spanDays = (eph.satellite.periodMinutes / 1440) * 0.9;
    } else if (eph.kind === 'radiant') {
      spanDays = 365.25 * 12;
    } else {
      spanDays = 180;
    }

    const steps = 180;
    const out: Vec3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = jd - spanDays * (1 - i / steps);
      out.push(this.world.resolve(obj, t).position);
    }
    // resolveAll caches per instant; restore the cache to the frame's time.
    this.world.resolveAll(jd);

    // Trim the tail to a few view widths. A full half-orbit of trail is right when the
    // orbit is on screen and useless when it is not — zoomed in on the Moon it becomes a
    // single straight line running off the edge, which reads as a bug rather than a path.
    // Measured against what is on screen, not against the camera distance, so the trail
    // always occupies a sensible fraction of the view at any zoom.
    const reach = this.rig.visibleRadiusKm * 2.5;
    const head = out[out.length - 1]!;
    let first = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      if (distance(out[i]!, head) > reach) {
        first = i + 1;
        break;
      }
    }
    return first > 0 ? out.slice(first) : out;
  }

  // -------------------------------------------------------------------------
  // Telemetry
  // -------------------------------------------------------------------------

  private publish(): void {
    const t = this.telemetry();
    for (const fn of this.listeners) fn(t);
  }

  telemetry(): Telemetry {
    const jd = this.clock.jd;
    const selected = this._selectedId ? this.readout(this._selectedId) : null;

    return {
      jd,
      offsetDays: this.clock.offsetDays,
      live: this.clock.live,
      rate: this.clock.rate,
      band: scaleBand(this.rig.distance),
      cameraDistanceKm: this.rig.distance,
      spanKm: this.rig.spanKm,
      selected,
      trackedId: this._trackedId,
      chase: this._chase,
      fps: this.frameTimes.length,
      visibleCount: this.overlay.markers.filter((m) => m.visible).length,
      totalCount: this.resolved.length,
      neighbours: this.neighbours(this._trackedId ?? this._selectedId),
      layers: { ...this.layers },
      dataNotice: this._dataNotice,
    };
  }

  /** Full readout for one object at the current instant. */
  readout(id: string): ObjectReadout | null {
    const obj = this.world.get(id);
    if (!obj) return null;
    const jd = this.clock.jd;
    const r = this.world.resolve(obj, jd);

    const earth = this.world.get('earth');
    const earthPos = earth ? this.world.state('earth', jd).position : ([0, 0, 0] as Vec3);
    const distEarth = distance(r.position, earthPos);
    const distSun = length(r.position);

    const parent = obj.parent ? this.world.get(obj.parent) : null;
    const localSpeed = length(sub(r.velocity, obj.parent ? this.world.state(obj.parent, jd).velocity : [0, 0, 0]));

    let orbitalPeriod: number | null = null;
    let apo: number | null = null;
    let peri: number | null = null;
    let ecc: number | null = null;
    let inc: number | null = null;

    if (obj.ephemeris.kind === 'elements' || obj.ephemeris.kind === 'elements-unphased') {
      const el = obj.ephemeris.elements;
      orbitalPeriod = periodDays(el);
      ecc = el.e;
      inc = (el.i * 180) / Math.PI;
      peri = el.a * (1 - el.e);
      apo = el.e < 1 ? el.a * (1 + el.e) : null;
    } else if (obj.ephemeris.kind === 'tle') {
      orbitalPeriod = obj.ephemeris.satellite.periodMinutes / 1440;
      ecc = obj.ephemeris.satellite.eccentricity;
      inc = (obj.ephemeris.satellite.inclination * 180) / Math.PI;
    } else if (obj.ephemeris.kind === 'planet') {
      const days: Record<string, number> = {
        mercury: 87.969, venus: 224.701, earth: 365.256, mars: 686.98,
        jupiter: 4332.59, saturn: 10759.22, uranus: 30688.5, neptune: 60182, pluto: 90560,
      };
      orbitalPeriod = days[obj.ephemeris.planet] ?? null;
    } else if (obj.ephemeris.kind === 'luna') {
      orbitalPeriod = 27.321661;
    }

    // Altitude means something only for a body orbiting a solid surface.
    // Altitude is only meaningful for something orbiting close to a surface. "Altitude
    // over Sun: 172 AU" for Voyager is technically a subtraction and completely useless.
    let altitude: number | null = null;
    if (
      parent?.radiusKm &&
      obj.parent !== 'sun' &&
      (obj.kind === 'satellite' || obj.kind === 'moon' || obj.kind === 'spacecraft')
    ) {
      const local = length(r.local);
      if (local < parent.radiusKm * 400) altitude = local - parent.radiusKm;
    }

    return {
      id: obj.id,
      name: obj.name,
      ...(obj.subtitle ? { subtitle: obj.subtitle } : {}),
      kind: obj.kind,
      ...(obj.status ? { status: obj.status } : {}),
      color: obj.color,
      provenance: obj.provenance,
      facts: obj.facts ?? [],
      parentName: parent?.name ?? (obj.id === 'sun' ? null : 'SUN'),
      distanceFromEarthKm: distEarth,
      distanceFromSunKm: distSun,
      speedKmS: length(r.velocity),
      localSpeedKmS: localSpeed,
      signalDelaySec: distEarth / C_KM_S,
      orbitalPeriodDays: orbitalPeriod,
      altitudeKm: altitude,
      apoapsisKm: apo,
      periapsisKm: peri,
      eccentricity: ecc,
      inclinationDeg: inc,
      unplaced: r.unplaced,
      phaseUnknown: obj.phaseUnknown === true,
      soiKm: obj.soiKm ?? null,
    };
  }

  private neighbours(id: string | null): Telemetry['neighbours'] {
    if (!id) return [];
    const self = this.resolved.find((r) => r.object.id === id);
    if (!self || self.unplaced) return [];
    return this.resolved
      .filter((r) => r.object.id !== id && !r.unplaced && r.object.kind !== 'satellite')
      .map((r) => ({
        id: r.object.id,
        name: r.object.name,
        km: distance(r.position, self.position),
        color: r.object.color,
      }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 5);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  get selectedId(): string | null {
    return this._selectedId;
  }

  select(id: string | null): void {
    this._selectedId = id;
    this.onSelectCb?.(id ? (this.world.get(id) ?? null) : null);
    this.publish();
  }

  /**
   * Tell the renderer how much of the viewport is hidden behind UI, so the camera can
   * offset its projection and put the focused object where it can actually be seen.
   */
  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
    // The vertical rail of zoom/layer buttons sits on the right on every viewport.
    this.overlayInsets = { top, bottom, right: 58 };
  }

  /**
   * A sensible viewing distance for an object: framed, not buried.
   *
   * Expressed as the radius to fit rather than a raw distance, so the answer adapts to a
   * tall phone, a wide desktop window, and every panel state in between.
   */
  frameDistance(obj: SpaceObject): number {
    const fitRadius =
      obj.radiusKm && obj.radiusKm > 1
        ? obj.radiusKm * 2.6
        : obj.kind === 'satellite'
          ? 900
          : obj.kind === 'spacecraft'
            ? 90_000
            : 320_000;
    return this.rig.distanceToFit(fitRadius);
  }

  flyTo(id: string, opts: { distanceKm?: number; track?: boolean } = {}): void {
    const obj = this.world.get(id);
    if (!obj) return;

    // Flying somewhere else releases an existing lock. Without this the rig keeps pulling
    // the focus back to the tracked object every frame while the panel claims you are
    // looking at the new one — the camera and the readout disagree, and the camera wins.
    if (this._trackedId && this._trackedId !== id && !opts.track) {
      this._trackedId = null;
      this._chase = false;
      this.rig.setFocusResponsiveness(0.18);
    }

    const r = this.world.resolve(obj, this.clock.jd);

    if (r.unplaced) {
      // Still useful: frame the orbit even when the body itself cannot be placed.
      const eph = obj.ephemeris;
      const a = eph.kind === 'elements-unphased' ? Math.abs(eph.elements.a) : 2 * AU_KM;
      this.rig.flyTo({ focus: [0, 0, 0], distanceKm: a * 2.6 });
      this.select(id);
      return;
    }

    this.rig.flyTo({
      focus: r.position,
      distanceKm: opts.distanceKm ?? this.frameDistance(obj),
      elevation: 0.42,
    });
    this.select(id);
    if (opts.track) this.setTracked(id);
  }

  setTracked(id: string | null): void {
    this._trackedId = id;
    if (!id) {
      this._chase = false;
      this.rig.setFocusResponsiveness(0.18);
      this.publish();
      return;
    }
    const obj = this.world.get(id);
    if (!obj) return;
    this.rig.setFocusResponsiveness(0.32);
    const r = this.world.resolve(obj, this.clock.jd);
    if (!r.unplaced) {
      this.rig.flyTo({ focus: r.position, distanceKm: this.rig.distance });
    }
    this.publish();
  }

  /**
   * Chase mode: lock on and drop right down next to the object, close enough that its
   * neighbours and its own motion become the frame of reference.
   */
  setChase(on: boolean): void {
    this._chase = on;
    if (!on) {
      this.rig.setFocusResponsiveness(0.18);
      this.publish();
      return;
    }
    const id = this._trackedId ?? this._selectedId;
    if (!id) {
      this._chase = false;
      return;
    }
    this._trackedId = id;
    const obj = this.world.get(id);
    if (!obj) return;
    const r = this.world.resolve(obj, this.clock.jd);
    this.rig.setFocusResponsiveness(0.85);
    this.rig.flyTo({
      focus: r.unplaced ? this.rig.focus : r.position,
      distanceKm: this.frameDistance(obj) * 0.42,
      elevation: 0.12,
      durationMs: 1500,
    });
    this.publish();
  }

  setLayer<K extends keyof Layers>(key: K, value: boolean): void {
    this.layers[key] = value;
    this.publish();
  }

  setOverlays(overlays: SandboxOverlay[]): void {
    this._overlays = overlays;
  }

  setDataNotice(notice: string | null): void {
    this._dataNotice = notice;
    this.publish();
  }

  addObjects(objects: SpaceObject[]): void {
    this.world.add(objects);
  }

  removeObjects(predicate: (o: SpaceObject) => boolean): void {
    this.world.remove(predicate);
  }

  /** Current camera-relative info the HUD scale bar needs. */
  get viewDistanceKm(): number {
    return this.rig.distance;
  }

  zoom(factor: number): void {
    this.rig.cancelTransition();
    this.rig.zoomBy(factor);
  }

  resetView(): void {
    this.setTracked(null);
    this._chase = false;
    this.rig.flyTo({
      focus: [0, 0, 0],
      distanceKm: this.rig.distanceToFit(1.75 * AU_KM),
      elevation: 0.55,
      azimuth: 0.6,
    });
  }

  /** Frame the Earth with its satellite belt visible around it. */
  goHome(): void {
    this.flyTo('earth', { distanceKm: this.rig.distanceToFit(RADIUS.earth * 3.4) });
  }

  goLive(): void {
    this.clock.goLive();
    this.publish();
  }

  /**
   * Set a time rate matched to the selected object, so one orbit takes about twenty
   * seconds of real time.
   *
   * A fixed "1 hour per second" is useless for Jupiter and absurd for the ISS. Deriving
   * the rate from the object's own period means TIME TRAVEL always does the interesting
   * thing: tap it on Jupiter and watch a twelve-year orbit close; tap it on the ISS and
   * watch it go round.
   */
  timeTravelForSelection(): { rate: number; description: string } | null {
    const id = this._selectedId;
    const obj = id ? this.world.get(id) : null;
    if (!obj) return null;

    const readout = id ? this.readout(id) : null;
    const periodDaysValue = readout?.orbitalPeriodDays ?? null;

    if (!periodDaysValue || periodDaysValue <= 0) {
      // No closed orbit — an escaping probe or an unbound body. A year per second makes
      // its motion visible without pretending it is periodic.
      this.clock.setRate(31_557_600);
      this.layers.trajectory = true;
      this.publish();
      return { rate: 31_557_600, description: '1 year per second — this orbit never closes' };
    }

    const rate = (periodDaysValue * 86_400) / 20;
    this.clock.setRate(rate);
    this.layers.trajectory = true;
    this.publish();
    return {
      rate,
      description: `one orbit of ${obj.name} every ~20 seconds`,
    };
  }

  get nowJd(): number {
    return nowJd();
  }
}
