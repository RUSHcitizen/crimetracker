/** Formatting helpers shared by the HUD and server-side log lines. */

export function formatClock(date: Date | string | number, withSeconds = true): string {
  const d = date instanceof Date ? date : new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withSeconds) return `${hh}:${mm}`;
  return `${hh}:${mm}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function formatUtcStamp(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
}

/** "14s" / "6m" / "2h" / "3d" — compact enough for a dense readout. */
export function formatRelative(from: string | number | Date, now = Date.now()): string {
  const ms = now - (from instanceof Date ? from.getTime() : new Date(from).getTime());
  if (!Number.isFinite(ms)) return '--';
  const abs = Math.abs(ms);
  const suffix = ms < 0 ? '+' : '';
  if (abs < 60_000) return `${suffix}${Math.max(0, Math.floor(abs / 1000))}s`;
  if (abs < 3_600_000) return `${suffix}${Math.floor(abs / 60_000)}m`;
  if (abs < 86_400_000) return `${suffix}${Math.floor(abs / 3_600_000)}h`;
  return `${suffix}${Math.floor(abs / 86_400_000)}d`;
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '--%';
  return `${(value * 100).toFixed(digits)}%`;
}

/** Zero-padded sequence readout, e.g. `0042`. */
export function pad(value: number, width = 4): string {
  return Math.max(0, Math.floor(value)).toString().padStart(width, '0');
}
