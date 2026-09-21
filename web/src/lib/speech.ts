/**
 * Spoken briefs, via the browser's own speech synthesis.
 *
 * No audio assets and no network: `speechSynthesis` ships with the browser, so a brief is
 * spoken locally and nothing about the incident leaves the page to be voiced.
 *
 * It is **off until asked**. The project's rule is that nothing makes noise on its own,
 * and it applies with more force here than to a UI beep: a synthetic voice reading out
 * crime reports is not something to spring on someone who just opened a map.
 */

export type SpeechState = 'unsupported' | 'idle' | 'speaking';

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

export function speechSupported(): boolean {
  return synth() !== null;
}

/**
 * Pick a voice that sounds like a person reading, not a station announcer.
 *
 * Voice availability varies wildly by platform and loads asynchronously, so this is a
 * preference, not a requirement: with no match the browser default is used.
 */
function preferredVoice(available: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = available.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
  if (english.length === 0) return null;
  const local = english.find((voice) => voice.localService);
  return local ?? english[0] ?? null;
}

export interface SpeakOptions {
  readonly onStart?: () => void;
  readonly onEnd?: () => void;
}

/**
 * Speak a brief, cancelling anything already in progress.
 *
 * Cancelling matters: clicking through incidents quickly would otherwise queue a backlog
 * of voices describing incidents you have already moved past.
 */
export function speak(text: string, options: SpeakOptions = {}): void {
  const speech = synth();
  if (!speech || !text.trim()) return;

  speech.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = preferredVoice(speech.getVoices());
  if (voice) utterance.voice = voice;
  // Slightly slower than default: these are unfamiliar street names and abbreviations.
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.volume = 1;

  utterance.onstart = () => options.onStart?.();
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = () => options.onEnd?.();

  speech.speak(utterance);
}

export function stopSpeaking(): void {
  synth()?.cancel();
}
