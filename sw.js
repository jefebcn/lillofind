/* LilloFind — Service Worker
   Strategia prudente per evitare contenuti obsoleti:
   - HTML/navigazioni: NETWORK-FIRST (mostra sempre l'ultima versione)
   - Asset statici same-origin: CACHE-FIRST con aggiornamento in background
   - Richieste cross-origin (Firestore, Worker, Stripe, Yupoo): mai toccate
*/
const CACHE = 'lillofind-v1';
const STATIC = ['/', '/index.html', '/manifest.json', '/style.css',
  '/firebase.js', '/icon-192.png', '/icon-512.png', '/assets/og-image.jpg'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) =>
    // cache singolarmente: un 404 non fa fallire l'intero install
    Promise.allSettled(STATIC.map((u) => c.add(new Request(u, { cache: 'reload' }))))
  ));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Non intercettare cross-origin (Firestore, Cloudflare Worker, Stripe, Yupoo…)
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // Network-first: la pagina è sempre aggiornata; cache solo come fallback offline
    e.respondWith(
      fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // Asset statici: cache-first, aggiorna in background
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((r) => {
        if (r && r.ok) {
          const cp = r.clone();
          caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
        }
        return r;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
