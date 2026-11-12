// Caches the app shell so it opens offline; data always comes fresh from GitHub (app.js keeps the last copy).
const SHELL = 'stats2-v2'; // bump together with APP_V in app.js
const FILES = ['./', 'index.html', 'style.css', 'v2.css', 'app.js', 'log.js', 'v2.js', 'body.js', 'graph.js', 'vendor/d3-force.min.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('stats2-') && k !== SHELL).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // network first, so a new version shows up right away; cache when offline.
  // cache: 'no-cache' = always ask GitHub Pages (ETag check), never the browser's 10-min HTTP cache (Pages sends max-age=600)
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
