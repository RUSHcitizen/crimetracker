/**
 * Optional interaction sounds.
 *
 * OFF BY DEFAULT, and the app is designed to be complete without it — nothing here
 * conveys information that is not already on screen. It exists because a real instrument
 * gives you a small physical acknowledgement when it accepts an input, and because a
 * scale transition across nine orders of magnitude is more legible with a pitch sweep
 * attached to it.
 *
 * Synthesised with two oscillators and a gain envelope rather than shipping audio files:
 * no download, no decoding, and the pitch can follow the thing it is describing.
 */

const STORAGE_KEY = 'space-radar.sound.v1';

type Cue = 'select' | 'lock' | 'release' | 'zoom' | 'discover' | 'complete' | 'toggle';

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _enabled = false;
  private lastPlayed = 0;

  constructor() {
    if (typeof localStorage !== 'undefined') {
      try {
        this._enabled = localStorage.getItem(STORAGE_KEY) === 'on';
      } catch {
        // Blocked storage just means the preference does not persist.
        this._enabled = false;
      }
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      /* not persisting is fine */
    }
    if (on) {
      this.ensureContext();
      this.play('toggle');
    }
  }

  /**
   * Browsers will not start an AudioContext outside a user gesture, so it is created
   * lazily on the first cue after the toggle — which is itself a tap.
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    // Quiet on purpose. This is an acknowledgement, not an alert.
    this.master.gain.value = 0.055;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  play(cue: Cue, intensity = 1): void {
    if (!this._enabled) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.master) return;

    // Rate-limit: rapid taps should not stack into a buzz.
    const now = ctx.currentTime;
    if (now - this.lastPlayed < 0.035) return;
    this.lastPlayed = now;

    const spec = SPECS[cue];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;

    const clamped = Math.min(1.6, Math.max(0.4, intensity));
    osc.frequency.setValueAtTime(spec.from * clamped, now);
    if (spec.to !== spec.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to * clamped), now + spec.duration);
    }

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(spec.peak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);

    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + spec.duration + 0.02);
  }
}

interface Spec {
  type: OscillatorType;
  from: number;
  to: number;
  duration: number;
  peak: number;
}

const SPECS: Record<Cue, Spec> = {
  // A short, dry tick. The sound of a control accepting a press.
  select: { type: 'triangle', from: 880, to: 880, duration: 0.05, peak: 0.6 },
  // Rising: acquiring a target.
  lock: { type: 'sine', from: 520, to: 1040, duration: 0.16, peak: 0.75 },
  // Falling: letting one go.
  release: { type: 'sine', from: 880, to: 440, duration: 0.14, peak: 0.5 },
  // Pitch follows the direction of travel through scale.
  zoom: { type: 'sine', from: 300, to: 600, duration: 0.12, peak: 0.35 },
  discover: { type: 'triangle', from: 660, to: 990, duration: 0.22, peak: 0.7 },
  complete: { type: 'sine', from: 660, to: 1320, duration: 0.34, peak: 0.85 },
  toggle: { type: 'square', from: 1200, to: 1200, duration: 0.025, peak: 0.28 },
};

export const sound = new Sound();
