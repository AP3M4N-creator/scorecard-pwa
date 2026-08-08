// Self-updating service worker.
// You no longer need to bump a version string on every asset change:
//  - App code (HTML/JS/CSS/manifest) is network-first, so an online load
//    always fetches the latest and falls back to cache when offline.
//  - Fonts/icons are stale-while-revalidate: instant from cache, refreshed
//    in the background.
// Bump SHELL_VERSION only if you ever need to force-drop the whole cache.
const SHELL_VERSION = 'v110';
const CACHE = 'scorecard-' + SHELL_VERSION;

// One file per family (per style for Source Serif): the variable ones cover
// every weight the stylesheet asks for from a single file. Graduate is a
// single-weight face and the theme's display type; Source Serif stays on as
// its fallback. addAll() is all-or-nothing, so only list files that are
// actually in the repo.
const FONTS = [
  'fonts/graduate-latin.woff2',
  'fonts/source-serif-4-latin.woff2',
  'fonts/source-serif-4-italic.woff2',
  'fonts/jetbrains-mono-latin.woff2'
];

// Files treated as "app code": always try the network first when online.
const SHELL = ['index.html', 'styles.css', 'app.js', 'ui.js', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      const base = self.registration.scope;
      return c.addAll([
        base,
        ...SHELL.map(f => base + f),
        base + 'icon-192.png',
        base + 'icon-512.png',
        base + 'icon-180.png',
        base + 'field.png',
        ...FONTS.map(f => base + f)
      ]);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// Cache a good same-origin response, then hand it back.
function cachePut(req, resp) {
  if (resp && resp.ok && req.url.startsWith(self.location.origin)) {
    const clone = resp.clone();
    caches.open(CACHE).then(c => c.put(req, clone));
  }
  return resp;
}

// Network-first with a timeout so flaky stadium wifi still falls back to cache.
function networkFirst(req, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const fallback = () => caches.match(req).then(r => r || caches.match(self.registration.scope));
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(fallback()); }
    }, timeoutMs);
    fetch(req).then(resp => {
      cachePut(req, resp);
      if (!settled) { settled = true; clearTimeout(timer); resolve(resp); }
    }).catch(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(fallback()); }
    });
  });
}

// Serve cache instantly, refresh in the background for next time.
function staleWhileRevalidate(req) {
  return caches.match(req).then(cached => {
    const network = fetch(req).then(resp => cachePut(req, resp)).catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin through untouched
  const isShell = e.request.mode === 'navigate' ||
    SHELL.some(f => url.pathname.endsWith('/' + f));
  e.respondWith(isShell ? networkFirst(e.request, 3500) : staleWhileRevalidate(e.request));
});
