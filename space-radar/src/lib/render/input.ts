/**
 * Touch and pointer gestures.
 *
 * Built on Pointer Events so one code path covers finger, pen, mouse and trackpad. The
 * gesture set is deliberately small and phone-shaped:
 *
 *   one finger drag    orbit the camera
 *   two finger pinch   zoom, anchored on the midpoint
 *   two finger drag    pan the focus
 *   tap                select the nearest object
 *   double tap         zoom in one step, centred on what was tapped
 *   wheel / trackpad   zoom (desktop)
 *
 * `touch-action: none` on the target element is what stops the browser stealing the
 * gesture for page scroll or pinch-zoom, and is set by the caller in CSS.
 */

export interface GestureHandlers {
  onRotate(dAzimuthRad: number, dElevationRad: number): void;
  onZoom(factor: number): void;
  onPan(dxFraction: number, dyFraction: number): void;
  onTap(x: number, y: number): void;
  onDoubleTap(x: number, y: number): void;
  /** Fired on first contact so the app can cancel any camera transition in flight. */
  onInteractStart(): void;
  /** Pointer devices only. `x < 0` means the pointer left the surface. */
  onHover(x: number, y: number): void;
}

interface Pt {
  id: number;
  x: number;
  y: number;
}

const TAP_MS = 280;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 320;

export class GestureController {
  private pointers = new Map<number, Pt>();
  private lastPinchDistance = 0;
  private lastCentroid: { x: number; y: number } | null = null;
  private downAt = 0;
  private downPos = { x: 0, y: 0 };
  private moved = 0;
  private lastTapAt = 0;
  private lastTapPos = { x: 0, y: 0 };
  private disposed = false;

  constructor(
    private el: HTMLElement,
    private handlers: GestureHandlers,
  ) {
    el.addEventListener('pointerdown', this.onDown, { passive: false });
    el.addEventListener('pointermove', this.onMove, { passive: false });
    el.addEventListener('pointerup', this.onUp, { passive: false });
    el.addEventListener('pointercancel', this.onUp, { passive: false });
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.onContextMenu);
    el.addEventListener('pointermove', this.onHoverMove, { passive: true });
    el.addEventListener('pointerleave', this.onHoverLeave, { passive: true });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const el = this.el;
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerup', this.onUp);
    el.removeEventListener('pointercancel', this.onUp);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    el.removeEventListener('pointermove', this.onHoverMove);
    el.removeEventListener('pointerleave', this.onHoverLeave);
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onHoverMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || this.pointers.size > 0) return;
    const p = this.local(e);
    this.handlers.onHover(p.x, p.y);
  };

  private onHoverLeave = (): void => {
    this.handlers.onHover(-1, -1);
  };

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.el.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y });

    if (this.pointers.size === 1) {
      this.downAt = performance.now();
      this.downPos = p;
      this.moved = 0;
      this.handlers.onInteractStart();
    } else {
      this.lastPinchDistance = this.pinchDistance();
      this.lastCentroid = this.centroid();
      // A second finger means this is no longer a tap.
      this.moved = TAP_SLOP_PX + 1;
    }
  };

  private onMove = (e: PointerEvent): void => {
    const existing = this.pointers.get(e.pointerId);
    if (!existing) return;
    e.preventDefault();

    const p = this.local(e);
    const dx = p.x - existing.x;
    const dy = p.y - existing.y;
    existing.x = p.x;
    existing.y = p.y;
    this.moved += Math.hypot(dx, dy);

    const rect = this.el.getBoundingClientRect();

    if (this.pointers.size === 1) {
      // Scale rotation by viewport size so the same swipe turns the same amount on any
      // screen. 2.6 rad across the full width is a comfortable phone rate.
      this.handlers.onRotate((dx / rect.width) * 2.6, (dy / rect.height) * 2.2);
      return;
    }

    if (this.pointers.size >= 2) {
      const dist = this.pinchDistance();
      const centroid = this.centroid();

      if (this.lastPinchDistance > 0 && dist > 0) {
        const ratio = this.lastPinchDistance / dist;
        // Ignore sub-pixel jitter, which otherwise reads as a slow drift.
        if (Math.abs(1 - ratio) > 0.0015) this.handlers.onZoom(ratio);
      }
      if (this.lastCentroid && centroid) {
        const cdx = (centroid.x - this.lastCentroid.x) / rect.width;
        const cdy = (centroid.y - this.lastCentroid.y) / rect.height;
        if (Math.abs(cdx) + Math.abs(cdy) > 0.0004) this.handlers.onPan(cdx, cdy);
      }
      this.lastPinchDistance = dist;
      this.lastCentroid = centroid;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);

    if (this.pointers.size === 0) {
      const dt = performance.now() - this.downAt;
      if (dt < TAP_MS && this.moved < TAP_SLOP_PX) {
        const now = performance.now();
        const near =
          Math.hypot(this.downPos.x - this.lastTapPos.x, this.downPos.y - this.lastTapPos.y) < 28;
        if (now - this.lastTapAt < DOUBLE_TAP_MS && near) {
          this.lastTapAt = 0;
          this.handlers.onDoubleTap(this.downPos.x, this.downPos.y);
        } else {
          this.lastTapAt = now;
          this.lastTapPos = { ...this.downPos };
          this.handlers.onTap(this.downPos.x, this.downPos.y);
        }
      }
      this.lastPinchDistance = 0;
      this.lastCentroid = null;
    } else {
      // Recompute the pinch baseline so lifting one of three fingers does not jump.
      this.lastPinchDistance = this.pinchDistance();
      this.lastCentroid = this.centroid();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.handlers.onInteractStart();
    // deltaMode 1 is lines, 2 is pages; normalise to something pixel-ish.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const delta = e.deltaY * unit;
    this.handlers.onZoom(Math.exp(delta * 0.0016));
  };

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }

  private centroid(): { x: number; y: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length === 0) return null;
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pts.length, y: y / pts.length };
  }
}
