import { AU_KM } from '../astro/constants';
import { add, lerp, scale as vscale, sub, type Vec3 } from '../astro/vec';

/**
 * The camera rig.
 *
 * SPACE RADAR spans ten orders of magnitude — a few kilometres above a spacecraft up to
 * four hundred astronomical units. Two decisions make that survivable:
 *
 *  1. Distance is interpolated in LOG space. Easing linearly from 400 AU to 400 km spends
 *     99.9999% of the animation inside the first AU and then snaps; easing the logarithm
 *     gives a constant *perceived* rate of zoom the whole way, which is what makes a
 *     scale transition feel like flying rather than cutting.
 *
 *  2. The scene is rendered focus-relative. The rig reports a `renderScale` and the
 *     renderer places everything at (world − focus) × renderScale, so float32 precision
 *     is always spent near the thing being looked at instead of near the Sun.
 */

export const MIN_DISTANCE_KM = 0.35;
export const MAX_DISTANCE_KM = 420 * AU_KM;

const clampDistance = (d: number) => Math.min(MAX_DISTANCE_KM, Math.max(MIN_DISTANCE_KM, d));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Transition {
  fromFocus: Vec3;
  toFocus: Vec3 | null;
  fromLogDist: number;
  toLogDist: number;
  fromAz: number;
  toAz: number;
  fromEl: number;
  toEl: number;
  start: number;
  duration: number;
}

export class CameraRig {
  /** Point the camera orbits, in heliocentric km. */
  focus: Vec3 = [0, 0, 0];
  /** Where the focus is heading — set every frame while following an object. */
  private focusGoal: Vec3 = [0, 0, 0];

  distance = 3 * AU_KM;
  azimuth = 0.6;
  elevation = 0.55;

  private targetDistance = this.distance;
  private targetAzimuth = this.azimuth;
  private targetElevation = this.elevation;

  private transition: Transition | null = null;
  /** How hard the focus is pulled toward its goal: 1 snaps, lower values trail. */
  private focusLerp = 0.18;

  /** Scene units per kilometre. Keeps the camera one unit from the origin. */
  get renderScale(): number {
    return 1 / this.distance;
  }

  get inTransition(): boolean {
    return this.transition !== null;
  }

  /** Camera position in scene units, relative to the focus at the origin. */
  get eye(): Vec3 {
    const ce = Math.cos(this.elevation);
    return [Math.cos(this.azimuth) * ce, Math.sin(this.azimuth) * ce, Math.sin(this.elevation)];
  }

  /** Set the point being orbited without any animation. */
  snapFocus(p: Vec3): void {
    this.focus = p;
    this.focusGoal = p;
  }

  /** Update the followed point. The rig eases toward it so tracking never judders. */
  setFocusGoal(p: Vec3, immediate = false): void {
    this.focusGoal = p;
    if (immediate) this.focus = p;
  }

  rotateBy(dAz: number, dEl: number): void {
    this.transition = null;
    this.targetAzimuth -= dAz;
    // Stop just short of the poles: at exactly ±90° the up vector degenerates.
    const limit = Math.PI / 2 - 0.02;
    this.targetElevation = Math.min(limit, Math.max(-limit, this.targetElevation + dEl));
  }

  /** Multiplicative zoom — the only kind that behaves across this many decades. */
  zoomBy(factor: number): void {
    this.transition = null;
    this.targetDistance = clampDistance(this.targetDistance * factor);
  }

  setDistance(km: number, immediate = false): void {
    this.transition = null;
    this.targetDistance = clampDistance(km);
    if (immediate) this.distance = this.targetDistance;
  }

  /**
   * Fly to a new focus, distance and orientation.
   * `duration` scales with how many decades of zoom the move covers, so a hop from the
   * Moon to the Earth is quick and a run to Voyager 1 takes its time.
   */
  flyTo(opts: {
    focus?: Vec3 | null;
    distanceKm?: number;
    azimuth?: number;
    elevation?: number;
    durationMs?: number;
  }): void {
    const toDist = clampDistance(opts.distanceKm ?? this.targetDistance);
    const decades = Math.abs(Math.log10(toDist / this.distance));
    const spatial = opts.focus
      ? Math.log10(1 + Math.hypot(...sub(opts.focus, this.focus)) / Math.max(this.distance, 1))
      : 0;

    const duration =
      opts.durationMs ?? Math.min(3400, 900 + decades * 380 + Math.max(0, spatial) * 260);

    this.transition = {
      fromFocus: this.focus,
      toFocus: opts.focus ?? null,
      fromLogDist: Math.log(this.distance),
      toLogDist: Math.log(toDist),
      fromAz: this.azimuth,
      toAz: opts.azimuth ?? this.targetAzimuth,
      fromEl: this.elevation,
      toEl: opts.elevation ?? this.targetElevation,
      start: performance.now(),
      duration,
    };
    // Rotation is eased by the transition itself; keep the damping targets in step so the
    // rig does not fight it on the frame the transition ends.
    this.targetDistance = toDist;
    if (opts.azimuth !== undefined) this.targetAzimuth = opts.azimuth;
    if (opts.elevation !== undefined) this.targetElevation = opts.elevation;
    if (opts.focus) this.focusGoal = opts.focus;
  }

  cancelTransition(): void {
    this.transition = null;
  }

