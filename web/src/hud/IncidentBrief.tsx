import { useEffect, useRef, useState } from 'react';
import type { Incident } from '@crimetracker/shared';
import { fetchBrief, type IncidentBrief as BriefData } from '../lib/api.js';
import { speak, speechSupported, stopSpeaking } from '../lib/speech.js';
import { useTracker } from '../state/store.js';
import { Chip } from '../components/primitives.js';

/**
 * The plain-language brief for the selected incident, with the option to hear it.
 *
 * Two things this is careful about.
 *
 * It labels itself. A fluent sentence about a real incident reads as authoritative, and a
 * *spoken* one even more so — so a model-written brief is chipped `AI-WRITTEN` in violet,
 * the same colour this interface uses for every inference, and one composed from the
 * record's own fields is chipped `COMPOSED`. The two never look alike.
 *
 * And it stays quiet. Voice is opt-in per session and off by default; once enabled,
 * selecting an incident speaks its brief, which is the point of the feature.
 */
export function IncidentBriefPanel({ incident }: { incident: Incident }) {
  const voiceEnabled = useTracker((s) => s.ui.voiceEnabled);
  const setUi = useTracker((s) => s.setUi);

  const [brief, setBrief] = useState<BriefData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [speaking, setSpeaking] = useState(false);
  const supported = useRef(speechSupported());

  /* ------------------------------ fetch ------------------------------- */
  useEffect(() => {
    const controller = new AbortController();
    setBrief(null);
    setState('loading');

    fetchBrief(incident.id, controller.signal)
      .then((result) => {
        setBrief(result);
        setState('ready');
      })
      .catch(() => {
        // An aborted request is a selection change, not a failure.
        if (!controller.signal.aborted) setState('failed');
      });

    return () => controller.abort();
  }, [incident.id]);

  /* ------------------------------ speak ------------------------------- */
  useEffect(() => {
    if (!voiceEnabled || !brief || state !== 'ready') return;
    speak(brief.text, {
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
    });
    // Moving to another incident must not leave the previous one still being read out.
    return () => {
      stopSpeaking();
      setSpeaking(false);
    };
  }, [brief, state, voiceEnabled]);

  const aiWritten = brief?.origin === 'ai-inferred';

  return (
    <section className={`brief${aiWritten ? ' brief--ai' : ''}`}>
      <header className="brief__head">
        <span className="brief__title label">BRIEF</span>
        {brief && (
          <Chip
            tone={aiWritten ? 'violet' : 'amber'}
            title={
              aiWritten
                ? `Written by a language model from this record's fields (${brief.generatorId}). It adds no facts, but the wording is the model's.`
                : "Composed from this record's own fields. No model involved."
            }
          >
            {aiWritten ? 'AI-WRITTEN' : 'COMPOSED'}
          </Chip>
        )}
        <span className="brief__spacer" />
        {supported.current && (
          <>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={!brief}
              onClick={() => {
                if (speaking) {
                  stopSpeaking();
                  setSpeaking(false);
                } else if (brief) {
                  speak(brief.text, {
                    onStart: () => setSpeaking(true),
                    onEnd: () => setSpeaking(false),
                  });
                }
              }}
            >
              {speaking ? '■ STOP' : '▶ SPEAK'}
            </button>
            <button
              type="button"
              className={`btn btn--sm ${voiceEnabled ? 'btn--on' : 'btn--ghost'}`}
              aria-pressed={voiceEnabled}
              title={
                voiceEnabled
                  ? 'Stop reading each incident aloud when it is selected.'
                  : 'Read each incident aloud as it is selected. Off by default.'
              }
              onClick={() => {
                const next = !voiceEnabled;
                setUi({ voiceEnabled: next });
                if (!next) {
                  stopSpeaking();
                  setSpeaking(false);
                }
              }}
            >
              AUTO
            </button>
          </>
        )}
      </header>

      <div className="brief__body">
        {state === 'loading' && <p className="brief__pending micro">COMPOSING…</p>}
        {state === 'failed' && (
          <p className="brief__pending micro">BRIEF UNAVAILABLE — THE RECORD IS SHOWN BELOW</p>
        )}
        {state === 'ready' && brief && (
          <p className={`brief__text${speaking ? ' brief__text--speaking' : ''}`}>{brief.text}</p>
        )}
      </div>

      {aiWritten && (
        <p className="brief__footnote micro">
          Wording generated from this record. Read the source fields below for what the
          agency actually published.
        </p>
      )}
    </section>
  );
}
