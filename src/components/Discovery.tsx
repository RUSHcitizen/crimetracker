import type { Discovery } from '../lib/discover';

/**
 * The SURPRISE ME card.
 *
 * Sits above the dock, dismissible, and always offers the next one — the whole point is
 * that you keep pressing it. It never blocks the view: the camera has already flown to the
 * object by the time the card appears, so the thing being described is visible behind it.
 */
export function DiscoveryCard(props: {
  discovery: Discovery;
  onAgain: () => void;
  onDismiss: () => void;
  onTrack: () => void;
}) {
  return (
    <div class="discovery" role="status">
      <div class="dh">{props.discovery.headline}</div>
      <div class="dd">{props.discovery.detail}</div>
      <div class="drow">
        <button class="btn primary" onClick={props.onAgain}>SURPRISE ME AGAIN</button>
        <button class="btn" onClick={props.onTrack}>TRACK IT</button>
        <button class="btn" onClick={props.onDismiss} style={{ marginLeft: 'auto' }}>CLOSE</button>
      </div>
    </div>
  );
}
