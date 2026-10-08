/* LilloFind — Service Worker
   Strategia prudente per evitare contenuti obsoleti:
   - HTML/navigazioni: NETWORK-FIRST e sempre riconvalidate col server
   - Asset statici same-origin: CACHE-FIRST con aggiornamento in background
   - Richieste cross-origin (Firestore, Worker, Stripe, Yupoo): mai toccate

   Il sito è servito da GitHub Pages, che manda l'HTML con
   Cache-Control: max-age=600 (non configurabile). Un semplice fetch(req)
   passa dalla cache HTTP del browser e quindi, per 10 minuti dopo un
   aggiornamento, il telefono continuava a mostrare la pagina vecchia.
   Con cache:'no-cache' il browser chiede sempre al server se la pagina è
   cambiata (risposta 304 leggera se è uguale).
*/
const CACHE = 'lillofind-v6';
const STATIC = ['/', '/index.html', '/stream.html', '/manifest.json', '/style.css', '/index.css',
  '/theme-v3.css', '/firebase.js', '/icon-192.png', '/icon-512.png', '/assets/og-image.jpg'];

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

// Una navigazione non accetta una risposta marcata "redirected" (Chrome la
// rifiuta): se il server ha reindirizzato, ricostruiamo una risposta pulita.
function cleanResponse(r) {
  if (!r || !r.redirected) return r;
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
// Le richieste "navigate" non si possono clonare con opzioni nuove: si rifà
// la richiesta per URL, chiedendo di riconvalidare col server.
function fetchFresh(req) {
  if (req.mode === 'navigate') {
    return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(cleanResponse);
  }
  return fetch(req, { cache: 'no-cache' });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // Non intercettare cross-origin (Firestore, Cloudflare Worker, Stripe, Yupoo…)
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // Network-first riconvalidato: la pagina è sempre l'ultima; cache solo offline
    e.respondWith(
      fetchFresh(req).then((r) => {
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
      const net = fetchFresh(req).then((r) => {
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
