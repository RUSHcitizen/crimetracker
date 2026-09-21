import * as THREE from 'three';
import type { ResolvedObject } from '../data/types';
import type { ProjectedItem } from './scene';

/**
 * The instrument overlay.
 *
 * Everything with an edge or a letter is drawn here, on a plain 2D canvas over the WebGL
 * one. Three reasons: text stays pixel-crisp at any device ratio, the glyph vocabulary can
 * be drawn as real vector graphics rather than textured quads, and hit-testing a tap is
 * just "which marker is nearest the finger" — which is exactly what the user perceives,
 * unlike raycasting a sphere that is half a pixel wide.
 */

export interface Marker {
  object: ResolvedObject;
  x: number;
  y: number;
  /** Depth in NDC; used to skip things behind the camera. */
  visible: boolean;
  /** Apparent radius of the globe in CSS pixels, 0 when not meshed. */
  bodyRadius: number;
  /** Apparent radius of the sphere of influence in CSS pixels, 0 when it has none. */
  soiRadius: number;
  priority: number;
}

export interface OverlayStyle {
  text: string;
  dim: string;
  accent: string;
  hair: string;
}

const STYLE: OverlayStyle = {
  text: '#e6eaf0',
  dim: '#8b95a5',
  accent: '#ffb000',
  hair: 'rgba(230,238,248,0.22)',
};

