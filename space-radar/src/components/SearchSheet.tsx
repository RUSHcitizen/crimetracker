import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AU_KM } from '../lib/astro/constants';
import type { SpaceObject } from '../lib/data/types';
import { searchObjects, searchSuggestions, type SearchHit } from '../lib/search';
import type { Engine } from '../lib/render/engine';
import { Sheet } from './Sheet';
import { IconSearch } from './icons';

/**
 * Search.
 *
 * Filters on every keystroke against the in-memory catalogue — no debounce, because there
 * is nothing to wait for. Enter flies to the top hit, which makes "mars ⏎" a one-gesture
 * way to cross the Solar System.
 */

function highlight(name: string, ranges: [number, number][]) {
  if (ranges.length === 0) return name;
  const out: (string | preact.JSX.Element)[] = [];
  let cursor = 0;
  ranges.forEach(([a, b], i) => {
    if (a > cursor) out.push(name.slice(cursor, a));
    out.push(<mark key={i}>{name.slice(a, b)}</mark>);
    cursor = b;
  });
  if (cursor < name.length) out.push(name.slice(cursor));
  return out;
}

export function SearchSheet(props: { engine: Engine; onClose: () => void; onPick: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const objects = useMemo(() => props.engine.world.objects, [props.engine]);

  const hits: SearchHit[] = useMemo(() => {
    if (query.trim().length === 0) {
      return searchSuggestions(objects).map((object) => ({ object, score: 0, ranges: [] }));
    }
    return searchObjects(objects, query);
  }, [objects, query]);

  useEffect(() => {
    // Autofocus on desktop only: on a phone this yanks the keyboard up over the results.
    if (window.matchMedia('(min-width: 900px)').matches) inputRef.current?.focus();
  }, []);

  const describe = (o: SpaceObject): string => {
    const r = props.engine.readout(o.id);
    if (!r) return o.kind.toUpperCase();
    if (r.unplaced) return 'ORBIT ONLY';
    const km = r.distanceFromEarthKm;
    return km > 0.01 * AU_KM
      ? `${(km / AU_KM).toFixed(3)} AU`
      : `${Math.round(km).toLocaleString('en-US')} km`;
  };

  return (
    <Sheet
      title="SEARCH"
      note={`${objects.length} OBJECTS`}
      onClose={props.onClose}
      sticky={
        <div class="searchfield">
          <IconSearch style={{ width: 15, height: 15, color: 'var(--faint)', flex: 'none' }} />
          <input
            ref={inputRef}
            value={query}
            placeholder="VOYAGER 1 · MARS · ISS · APOPHIS"
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hits[0]) props.onPick(hits[0].object.id);
            }}
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            aria-label="Search objects"
            enterkeyhint="go"
          />
          {query ? (
            <button class="btn" onClick={() => setQuery('')} style={{ padding: '4px 8px', minHeight: 26 }}>
              CLR
            </button>
          ) : null}
        </div>
      }
    >
      {query.trim().length === 0 ? (
        <div class="sheet-head" style={{ borderBottom: 'none', paddingBottom: 2 }}>
          <span class="note">SUGGESTED</span>
        </div>
      ) : null}

      {hits.length === 0 ? (
        <div class="prose">
          <p>Nothing in the catalogue matches “{query}”.</p>
          <p>
            This instrument carries the planets, their major moons, the deep-space probes, a set of
            named small bodies, and whatever live satellite elements it could reach. It is not a
            complete sky survey — the real small-body catalogue runs to well over a million objects.
          </p>
        </div>
      ) : (
        hits.map((hit) => (
          <button class="result" key={hit.object.id} onClick={() => props.onPick(hit.object.id)}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: hit.object.color,
                flex: 'none',
              }}
            />
            <span style={{ minWidth: 0 }}>
              <div class="rname">{highlight(hit.object.name, hit.ranges)}</div>
              <div class="rsub">{hit.object.subtitle ?? hit.object.kind.toUpperCase()}</div>
            </span>
            <span class="rmeta">
              <div class="rsub" style={{ margin: 0, color: 'var(--dim)' }}>{describe(hit.object)}</div>
              <div class="rsub" style={{ color: hit.object.provenance.tier === 'simulated' ? 'var(--sim)' : 'var(--faint)' }}>
                {hit.object.provenance.tier.toUpperCase()}
              </div>
            </span>
          </button>
        ))
      )}
    </Sheet>
  );
}
