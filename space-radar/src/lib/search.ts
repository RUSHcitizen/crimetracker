import type { SpaceObject } from './data/types';

/**
 * Search.
 *
 * The catalogue is small enough (tens to low hundreds of objects, including anything
 * pulled in live) that a scan per keystroke costs microseconds. No index, no library, no
 * debounce needed — which keeps the "type three letters, hit enter, fly there" loop as
 * fast as it should be.
 */

export interface SearchHit {
  object: SpaceObject;
  score: number;
  /** Character ranges in the display name that matched, for highlighting. */
  ranges: [number, number][];
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();

/** Subsequence match, e.g. "vgr1" -> "voyager 1". Returns null if it does not match. */
function subsequence(haystack: string, needle: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  let hi = 0;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]!;
    const found = haystack.indexOf(ch, hi);
    if (found === -1) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    hi = found + 1;
  }
  return ranges;
}

export function searchObjects(objects: SpaceObject[], query: string, limit = 12): SearchHit[] {
  const q = normalise(query);
  if (!q) return [];

  const hits: SearchHit[] = [];

  for (const object of objects) {
    const name = normalise(object.name);
    const haystacks = [name, ...(object.aliases ?? []).map(normalise), normalise(object.subtitle ?? '')];

    let best = -Infinity;
    let bestRanges: [number, number][] = [];

    haystacks.forEach((hay, index) => {
      if (!hay) return;
      // Exact and prefix matches dominate; the alias and subtitle fields are discounted so
      // "MARS" never loses to something whose subtitle mentions Mars.
      const fieldPenalty = index === 0 ? 0 : index === 1 ? 14 : 34;
      let score: number | null = null;
      let ranges: [number, number][] = [];

      if (hay === q) {
        score = 1000;
        ranges = [[0, q.length]];
      } else if (hay.startsWith(q)) {
        score = 800 - hay.length;
        ranges = [[0, q.length]];
      } else {
        const wordStart = hay.split(' ').some((w) => w.startsWith(q));
        const idx = hay.indexOf(q);
        if (idx >= 0) {
          score = (wordStart ? 600 : 420) - idx * 3 - hay.length;
          ranges = [[idx, idx + q.length]];
        } else {
          const sub = subsequence(hay, q.replace(/ /g, ''));
          if (sub) {
            score = 240 - (sub[sub.length - 1]![1] - sub[0]![0]) - hay.length;
            ranges = sub;
          }
        }
      }

      if (score !== null) {
        const adjusted = score - fieldPenalty;
        if (adjusted > best) {
          best = adjusted;
          bestRanges = index === 0 ? ranges : [];
        }
      }
    });

    if (best > -Infinity) {
      // Prominence breaks ties: a planet outranks a demo satellite at the same score.
      hits.push({ object, score: best + object.weight * 24, ranges: bestRanges });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** What to show before anything has been typed. */
export function searchSuggestions(objects: SpaceObject[], limit = 8): SpaceObject[] {
  const featured = ['voyager-1', 'earth', 'moon', 'mars', 'jwst', 'apophis', 'halley', 'parker-solar-probe'];
  const byId = new Map(objects.map((o) => [o.id, o]));
  const out: SpaceObject[] = [];
  for (const id of featured) {
    const o = byId.get(id);
    if (o) out.push(o);
    if (out.length >= limit) break;
  }
  return out;
}
