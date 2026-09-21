import type { JSX } from 'preact';

/**
 * Icons.
 *
 * Hand-drawn 24-grid strokes rather than an icon font: they stay hairline-thin at the
 * sizes this UI uses, they inherit `currentColor`, and there is no webfont to load before
 * the dock can paint.
 */

type P = JSX.SVGAttributes<SVGSVGElement>;

const base: P = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.4,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': true,
};

export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="6" /><path d="m15.5 15.5 4 4" /></svg>
);

export const IconSurprise = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);

export const IconMissions = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" />
    <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
  </svg>
);

export const IconSandbox = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-24 12 12)" />
    <circle cx="12" cy="12" r="2.4" />
    <path d="M18.5 6.5 21 4M21 4h-2.6M21 4v2.6" />
  </svg>
);

export const IconLayers = (p: P) => (
  <svg {...base} {...p}>
    <path d="m12 3 8.5 4.6L12 12.2 3.5 7.6 12 3Z" />
    <path d="m4.6 11.4-1.1.6L12 16.6l8.5-4.6-1.1-.6" />
    <path d="m4.6 15.4-1.1.6L12 20.6l8.5-4.6-1.1-.6" />
  </svg>
);

export const IconTrack = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </svg>
);

export const IconChase = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 12h4l2.6-6 4.8 12L17 12h4" />
    <circle cx="12" cy="12" r="9.2" opacity=".45" />
  </svg>
);

export const IconTrajectory = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2.5 18C6 9.5 12 5 21.5 5" stroke-dasharray="2.6 2.4" />
    <circle cx="16" cy="6.6" r="2" />
  </svg>
);

export const IconTime = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8.4" /><path d="M12 7v5.3l3.3 2" /></svg>
);

export const IconHome = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="5.6" /><ellipse cx="12" cy="12" rx="10" ry="3.6" transform="rotate(-28 12 12)" /></svg>
);

export const IconZoomIn = (p: P) => (
  <svg {...base} {...p}><path d="M12 6v12M6 12h12" /></svg>
);

export const IconZoomOut = (p: P) => (
  <svg {...base} {...p}><path d="M6 12h12" /></svg>
);

export const IconData = (p: P) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="6.4" rx="7" ry="2.9" />
    <path d="M5 6.4v11.2c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.4" />
    <path d="M5 12c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9" />
  </svg>
);

export const IconGravity = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="6" opacity=".7" stroke-dasharray="2 2.4" />
    <circle cx="12" cy="12" r="9.6" opacity=".4" stroke-dasharray="2 2.4" />
  </svg>
);

export const IconClose = (p: P) => (
  <svg {...base} {...p}><path d="m6.5 6.5 11 11M17.5 6.5l-11 11" /></svg>
);

export const IconCheck = (p: P) => (
  <svg {...base} {...p}><path d="m5 12.5 4.6 4.6L19 7.5" /></svg>
);
