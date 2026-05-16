/**
 * Timelapse Capture — service worker.
 * Strategy:
 *   - HTML (navigation): network-first, fall back to cache.
 *   - Assets (script, style, font, image): cache-first, fetch + cache miss.
 * On version bump, old caches are deleted.
 */

const CACHE_NAME = 'tlc-v1';

self.addEventListener('install', (event) => {
  // Activate immediately on first install
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Don't try to cache cross-origin requests we can't control
  // (Google Fonts will use stale-while-revalidate naturally below).
  const isNavigate = req.mode === 'navigate' || (req.destination === 'document');

  if (isNavigate) {
    event.respondWith(networkFirst(req));
  } else if (
    req.destination === 'script' ||
    req.destination === 'style' ||
    req.destination === 'font' ||
    req.destination === 'image' ||
    req.destination === 'manifest' ||
    url.pathname.endsWith('.webmanifest')
  ) {
    event.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Last resort: cached root
    const root = await caches.match('/');
    return root || Response.error();
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    return Response.error();
  }
}
