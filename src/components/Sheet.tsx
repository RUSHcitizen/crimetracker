import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { IconClose } from './icons';

/**
 * The bottom sheet.
 *
 * Every secondary surface in the app is one of these — search, missions, layers, the
 * sandbox, the data log. Bottom sheets rather than modals or side drawers because on a
 * phone the bottom of the screen is the only part a thumb reaches comfortably, and because
 * sliding up from the dock keeps the visualisation visible above it the whole time.
 */
export function Sheet(props: {
  title: string;
  note?: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Rendered between the header and the scrolling body, e.g. a search field. */
  sticky?: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return (
    <>
      <div class="sheet-backdrop" onClick={props.onClose} />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <div class="sheet-head">
          <h3>{props.title}</h3>
          {props.note ? <span class="note">{props.note}</span> : null}
          <button class="close-x" onClick={props.onClose} aria-label="Close">
            <IconClose style={{ width: 14, height: 14 }} />
          </button>
        </div>
        {props.sticky}
        <div class="sheet-body">{props.children}</div>
      </div>
    </>
  );
}
