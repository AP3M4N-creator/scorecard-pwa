// Self-updating service worker.
// You no longer need to bump a version string on every asset change:
//  - App code (HTML/JS/CSS/manifest) is network-first, so an online load
//    always fetches the latest and falls back to cache when offline.
//  - Fonts/icons are stale-while-revalidate: instant from cache, refreshed
//    in the background.
// Bump SHELL_VERSION only if you ever need to force-drop the whole cache.
const SHELL_VERSION = 'v124';
const CACHE = 'scorecard-' + SHELL_VERSION;

// One file per family (per style for Source Serif): the variable ones cover
// every weight the stylesheet asks for from a single file. Graduate is a
// single-weight face and the theme's display type; Source Serif stays on as
// its fallback.
const FONTS = [
  'fonts/graduate-latin.woff2',
  'fonts/source-serif-4-latin.woff2',
  'fonts/source-serif-4-italic.woff2',
  'fonts/jetbrains-mono-latin.woff2'
];

// Files treated as "app code": always try the network first when online.
const SHELL = ['index.html', 'styles.css', 'app.js', 'ui.js', 'boot.js', 'manifest.json'];

// Without these the card cannot be drawn at all, so a failure to cache one is
// worth failing the install over — the previous worker stays in charge and
// keeps serving a cache that works.
const CRITICAL = ['index.html', 'styles.css', 'app.js', 'ui.js', 'boot.js'];
// Everything else is nice to have offline. A single 404 here used to reject
// addAll() and leave the whole cache empty, which is how an installed app ends
// up with a worker in charge and nothing to fall back on.
const OPTIONAL = ['manifest.json', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'field.png'].concat(FONTS);

// The launch navigation must always end in a document. This is what the scorer
// sees if the shell is genuinely unreachable — a named failure with a way out,
// rather than the blank page a rejected respondWith() produces. No inline
// script: the page's CSP forbids it, and this has to render under that CSP.
const OFFLINE_DOC = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Baseball Scorecard</title></head>
<body style="margin:0;padding:48px 24px;font-family:Georgia,serif;color:#003278;background:#f7f3e8;text-align:center">
<h1 style="font-size:22px;margin:0 0 12px">Scorecard couldn't load</h1>
<p style="font-size:16px;line-height:1.5;margin:0 0 24px">
The app files aren't on this device yet and there's no connection to fetch them.
Reconnect and open the app again.</p>
<p><a href="./" style="display:inline-block;padding:12px 22px;background:#003278;color:#fff;text-decoration:none;border-radius:6px;font-size:16px">Try again</a></p>
</body></html>`;

function offlineResponse() {
  return new Response(OFFLINE_DOC, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      const base = self.registration.scope;
      // The scope itself is the launch URL, so it is as critical as index.html.
      return c.addAll([base].concat(CRITICAL.map(f => base + f)))
        .then(() => Promise.all(OPTIONAL.map(f =>
          c.add(base + f).catch(() => {})   // best-effort, never fails the install
        )));
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
  if (resp && resp.ok && resp.type === 'basic' && req.url.startsWith(self.location.origin)) {
    const clone = resp.clone();
    caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
  }
  return resp;
}

// A navigation may not be answered with a response that followed a redirect —
// the browser rejects it and paints nothing. Rebuild it as a plain response so
// the document renders instead. (Cheap insurance: it only copies on redirect.)
function unredirect(resp) {
  if (!resp || !resp.redirected) return resp;
  return resp.blob().then(body => new Response(body, {
    status: resp.status, statusText: resp.statusText, headers: resp.headers
  }));
}

// Last resort for a navigation: whatever the cache has for this URL, then the
// launch URL, then index.html, then the offline document. Something is always
// returned — resolving undefined here is what blanks the app.
function shellFallback(req) {
  const base = self.registration.scope;
  return caches.match(req)
    .then(r => r || caches.match(req, { ignoreSearch: true }))
    .then(r => r || caches.match(base))
    .then(r => r || caches.match(base + 'index.html'))
    .then(r => r || offlineResponse())
    .catch(() => offlineResponse());
}

// Network-first with a timeout so flaky stadium wifi still falls back to cache.
// The timeout is short for navigations: the cached shell is complete and the
// sub-resources are network-first in their own right, so waiting on a hung
// socket only buys a longer blank screen at launch.
function networkFirst(req, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const settle = p => { if (!settled) { settled = true; resolve(p); } };
    const timer = setTimeout(() => settle(shellFallback(req)), timeoutMs);
    fetch(req).then(resp => {
      cachePut(req, resp);
      clearTimeout(timer);
      // A 4xx/5xx from the network is worse than a good cached copy.
      settle(resp && resp.ok ? unredirect(resp) : shellFallback(req));
    }).catch(() => {
      clearTimeout(timer);
      settle(shellFallback(req));
    });
  });
}

// Serve cache instantly, refresh in the background for next time.
function staleWhileRevalidate(req) {
  return caches.match(req).then(cached => {
    if (cached) {
      fetch(req).then(resp => cachePut(req, resp)).catch(() => {});
      return cached;
    }
    return fetch(req).then(resp => cachePut(req, resp));
  }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin through untouched
  const isNav = e.request.mode === 'navigate';
  const isShell = isNav || SHELL.some(f => url.pathname.endsWith('/' + f));
  if (!isShell) { e.respondWith(staleWhileRevalidate(e.request)); return; }
  e.respondWith(
    networkFirst(e.request, isNav ? 2000 : 3500)
      // Nothing above should throw, but respondWith() rejecting is exactly the
      // blank screen this file exists to prevent. Belt and braces.
      .catch(() => (isNav ? offlineResponse() : new Response('', { status: 504 })))
  );
});
