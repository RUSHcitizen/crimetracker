import {
  formatPercent,
  formatRelative,
  formatUtcStamp,
  INCIDENT_TYPE_META,
  SEVERITY_LABEL,
  STATUS_LABEL,
  type Incident,
  type ProvenanceEntry,
  type ProvenanceField,
} from '@crimetracker/shared';
import { useTracker } from '../state/store.js';
import { useSelectedIncident } from '../state/selectors.js';
import { Chip, EmptyState, Meter, Panel, Section } from '../components/primitives.js';
import { IncidentBriefPanel } from './IncidentBrief.js';

const PROCESSING_STAGES: { key: string; label: string }[] = [
  { key: 'received', label: 'RECEIVED' },
  { key: 'transcribing', label: 'TRANSCRIBE' },
  { key: 'extracting', label: 'EXTRACT' },
  { key: 'normalized', label: 'NORMALIZE' },
  { key: 'verified', label: 'CONFIRM' },
];

/**
 * The incident detail readout.
 *
 * Its most important job is honesty about where each value came from: any field whose
 * provenance is `ai-inferred` is chipped `AI-INFERRED` in violet, an approximate position
 * says so explicitly, and a missing position is stated rather than hidden.
 */
export function RightPanel() {
  const incident = useSelectedIncident();
  const select = useTracker((s) => s.select);

  return (
    <Panel
      title="Incident Detail"
      count={incident ? incident.id.split(':').pop()?.slice(0, 10) : undefined}
      actions={
        incident ? (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => select(null)}>
            CLOSE
          </button>
        ) : null
      }
      className="panel--right"
    >
      <div className="panel__body">
        {!incident ? (
          <div className="detail-idle">
            <div className="detail-idle__reticle" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
            <EmptyState>SELECT AN INCIDENT ON THE MAP OR IN THE FEED</EmptyState>
          </div>
        ) : (
          <IncidentDetail incident={incident} />
        )}
      </div>
    </Panel>
  );
}

