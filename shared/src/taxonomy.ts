/**
 * The controlled vocabularies of the system. Everything that crosses the wire is
 * checked against these lists — an unknown value from an external source is mapped to a
 * safe fallback rather than being passed through.
 */

export const INCIDENT_TYPES = [
  'assault',
  'robbery',
  'burglary',
  'theft',
  'vehicle',
  'weapons',
  'disturbance',
  'traffic',
  'fire',
  'medical',
  'hazard',
  'missing-person',
  'suspicious',
  'other',
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export interface IncidentTypeMeta {
  readonly id: IncidentType;
  /** Short display label used across the HUD. */
  readonly label: string;
  /** Two-letter glyph used on dense readouts and map labels. */
  readonly glyph: string;
  /** Baseline severity when a source does not provide one. */
  readonly baseSeverity: SeverityLevel;
  /** Accent family — the UI keeps a deliberately restrained palette. */
  readonly accent: 'critical' | 'elevated' | 'standard' | 'support';
  /** Words that map free text onto this type. Ordered by specificity. */
  readonly keywords: readonly string[];
}

export const INCIDENT_TYPE_META: Record<IncidentType, IncidentTypeMeta> = {
  assault: {
    id: 'assault',
    label: 'Assault',
    glyph: 'AS',
    baseSeverity: 4,
    accent: 'critical',
    keywords: ['assault', 'fight in progress', 'battery', 'altercation', 'stabbing', 'struck'],
  },
  robbery: {
    id: 'robbery',
    label: 'Robbery',
    glyph: 'RB',
    baseSeverity: 4,
    accent: 'critical',
    keywords: ['robbery', 'armed robbery', 'strong arm', 'holdup', 'mugging'],
  },
  burglary: {
    id: 'burglary',
    label: 'Burglary',
    glyph: 'BG',
    baseSeverity: 3,
    accent: 'elevated',
    keywords: ['burglary', 'break in', 'breaking and entering', 'forced entry', 'prowler'],
  },
  theft: {
    id: 'theft',
    label: 'Theft',
    glyph: 'TH',
    baseSeverity: 2,
    accent: 'standard',
    keywords: ['theft', 'shoplifting', 'larceny', 'stolen', 'package theft', 'catalytic'],
  },
  vehicle: {
    id: 'vehicle',
    label: 'Vehicle',
    glyph: 'VH',
    baseSeverity: 3,
    accent: 'standard',
    keywords: ['stolen vehicle', 'vehicle prowl', 'carjacking', 'reckless driver', 'hit and run'],
  },
  weapons: {
    id: 'weapons',
    label: 'Weapons',
    glyph: 'WP',
    baseSeverity: 5,
    accent: 'critical',
    keywords: ['shots fired', 'weapon', 'firearm', 'gunshot', 'brandishing'],
  },
  disturbance: {
    id: 'disturbance',
    label: 'Disturbance',
    glyph: 'DS',
    baseSeverity: 2,
    accent: 'standard',
    keywords: ['disturbance', 'noise complaint', 'disorderly', 'trespass', 'harassment'],
  },
  traffic: {
    id: 'traffic',
    label: 'Traffic',
    glyph: 'TR',
    baseSeverity: 2,
    accent: 'support',
    keywords: ['collision', 'traffic', 'mva', 'road blocked', 'disabled vehicle'],
  },
  fire: {
    id: 'fire',
    label: 'Fire',
    glyph: 'FR',
    baseSeverity: 4,
    accent: 'elevated',
    keywords: ['fire', 'structure fire', 'smoke', 'brush fire', 'alarm sounding'],
  },
  medical: {
    id: 'medical',
    label: 'Medical',
    glyph: 'MD',
    baseSeverity: 3,
    accent: 'support',
    keywords: ['medical', 'aid', 'unconscious', 'cardiac', 'overdose', 'injury'],
  },
  hazard: {
    id: 'hazard',
    label: 'Hazard',
    glyph: 'HZ',
    baseSeverity: 3,
    accent: 'elevated',
    keywords: ['hazard', 'gas leak', 'wires down', 'spill', 'flooding', 'debris'],
  },
  'missing-person': {
    id: 'missing-person',
    label: 'Missing Person',
    glyph: 'MP',
    baseSeverity: 4,
    accent: 'elevated',
    keywords: ['missing', 'welfare check', 'runaway', 'lost child'],
  },
  suspicious: {
    id: 'suspicious',
    label: 'Suspicious',
    glyph: 'SP',
    baseSeverity: 2,
    accent: 'standard',
    keywords: ['suspicious', 'unknown circumstances', 'check the area', 'loitering'],
  },
  other: {
    id: 'other',
    label: 'Other',
    glyph: 'OT',
    baseSeverity: 1,
    accent: 'support',
    keywords: [],
  },
};

export const SEVERITY_LEVELS = [1, 2, 3, 4, 5] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_LABEL: Record<SeverityLevel, string> = {
  1: 'INFO',
  2: 'LOW',
  3: 'MODERATE',
  4: 'HIGH',
  5: 'CRITICAL',
};

/** Lifecycle of an incident as it moves through the pipeline. */
export const INCIDENT_STATUSES = [
  'received',
  'transcribing',
  'extracting',
  'normalized',
  'verified',
  'unresolved',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  received: 'RECEIVED',
  transcribing: 'TRANSCRIBING',
  extracting: 'EXTRACTING',
  normalized: 'NORMALIZED',
  verified: 'CONFIRMED',
  unresolved: 'UNRESOLVED',
};

/** Where a source sits on the trust spectrum. */
export const SOURCE_KINDS = ['simulation', 'public-feed', 'audio', 'manual'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * How a field's value came to exist. The UI must never render `ai-inferred` the same way
 * it renders `source`.
 */
export const PROVENANCE_ORIGINS = ['source', 'ai-inferred', 'derived', 'simulated'] as const;
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];

export const LOCATION_PRECISIONS = ['exact', 'block', 'area', 'unknown'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

/** Resolve free text onto an incident type. Returns `other` when nothing matches. */
export function classifyText(text: string): { type: IncidentType; matched: string | null } {
  const haystack = text.toLowerCase();
  let best: { type: IncidentType; matched: string; weight: number } | null = null;
  for (const meta of Object.values(INCIDENT_TYPE_META)) {
    for (const keyword of meta.keywords) {
      if (!haystack.includes(keyword)) continue;
      // Longer keyword matches are more specific and win.
      const weight = keyword.length;
      if (!best || weight > best.weight) best = { type: meta.id, matched: keyword, weight };
    }
  }
  return best ? { type: best.type, matched: best.matched } : { type: 'other', matched: null };
}

export function isIncidentType(value: unknown): value is IncidentType {
  return typeof value === 'string' && (INCIDENT_TYPES as readonly string[]).includes(value);
}

export function coerceSeverity(value: unknown, fallback: SeverityLevel = 2): SeverityLevel {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const clamped = Math.min(5, Math.max(1, Math.round(n)));
  return clamped as SeverityLevel;
}
