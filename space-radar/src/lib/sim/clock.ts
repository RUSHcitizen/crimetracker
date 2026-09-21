import { nowJd } from '../astro/time';

/**
 * The simulation clock.
 *
 * Two things move time: real elapsed time multiplied by a rate, and direct seeks from the
 * scrubber. `LIVE` is not rate 1 — it is a distinct mode that re-syncs to the wall clock
 * every frame, so the app never drifts away from now while it sits open.
 */

/** Rate steps the UI offers. Negative rates run time backwards. */
export const RATE_STEPS = [
  0, 1, 10, 60, 600, 3_600, 86_400, 604_800, 2_592_000, 31_557_600,
] as const;

export const RATE_LABELS: Record<number, string> = {
  0: 'HOLD',
  1: 'REAL TIME',
  10: '10×',
  60: '1 MIN/S',
  600: '10 MIN/S',
  3600: '1 HR/S',
  86400: '1 DAY/S',
  604800: '1 WEEK/S',
  2592000: '1 MONTH/S',
  31557600: '1 YEAR/S',
};

export interface ClockState {
  /** Current simulated instant, Julian Date. */
  jd: number;
  /** Seconds of simulated time per second of real time. Signed. */
  rate: number;
  /** True while the clock is pinned to the wall clock. */
  live: boolean;
}

export class Clock {
  private _jd = nowJd();
  private _rate = 1;
  private _live = true;
  private lastRealMs = performance.now();

  get jd(): number {
    return this._jd;
  }

  get rate(): number {
    return this._live ? 1 : this._rate;
  }

  get live(): boolean {
    return this._live;
  }

  /** Offset from the present, in days. Zero while live. */
  get offsetDays(): number {
    return this._jd - nowJd();
  }

  get state(): ClockState {
    return { jd: this._jd, rate: this.rate, live: this._live };
  }

  /** Advance by real elapsed time. Returns the new instant. */
  tick(nowMs: number): number {
    const dtRealSec = Math.min(0.25, (nowMs - this.lastRealMs) / 1000);
    this.lastRealMs = nowMs;

    if (this._live) {
      this._jd = nowJd();
    } else {
      this._jd += (this._rate * dtRealSec) / 86_400;
    }
    return this._jd;
  }

  /** Pin to the wall clock. */
  goLive(): void {
    this._live = true;
    this._rate = 1;
    this._jd = nowJd();
  }

  /**
   * Set the rate. Any non-live rate leaves LIVE mode, including 1× — watching real time
   * pass from a chosen instant is a different thing from tracking now.
   */
  setRate(rate: number): void {
    this._rate = rate;
    this._live = false;
  }

  /** Jump to an absolute instant. */
  seek(jd: number): void {
    this._jd = jd;
    this._live = false;
  }

  /** Jump by a number of days, signed. */
  nudge(days: number): void {
    this.seek(this._jd + days);
  }

  /** Jump to an offset from the present. */
  seekOffset(days: number): void {
    if (Math.abs(days) < 1e-9) {
      this.goLive();
      return;
    }
    this.seek(nowJd() + days);
  }

  /** Called after the tab was hidden, so a long gap does not lurch the simulation. */
  resync(nowMs: number): void {
    this.lastRealMs = nowMs;
    if (this._live) this._jd = nowJd();
  }
}
