// Service worker: makes the app open without internet (emergency map),
// and keeps recently viewed map tiles for offline use. No data is sent anywhere.
const VERSION = 'smartmap-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './app.css',
  './app.js', './util.js', './store.js', './sources.js', './laws.js',
  './icon-180.png', './icon-192.png', './icon-512.png'
];
const LIBS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js'
];
const TILE_CACHE = 'smartmap-tiles';
const MAX_TILES = 600;
const TILE_HOSTS = ['tile.openstreetmap.org', 'basemaps.cartocdn.com', 'server.arcgisonline.com', 'tile.opentopomap.org'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL);
    await Promise.all(LIBS.map(async u => {
      try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await c.put(u, r); } catch {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== TILE_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell + libraries: cache first, refresh in background
  if (url.origin === self.location.origin || LIBS.includes(req.url)) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = await c.match(req, { ignoreSearch: url.origin === self.location.origin });
      const net = fetch(req).then(r => { if (r.ok && url.origin === self.location.origin) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || (url.pathname.endsWith('/') ? c.match('./index.html') : Response.error());
    })());
    return;
  }

  // Base-map tiles: cache first (offline map of places you have viewed)
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith((async () => {
      const c = await caches.open(TILE_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trimTiles(); }
        return r;
      } catch { return Response.error(); }
    })());
  }
  // Everything else (live data) always goes to the network.
});
