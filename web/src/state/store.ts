import { create } from 'zustand';
import type {
  AppMode,
  Incident,
  IncidentType,
  PatternCluster,
  ServerFrame,
  SourceStatus,
  Stats,
} from '@crimetracker/shared';

/**
 * Client state.
 *
 * Incidents are held in a bounded ring: the newest `MAX_INCIDENTS` are kept in memory and
 * everything older is dropped, so a long-running session cannot grow without limit. The
 * full history always remains queryable through the REST API.
 */
export const MAX_INCIDENTS = 6000;

/** Ids of incidents that arrived in the last few seconds, for spawn animations. */
const ARRIVAL_TTL_MS = 6000;

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export interface GeoFocus {
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
  readonly radiusKm: number;
}

export interface Filters {
  readonly types: ReadonlySet<IncidentType>;
  readonly minSeverity: number;
  readonly sinceMinutes: number;
  readonly sources: ReadonlySet<string>;
  readonly query: string;
  readonly geo: GeoFocus | null;
  /** Restrict to what is currently on screen. */
  readonly viewportOnly: boolean;
}

export interface UiState {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  statsOpen: boolean;
  searchOpen: boolean;
  patternsVisible: boolean;
  soundEnabled: boolean;
}

interface TrackerState {
  /* data */
  incidents: Incident[];
  byId: Map<string, Incident>;
  patterns: PatternCluster[];
  stats: Stats | null;
  sources: SourceStatus[];
  mode: AppMode;
  serverTime: string | null;
  /** Bumped whenever `incidents` changes identity — lets selectors memoize cheaply. */
  version: number;

  /* connection */
  connection: ConnectionState;
  lastFrameAt: number | null;
  snapshotReceived: boolean;

  /* selection */
  selectedId: string | null;
  focusedPatternId: string | null;
  recentArrivals: Map<string, number>;

  /* view */
  filters: Filters;
  viewportBounds: [number, number, number, number] | null;
  ui: UiState;

  /* actions */
  applyFrame: (frame: ServerFrame) => void;
  setConnection: (state: ConnectionState) => void;
  select: (id: string | null) => void;
  focusPattern: (id: string | null) => void;
  setFilters: (patch: Partial<Filters>) => void;
  toggleType: (type: IncidentType) => void;
  toggleSource: (id: string) => void;
  resetFilters: () => void;
  setViewportBounds: (bounds: [number, number, number, number] | null) => void;
  setUi: (patch: Partial<UiState>) => void;
  setMode: (mode: AppMode) => void;
  pruneArrivals: () => void;
}

export const DEFAULT_FILTERS: Filters = {
  types: new Set(),
  minSeverity: 1,
  sinceMinutes: 720,
  sources: new Set(),
  query: '',
  geo: null,
  viewportOnly: false,
};

const isNarrow = () => typeof window !== 'undefined' && window.innerWidth < 900;

export const useTracker = create<TrackerState>((set, get) => ({
  incidents: [],
  byId: new Map(),
  patterns: [],
  stats: null,
  sources: [],
  mode: 'simulation',
  serverTime: null,
  version: 0,

  connection: 'connecting',
  lastFrameAt: null,
  snapshotReceived: false,

  selectedId: null,
  focusedPatternId: null,
  recentArrivals: new Map(),

  filters: DEFAULT_FILTERS,
  viewportBounds: null,
  ui: {
    // On a phone the panels start collapsed so the map owns the screen.
    leftOpen: !isNarrow(),
    rightOpen: !isNarrow(),
    bottomOpen: !isNarrow(),
    statsOpen: false,
    searchOpen: false,
    patternsVisible: true,
    soundEnabled: false,
  },

  applyFrame: (frame) => {
    const now = Date.now();
    switch (frame.type) {
      case 'snapshot': {
        const byId = new Map<string, Incident>();
        for (const incident of frame.incidents) byId.set(incident.id, incident);
        set({
          incidents: sortNewestFirst([...byId.values()]).slice(0, MAX_INCIDENTS),
          byId,
          patterns: [...frame.patterns],
          stats: frame.stats,
          sources: [...frame.sources],
          mode: frame.mode,
          serverTime: frame.serverTime,
          snapshotReceived: true,
          lastFrameAt: now,
          version: get().version + 1,
        });
        break;
      }
      case 'incidents': {
        if (frame.incidents.length === 0) return;
        const byId = new Map(get().byId);
        const arrivals = new Map(get().recentArrivals);
        for (const incident of frame.incidents) {
          byId.set(incident.id, incident);
          arrivals.set(incident.id, now);
        }
        set({
          byId,
          incidents: sortNewestFirst([...byId.values()]).slice(0, MAX_INCIDENTS),
          recentArrivals: arrivals,
          lastFrameAt: now,
          version: get().version + 1,
        });
        break;
      }
      case 'incident:update': {
        const byId = new Map(get().byId);
        let touched = false;
        for (const incident of frame.incidents) {
          // Only apply updates for incidents we are still holding.
          if (!byId.has(incident.id)) continue;
          byId.set(incident.id, incident);
          touched = true;
        }
        if (!touched) return;
        set({
          byId,
          incidents: sortNewestFirst([...byId.values()]).slice(0, MAX_INCIDENTS),
          lastFrameAt: now,
          version: get().version + 1,
        });
        break;
      }
      case 'patterns':
        set({ patterns: [...frame.patterns], lastFrameAt: now });
        break;
      case 'stats':
        set({ stats: frame.stats, lastFrameAt: now });
        break;
      case 'sources':
        set({ sources: [...frame.sources], lastFrameAt: now });
        break;
      case 'mode':
        set({ mode: frame.mode, lastFrameAt: now });
        break;
      case 'pulse':
        set({ serverTime: frame.serverTime, lastFrameAt: now });
        break;
    }
  },

  setConnection: (connection) => set({ connection }),

  select: (selectedId) =>
    set((state) => ({
      selectedId,
      ui: selectedId && isNarrow() ? { ...state.ui, rightOpen: true } : state.ui,
    })),

  focusPattern: (focusedPatternId) => set({ focusedPatternId }),

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),

  toggleType: (type) =>
    set((state) => {
      const types = new Set(state.filters.types);
      if (types.has(type)) types.delete(type);
      else types.add(type);
      return { filters: { ...state.filters, types } };
    }),

  toggleSource: (id) =>
    set((state) => {
      const sources = new Set(state.filters.sources);
      if (sources.has(id)) sources.delete(id);
      else sources.add(id);
      return { filters: { ...state.filters, sources } };
    }),

  resetFilters: () => set({ filters: DEFAULT_FILTERS }),

  setViewportBounds: (viewportBounds) => set({ viewportBounds }),

  setUi: (patch) => set((state) => ({ ui: { ...state.ui, ...patch } })),

  setMode: (mode) => set({ mode }),

  pruneArrivals: () => {
    const arrivals = get().recentArrivals;
    if (arrivals.size === 0) return;
    const cutoff = Date.now() - ARRIVAL_TTL_MS;
    let changed = false;
    const next = new Map<string, number>();
    for (const [id, at] of arrivals) {
      if (at >= cutoff) next.set(id, at);
      else changed = true;
    }
    if (changed) set({ recentArrivals: next });
  },
}));

function sortNewestFirst(incidents: Incident[]): Incident[] {
  return incidents.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
}
