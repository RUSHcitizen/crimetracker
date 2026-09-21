import { useEffect, useRef, useState } from 'preact/hooks';
import { formatOffset, formatUtc } from '../lib/astro/time';
import { RATE_STEPS } from '../lib/sim/clock';
import type { Telemetry } from '../lib/render/engine';

/**
 * The time control.
 *
 * The scrubber is logarithmic in both directions from now. A linear slider covering fifty
 * years gives you six-day steps at the finest, which makes it useless for watching the ISS
 * go round; a log slider gives seconds of resolution near the centre and still reaches the
 * far end of the range. The centre detent is LIVE, and it snaps.
 *
 * Rate and offset are separate controls on purpose: "jump to next March" and "run at a day
 * per second" are different intentions, and collapsing them into one control makes both
 * worse.
 */

const MAX_DAYS = 365.25 * 50;
const SLIDER_RANGE = 1000;
const LOG_MAX = Math.log(MAX_DAYS + 1);

function sliderToDays(v: number): number {
  const sign = Math.sign(v);
  const mag = Math.abs(v) / SLIDER_RANGE;
  return sign * (Math.exp(mag * LOG_MAX) - 1);
}

function daysToSlider(days: number): number {
  const sign = Math.sign(days);
  const mag = Math.log(Math.abs(days) + 1) / LOG_MAX;
  return sign * Math.min(SLIDER_RANGE, mag * SLIDER_RANGE);
}

const RATE_LABEL: Record<number, string> = {
  0: 'HOLD',
  1: '1×',
  10: '10×',
  60: '1 MIN/S',
  600: '10 MIN/S',
  3600: '1 HR/S',
  86400: '1 DAY/S',
  604800: '1 WK/S',
  2592000: '1 MO/S',
  31557600: '1 YR/S',
};

const JUMPS: [string, number][] = [
  ['−1 YR', -365.25],
  ['−1 MO', -30.44],
  ['−1 D', -1],
  ['−6 H', -0.25],
  ['+6 H', 0.25],
  ['+1 D', 1],
  ['+1 MO', 30.44],
  ['+1 YR', 365.25],
];

export function TimeBar(props: {
  telemetry: Telemetry;
  onSeekOffset: (days: number) => void;
  onNudge: (days: number) => void;
  onSetRate: (rate: number) => void;
  onLive: () => void;
}) {
  const t = props.telemetry;
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);
  const reverse = t.rate < 0;
  const magnitude = Math.abs(t.rate);
  const liveRef = useRef<HTMLDivElement>(null);

  // While the finger is down the slider owns its own value; otherwise it follows the clock.
  const sliderValue = dragging ? dragValue : daysToSlider(t.offsetDays);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging]);

  const onInput = (e: Event) => {
    const raw = Number((e.currentTarget as HTMLInputElement).value);
    // Snap to LIVE near the centre so it is reachable with a thumb.
    const snapped = Math.abs(raw) < 14 ? 0 : raw;
    setDragValue(snapped);
    props.onSeekOffset(sliderToDays(snapped));
  };

  return (
    <div class="timebar">
      <div class="row">
        <span class="stamp">{formatUtc(t.jd)}</span>
        <span class={`offset ${t.live ? 'is-live' : ''}`} ref={liveRef}>
          {t.live ? 'LIVE' : formatOffset(t.offsetDays)}
        </span>
        <span style={{ flex: 1 }} />
        <span>{t.live ? 'REAL TIME' : (reverse ? '◀ ' : '') + (RATE_LABEL[magnitude] ?? `${magnitude}×`)}</span>
      </div>

      <div class="scrub">
        <div class="track" />
        <div class="ticks" aria-hidden="true">
          {Array.from({ length: 21 }, (_, i) => (
            <span key={i} class={i % 5 === 0 ? 'major' : ''} />
          ))}
        </div>
        <div class="zero" />
        <input
          type="range"
          min={-SLIDER_RANGE}
          max={SLIDER_RANGE}
          step={1}
          value={sliderValue}
          onPointerDown={() => {
            setDragValue(daysToSlider(t.offsetDays));
            setDragging(true);
          }}
          onInput={onInput}
          onChange={onInput}
          aria-label="Time offset from now"
          aria-valuetext={t.live ? 'Live' : formatOffset(t.offsetDays)}
        />
      </div>

      {/* Rates and jumps share one horizontally-scrolling row. Two stacked rows cost
          ~36 px of sky on a phone, and with the object panel open that is the difference
          between seeing what you are tracking and not. */}
      <div class="rates">
        <button
          class="rate live"
          aria-pressed={t.live}
          onClick={props.onLive}
          title="Follow the wall clock"
        >
          LIVE
        </button>
        <button
          class="rate"
          aria-pressed={reverse}
          onClick={() => props.onSetRate(-t.rate === 0 ? -1 : -t.rate)}
          title="Reverse the direction of time"
        >
          ◀▶
        </button>
        {RATE_STEPS.map((step) => (
          <button
            key={step}
            class="rate"
            aria-pressed={!t.live && magnitude === step}
            onClick={() => props.onSetRate(reverse ? -step : step)}
          >
            {RATE_LABEL[step] ?? `${step}×`}
          </button>
        ))}
        <span class="rate-sep" aria-hidden="true" />
        {JUMPS.map(([label, days]) => (
          <button key={label} class="rate jump" onClick={() => props.onNudge(days)} title={`Jump ${label}`}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
