import type { ReactNode } from 'react';
import { SEVERITY_LABEL, type SeverityLevel } from '@crimetracker/shared';

/* Small building blocks shared across the HUD. Everything here is presentational. */

export function Panel({
  title,
  count,
  actions,
  children,
  className = '',
  accent = false,
}: {
  title: string;
  count?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <section className={`panel ${accent ? 'panel--accent' : ''} ${className}`}>
      <div className="panel__inner">
        <header className="panel__head">
          <h2 className="panel__title">{title}</h2>
          {count != null && <span className="panel__count">{count}</span>}
          <span className="panel__head-spacer" />
          {actions}
        </header>
        {children}
      </div>
    </section>
  );
}

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="panel__section">
      {title && <div className="panel__section-title">{title}</div>}
      {children}
    </div>
  );
}

export type ChipTone = 'cyan' | 'crimson' | 'amber' | 'violet' | 'green' | 'ghost' | 'neutral';

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  const cls = tone === 'neutral' ? 'chip' : `chip chip--${tone}`;
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Readout({ k, v, mono = false }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <>
      <span className="readout__k">{k}</span>
      <span className={`readout__v ${mono ? 'readout__v--mono' : ''}`}>{v}</span>
    </>
  );
}

export function SeverityDot({ severity }: { severity: SeverityLevel }) {
  return (
    <span
      className="sev-dot"
      style={{ color: `var(--sev-${severity})` }}
      title={`Severity ${severity} — ${SEVERITY_LABEL[severity]}`}
      aria-label={`Severity ${severity}`}
    />
  );
}

export function Meter({
  value,
  tone = 'var(--cyan)',
  segmented = true,
}: {
  value: number;
  tone?: string;
  segmented?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={`meter ${segmented ? 'meter--seg' : ''}`}>
      <div className="meter__fill" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

/** Thin bar chart used for the activity timeline. Deliberately not a chart library. */
export function Histogram({
  values,
  height = 40,
  tone = 'var(--cyan)',
  label,
}: {
  values: readonly number[];
  height?: number;
  tone?: string;
  label?: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="histogram" style={{ height }} role="img" aria-label={label ?? 'activity over time'}>
      {values.map((value, index) => (
        <span
          key={index}
          className="histogram__bar"
          style={{
            height: `${Math.max(value === 0 ? 1 : 6, (value / max) * 100)}%`,
            background: value === 0 ? 'var(--line-faint)' : tone,
            opacity: value === 0 ? 1 : 0.35 + 0.65 * (value / max),
          }}
        />
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span className="micro">{children}</span>
    </div>
  );
}
