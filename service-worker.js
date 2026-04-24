/* ============================================================
   BucaMap Service Worker
   Strategy:
     - Core shell (HTML, icons, manifest) → Cache First
     - App images                          → Cache First  (pre-cached on install)
     - Google Fonts / Leaflet CDN          → Stale-While-Revalidate
     - CartoDB map tiles                   → Network First with cache fallback
     - Anything else                       → Network First
   ============================================================ */

const CACHE_VERSION  = 'v1';
const SHELL_CACHE    = `bucamap-shell-${CACHE_VERSION}`;
const IMAGES_CACHE   = `bucamap-images-${CACHE_VERSION}`;
const TILES_CACHE    = `bucamap-tiles-${CACHE_VERSION}`;
const CDN_CACHE      = `bucamap-cdn-${CACHE_VERSION}`;

/* ── Assets pre-cached on install ── */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
];

const IMAGE_ASSETS = [
  './images/apack-evi.jpg',
  './images/baris-manco-sokagi.jpeg',
  './images/bayrak-muzesi.jpg',
  './images/buca-kiz-kulesi.jpg',
  './images/buca-tren-istasyonu.jpg',
  './images/caporal-evi.jpg',
  './images/cumhuriyet-kutuphanesi.jpg',
  './images/dokuzcesmeler.jpg',
  './images/forbes-kosku.jpg',
  './images/hasanaga-bahcesi.jpg',
  './images/kasaplar-meydani.jpg',
  './images/kizilcullu-su-kemerleri.jpg',
  './images/latin-katolik-kilisesi.jpg',
  './images/lipovats-kosku.webp',
  './images/manoli-otel.jpg',
  './images/mevlana-heykeli.jpg',
  './images/mubadele-evi.jpg',
  './images/muradiye-camii.jpg',
  './images/osman-nuri-saygin-kutuphanesi.webp',
  './images/papaz-okulu.webp',
  './images/protestan-kilisesi.jpg',
  './images/russo-kosku.jpg',
  './images/yoruk-ali-efe-kulesi.jpg',
];

/* Max tiles to keep cached (to avoid unbounded storage growth) */
const MAX_TILE_ENTRIES = 500;

/* ── Install: pre-cache shell + all images ── */
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_ASSETS)),
      caches.open(IMAGES_CACHE).then(c =>
        Promise.allSettled(IMAGE_ASSETS.map(url =>
          c.add(url).catch(() => { /* image may not exist yet — skip */ })
        ))
      ),
    ]).then(() => self.skipWaiting())
  );
});

/* ── Activate: delete old cache versions ── */
self.addEventListener('activate', event => {
  const keep = new Set([SHELL_CACHE, IMAGES_CACHE, TILES_CACHE, CDN_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Helpers ── */
function isMapTile(url) {
  return url.hostname.includes('carto') || url.hostname.includes('tile');
}

function isCDN(url) {
  return url.hostname.includes('fonts.googleapis.com')
      || url.hostname.includes('fonts.gstatic.com')
      || url.hostname.includes('unpkg.com')
      || url.hostname.includes('cdnjs.cloudflare.com');
}

function isLocalImage(url) {
  return url.pathname.startsWith('/images/')
      || url.pathname.startsWith('./images/');
}

/* Trim a cache to a max number of entries (FIFO) */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys  = await cache.keys();
  if (keys.length > maxEntries) {
    await Promise.all(keys.slice(0, keys.length - maxEntries).map(k => cache.delete(k)));
  }
}

/* ── Fetch: route requests to the right strategy ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  /* 1. Map tiles → Network First, fallback to cache */
  if (isMapTile(url)) {
    event.respondWith(networkFirstWithCache(event.request, TILES_CACHE, MAX_TILE_ENTRIES));
    return;
  }

  /* 2. CDN (Leaflet, Google Fonts) → Stale-While-Revalidate */
  if (isCDN(url)) {
    event.respondWith(staleWhileRevalidate(event.request, CDN_CACHE));
    return;
  }

  /* 3. Same-origin requests → Cache First */
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  /* 4. Everything else → Network, no cache */
  event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
});

/* ── Strategy: Cache First (shell + images) ── */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Decide which cache bucket to write to
      const url = new URL(request.url);
      const bucket = isLocalImage(url) ? IMAGES_CACHE : SHELL_CACHE;
      const cache = await caches.open(bucket);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    /* Offline and not cached – return a minimal offline response */
    return caches.match('./index.html') ?? new Response('Offline', { status: 503 });
  }
}

/* ── Strategy: Network First with cache fallback (tiles) ── */
async function networkFirstWithCache(request, cacheName, maxEntries) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
      trimCache(cacheName, maxEntries); // async, don't await
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response('', { status: 503 });
  }
}

/* ── Strategy: Stale-While-Revalidate (CDN) ── */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached ?? await networkFetch ?? new Response('', { status: 503 });
}

/* ── Handle SW update messages from the page ── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
