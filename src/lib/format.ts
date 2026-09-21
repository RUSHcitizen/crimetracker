import { AU_KM, C_KM_S } from './astro/constants';

/**
 * Number formatting for a readout that has to stay legible on a phone.
 *
 * The rule throughout: pick the unit that gives 2–4 significant figures, and never print
 * more precision than the underlying model actually has.
 */

const nf = (v: number, digits: number): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Distance with an automatically chosen unit. */
export function formatDistance(km: number): { value: string; unit: string } {
  const a = Math.abs(km);
  if (!Number.isFinite(a)) return { value: '—', unit: '' };
  if (a < 1) return { value: nf(km * 1000, 0), unit: 'm' };
  if (a < 10_000) return { value: nf(km, 1), unit: 'km' };
  // Straight kilometres, with separators, all the way out to a few million — "1,644,000 km"
  // reads instantly, where a thousands-of-km unit ("1,644" + "000 km") does not.
  if (a < 0.02 * AU_KM) return { value: nf(km, 0), unit: 'km' };
  if (a < 1000 * AU_KM) {
    const au = km / AU_KM;
    return { value: nf(au, au < 10 ? 4 : au < 100 ? 3 : 2), unit: 'AU' };
  }
  return { value: nf(km / (C_KM_S * 86_400 * 365.25), 4), unit: 'ly' };
}

export const formatDistanceInline = (km: number): string => {
  const d = formatDistance(km);
  return `${d.value} ${d.unit}`.trim();
};

/** A second, human-scale rendering of the same distance — used under the primary readout. */
export function distanceAside(km: number): string | null {
  const a = Math.abs(km);
  if (a < 1000) return null;
  if (a > 0.01 * AU_KM && a < 1000 * AU_KM) {
    const lightMinutes = km / C_KM_S / 60;
    if (lightMinutes < 1) return `${nf(km / C_KM_S, 1)} light-seconds`;
    if (lightMinutes < 90) return `${nf(lightMinutes, 1)} light-minutes`;
    return `${nf(lightMinutes / 60, 2)} light-hours`;
  }
  if (a >= 1000 * AU_KM) return `${nf(km / AU_KM, 0)} AU`;
  return `${nf(km, 0)} km`;
}

export function formatSpeed(kmPerSec: number): string {
  const a = Math.abs(kmPerSec);
  if (!Number.isFinite(a)) return '—';
  if (a < 0.01) return `${nf(kmPerSec * 1000, 1)} m/s`;
  if (a < 100) return `${nf(kmPerSec, 3)} km/s`;
  return `${nf(kmPerSec, 1)} km/s`;
}

/** Speed as a fraction of light, for the genuinely fast things. */
export const speedAside = (kmPerSec: number): string =>
  `${nf((kmPerSec / C_KM_S) * 100, 4)}% of light speed · ${nf(kmPerSec * 3600, 0)} km/h`;

/** One-way light travel time across a distance. */
export const lightTimeSeconds = (km: number): number => km / C_KM_S;

export function formatDuration(days: number): string {
  const a = Math.abs(days);
  if (!Number.isFinite(a)) return '—';
  if (a < 1 / 24) return `${nf(a * 1440, 1)} min`;
  if (a < 2) return `${nf(a * 24, 2)} hours`;
  if (a < 400) return `${nf(a, a < 30 ? 2 : 1)} days`;
  return `${nf(a / 365.25, a < 3652 ? 2 : 1)} years`;
}

export function formatMetres(m: number): string {
  if (m < 1000) return `${nf(m, 0)} m`;
  return `${nf(m / 1000, 2)} km`;
}

/** Compact integer with thousands separators. */
export const formatInt = (v: number): string => Math.round(v).toLocaleString('en-US');
