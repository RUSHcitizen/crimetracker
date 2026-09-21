/**
 * Minimal float64 3-vector maths.
 *
 * Plain `[x, y, z]` tuples rather than a class: they allocate less, destructure cleanly,
 * and never get confused with three.js `Vector3`, which lives on the render side of the
 * app and is float32. Nothing in the simulation should ever touch a `Vector3`.
 */
export type Vec3 = readonly [number, number, number];

export const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const ZERO: Vec3 = [0, 0, 0];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export const distance = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? ZERO : [a[0] / l, a[1] / l, a[2] / l];
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Rotate about the X axis — the ecliptic/equatorial conversion. */
export function rotateX(a: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0], a[1] * c - a[2] * s, a[1] * s + a[2] * c];
}

export function rotateZ(a: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c, a[2]];
}
