import { J2000, DAYS_PER_CENTURY } from './constants';

/**
 * Time handling.
 *
 * The simulation clock is a Julian Date. We treat it as Terrestrial Time throughout and
 * ignore the TT-UTC offset (~69 s in 2026). At the accuracy this app claims — arcminutes
 * for planets, kilometres for the Moon — 69 s of Earth rotation matters only for the
 * ground track under a satellite, which is documented as approximate.
 */

const MS_PER_DAY = 86_400_000;
/** Julian Date of the Unix epoch, 1970-01-01T00:00:00Z. */
const JD_UNIX_EPOCH = 2_440_587.5;

export const dateToJd = (d: Date): number => d.getTime() / MS_PER_DAY + JD_UNIX_EPOCH;
export const jdToDate = (jd: number): Date => new Date((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
export const nowJd = (): number => Date.now() / MS_PER_DAY + JD_UNIX_EPOCH;

/** Julian centuries since J2000.0 — the argument every ephemeris series below takes. */
export const centuriesSinceJ2000 = (jd: number): number => (jd - J2000) / DAYS_PER_CENTURY;
export const daysSinceJ2000 = (jd: number): number => jd - J2000;

/** Greenwich Mean Sidereal Time in radians — orients the Earth under its satellites. */
export function gmst(jd: number): number {
  const t = centuriesSinceJ2000(jd);
  let deg =
    280.46061837 +
    360.98564736629 * (jd - J2000) +
    0.000387933 * t * t -
    (t * t * t) / 38_710_000;
  deg %= 360;
  if (deg < 0) deg += 360;
  return (deg * Math.PI) / 180;
}

/** ISO-ish UTC stamp without the milliseconds, e.g. `2026-09-21 07:44:03Z`. */
export function formatUtc(jd: number): string {
  const d = jdToDate(jd);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

export function formatUtcDate(jd: number): string {
  const d = jdToDate(jd);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * A signed, human-scaled offset from live: `+3 d 04:12`, `LIVE`, `−1 y 022 d`.
 * Used by the time scrubber, which needs the magnitude readable at a glance on a phone.
 */
export function formatOffset(days: number): string {
  const abs = Math.abs(days);
  if (abs < 1 / 86_400) return 'LIVE';
  const sign = days < 0 ? '−' : '+';
  if (abs < 1) {
    const secs = Math.round(abs * 86_400);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0
      ? `${sign}${h}h ${String(m).padStart(2, '0')}m`
      : `${sign}${m}m ${String(s).padStart(2, '0')}s`;
  }
  if (abs < 365.25) {
    const d = Math.floor(abs);
    const h = Math.round((abs - d) * 24);
    return `${sign}${d}d ${String(h).padStart(2, '0')}h`;
  }
  const y = Math.floor(abs / 365.25);
  const d = Math.round(abs - y * 365.25);
  return `${sign}${y}y ${String(d).padStart(3, '0')}d`;
}

/** `1×`, `10×`, `1 000×`, `1.0e6×` — the rate readout on the time bar. */
export function formatRate(rate: number): string {
  const abs = Math.abs(rate);
  if (abs === 0) return 'HOLD';
  if (abs >= 1e6) return `${(rate / 1e6).toFixed(rate % 1e6 === 0 ? 0 : 1)}M×`;
  if (abs >= 1000) return `${(rate / 1000).toLocaleString('en-US')}k×`;
  return `${rate.toLocaleString('en-US')}×`;
}

/** Light-time as a readable string — used for signal delay on distant spacecraft. */
export function formatLightTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(2)} h`;
  return `${(seconds / 86_400).toFixed(2)} d`;
}

/**
 * General precession in ecliptic longitude since J2000.0, in degrees.
 *
 * The ephemerides in this app work in the fixed J2000 ecliptic frame. Anything defined
 * against the *equinox of date* — the equinoxes and solstices, a RA/Dec read off a modern
 * star chart — sits about 50.3 arcseconds per year away from that frame. This converts
 * between the two. (Lieske et al., p_A series.)
 */
export function precessionFromJ2000Deg(jd: number): number {
  const t = centuriesSinceJ2000(jd);
  return (5029.0966 * t + 1.11113 * t * t - 0.000006 * t * t * t) / 3600;
}
