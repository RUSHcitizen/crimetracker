import { formatUtc } from '../lib/astro/time';
import type { Telemetry } from '../lib/render/engine';
import type { FeedStatus } from '../lib/data/live';
import { formatDistanceInline } from '../lib/format';

/**
 * The status strip.
 *
 * Deliberately one line and non-interactive: it answers "what am I looking at, when, and
 * is the data any good" without taking a single pixel of touch target away from the
 * visualisation. It hides its less important fields as the screen narrows rather than
 * wrapping onto a second line.
 */
export function TopStrip(props: { telemetry: Telemetry; feeds: FeedStatus[] }) {
  const { telemetry: t, feeds } = props;
  const liveFeeds = feeds.filter((f) => f.ok).length;
  const anyFeeds = feeds.length > 0;

  return (
    <div class="topstrip">
      <span class="brand">SPACE<b>·</b>RADAR</span>
      {/* The view span, not just a regime name: "CISLUNAR" is confusing when the camera
          is parked 240 000 km from Voyager 1, but "240 000 km across" never is. */}
      <span class="band" title={`${t.band.label} scale`}>
        ↔ {formatDistanceInline(t.spanKm)}
      </span>
      <span class="spacer" />
      <span class="chip hide-narrow">{t.band.label}</span>
      <span class="chip" title="Simulation time (UTC)">
        <span class={`dot ${t.live ? 'live' : ''}`} />
        {formatUtc(t.jd)}
      </span>
      <span class="chip hide-narrow" style={{ minWidth: 42, justifyContent: 'flex-end' }} title="Frames per second">
        {t.fps} FPS
      </span>
      <span
        class="chip"
        title={anyFeeds ? feeds.map((f) => `${f.label}: ${f.detail}`).join('\n') : 'No live feeds connected'}
      >
        <span class={`dot ${!anyFeeds ? '' : liveFeeds === feeds.length ? 'ok' : liveFeeds > 0 ? 'live' : 'bad'}`} />
        <span class="hide-narrow">{anyFeeds ? `${liveFeeds}/${feeds.length}` : 'LOCAL'}</span>
      </span>
    </div>
  );
}