const FONT_LABEL = '600 11px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const FONT_SMALL = '500 9.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  markers: Marker[] = [];

  /**
   * Screen regions the UI occupies, in CSS pixels. Labels keep out of them — a name
   * rendered underneath the zoom buttons is worse than no name at all.
   */
  insets = { top: 0, right: 0, bottom: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Project scene-space positions to CSS pixels and build the marker list. */
  project(camera: THREE.PerspectiveCamera, items: ProjectedItem[]): Marker[] {
    const v = new THREE.Vector3();
    const markers: Marker[] = [];
    const halfH = this.height / 2;
    // Pixels per radian at the centre of the view, from the vertical field of view.
    const tanHalfFov = Math.tan(((camera.fov / 2) * Math.PI) / 180);

    for (const item of items) {
      v.copy(item.scene).project(camera);
      // project() mirrors x and y for points behind the camera, so reject on z first.
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * this.width;
      const y = (-v.y * 0.5 + 0.5) * this.height;

      let bodyRadius = 0;
      if (item.radiusScene > 0) {
        const distScene = item.scene.distanceTo(camera.position);
        if (distScene > item.radiusScene) {
          bodyRadius = (item.radiusScene / (distScene * tanHalfFov)) * halfH;
        } else {
          // Inside the body: it fills the screen.
          bodyRadius = halfH * 2;
        }
      }

      const distScene = item.scene.distanceTo(camera.position);
      const soiRadius =
        item.soiScene > 0 && distScene > 0
          ? (item.soiScene / (distScene * tanHalfFov)) * halfH
          : 0;

      markers.push({
        object: item.object,
        x,
        y,
        visible: !behind && x > -80 && x < this.width + 80 && y > -80 && y < this.height + 80,
        bodyRadius,
        soiRadius,
        priority: item.object.object.weight,
      });
    }

    this.markers = markers;
    return markers;
  }

  clear(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
  }

  /** Draw every marker glyph, then a bounded number of labels. */
  /** Radius of the tracking reticle for a marker — labels have to clear it. */
  private reticleRadius(m: Marker): number {
    return Math.max(22, Math.min(74, m.bodyRadius * 1.6 + 22));
  }

  draw(opts: {
    selectedId: string | null;
    trackedId: string | null;
    chase: boolean;
    time: number;
    labelBudget: number;
    showLabels: boolean;
    distanceLabel: (m: Marker) => string | null;
    /** Non-null when the GRAVITY layer is on: the caption for a body's SOI ring. */
    soiLabel: ((m: Marker) => string) | null;
    /** One line explaining what the GRAVITY layer is currently showing, if anything. */
    gravityHint: string | null;
  }): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const sorted = [...this.markers]
      .filter((m) => m.visible)
      .sort((a, b) => b.priority - a.priority);

    // Caption the sphere-of-influence rings the scene has drawn. An unlabelled dashed
    // circle is exactly the kind of meaningless HUD decoration this app is supposed to
    // avoid; with the number on it, it is a measurement.
    if (opts.soiLabel) {
      for (const m of this.markers) {
        if (m.soiRadius < 40 || m.soiRadius > 4000) continue;
        this.drawSoiCaption(m, opts.soiLabel(m));
      }
    }

    for (const m of sorted) {
      const selected = m.object.object.id === opts.selectedId;
      const tracked = m.object.object.id === opts.trackedId;
      this.drawGlyph(m, selected, tracked);
    }

    if (opts.showLabels) {
      const taken: { x: number; y: number; w: number; h: number }[] = [];
      let drawn = 0;
      for (const m of sorted) {
        if (drawn >= opts.labelBudget) break;
        const selected = m.object.object.id === opts.selectedId;
        const tracked = m.object.object.id === opts.trackedId;
        // Minor objects only get a name when they are the thing you are looking at.
        // Otherwise five DEMO ORBIT labels bury the one that says EARTH.
        if (m.priority < 0.3 && !selected && !tracked) continue;
        const clearance = tracked ? this.reticleRadius(m) - 6 : 0;
        if (this.drawLabel(m, selected || tracked, taken, opts.distanceLabel(m), clearance)) drawn++;
      }
    }

    if (opts.gravityHint) this.drawFootnote(opts.gravityHint);

    const target = this.markers.find((m) => m.object.object.id === (opts.trackedId ?? opts.selectedId));
    if (target) {
      if (target.visible) {
        if (opts.trackedId) this.drawReticle(target, opts.time, opts.chase);
      } else {
        this.drawOffscreenArrow(target);
      }
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------

  private drawGlyph(m: Marker, selected: boolean, tracked: boolean): void {
    const { ctx } = this;
    const o = m.object.object;
    const color = o.color;
    const r = Math.max(3.2, Math.min(9, m.bodyRadius));
    const bright = selected || tracked;

    ctx.save();
    ctx.translate(Math.round(m.x) + 0.5, Math.round(m.y) + 0.5);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = bright ? 1 : o.kind === 'satellite' ? 0.55 : 0.82;

    // The glyph vocabulary: every class of object reads differently at a glance.
    switch (o.kind) {
      case 'star': {
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(2.5, m.bodyRadius * 0.15), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha *= 0.5;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          ctx.beginPath();
          ctx.moveTo(dx * (r + 3), dy * (r + 3));
          ctx.lineTo(dx * (r + 8), dy * (r + 8));
          ctx.stroke();
        }
        break;
      }
      case 'planet':
      case 'dwarf': {
        if (m.bodyRadius < 4) {
          ctx.beginPath();
          ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha *= 0.75;
        ctx.beginPath();
        ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'moon': {
        ctx.beginPath();
        ctx.moveTo(0, -3.4);
        ctx.lineTo(3.4, 0);
        ctx.lineTo(0, 3.4);
        ctx.lineTo(-3.4, 0);
        ctx.closePath();
        m.bodyRadius < 4 ? ctx.fill() : ctx.stroke();
        break;
      }
      case 'spacecraft': {
        // A bracket pair — reads as "tracked craft" rather than "rock".
        const s = 5;
        ctx.beginPath();
        ctx.moveTo(-s, -s + 2); ctx.lineTo(-s, -s); ctx.lineTo(-s + 2, -s);
        ctx.moveTo(s - 2, -s); ctx.lineTo(s, -s); ctx.lineTo(s, -s + 2);
        ctx.moveTo(s, s - 2); ctx.lineTo(s, s); ctx.lineTo(s - 2, s);
        ctx.moveTo(-s + 2, s); ctx.lineTo(-s, s); ctx.lineTo(-s, s - 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, 1.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'satellite': {
        ctx.beginPath();
        ctx.moveTo(-2.6, 0); ctx.lineTo(2.6, 0);
        ctx.moveTo(0, -2.6); ctx.lineTo(0, 2.6);
        ctx.stroke();
        break;
      }
      case 'comet':
      case 'interstellar': {
        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.lineTo(3.6, 2.6);
        ctx.lineTo(-3.6, 2.6);
        ctx.closePath();
        ctx.stroke();
        break;
      }
      default: {
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = STYLE.accent;
      const b = Math.max(11, r + 8);
      const c = 4;
      ctx.beginPath();
      ctx.moveTo(-b, -b + c); ctx.lineTo(-b, -b); ctx.lineTo(-b + c, -b);
      ctx.moveTo(b - c, -b); ctx.lineTo(b, -b); ctx.lineTo(b, -b + c);
      ctx.moveTo(b, b - c); ctx.lineTo(b, b); ctx.lineTo(b - c, b);
      ctx.moveTo(-b + c, b); ctx.lineTo(-b, b); ctx.lineTo(-b, b - c);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLabel(
    m: Marker,
    emphasised: boolean,
    taken: { x: number; y: number; w: number; h: number }[],
    sub: string | null,
    clearance = 0,
  ): boolean {
    const { ctx } = this;
    const o = m.object.object;
    const name = o.name;

    ctx.font = FONT_LABEL;
    const nameWidth = ctx.measureText(name).width;
    ctx.font = FONT_SMALL;
    const subWidth = sub ? ctx.measureText(sub).width : 0;
    const w = Math.max(nameWidth, subWidth) + 10;
    const h = sub ? 22 : 12;

    const offset = Math.max(12, Math.min(20, m.bodyRadius + 12)) + clearance;
    const y = m.y - 4;

    // Keep the label inside the area the UI does not cover. Flip it to the left of the
    // marker rather than let it slide under the side rail.
    const rightLimit = this.width - this.insets.right - 6;
    let bx = m.x + offset;
    let leaderFrom = m.x + offset - 8;
    let leaderTo = bx - 2;
    if (bx + w > rightLimit) {
      bx = m.x - offset - w;
      leaderFrom = m.x - offset + 8;
      leaderTo = bx + w + 2;
    }

    const box = { x: bx, y: y - 9, w, h };
    if (
      box.x < 4 ||
      box.x + box.w > rightLimit ||
      box.y < this.insets.top + 2 ||
      box.y + box.h > this.height - this.insets.bottom - 2
    ) {
      return false;
    }

    // Pad the test: labels that merely miss each other by a pixel still read as one
    // block of text, which is the thing the budget is trying to prevent.
    const pad = 5;
    for (const t of taken) {
      if (
        box.x - pad < t.x + t.w &&
        box.x + box.w + pad > t.x &&
        box.y - pad < t.y + t.h &&
        box.y + box.h + pad > t.y
      ) {
        return false;
      }
    }
    taken.push(box);

    ctx.save();
    // A short leader from the glyph to the text — the detail that makes it read as an
    // instrument annotation rather than a floating tooltip.
    ctx.strokeStyle = emphasised ? STYLE.accent : STYLE.hair;
    ctx.globalAlpha = emphasised ? 0.9 : 0.5;
    ctx.beginPath();
    ctx.moveTo(leaderFrom, m.y);
    ctx.lineTo(leaderTo, m.y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
    ctx.font = FONT_LABEL;
    ctx.fillStyle = emphasised ? STYLE.accent : STYLE.text;
    ctx.fillText(name, bx + 2, y);

    if (sub) {
      ctx.font = FONT_SMALL;
      ctx.fillStyle = STYLE.dim;
      ctx.fillText(sub, bx + 2, y + 11);
    }
    ctx.restore();
    return true;
  }

  /**
   * A single line of explanation just above the panel stack.
   * Truncated to the width the UI leaves free, so it can never run under the side rail.
   */
  private drawFootnote(text: string): void {
    const { ctx } = this;
    const y = this.height - this.insets.bottom - 10;
    if (y < this.insets.top + 20) return;

    ctx.save();
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    const maxWidth = this.width - this.insets.right - 26;
    let shown = text;
    if (ctx.measureText(shown).width > maxWidth) {
      while (shown.length > 4 && ctx.measureText(`${shown}…`).width > maxWidth) {
        shown = shown.slice(0, -1);
      }
      shown = `${shown.trimEnd()}…`;
    }

    const w = ctx.measureText(shown).width;
    ctx.fillStyle = 'rgba(6,8,11,0.78)';
    ctx.fillRect(8, y - 14, w + 12, 18);
    ctx.fillStyle = 'rgba(126,178,208,0.95)';
    ctx.fillText(shown, 14, y);
    ctx.restore();
  }

  private drawSoiCaption(m: Marker, text: string): void {
    const { ctx } = this;
    const y = m.y - m.soiRadius;
    if (y < this.insets.top + 12 || y > this.height - this.insets.bottom - 6) return;
    const x = Math.min(Math.max(m.x, 8), this.width - this.insets.right - 8);

    ctx.save();
    ctx.font = FONT_SMALL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.strokeStyle = 'rgba(126,178,208,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(146,196,224,0.95)';
    ctx.fillText(text, x, y - 7);
    ctx.restore();
  }

  /** The tracking reticle: a rotating tick ring that makes lock-on legible. */
  private drawReticle(m: Marker, time: number, chase: boolean): void {
    const { ctx } = this;
    const radius = Math.max(22, Math.min(74, m.bodyRadius * 1.6 + 22));
    ctx.save();
    ctx.translate(m.x, m.y);

    ctx.strokeStyle = chase ? '#6fd3ff' : STYLE.accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.85;

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();

    const spin = (time / 5200) * Math.PI * 2;
    ctx.globalAlpha = 0.6;
    for (let k = 0; k < 4; k++) {
      const a = spin + (k / 4) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (radius - 5), Math.sin(a) * (radius - 5));
      ctx.lineTo(Math.cos(a) * (radius + 5), Math.sin(a) * (radius + 5));
      ctx.stroke();
    }

    ctx.globalAlpha = 0.35;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      ctx.beginPath();
      ctx.moveTo(dx * 6, dy * 6);
      ctx.lineTo(dx * 13, dy * 13);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** When the tracked object is off screen, point at it from the edge. */
  private drawOffscreenArrow(m: Marker): void {
    const { ctx } = this;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const angle = Math.atan2(m.y - cy, m.x - cx);
    const margin = 34;
    const rx = Math.min(cx - margin, Math.abs(Math.cos(angle)) > 1e-3 ? Math.abs((cx - margin) / Math.cos(angle)) : Infinity);
    const ry = Math.min(cy - margin, Math.abs(Math.sin(angle)) > 1e-3 ? Math.abs((cy - margin) / Math.sin(angle)) : Infinity);
    const r = Math.min(rx, ry, Math.min(cx, cy) - margin);

    ctx.save();
    ctx.translate(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    ctx.rotate(angle);
    ctx.fillStyle = STYLE.accent;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-5, -5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Nearest marker to a tap, within a generous touch radius. */
  pick(x: number, y: number, radius = 34): ResolvedObject | null {
    let best: ResolvedObject | null = null;
    let bestScore = Infinity;
    for (const m of this.markers) {
      if (!m.visible) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      const reach = Math.max(radius, m.bodyRadius + 12);
      if (d > reach) continue;
      // Break ties toward the more prominent object so tapping Earth does not select a
      // demo satellite that happens to be a pixel closer.
      const score = d - m.priority * 14;
      if (score < bestScore) {
        bestScore = score;
        best = m.object;
      }
    }
    return best;
  }
}