  /** Advance the rig one frame. `followPoint` overrides the focus goal while tracking. */
  update(now: number, followPoint: Vec3 | null): void {
    if (followPoint) this.focusGoal = followPoint;

    const tr = this.transition;
    if (tr) {
      const raw = Math.min(1, (now - tr.start) / tr.duration);
      const t = easeInOut(raw);

      // Log-space distance easing: the reason a 9-decade zoom reads as one continuous move.
      this.distance = clampDistance(Math.exp(tr.fromLogDist + (tr.toLogDist - tr.fromLogDist) * t));
      this.azimuth = tr.fromAz + (tr.toAz - tr.fromAz) * t;
      this.elevation = tr.fromEl + (tr.toEl - tr.fromEl) * t;

      if (tr.toFocus) {
        // Chase the goal as it moves — the target is usually an orbiting body.
        const dest = followPoint ?? tr.toFocus;
        this.focus = lerp(tr.fromFocus, dest, t);
      } else {
        this.focus = lerp(this.focus, this.focusGoal, this.focusLerp);
      }

      if (raw >= 1) {
        this.transition = null;
        this.targetAzimuth = this.azimuth;
        this.targetElevation = this.elevation;
        if (tr.toFocus) this.focus = followPoint ?? tr.toFocus;
      }
      return;
    }

    // Critically-damped-ish easing. Frame-rate independence matters on phones that drop
    // to 30 fps under load.
    const k = 0.22;
    this.distance = clampDistance(this.distance * Math.pow(this.targetDistance / this.distance, k));
    this.azimuth += (this.targetAzimuth - this.azimuth) * k;
    this.elevation += (this.targetElevation - this.elevation) * k;
    this.focus = lerp(this.focus, this.focusGoal, this.focusLerp);
  }

  /** Pan the focus sideways in screen space, in scene units. */
  panBy(dxUnits: number, dyUnits: number): void {
    this.transition = null;
    const eye = this.eye;
    // Right = eye × up, with up = +z; then the screen-up vector in world terms.
    const right: Vec3 = [-eye[1], eye[0], 0];
    const rl = Math.hypot(right[0], right[1]) || 1;
    const r: Vec3 = [right[0] / rl, right[1] / rl, 0];
    const up: Vec3 = [
      eye[1] * r[2] - eye[2] * r[1],
      eye[2] * r[0] - eye[0] * r[2],
      eye[0] * r[1] - eye[1] * r[0],
    ];
    const km = this.distance;
    const delta = add(vscale(r, -dxUnits * km), vscale(up, dyUnits * km));
    this.focusGoal = add(this.focusGoal, delta);
    this.focus = add(this.focus, delta);
  }

  /** How tightly the focus tracks its goal. Chase mode pulls harder. */
  setFocusResponsiveness(v: number): void {
    this.focusLerp = Math.min(1, Math.max(0.02, v));
  }

  /**
   * Viewport shape, kept here so framing can account for it.
   *
   * On a portrait phone the horizontal field of view is less than half the vertical one.
   * Framing by the vertical alone — which is what a naive `distance = radius / tan(fov/2)`
   * does — puts everything interesting off the left and right edges. Every framing
   * decision in the app goes through `distanceToFit`, which uses the tighter of the two.
   */
  aspect = 1;
  fovDeg = 48;

  /** Half-angle of the narrower field of view, radians. */
  private get tightHalfFov(): number {
    const vertical = ((this.fovDeg / 2) * Math.PI) / 180;
    const horizontal = Math.atan(Math.tan(vertical) * this.aspect);
    return Math.min(vertical, horizontal);
  }

  /** Camera distance that just fits a sphere of this radius in the narrower axis. */
  distanceToFit(radiusKm: number, margin = 1.18): number {
    return clampDistance((radiusKm * margin) / Math.tan(this.tightHalfFov));
  }

  /** Radius currently visible across the narrower axis, km. */
  get visibleRadiusKm(): number {
    return this.distance * Math.tan(this.tightHalfFov);
  }

  /** Width of the view across the screen's horizontal axis, km. */
  get spanKm(): number {
    const vertical = ((this.fovDeg / 2) * Math.PI) / 180;
    return 2 * this.distance * Math.tan(vertical) * this.aspect;
  }
}

/**
 * A readable name for the scale currently on screen. Shown in the HUD so you always know
 * which regime you are in, and used to decide which objects are worth labelling.
 */
export function scaleBand(distanceKm: number): {
  id: 'surface' | 'orbital' | 'cislunar' | 'planetary' | 'inner' | 'outer' | 'deep';
  label: string;
} {
  if (distanceKm < 2_000) return { id: 'surface', label: 'SURFACE' };
  if (distanceKm < 120_000) return { id: 'orbital', label: 'ORBITAL' };
  if (distanceKm < 3_000_000) return { id: 'cislunar', label: 'CISLUNAR' };
  if (distanceKm < 0.35 * AU_KM) return { id: 'planetary', label: 'PLANETARY' };
  if (distanceKm < 8 * AU_KM) return { id: 'inner', label: 'INNER SYSTEM' };
  if (distanceKm < 70 * AU_KM) return { id: 'outer', label: 'OUTER SYSTEM' };
  return { id: 'deep', label: 'DEEP SPACE' };
}
