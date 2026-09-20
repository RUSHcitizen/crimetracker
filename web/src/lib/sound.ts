/**
 * Optional UI sound.
 *
 * Disabled by default and never started without an explicit user gesture. All tones are
 * generated with the WebAudio oscillator — there are no audio assets in this project.
 */

let context: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    master = context.createGain();
    // Deliberately quiet: these are accents, not alerts.
    master.gain.value = 0.045;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

type Tone = 'arrive' | 'select' | 'pattern';

const TONES: Record<Tone, { freq: number; to: number; duration: number; type: OscillatorType }> = {
  arrive: { freq: 880, to: 1320, duration: 0.09, type: 'triangle' },
  select: { freq: 420, to: 520, duration: 0.06, type: 'sine' },
  pattern: { freq: 220, to: 660, duration: 0.5, type: 'sawtooth' },
};

export function playTone(tone: Tone, enabled: boolean): void {
  if (!enabled) return;
  const ctx = ensureContext();
  if (!ctx || !master) return;

  const spec = TONES[tone];
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.freq, now);
  osc.frequency.exponentialRampToValueAtTime(spec.to, now + spec.duration);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(1, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.duration);

  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + spec.duration + 0.02);
}