function IncidentDetail({ incident }: { incident: Incident }) {
  const meta = INCIDENT_TYPE_META[incident.incidentType];
  const stageIndex = PROCESSING_STAGES.findIndex((s) => s.key === incident.status);
  const processing = incident.status === 'transcribing' || incident.status === 'extracting';
  const aiFields = (Object.entries(incident.provenance) as [ProvenanceField, ProvenanceEntry][])
    .filter(([, entry]) => entry?.origin === 'ai-inferred');

  return (
    <div className="detail" key={incident.id}>
      {/* The brief comes first: it is the answer to "what is this?", and everything
          below it is the evidence for that answer. */}
      <IncidentBriefPanel incident={incident} />

      {/* ------------------------------ headline ------------------------- */}
      <div className={`detail__head detail__head--${meta.accent}`}>
        <div className="detail__glyph" aria-hidden="true">
          {meta.glyph}
        </div>
        <div className="detail__headtext">
          <div className="detail__type">{meta.label}</div>
          <div className="detail__sev">
            <span style={{ color: `var(--sev-${incident.severity})` }}>
              SEV {incident.severity} · {SEVERITY_LABEL[incident.severity]}
            </span>
          </div>
        </div>
        <div className="detail__age mono">{formatRelative(incident.timestamp)}</div>
      </div>

      {/* --------------------------- primary facts ----------------------- */}
      <Section>
        <div className="readout">
          <Readout k="TIME" v={formatUtcStamp(incident.timestamp)} mono />
          <Readout k="INGESTED" v={formatUtcStamp(incident.ingestedAt)} mono />
          <Readout
            k="AREA"
            v={
              <>
                {incident.location.label}
                {incident.location.area && (
                  <span className="detail__subtle"> · {incident.location.area}</span>
                )}
              </>
            }
          />
          <Readout
            k="POSITION"
            v={
              incident.coordinates ? (
                <span className="mono">
                  {incident.coordinates.lat.toFixed(4)}, {incident.coordinates.lon.toFixed(4)}
                </span>
              ) : (
                <span className="detail__warn">NOT DETERMINED</span>
              )
            }
          />
          <Readout
            k="SOURCE"
            v={
              <>
                {incident.source.name}{' '}
                <Chip tone="cyan">{incident.source.kind.toUpperCase()}</Chip>
              </>
            }
          />
          <Readout k="STATUS" v={STATUS_LABEL[incident.status]} mono />
        </div>

        <div className="detail__flags">
          {incident.location.approximate && (
            <Chip tone="amber" title="The position is area- or block-level, not an exact point.">
              APPROXIMATE LOCATION
            </Chip>
          )}
          <Chip tone="ghost">PRECISION {incident.location.precision.toUpperCase()}</Chip>
          {aiFields.length > 0 && (
            <Chip tone="violet" title="One or more fields were produced by a model, not the source.">
              CONTAINS AI INFERENCE
            </Chip>
          )}
        </div>
      </Section>

      {/* ---------------------------- confidence ------------------------- */}
      <Section title="Confidence">
        <div className="detail__confrow">
          <span className="stat__value stat__value--sm">{formatPercent(incident.confidence)}</span>
          <div className="detail__confbar">
            <Meter
              value={incident.confidence}
              tone={incident.confidence > 0.7 ? 'var(--green)' : 'var(--amber)'}
            />
            <span className="micro">
              {incident.confidence > 0.75
                ? 'WELL-SUPPORTED RECORD'
                : incident.confidence > 0.5
                  ? 'PARTIALLY SUPPORTED'
                  : 'LOW SUPPORT — TREAT AS UNCONFIRMED'}
            </span>
          </div>
        </div>
      </Section>

      {/* -------------------------- processing state --------------------- */}
      <Section title="Processing">
        <div className="stages">
          {PROCESSING_STAGES.map((stage, index) => (
            <div
              key={stage.key}
              className={`stage ${index <= stageIndex ? 'stage--done' : ''} ${
                index === stageIndex ? 'stage--current' : ''
              }`}
            >
              <span className="stage__pip" />
              <span className="stage__label">{stage.label}</span>
            </div>
          ))}
        </div>
        {processing && <div className="scanbar" style={{ marginTop: 6 }} />}
      </Section>

      {/* ------------------------ source information --------------------- */}
      <Section title="Source Information">
        <p className="detail__desc">{incident.description}</p>
        <div className="detail__provrow">
          {(['description', 'incidentType', 'severity', 'location', 'coordinates'] as ProvenanceField[]).map(
            (field) => {
              const entry = incident.provenance[field];
              if (!entry) return null;
              return <ProvenanceChip key={field} field={field} entry={entry} />;
            },
          )}
        </div>
      </Section>

      {/* ----------------------------- transcript ------------------------ */}
      {incident.transcript && (
        <Section title="Transcript">
          <pre className="transcript">{incident.transcript}</pre>
          <span className="micro">
            VERBATIM FROM SOURCE · NOT EDITED
          </span>
        </Section>
      )}

      {/* ------------------------ extracted information ------------------ */}
      <Section title="Extracted Information">
        {aiFields.length === 0 ? (
          <div className="detail__noai">
            <Chip tone="green">NO AI INFERENCE</Chip>
            <span className="micro" style={{ marginLeft: 6 }}>
              EVERY FIELD ABOVE CAME FROM THE SOURCE
            </span>
          </div>
        ) : (
          <>
            <div className="ai-note">
              <Chip tone="violet">AI-INFERRED</Chip>
              <span className="micro">
                DERIVED BY A MODEL FROM THE TRANSCRIPT — NOT CONFIRMED BY THE SOURCE
              </span>
            </div>
            <div className="readout" style={{ marginTop: 7 }}>
              {aiFields.map(([field, entry]) => (
                <Readout
                  key={field}
                  k={field.toUpperCase()}
                  v={
                    <>
                      <span className="ai-value">{String(valueOf(incident, field))}</span>
                      {entry.confidence != null && (
                        <span className="detail__subtle mono"> · {formatPercent(entry.confidence)}</span>
                      )}
                      {entry.note && <span className="detail__subtle"> · {entry.note}</span>}
                    </>
                  }
                />
              ))}
            </div>
          </>
        )}
      </Section>

      {incident.tags.length > 0 && (
        <Section title="Tags">
          <div className="detail__flags">
            {incident.tags.map((tag) => (
              <Chip key={tag} tone="ghost">
                {tag}
              </Chip>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Readout({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <span className="readout__k">{k}</span>
      <span className={`readout__v ${mono ? 'readout__v--mono' : ''}`}>{v}</span>
    </>
  );
}

function ProvenanceChip({ field, entry }: { field: ProvenanceField; entry: ProvenanceEntry }) {
  const tone = entry.origin === 'ai-inferred' ? 'violet' : entry.origin === 'derived' ? 'amber' : 'cyan';
  const label =
    entry.origin === 'ai-inferred' ? 'AI' : entry.origin === 'derived' ? 'DERIVED' : 'SOURCE';
  return (
    <Chip tone={tone} title={entry.note ?? `${field}: ${entry.origin}`}>
      {field.replace('incidentType', 'TYPE').toUpperCase()} · {label}
    </Chip>
  );
}

function valueOf(incident: Incident, field: ProvenanceField): unknown {
  switch (field) {
    case 'incidentType':
      return INCIDENT_TYPE_META[incident.incidentType].label;
    case 'location':
      return incident.location.label;
    case 'coordinates':
      return incident.coordinates
        ? `${incident.coordinates.lat}, ${incident.coordinates.lon}`
        : 'none';
    case 'timestamp':
      return incident.timestamp;
    case 'transcript':
      return 'see transcript';
    default:
      return incident[field];
  }
}
