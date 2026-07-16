const CACHE = 'scorecard-v6';

const FONTS = [
  'fonts/oswald-400-latin.woff2',
  'fonts/oswald-500-latin.woff2',
  'fonts/oswald-600-latin.woff2',
  'fonts/oswald-700-latin.woff2',
  'fonts/source-sans-3-400-ext.woff2',
  'fonts/source-sans-3-400-latin.woff2',
  'fonts/source-sans-3-500-ext.woff2',
  'fonts/source-sans-3-500-latin.woff2',
  'fonts/source-sans-3-600-ext.woff2',
  'fonts/source-sans-3-600-latin.woff2',
  'fonts/source-sans-3-700-ext.woff2',
  'fonts/source-sans-3-700-latin.woff2',
  'fonts/jetbrains-mono-500-latin.woff2',
  'fonts/jetbrains-mono-600-latin.woff2',
  'fonts/jetbrains-mono-700-latin.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      const base = self.registration.scope;
      return c.addAll([
        base,
        base + 'index.html',
        base + 'styles.css',
        base + 'app.js',
        base + 'manifest.json',
        base + 'icon-192.png',
        base + 'icon-512.png',
        base + 'icon-180.png',
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

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok && e.request.url.startsWith(self.location.origin)) {
        const clone = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return resp;
    })).catch(() => caches.match(self.registration.scope))
  );
});
