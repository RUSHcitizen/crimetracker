/**
 * Washington places used for geographic filtering and search.
 *
 * Ordinary public geographic facts (city centroids), bundled so geographic search works
 * without a geocoding service — no network call, no API key, no data leaving the browser.
 */

export interface Place {
  readonly label: string;
  readonly county: string;
  readonly lat: number;
  readonly lon: number;
  /** A sensible default view radius in kilometres. */
  readonly radiusKm: number;
}

export const WA_PLACES: readonly Place[] = [
  { label: 'Seattle', county: 'King', lat: 47.6062, lon: -122.3321, radiusKm: 16 },
  { label: 'Bellevue', county: 'King', lat: 47.6101, lon: -122.2015, radiusKm: 10 },
  { label: 'Redmond', county: 'King', lat: 47.674, lon: -122.1215, radiusKm: 8 },
  { label: 'Kirkland', county: 'King', lat: 47.6769, lon: -122.2059, radiusKm: 8 },
  { label: 'Renton', county: 'King', lat: 47.4829, lon: -122.2171, radiusKm: 10 },
  { label: 'Kent', county: 'King', lat: 47.3809, lon: -122.2348, radiusKm: 10 },
  { label: 'Federal Way', county: 'King', lat: 47.3223, lon: -122.3126, radiusKm: 9 },
  { label: 'Auburn', county: 'King', lat: 47.3073, lon: -122.2285, radiusKm: 9 },
  { label: 'Tacoma', county: 'Pierce', lat: 47.2529, lon: -122.4443, radiusKm: 14 },
  { label: 'Lakewood', county: 'Pierce', lat: 47.1718, lon: -122.5185, radiusKm: 9 },
  { label: 'Puyallup', county: 'Pierce', lat: 47.1854, lon: -122.2929, radiusKm: 9 },
  { label: 'Everett', county: 'Snohomish', lat: 47.9789, lon: -122.2021, radiusKm: 11 },
  { label: 'Lynnwood', county: 'Snohomish', lat: 47.8279, lon: -122.3051, radiusKm: 8 },
  { label: 'Marysville', county: 'Snohomish', lat: 48.0518, lon: -122.1771, radiusKm: 9 },
  { label: 'Spokane', county: 'Spokane', lat: 47.6588, lon: -117.426, radiusKm: 14 },
  { label: 'Spokane Valley', county: 'Spokane', lat: 47.6733, lon: -117.2394, radiusKm: 11 },
  { label: 'Vancouver', county: 'Clark', lat: 45.6387, lon: -122.6615, radiusKm: 13 },
  { label: 'Olympia', county: 'Thurston', lat: 47.0379, lon: -122.9007, radiusKm: 10 },
  { label: 'Lacey', county: 'Thurston', lat: 47.0343, lon: -122.8232, radiusKm: 8 },
  { label: 'Bellingham', county: 'Whatcom', lat: 48.7519, lon: -122.4787, radiusKm: 10 },
  { label: 'Mount Vernon', county: 'Skagit', lat: 48.4212, lon: -122.334, radiusKm: 8 },
  { label: 'Yakima', county: 'Yakima', lat: 46.6021, lon: -120.5059, radiusKm: 11 },
  { label: 'Kennewick', county: 'Benton', lat: 46.2112, lon: -119.1372, radiusKm: 10 },
  { label: 'Richland', county: 'Benton', lat: 46.2857, lon: -119.2845, radiusKm: 9 },
  { label: 'Pasco', county: 'Franklin', lat: 46.2396, lon: -119.1006, radiusKm: 9 },
  { label: 'Walla Walla', county: 'Walla Walla', lat: 46.0646, lon: -118.343, radiusKm: 8 },
  { label: 'Wenatchee', county: 'Chelan', lat: 47.4235, lon: -120.3103, radiusKm: 8 },
  { label: 'Moses Lake', county: 'Grant', lat: 47.1301, lon: -119.2781, radiusKm: 9 },
  { label: 'Ellensburg', county: 'Kittitas', lat: 46.9965, lon: -120.5478, radiusKm: 7 },
  { label: 'Bremerton', county: 'Kitsap', lat: 47.5673, lon: -122.6329, radiusKm: 9 },
  { label: 'Silverdale', county: 'Kitsap', lat: 47.6445, lon: -122.6949, radiusKm: 7 },
  { label: 'Port Angeles', county: 'Clallam', lat: 48.1181, lon: -123.4307, radiusKm: 8 },
  { label: 'Aberdeen', county: 'Grays Harbor', lat: 46.9754, lon: -123.8157, radiusKm: 8 },
  { label: 'Longview', county: 'Cowlitz', lat: 46.1382, lon: -122.9382, radiusKm: 8 },
  { label: 'Pullman', county: 'Whitman', lat: 46.7298, lon: -117.1817, radiusKm: 7 },
];

/** Case-insensitive prefix/substring match used by the command search. */
export function findPlaces(query: string, limit = 6): Place[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = WA_PLACES.map((place) => {
    const label = place.label.toLowerCase();
    if (label.startsWith(q)) return { place, score: 0 };
    if (label.includes(q)) return { place, score: 1 };
    if (place.county.toLowerCase().includes(q)) return { place, score: 2 };
    return null;
  }).filter((entry): entry is { place: Place; score: number } => entry !== null);

  return scored
    .sort((a, b) => a.score - b.score || a.place.label.localeCompare(b.place.label))
    .slice(0, limit)
    .map((entry) => entry.place);
}
