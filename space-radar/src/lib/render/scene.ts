import * as THREE from 'three';
import { AU_KM, RADIUS } from '../astro/constants';
import { periodDays, sampleOrbit, type Elements } from '../astro/kepler';
import { SPIN } from '../astro/planets';
import type { Vec3 } from '../astro/vec';
import type { ParticleCloud } from '../data/populations';
import type { ResolvedObject } from '../data/types';
import { brightStarDirections, generateBackdrop, magnitudeToBrightness } from './stars';

/**
 * The WebGL half of the display.
 *
 * Draws the things that need depth and perspective: globes, orbit tracks, particle
 * populations, the sky. Everything with text on it — markers, labels, brackets, readouts —
 * is drawn by the 2D overlay instead, where it stays crisp and can be styled like an
 * instrument rather than like a game.
 *
 * FOCUS-RELATIVE RENDERING
 *   Scene coordinates are (world_km − focus_km) × renderScale, with renderScale chosen so
 *   the camera sits one unit from the origin. Float32 precision therefore always lands
 *   where the user is looking. Combined with a logarithmic depth buffer, a 400 AU view and
 *   a 400 m view use the same code path.
 */

/** Anything beyond this many scene units is off the table — cull rather than draw. */
const FAR_CULL = 6e4;
/** A globe is only worth meshing above this apparent size, in radians of view angle. */
const MIN_MESH_ANGLE = 0.0016;

/** What `sync` hands to the overlay: a scene-space position and an on-screen size. */
export interface ProjectedItem {
  object: ResolvedObject;
  scene: THREE.Vector3;
  /** True when a globe was actually meshed for this object. */
  meshed: boolean;
  /** The globe's radius in scene units — zero when only a marker is drawn. */
  radiusScene: number;
  /** Sphere-of-influence radius in scene units, zero when the body has none. */
  soiScene: number;
}

export interface Layers {
  orbits: boolean;
  labels: boolean;
  belts: boolean;
  satellites: boolean;
  gravity: boolean;
  grid: boolean;
  stars: boolean;
  trajectory: boolean;
}

export interface FrameInput {
  jd: number;
  /**
   * Pixels of the viewport covered by UI at the top and bottom.
   *
   * The panels on a phone can cover more than half the screen, which would otherwise put
   * the object you just flew to directly behind them. The camera's projection is offset so
   * the focus lands in the middle of what is actually visible.
   */
  insetTop: number;
  insetBottom: number;
  viewportHeight: number;
  focus: Vec3;
  renderScale: number;
  cameraDistanceKm: number;
  eye: Vec3;
  resolved: ResolvedObject[];
  clouds: ParticleCloud[];
  cloudPositionsFor: (cloud: ParticleCloud, jd: number) => Float32Array;
  selectedId: string | null;
  trackedId: string | null;
  layers: Layers;
  /** Extra polylines to draw, already in heliocentric km. Used by the sandbox. */
  overlays: { id: string; points: Vec3[]; color: string; dashed?: boolean }[];
  /** Recent positions of the tracked object, heliocentric km. */
  trail: Vec3[];
}

interface OrbitEntry {
  line: THREE.Line;
  /** Vertices in parent-relative km. */
  source: Float32Array;
  signature: string;
  parentId: string | null;
}

const SPHERE = new THREE.SphereGeometry(1, 32, 24);
const SPHERE_LOW = new THREE.SphereGeometry(1, 14, 10);

/**
 * A latitude/longitude cage, built once and shared.
 *
 * This app ships no surface imagery — partly for weight, mostly because a texture would
 * be decoration rather than data. A graticule does the job imagery would have done: it
 * makes the body's rotation and its axial tilt visible, and it is honest about being a
 * coordinate grid rather than a photograph.
 */
