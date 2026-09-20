import { useMemo } from 'react';
import {
  formatPercent,
  formatRelative,
  INCIDENT_TYPE_META,
  type Stats,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { Chip, Histogram } from '../components/primitives.js';

/**
 * The analytics view — a full-bleed overlay that keeps the map visible behind it.
 *
 * Same visual language as the HUD: no chart library, no cards. Bars are thin rails,
 * distributions are tracked type and tabular figures, and the timeline is a plain
 * histogram built from the server's own buckets.
 */
export function StatsView() {
  const open = useTracker((s) => s.ui.statsOpen);
  const stats = useTracker((s) => s.stats);
  const patterns = useTracker((s) => s.patterns);
  const sources = useTracker((s) => s.sources);
  const setUi = useTracker((s) => s.setUi);

  const timeline = useMemo(() => (stats ? stats.timeline.map((b) => b.count) : []), [stats]);
  const peak = useMemo(() => Math.max(0, ...timeline), [timeline]);
  // The server reports the span it actually had data for, so the axis never claims a
  // window the database cannot back up.
  const spanLabel = useMemo(() => {
    if (!stats) return { start: '', mid: '' };
    const startMs = Date.parse(stats.timelineStart);
    const endMs = Date.parse(stats.timelineEnd);
    const hours = Math.max(1, Math.round((endMs - startMs) / 3_600_000));
    return { start: `−${hours}H`, mid: `−${Math.round(hours / 2)}H` };
  }, [stats]);

  if (!open) return null;

  return (
    <div className="statsview" role="dialog" aria-label="Analytics">
      <div className="statsview__inner">
        <header className="statsview__head">
          <h2 className="statsview__title">ANALYTICS</h2>
          <span className="statsview__sub micro">
            {stats
              ? `GENERATED ${formatRelative(stats.generatedAt)} AGO · ${stats.total.toLocaleString()} RECORDS STORED`
              : 'AWAITING DATA'}
          </span>
          <span className="panel__head-spacer" />
          <button type="button" className="btn btn--sm" onClick={() => setUi({ statsOpen: false })}>
            CLOSE
          </button>
        </header>

        {!stats ? (
          <div className="empty">
            <span className="micro">NO STATISTICS YET</span>
          </div>
        ) : (
          <div className="statsview__grid">
            {/* --------------------------- headline --------------------- */}
            <div className="statsblock statsblock--wide">
              <div className="statsblock__title">VOLUME</div>
              <div className="bignums">
                <BigNum value={stats.last15Minutes} unit="LAST 15 MIN" />
                <BigNum value={stats.lastHour} unit="LAST HOUR" />
                <BigNum value={stats.today} unit="TODAY" />
                <BigNum value={stats.total} unit="TOTAL STORED" />
                <BigNum value={patterns.length} unit="ACTIVE CLUSTERS" tone="var(--violet)" />
              </div>
            </div>

            {/* --------------------------- timeline --------------------- */}
            <div className="statsblock statsblock--wide">
              <div className="statsblock__title">
                ACTIVITY OVER TIME
                <span className="statsblock__note micro">
                  PEAK {peak} / {stats?.timelineBucketMinutes ?? 30} MIN BUCKET
                </span>
              </div>
              <Histogram
                values={timeline}
                height={72}
                label={`incidents per ${stats.timelineBucketMinutes} minute bucket`}
              />
              <div className="statsblock__axis">
                <span className="micro">{spanLabel.start}</span>
                <span className="micro">{spanLabel.mid}</span>
                <span className="micro">NOW</span>
              </div>
            </div>

            {/* ------------------------- by category -------------------- */}
            <div className="statsblock">
              <div className="statsblock__title">BY CATEGORY</div>
              <DistributionList
                rows={stats.byType.map((bucket) => ({
                  key: bucket.key,
                  label: INCIDENT_TYPE_META[bucket.key as 'theft']?.label ?? bucket.label,
                  count: bucket.count,
                  tone: accentColor(bucket.key),
                }))}
              />
            </div>

            {/* --------------------------- by area ---------------------- */}
            <div className="statsblock">
              <div className="statsblock__title">BY AREA</div>
              <DistributionList
                rows={stats.byArea.map((bucket) => ({
                  key: bucket.key,
                  label: bucket.label,
                  count: bucket.count,
                  tone: 'var(--cyan)',
                }))}
              />
            </div>

            {/* ------------------------- by severity -------------------- */}
            <div className="statsblock">
              <div className="statsblock__title">BY SEVERITY</div>
              <DistributionList
                rows={stats.bySeverity.map((bucket) => ({
                  key: bucket.key,
                  label: `${bucket.key} · ${bucket.label}`,
                  count: bucket.count,
                  tone: `var(--sev-${bucket.key})`,
                }))}
              />
            </div>

            {/* --------------------------- clusters --------------------- */}
            <div className="statsblock">
              <div className="statsblock__title">
                ACTIVE CLUSTERS
                <Chip tone="violet">INFERENCE</Chip>
              </div>
              {patterns.length === 0 ? (
                <div className="empty">
                  <span className="micro">NO CONCENTRATIONS ABOVE THRESHOLD</span>
                </div>
              ) : (
                <div className="clusterlist">
                  {patterns.slice(0, 8).map((pattern) => (
                    <div key={pattern.id} className="clusterlist__row">
                      <span className="mono clusterlist__id">{pattern.id}</span>
                      <span className="clusterlist__type">
                        {INCIDENT_TYPE_META[pattern.dominantType].label}
                      </span>
                      <span className="mono clusterlist__count">{pattern.count}</span>
                      <span className="mono clusterlist__conf">
                        {formatPercent(pattern.confidence)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ------------------------- data quality ------------------- */}
            <div className="statsblock statsblock--wide">
              <div className="statsblock__title">DATA QUALITY &amp; SOURCES</div>
              <div className="quality">
                <div className="quality__item">
                  <span className="label">MEDIAN CONFIDENCE</span>
                  <span className="mono quality__value">{formatPercent(stats.medianConfidence)}</span>
                </div>
                <div className="quality__item">
                  <span className="label">WITHOUT POSITION</span>
                  <span className="mono quality__value">{stats.withoutCoordinates}</span>
                </div>
                {sources.map((source) => (
                  <div key={source.id} className="quality__item">
                    <span className="label">{source.name.toUpperCase()}</span>
                    <span className="mono quality__value">
                      {source.eventsIngested}
                      {source.eventsRejected > 0 && (
                        <em className="quality__rej"> / {source.eventsRejected} REJ</em>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BigNum({ value, unit, tone }: { value: number; unit: string; tone?: string }) {
  return (
    <div className="bignum">
      <span className="bignum__value" style={tone ? { color: tone } : undefined}>
        {value.toLocaleString()}
      </span>
      <span className="bignum__unit">{unit}</span>
    </div>
  );
}

function DistributionList({
  rows,
}: {
  rows: readonly { key: string; label: string; count: number; tone: string }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (rows.length === 0) {
    return (
      <div className="empty">
        <span className="micro">NO DATA IN WINDOW</span>
      </div>
    );
  }
  return (
    <div className="dist">
      {rows.slice(0, 10).map((row) => (
        <div key={row.key} className="dist__row">
          <span className="dist__label truncate">{row.label}</span>
          <span className="dist__bar">
            <span
              className="dist__fill"
              style={{ width: `${(row.count / max) * 100}%`, background: row.tone }}
            />
          </span>
          <span className="dist__count mono">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

function accentColor(type: string): string {
  const meta = INCIDENT_TYPE_META[type as 'theft'];
  switch (meta?.accent) {
    case 'critical':
      return 'var(--crimson)';
    case 'elevated':
      return 'var(--amber)';
    case 'support':
      return 'var(--slate)';
    default:
      return 'var(--cyan)';
  }
}

export type { Stats };
