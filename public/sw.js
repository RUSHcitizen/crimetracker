/*
 * Service worker.
 *
 * The point of offline support here is not a nicety: the entire simulation — planets, the
 * Moon, orbits, time travel — is computed in the browser from baked-in theory. With the
 * app shell cached, SPACE RADAR is fully functional on a plane. Only the live feeds
 * (satellite elements, JPL vectors, close approaches) need the network, and the UI already
 * says when they are unavailable.
 *
 * Strategies:
 *   app shell  cache-first, revalidated in the background
 *   /api/*     network-first with a short-lived fallback, so a dead feed degrades to a
 *              stale answer rather than to nothing
 */

const VERSION = 'space-radar-v1';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

const PRECACHE = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // addAll rejects the whole install if any single entry 404s; tolerate that.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: false });

  const network = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (hit) {
    // Stale-while-revalidate: serve instantly, refresh for next time.
    void network;
    return hit;
  }

  const fresh = await network;
  if (fresh) return fresh;

  // Navigations fall back to the cached shell so a cold offline load still works.
  if (request.mode === 'navigate') {
    const shell = await cache.match('/');
    if (shell) return shell;
  }
  return new Response('Offline and not cached', { status: 504, statusText: 'Offline' });
}

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const response = await fetch(request);
    if (response.ok) void cache.put(request, response.clone());
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Shape-compatible with what the client expects, so the DATA panel can explain itself.
    return new Response(
      JSON.stringify({
        ok: false,
        data: null,
        source: 'service worker',
        fetchedAt: new Date().toISOString(),
        error: 'offline — no cached response for this feed',
      }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
}