const GRATICULE = (() => {
  const pts: number[] = [];
  const seg = 48;
  for (let lat = -60; lat <= 60; lat += 30) {
    const r = Math.cos((lat * Math.PI) / 180);
    const z = Math.sin((lat * Math.PI) / 180);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2;
      const a1 = ((k + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z);
    }
  }
  for (let lon = 0; lon < 180; lon += 30) {
    const a = (lon * Math.PI) / 180;
    for (let k = 0; k < seg; k++) {
      const t0 = (k / seg) * Math.PI - Math.PI / 2;
      const t1 = ((k + 1) / seg) * Math.PI - Math.PI / 2;
      pts.push(
        Math.cos(t0) * Math.cos(a), Math.cos(t0) * Math.sin(a), Math.sin(t0),
        Math.cos(t1) * Math.cos(a), Math.cos(t1) * Math.sin(a), Math.sin(t1),
      );
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  return g;
})();

export class SpaceScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly bodyGroup = new THREE.Group();
  private readonly orbitGroup = new THREE.Group();
  private readonly cloudGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly gravityGroup = new THREE.Group();

  private readonly meshPool: THREE.Mesh[] = [];
  private readonly cagePool: THREE.LineSegments[] = [];
  private readonly orbits = new Map<string, OrbitEntry>();
  private readonly cloudPoints = new Map<string, THREE.Points>();
  private readonly overlayLines = new Map<string, THREE.Line>();

  private backdrop!: THREE.Points;
  private brightStars!: THREE.Points;
  private grid!: THREE.Group;
  private sunGlow!: THREE.Sprite;
  private trailLine!: THREE.Line;

  /** Screen-space positions computed during sync, consumed by the overlay. */
  readonly projected: ProjectedItem[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setClearColor(0x05070a, 1);

    this.camera = new THREE.PerspectiveCamera(48, 1, 1e-6, 1e6);
    this.scene.add(this.bodyGroup, this.orbitGroup, this.cloudGroup, this.overlayGroup, this.gravityGroup);

    this.buildSky();
    this.buildGrid();
    this.buildSunGlow();
    this.buildTrail();

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.14));
    const sunLight = new THREE.PointLight(0xfff0d8, 2.6, 0, 0);
    sunLight.name = 'sunlight';
    this.scene.add(sunLight);
  }

  // -------------------------------------------------------------------------
  // Static furniture
  // -------------------------------------------------------------------------

  private buildSky(): void {
    const backdropPositions = generateBackdrop(3600);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(backdropPositions, 3));
    const sizes = new Float32Array(backdropPositions.length / 3);
    for (let i = 0; i < sizes.length; i++) sizes[i] = 0.7 + Math.random() * 1.5;
    g.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.backdrop = new THREE.Points(g, skyMaterial(0x9fb4c7, 0.62));
    this.backdrop.frustumCulled = false;
    this.backdrop.renderOrder = -10;
    this.scene.add(this.backdrop);

    const stars = brightStarDirections();
    const bg = new THREE.BufferGeometry();
    const bp = new Float32Array(stars.length * 3);
    const bs = new Float32Array(stars.length);
    stars.forEach(({ star, dir }, i) => {
      bp[i * 3] = dir[0];
      bp[i * 3 + 1] = dir[1];
      bp[i * 3 + 2] = dir[2];
      bs[i] = 1.6 + magnitudeToBrightness(star.mag) * 5;
    });
    bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    bg.setAttribute('aSize', new THREE.BufferAttribute(bs, 1));
    this.brightStars = new THREE.Points(bg, skyMaterial(0xdfe7ef, 0.95));
    this.brightStars.frustumCulled = false;
    this.brightStars.renderOrder = -9;
    this.scene.add(this.brightStars);
  }

  /** Concentric ecliptic-plane rings at 1, 5, 10, 30 and 100 AU, plus radial spokes. */
  private buildGrid(): void {
    this.grid = new THREE.Group();
    const radiiAu = [0.4, 1, 2, 5, 10, 20, 30, 50, 100, 200];
    for (const au of radiiAu) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 180; k++) {
        const a = (k / 180) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * au * AU_KM, Math.sin(a) * au * AU_KM, 0));
      }
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(
        geom,
        // Kept deliberately dimmer than any orbit track: concentric ellipses that read
        // as bright as a real orbit are actively misleading.
        new THREE.LineBasicMaterial({ color: 0x18242e, transparent: true, opacity: 0.42, depthWrite: false }),
      );
      line.userData.au = au;
      this.grid.add(line);
    }
    // Bearing ticks rather than full spokes. Radial lines running the whole width of the
    // view read as trajectories and clutter every zoom level; short marks between two
    // rings give the same orientation cue and stay out of the way.
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const [r0, r1] of [[0.9, 1.1], [9, 11], [95, 105]] as const) {
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(Math.cos(a) * r0 * AU_KM, Math.sin(a) * r0 * AU_KM, 0),
          new THREE.Vector3(Math.cos(a) * r1 * AU_KM, Math.sin(a) * r1 * AU_KM, 0),
        ]);
        const tick = new THREE.Line(
          geom,
          new THREE.LineBasicMaterial({ color: 0x223140, transparent: true, opacity: 0.5, depthWrite: false }),
        );
        tick.userData.au = r1;
        this.grid.add(tick);
      }
    }
    this.scene.add(this.grid);
  }

  private buildSunGlow(): void {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,236,190,0.95)');
    grad.addColorStop(0.18, 'rgba(255,205,120,0.45)');
    grad.addColorStop(0.5, 'rgba(255,170,70,0.10)');
    grad.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.sunGlow.renderOrder = -1;
    this.scene.add(this.sunGlow);
  }

  private buildTrail(): void {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 600), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(3 * 600), 3));
    this.trailLine = new THREE.Line(
      geom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.trailLine.frustumCulled = false;
    this.scene.add(this.trailLine);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  private viewWidth = 1;
  private viewHeight = 1;

  resize(width: number, height: number, dpr: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const mats = [this.backdrop.material, this.brightStars.material] as THREE.ShaderMaterial[];
    for (const m of mats) m.uniforms.uPixelRatio!.value = dpr;
  }

  sync(f: FrameInput): void {
    const s = f.renderScale;

    // Camera one unit out, looking at the origin.
    this.camera.position.set(f.eye[0], f.eye[1], f.eye[2]);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);
    // Near/far track the view so the log depth buffer has something sane to work with.
    this.camera.near = 1e-5;
    this.camera.far = FAR_CULL * 2;

    // Shift the projection so the focus sits in the centre of the *visible* band rather
    // than the centre of the canvas. `setViewOffset` renders a window into a larger
    // virtual image; moving that window up moves the content down, and vice versa.
    //
    // NOTE: setViewOffset also assigns `camera.aspect = fullWidth / fullHeight`, so the
    // full size passed here must be the real viewport. Passing a placeholder width
    // silently collapses the horizontal field of view and flattens every orbit.
    const w = this.viewWidth;
    const h = this.viewHeight;
    const usable = h - f.insetTop - f.insetBottom;
    if (h > 0 && usable > 80 && (f.insetTop > 0 || f.insetBottom > 0)) {
      const visibleCentre = (f.insetTop + (h - f.insetBottom)) / 2;
      const shift = visibleCentre - h / 2;
      this.camera.setViewOffset(w, h, 0, -shift, w, h);
    } else {
      this.camera.clearViewOffset();
      this.camera.aspect = w / h;
    }
    this.camera.updateProjectionMatrix();

    // The sky sits at the camera, so it never parallaxes.
    const skyRadius = FAR_CULL * 0.4;
    for (const sky of [this.backdrop, this.brightStars]) {
      sky.position.copy(this.camera.position);
      sky.scale.setScalar(skyRadius);
      sky.visible = f.layers.stars;
    }

    // Sun light and glow at the Sun's scene position.
    const sunScene = this.toScene(f.focus, [0, 0, 0], s);
    const light = this.scene.getObjectByName('sunlight') as THREE.PointLight;
    light.position.copy(sunScene);
    const sunAngular = RADIUS.sun / Math.max(1, f.cameraDistanceKm);
    this.sunGlow.position.copy(sunScene);
    this.sunGlow.scale.setScalar(Math.max(RADIUS.sun * s * 5.5, 0.03));
    this.sunGlow.visible = sunScene.length() < FAR_CULL && sunAngular < 0.9;

    this.grid.visible = f.layers.grid;
    if (f.layers.grid) {
      this.grid.position.copy(this.toScene(f.focus, [0, 0, 0], s));
      this.grid.scale.setScalar(s);
      // Hide rings that are either a speck or wildly bigger than the view.
      for (const child of this.grid.children) {
        const au = (child.userData.au as number | undefined) ?? 0;
        if (!au) continue;
        const ratio = (au * AU_KM) / f.cameraDistanceKm;
        child.visible = ratio > 0.06 && ratio < 260;
      }
    }

    this.syncBodies(f, s);
    this.syncOrbits(f, s);
    this.syncClouds(f, s);
    this.syncOverlays(f, s);
    this.syncGravity(f, s);
    this.syncTrail(f, s);
  }

  private toScene(focus: Vec3, world: Vec3, s: number): THREE.Vector3 {
    return new THREE.Vector3(
      (world[0] - focus[0]) * s,
      (world[1] - focus[1]) * s,
      (world[2] - focus[2]) * s,
    );
  }

  private syncBodies(f: FrameInput, s: number): void {
    this.projected.length = 0;
    let meshIndex = 0;
    let cageIndex = 0;

    for (const r of f.resolved) {
      if (r.unplaced) continue;
      const o = r.object;
      if (o.kind === 'satellite' && !f.layers.satellites) continue;

      const p = this.toScene(f.focus, r.position, s);
      const dist = p.distanceTo(this.camera.position);
      if (dist > FAR_CULL) continue;

      // Apparent angular size decides whether this gets a globe or just a marker.
      const radiusKm = o.radiusKm ?? 0;
      const angular = radiusKm / Math.max(1e-6, dist / s);
      const meshed = radiusKm > 0 && angular > MIN_MESH_ANGLE;

      if (meshed) {
        const mesh = this.acquireMesh(meshIndex++);
        mesh.visible = true;
        mesh.position.copy(p);
        mesh.scale.setScalar(Math.max(radiusKm * s, 1e-9));

        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(o.color);
        if (o.id === 'sun') {
          mat.emissive.set(o.color);
          mat.emissiveIntensity = 1.5;
        } else {
          mat.emissive.set(o.color);
          mat.emissiveIntensity = 0.06;
        }
        // Swap to the cheap sphere when the globe is small on screen.
        const wantLow = angular < 0.02;
        if ((mesh.geometry === SPHERE_LOW) !== wantLow) mesh.geometry = wantLow ? SPHERE_LOW : SPHERE;

        // Axial tilt and rotation, where we know them.
        const spin = SPIN[o.id as keyof typeof SPIN];
        if (spin) {
          const rot = ((f.jd * 24) / spin.periodHours) * Math.PI * 2;
          mesh.rotation.set((spin.tiltDeg * Math.PI) / 180, 0, rot, 'ZXY');
        }

        // Only the handful of bodies big enough on screen get a graticule; below that it
        // collapses into a smear and costs draw calls for nothing.
        if (angular > 0.045 && o.id !== 'sun' && cageIndex < 4) {
          const cage = this.acquireCage(cageIndex++);
          cage.visible = true;
          cage.position.copy(p);
          cage.scale.setScalar(radiusKm * s * 1.002);
          cage.rotation.copy(mesh.rotation);
          (cage.material as THREE.LineBasicMaterial).opacity = Math.min(0.3, (angular - 0.045) * 4);
        }
      }

      this.projected.push({
        object: r,
        scene: p,
        meshed,
        radiusScene: radiusKm * s,
        soiScene: (o.soiKm ?? 0) * s,
      });
    }

    for (let i = meshIndex; i < this.meshPool.length; i++) this.meshPool[i]!.visible = false;
    for (let i = cageIndex; i < this.cagePool.length; i++) this.cagePool[i]!.visible = false;
  }

  private acquireCage(index: number): THREE.LineSegments {
    let cage = this.cagePool[index];
    if (!cage) {
      cage = new THREE.LineSegments(
        GRATICULE,
        new THREE.LineBasicMaterial({ color: 0xdfe7ef, transparent: true, opacity: 0.2, depthWrite: false }),
      );
      cage.frustumCulled = false;
      this.cagePool[index] = cage;
      this.bodyGroup.add(cage);
    }
    return cage;
  }

  private acquireMesh(index: number): THREE.Mesh {
    let mesh = this.meshPool[index];
    if (!mesh) {
      mesh = new THREE.Mesh(
        SPHERE,
        new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 }),
      );
      mesh.frustumCulled = false;
      this.meshPool[index] = mesh;
      this.bodyGroup.add(mesh);
    }
    return mesh;
  }

  /**
   * Orbit tracks.
   *
   * Geometry is built once per object in parent-relative kilometres and cached under a
   * signature of its elements, then repositioned and rescaled each frame. Rebuilding a
   * 256-segment polyline for forty objects every frame would cost more than everything
   * else in this file put together.
   */
  private syncOrbits(f: FrameInput, s: number): void {
    const wanted = new Set<string>();
    if (!f.layers.orbits) {
      for (const e of this.orbits.values()) e.line.visible = false;
      return;
    }

    for (const r of f.resolved) {
      const o = r.object;
      const eph = o.ephemeris;
      if (eph.kind !== 'elements' && eph.kind !== 'elements-unphased') continue;
      if (o.kind === 'satellite' && !f.layers.satellites) continue;

      const el = eph.elements;
      const parentPos = parentPosition(f, o.parent);
      if (!parentPos) continue;

      // Skip orbits that are either a dot or far larger than the screen. An orbit many
      // times wider than the view contributes one stray line crossing everything, so it
      // fades out well before the hard cut.
      const scaleKm = Math.abs(el.a) * (1 + el.e);
      const ratio = scaleKm / f.cameraDistanceKm;
      if (ratio < 0.02 || ratio > 90) continue;
      const overscaleFade = ratio > 4 ? Math.max(0.12, 1 - (ratio - 4) / 18) : 1;

      const selected = o.id === f.selectedId || o.id === f.trackedId;
      const entry = this.ensureOrbit(o.id, el, f.jd, o.color, o.parent);
      const count = entry.source.length / 3;
      const pos = entry.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;

      // Parent-relative km -> scene units, done on the CPU because the offset changes
      // every frame and a per-object matrix cannot express both offset and scale here.
      const ox = (parentPos[0] - f.focus[0]) * s;
      const oy = (parentPos[1] - f.focus[1]) * s;
      const oz = (parentPos[2] - f.focus[2]) * s;
      for (let i = 0; i < count; i++) {
        arr[i * 3] = entry.source[i * 3]! * s + ox;
        arr[i * 3 + 1] = entry.source[i * 3 + 1]! * s + oy;
        arr[i * 3 + 2] = entry.source[i * 3 + 2]! * s + oz;
      }
      pos.needsUpdate = true;
      entry.line.geometry.computeBoundingSphere();

      const mat = entry.line.material as THREE.LineBasicMaterial;
      mat.color.set(o.color);
      mat.opacity = selected ? 0.85 : o.phaseUnknown ? 0.3 : 0.26;
      entry.line.visible = true;
      wanted.add(o.id);
    }

    for (const [id, e] of this.orbits) if (!wanted.has(id)) e.line.visible = false;
  }

  private ensureOrbit(
    id: string,
    el: Elements,
    jd: number,
    color: string,
    parentId: string | null,
  ): OrbitEntry {
    // Open orbits are re-sampled as time moves because the drawn arc follows the object.
    const open = el.e >= 1;
    const signature = `${el.a.toFixed(3)}|${el.e.toFixed(6)}|${el.i.toFixed(6)}|${el.om.toFixed(6)}|${el.w.toFixed(6)}|${open ? Math.round(jd / 30) : 0}`;

    const existing = this.orbits.get(id);
    if (existing && existing.signature === signature) return existing;

    const segments = open ? 160 : 256;
    const pts = sampleOrbit(el, segments, jd);
    const source = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => {
      source[i * 3] = p[0];
      source[i * 3 + 1] = p[1];
      source[i * 3 + 2] = p[2];
    });

    let entry = existing;
    if (!entry || entry.source.length !== source.length) {
      entry?.line.geometry.dispose();
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(source.length), 3));
      const line = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false }),
      );
      line.frustumCulled = false;
      if (entry) this.orbitGroup.remove(entry.line);
      this.orbitGroup.add(line);
      entry = { line, source, signature, parentId };
    } else {
      entry.source = source;
      entry.signature = signature;
    }
    this.orbits.set(id, entry);
    return entry;
  }

  private syncClouds(f: FrameInput, s: number): void {
    for (const cloud of f.clouds) {
      let pts = this.cloudPoints.get(cloud.id);
      if (!pts) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cloud.elements.length * 3), 3));
        const sizes = new Float32Array(cloud.elements.length).fill(cloud.pointSize);
        geom.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
        pts = new THREE.Points(geom, skyMaterial(new THREE.Color(cloud.color).getHex(), 0.75));
        pts.frustumCulled = false;
        this.cloudGroup.add(pts);
        this.cloudPoints.set(cloud.id, pts);
      }

      if (!f.layers.belts) {
        pts.visible = false;
        continue;
      }

      const source = f.cloudPositionsFor(cloud, f.jd);
      const attr = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = (source[i]! - f.focus[0]) * s;
        arr[i + 1] = (source[i + 1]! - f.focus[1]) * s;
        arr[i + 2] = (source[i + 2]! - f.focus[2]) * s;
      }
      attr.needsUpdate = true;
      pts.visible = true;
    }
  }

  private syncOverlays(f: FrameInput, s: number): void {
    const wanted = new Set<string>();
    for (const ov of f.overlays) {
      wanted.add(ov.id);
      let line = this.overlayLines.get(ov.id);
      if (!line || line.geometry.getAttribute('position').count !== ov.points.length) {
        line?.geometry.dispose();
        if (line) this.overlayGroup.remove(line);
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ov.points.length * 3), 3));
        const mat = ov.dashed
          ? new THREE.LineDashedMaterial({ color: ov.color, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.9, depthWrite: false })
          : new THREE.LineBasicMaterial({ color: ov.color, transparent: true, opacity: 0.9, depthWrite: false });
        line = new THREE.Line(geom, mat);
        line.frustumCulled = false;
        this.overlayGroup.add(line);
        this.overlayLines.set(ov.id, line);
      }

      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      ov.points.forEach((p, i) => {
        arr[i * 3] = (p[0] - f.focus[0]) * s;
        arr[i * 3 + 1] = (p[1] - f.focus[1]) * s;
        arr[i * 3 + 2] = (p[2] - f.focus[2]) * s;
      });
      attr.needsUpdate = true;
      (line.material as THREE.Material & { color?: THREE.Color }).color?.set(ov.color);
      if (ov.dashed) line.computeLineDistances();
      line.visible = true;
    }
    for (const [id, line] of this.overlayLines) {
      if (!wanted.has(id)) {
        line.visible = false;
      }
    }
  }

  /**
   * The gravity layer.
   *
   * No invented "gravity beams". What is drawn is a real, defined quantity: the sphere of
   * influence of each massive body, r_SOI = a·(m/M)^(2/5), which is the boundary where
   * that body rather than the Sun dominates a small object's motion. It is a circle
   * because the SOI is a sphere, and that is all the honest visualisation there is.
   */
  private syncGravity(f: FrameInput, s: number): void {
    this.gravityGroup.visible = f.layers.gravity;
    if (!f.layers.gravity) return;

    while (this.gravityGroup.children.length < 12) {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0x6ea0c0, dashSize: 0.05, gapSize: 0.04, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      line.computeLineDistances();
      line.frustumCulled = false;
      this.gravityGroup.add(line);
    }

    let i = 0;
    for (const r of f.resolved) {
      const soi = r.object.soiKm;
      if (!soi || i >= this.gravityGroup.children.length) continue;
      // Below a few percent of the view the ring is a dot; far above it, it is a straight
      // line across the screen. Neither says anything, so neither is drawn.
      const ratio = soi / f.cameraDistanceKm;
      const line = this.gravityGroup.children[i] as THREE.Line;
      if (ratio < 0.05 || ratio > 8) {
        line.visible = false;
        continue;
      }
      line.visible = true;
      line.position.copy(this.toScene(f.focus, r.position, s));
      line.scale.setScalar(soi * s);
      // Face the camera so a circle always reads as a sphere boundary.
      line.quaternion.copy(this.camera.quaternion);
      i++;
    }
    for (let k = i; k < this.gravityGroup.children.length; k++) {
      this.gravityGroup.children[k]!.visible = false;
    }
  }

  private syncTrail(f: FrameInput, s: number): void {
    const n = f.trail.length;
    this.trailLine.visible = f.layers.trajectory && n > 1;
    if (!this.trailLine.visible) return;

    const pos = this.trailLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.trailLine.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pArr = pos.array as Float32Array;
    const cArr = col.array as Float32Array;
    const count = Math.min(n, pos.count);

    for (let i = 0; i < count; i++) {
      const p = f.trail[n - count + i]!;
      pArr[i * 3] = (p[0] - f.focus[0]) * s;
      pArr[i * 3 + 1] = (p[1] - f.focus[1]) * s;
      pArr[i * 3 + 2] = (p[2] - f.focus[2]) * s;
      // Fade toward the oldest sample so the direction of travel is unmistakable.
      const t = i / Math.max(1, count - 1);
      cArr[i * 3] = 0.94 * t;
      cArr[i * 3 + 1] = 0.7 * t;
      cArr[i * 3 + 2] = 0.16 * t;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.trailLine.geometry.setDrawRange(0, count);
    this.trailLine.geometry.computeBoundingSphere();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
    SPHERE.dispose();
    SPHERE_LOW.dispose();
  }
}

function parentPosition(f: FrameInput, parentId: string | null): Vec3 | null {
  if (!parentId || parentId === 'sun') return [0, 0, 0];
  const hit = f.resolved.find((r) => r.object.id === parentId);
  return hit ? hit.position : null;
}

/**
 * Points material with constant pixel size.
 * three.js `PointsMaterial` attenuates with distance, which is exactly wrong here: a star
 * and a belt asteroid should stay the same size on screen no matter the zoom.
 */
function skyMaterial(color: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uPixelRatio: { value: 1 },
    },
    vertexShader: `
      attribute float aSize;
      uniform float uPixelRatio;
      varying float vSize;
      void main() {
        vSize = aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vSize;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d) * 2.0;
        float alpha = smoothstep(1.0, 0.25, r);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(uColor, alpha * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

export { periodDays };
