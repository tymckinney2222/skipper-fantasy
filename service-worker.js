/**
 * Skipper service worker
 *
 * Strategy:
 *  - On install: pre-cache the app shell (index.html + manifest + icons)
 *  - On fetch:
 *      * For navigation requests: network-first, fall back to cached index.html
 *        so the app loads even offline (PWA shell pattern)
 *      * For static same-origin assets (icons, manifest): cache-first
 *      * For everything else (API calls, 3rd-party): pass through to network
 *  - On activate: clean up old caches
 *
 * Bump CACHE_VERSION whenever you ship a breaking change so users get the new
 * shell on their next visit.
 */

const CACHE_VERSION = 'skipper-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon.ico'
];

// ---- Install: pre-cache the app shell ------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Use addAll with individual catches so one missing asset doesn't kill install
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW: skip caching', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ---- Activate: clean up old caches ---------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ---- Fetch: network-first for navigation, cache-first for static ---------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests from our own origin
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Navigation requests (HTML): network-first, fall back to cached index
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Update cached shell on successful fetch
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Static same-origin assets: cache-first
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Only cache successful basic responses (no opaque, no errors)
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
