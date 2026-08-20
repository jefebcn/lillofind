// ════════════════════════════════════════════════════════════════
// LilloFind — Backend su Cloudflare Workers
// Sostituisce le Firebase Cloud Functions mantenendo lo stesso
// "contratto" col frontend (protocollo callable: body {data}, resp {result}).
// Deploy automatico via GitHub Actions (cloudflare-worker-deploy.yml).
// ════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { Firestore } from './lib/firestore.js';
import { verifyIdToken, bearerFrom } from './lib/auth.js';
import { HttpsError } from './lib/errors.js';
import * as admin from './handlers/admin.js';
import * as checkout from './handlers/checkout.js';
import * as scrapers from './handlers/scrapers.js';
import * as stream from './handlers/stream.js';
import { isAllowedSource, rewriteManifest } from './lib/stream-lib.js';

const app = new Hono();

// ── CORS ────────────────────────────────────────────────────────
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || !origin || allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin, c.env) });
  }
  await next();
  // Le risposte immutabili (es. dalla cache di proxyImage) non permettono di
  // modificare gli header → il set lancerebbe eccezione (500). Le proteggiamo:
  // hanno già i propri header CORS.
  try {
    const h = corsHeaders(origin, c.env);
    for (const k of Object.keys(h)) c.res.headers.set(k, h[k]);
  } catch (_) { /* header immutabili — ignora */ }
});

const HTTP_STATUS = {
  'ok': 200, 'invalid-argument': 400, 'unauthenticated': 401,
  'permission-denied': 403, 'not-found': 404, 'already-exists': 409,
  'resource-exhausted': 429, 'internal': 500, 'unavailable': 503,
};

// Wrapper che replica il protocollo Firebase callable.
//   opts.auth: 'required' | 'admin' | 'none'
function callable(handler, opts = {}) {
  return async (c) => {
    const env = c.env;
    try {
      let body = {};
      try { body = await c.req.json(); } catch (_) { body = {}; }
      const data = body && typeof body === 'object' && 'data' in body ? body.data : body;

      const ctx = { env, db: new Firestore(env), auth: null };

      if (opts.auth === 'required' || opts.auth === 'admin' || opts.auth === 'adminEmail') {
        const token = bearerFrom(c.req.raw);
        if (!token) throw new HttpsError('unauthenticated', 'Login richiesto.');
        let decoded;
        try { decoded = await verifyIdToken(token, env.FIREBASE_PROJECT_ID); }
        catch (e) { throw new HttpsError('unauthenticated', 'Token non valido.'); }
        ctx.auth = { uid: decoded.uid, email: decoded.email, token: decoded };

        if (opts.auth === 'admin') {
          const userSnap = await ctx.db.getDoc('users', decoded.uid);
          if (userSnap.data()?.isAdmin !== true) {
            throw new HttpsError('permission-denied', 'Solo admin.');
          }
        }

        // adminEmail: verifica admin tramite allowlist email (non usa Firestore,
        // quindi funziona anche senza FIREBASE_SERVICE_ACCOUNT).
        if (opts.auth === 'adminEmail') {
          const admins = (env.ADMIN_EMAILS || 'yishionvt@gmail.com')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          if (!admins.includes((decoded.email || '').toLowerCase())) {
            throw new HttpsError('permission-denied', 'Solo admin.');
          }
        }
      }

      const result = await handler(data, ctx);
      return c.json({ result: result ?? null });
    } catch (e) {
      const code = e instanceof HttpsError ? e.code : 'internal';
      const status = HTTP_STATUS[code] || 500;
      if (code === 'internal') console.error('Worker error:', e && e.stack ? e.stack : e);
      return c.json({ error: { status: code, message: e.message || 'Errore interno' } }, status);
    }
  };
}

// ════════════════════════════════════════════════════════════════
// proxyImage — proxy immagini Yupoo (GET pubblico, cacheable)
// ════════════════════════════════════════════════════════════════
app.get('/proxyImage', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.text('Missing url', 400);
  let parsed;
  try { parsed = new URL(url); } catch (e) { return c.text('Invalid URL', 400); }
  const ok = parsed.hostname.endsWith('.yupoo.com') || parsed.hostname.endsWith('.yunjifen.com')
    || parsed.hostname === 'yupoo.com' || parsed.hostname === 'yunjifen.com';
  if (!ok) return c.text('Host not allowed', 403);

  // Cache v2 — versioned key invalidates all previously cached error responses
  const cache = caches.default;
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.set('_cv', '2');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit && hit.ok) return new Response(hit.body, hit); // copia mutabile

  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': `https://${parsed.hostname}/`,
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // Retry con backoff: Yupoo restituisce 5xx/429 in caso di throttling temporaneo
    let upstream = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        upstream = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(12000) });
      } catch (fe) {
        if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
        throw fe;
      }
      if (upstream.ok) break;
      // 5xx o 429 → riprova; 4xx (es. 404) → esci subito
      if ((upstream.status >= 500 || upstream.status === 429) && attempt < 2) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!upstream || !upstream.ok) {
      return new Response('Upstream error', {
        status: (upstream && upstream.status) || 502,
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const ct = (upstream.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = await upstream.arrayBuffer();
    const resp = new Response(buf, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response('Fetch error', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

// ── Health check ────────────────────────────────────────────────
app.get('/', (c) => c.json({ ok: true, service: 'lillofind-worker' }));

// ── Geo del visitatore (da Cloudflare, no servizi esterni) ──────
// Usato dal tracker di presenza per sapere indicativamente da dove
// arrivano i visitatori (livello paese/città, nessuna posizione precisa).
app.get('/geo', (c) => {
  const cf = (c.req.raw && c.req.raw.cf) || {};
  return c.json({
    country: cf.country || '',
    city: cf.city || '',
    region: cf.region || '',
  });
});

// ── Diagnostica (pubblica, nessun dato sensibile) ───────────────
// Verifica che i secret e l'accesso a Firestore siano configurati bene.
// Utile subito dopo il deploy: GET /diag
app.get('/diag', async (c) => {
  const env = c.env;
  const out = {
    projectId: env.FIREBASE_PROJECT_ID || null,
    secrets: {
      FIREBASE_SERVICE_ACCOUNT: !!env.FIREBASE_SERVICE_ACCOUNT,
      STRIPE_SECRET_KEY: !!env.STRIPE_SECRET_KEY,
      RESEND_API_KEY: !!env.RESEND_API_KEY,
      ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
      TMDB_API_KEY: !!env.TMDB_API_KEY,
    },
    firestore: { reachable: false },
  };
  try {
    out.firestore = await new Firestore(env).ping();
  } catch (e) {
    out.firestore = { reachable: false, error: e.message };
  }
  return c.json(out);
});

// ════════════════════════════════════════════════════════════════
// TMDB — "Cosa guardare" (GET pubblico, cacheable)
// Proxy verso The Movie Database. La chiave resta lato server (secret
// TMDB_API_KEY) e non viene mai esposta al browser. Solo percorsi in
// whitelist: nessun open-proxy. Dati/immagini 100% ufficiali e legali.
// ════════════════════════════════════════════════════════════════
const TMDB_BASE = 'https://api.themoviedb.org/3';
// Costruisce SOLO percorsi TMDB consentiti a partire da parametri semplici.
function tmdbPath(kind, q) {
  const L = 'language=it-IT';
  switch (kind) {
    case 'trending': return `/trending/all/week?${L}`;
    case 'movies':   return `/movie/popular?${L}&region=IT`;
    case 'tv':       return `/tv/popular?${L}`;
    case 'search': {
      const query = (q.q || '').slice(0, 120);
      if (!query.trim()) return null;
      return `/search/multi?${L}&include_adult=false&query=${encodeURIComponent(query)}`;
    }
    case 'detail': {
      const type = q.type === 'tv' ? 'tv' : 'movie';
      const id = String(q.id || '').replace(/[^0-9]/g, '').slice(0, 12);
      if (!id) return null;
      return `/${type}/${id}?${L}&append_to_response=videos,watch/providers,credits`;
    }
    default: return null;
  }
}
app.get('/tmdb', async (c) => {
  const env = c.env;
  const kind = c.req.query('kind') || 'trending';
  const path = tmdbPath(kind, { q: c.req.query('q'), type: c.req.query('type'), id: c.req.query('id') });
  if (!path) return c.json({ error: 'invalid-request', results: [] }, 400);
  // Senza chiave configurata: rispondi in modo "morbido" così il frontend
  // mostra lo stato "presto disponibile" invece di un errore.
  if (!env.TMDB_API_KEY) {
    return c.json({ error: 'tmdb-not-configured', results: [] },
      200, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  }
  const upstream = `${TMDB_BASE}${path}${path.includes('?') ? '&' : '?'}api_key=${env.TMDB_API_KEY}`;

  // Cache (non per la ricerca). La chiave di cache è l'URL pubblico (senza api_key).
  const cacheable = kind !== 'search';
  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: 'GET' });
  if (cacheable) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, hit);
  }
  try {
    const r = await fetch(upstream, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const body = await r.text();
    const resp = new Response(body, {
      status: r.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': cacheable ? 'public, max-age=1800, s-maxage=3600' : 'no-store',
      },
    });
    if (cacheable && r.ok) c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return c.json({ error: 'tmdb-fetch-failed', results: [] },
      502, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  }
});

// ════════════════════════════════════════════════════════════════
// "Cosa guardare" SENZA API KEY — serie TV via TVMaze (api.tvmaze.com).
// Nessuna chiave, nessun contenuto piratato: solo metadati, copertine e
// link ufficiali. (Le classifiche film Apple non sono raggiungibili
// dall'edge Cloudflare → sezione basata su TVMaze.)
// Forma normalizzata verso il frontend:
//   { id, type:'tv', title, year, poster, rating, genres:[], overview, link }
// ════════════════════════════════════════════════════════════════
const WATCH_TTL = 'public, max-age=1800, s-maxage=86400';
// Bump per invalidare la cache edge quando cambia la logica/normalizzazione.
const WATCH_VER = '3';
async function fetchJSON(url, ms, extraHeaders) {
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms || 12000) });
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}
function stripHtml(h) { return String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function normTvFromTvmaze(s) {
  if (!s) return null;
  return {
    id: String(s.id),
    type: 'tv',
    title: s.name || '',
    year: (s.premiered || '').slice(0, 4),
    poster: (s.image && (s.image.original || s.image.medium)) || '',
    rating: (s.rating && s.rating.average) || null,
    genres: s.genres || [],
    overview: stripHtml(s.summary),
    link: s.officialSite || s.url || '',
  };
}
// Bacino di serie da più pagine indice TVMaze (nessuna chiave).
async function tvmazePool() {
  const pages = await Promise.all([0, 1, 2, 3].map(p => fetchJSON(`https://api.tvmaze.com/shows?page=${p}`).catch(() => [])));
  return pages.flat();
}
async function tvmazePopular() {
  const all = await tvmazePool();
  all.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return all.slice(0, 48).map(normTvFromTvmaze).filter(x => x && x.title && x.poster);
}
async function tvmazeTop() {
  const all = (await tvmazePool()).filter(s => s.rating && s.rating.average);
  all.sort((a, b) => b.rating.average - a.rating.average);
  return all.slice(0, 48).map(normTvFromTvmaze).filter(x => x && x.title && x.poster);
}
async function tvmazeSearch(q) {
  const arr = await fetchJSON(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(String(q).slice(0, 80))}`);
  return (arr || []).map(r => normTvFromTvmaze(r.show)).filter(x => x && x.title && x.poster);
}
async function tvmazeDetail(id) {
  const clean = String(id).replace(/[^0-9]/g, '').slice(0, 10);
  const s = await fetchJSON(`https://api.tvmaze.com/shows/${clean}?embed[]=cast`);
  const item = normTvFromTvmaze(s) || {};
  item.cast = (((s._embedded && s._embedded.cast) || []).slice(0, 8))
    .map(c => ({ name: c.person && c.person.name, char: c.character && c.character.name, img: (c.person && c.person.image && c.person.image.medium) || '' }))
    .filter(c => c.name);
  item.network = (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '';
  item.status = s.status || '';
  item.premiered = s.premiered || '';
  item.ended = s.ended || '';
  return item;
}
app.get('/watch', async (c) => {
  const kind = c.req.query('kind') || 'trending';
  const q = c.req.query('q') || '';
  const type = c.req.query('type');
  const id = c.req.query('id');
  const cache = caches.default;
  const cacheable = kind !== 'search';
  const _ckUrl = new URL(c.req.url); _ckUrl.searchParams.set('_wv', WATCH_VER);
  const cacheKey = new Request(_ckUrl.toString(), { method: 'GET' });
  if (cacheable) { const hit = await cache.match(cacheKey); if (hit) return new Response(hit.body, hit); }
  const send = (obj, ttl) => new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': ttl || (cacheable ? WATCH_TTL : 'no-store') },
  });
  try {
    if (kind === 'detail') {
      const out = (type === 'tv' && id) ? await tvmazeDetail(id) : { error: 'no-detail' };
      const r = send(out, 'public, max-age=3600, s-maxage=86400');
      if (cacheable && out && out.id) c.executionCtx.waitUntil(cache.put(cacheKey, r.clone()));
      return r;
    }
    if (kind === 'search') {
      const results = q.trim() ? await tvmazeSearch(q) : [];
      return send({ results }, 'no-store');
    }
    let out;
    if (kind === 'top') out = { results: await tvmazeTop() };
    else out = { results: await tvmazePopular() }; // trending / tv / default
    const r = send(out);
    if (cacheable && out.results && out.results.length) c.executionCtx.waitUntil(cache.put(cacheKey, r.clone()));
    return r;
  } catch (e) {
    return send({ error: 'watch-fetch-failed', results: [] }, 'no-store');
  }
});

// ════════════════════════════════════════════════════════════════
// Catalogo streaming — letture pubbliche
//
// Sono GET e non callable di proposito: una POST non passa da
// caches.default, e il catalogo è esattamente il tipo di risposta
// che conviene servire dal bordo. Nessuna di queste risposte
// contiene URL riproducibili: quelli escono solo da /streamPlay.
// ════════════════════════════════════════════════════════════════
const STREAM_TTL = 'public, max-age=300, s-maxage=900';
// Bump per invalidare la cache edge quando cambia la normalizzazione.
const STREAM_VER = '1';

app.get('/stream', async (c) => {
  const kind = c.req.query('kind') || 'home';
  const q = c.req.query('q') || '';
  // La ricerca non si cachea: cambia a ogni tasto premuto.
  const cacheable = !(kind === 'browse' && q.trim());

  const cache = caches.default;
  const _ck = new URL(c.req.url); _ck.searchParams.set('_sv', STREAM_VER);
  const cacheKey = new Request(_ck.toString(), { method: 'GET' });
  if (cacheable) { const hit = await cache.match(cacheKey); if (hit && hit.ok) return new Response(hit.body, hit); }

  const send = (obj, status, ttl) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ttl || (cacheable ? STREAM_TTL : 'no-store'),
    },
  });

  try {
    const db = new Firestore(c.env);
    let out;
    if (kind === 'title') out = await stream.titleBySlug(db, c.req.query('slug') || '');
    else if (kind === 'browse') out = await stream.browse(db, {
      type: c.req.query('type') || '',
      genre: c.req.query('genre') || '',
      year: c.req.query('year') || '',
      q,
    });
    else out = await stream.home(db);

    const r = send(out);
    if (cacheable) c.executionCtx.waitUntil(cache.put(cacheKey, r.clone()));
    return r;
  } catch (e) {
    const code = e && e.code === 'not-found' ? 404 : e && e.code === 'invalid-argument' ? 400 : 500;
    if (code === 500) console.error('stream:', e && e.stack);
    // Degrado morbido come /watch: la pagina mostra lo stato vuoto,
    // non una schermata di errore.
    return send({ error: (e && e.code) || 'stream-failed', results: [], hero: [], rows: [] }, code, 'no-store');
  }
});

// ── Proxy del manifest HLS ──────────────────────────────────────
//
// Le origini esterne spesso non espongono header CORS utilizzabili da
// hls.js. Proxiamo SOLO il manifest, riscrivendo i riferimenti in
// assoluto: i segmenti (migliaia di richieste) restano sull'origine e
// non consumano la quota del Worker.
//
// Come /proxyImage, la protezione è l'allowlist degli host: mai un
// relay aperto. Il gate di accesso è /streamPlay, non questo endpoint.
app.get('/streamManifest', async (c) => {
  const url = c.req.query('u');
  if (!url) return c.text('Missing u', 400);
  if (!isAllowedSource(url)) return c.text('Host not allowed', 403);

  const cache = caches.default;
  const _ck = new URL(c.req.url); _ck.searchParams.set('_sv', STREAM_VER);
  const cacheKey = new Request(_ck.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit && hit.ok) return new Response(hit.body, hit);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    let upstream = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        upstream = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
      } catch (fe) {
        if (attempt < 2) { await sleep(350 * (attempt + 1)); continue; }
        throw fe;
      }
      if (upstream.ok) break;
      if ((upstream.status >= 500 || upstream.status === 429) && attempt < 2) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!upstream || !upstream.ok) {
      return new Response('Upstream error', {
        status: (upstream && upstream.status) || 502,
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Le playlist annidate tornano da qui (stesso problema CORS);
    // i segmenti no.
    const self = new URL(c.req.url);
    const proxied = (abs) => `${self.origin}/streamManifest?u=${encodeURIComponent(abs)}`;
    const body = rewriteManifest(await upstream.text(), upstream.url || url, proxied);

    const resp = new Response(body, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'public, max-age=120, s-maxage=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response('Fetch error', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

// ════════════════════════════════════════════════════════════════
// Endpoint callable (POST /<nomeFunzione>)
// ════════════════════════════════════════════════════════════════
// Lettura admin
app.post('/getAdminProducts', callable(admin.getAdminProducts, { auth: 'admin' }));
app.post('/getAdminOrders',   callable(admin.getAdminOrders,   { auth: 'admin' }));
app.post('/getAdminStats',    callable(admin.getAdminStats,    { auth: 'admin' }));
// Scrittura admin
app.post('/saveProduct',        callable(admin.saveProduct,        { auth: 'admin' }));
app.post('/updateAdminProduct', callable(admin.updateAdminProduct, { auth: 'admin' }));
app.post('/deleteAdminProduct', callable(admin.deleteAdminProduct, { auth: 'admin' }));
app.post('/updateAdminOrder',   callable(admin.updateAdminOrder,   { auth: 'admin' }));
app.post('/batchSetGender',     callable(admin.batchSetGender,     { auth: 'admin' }));
// Checkout
app.post('/createPaymentIntent', callable(checkout.createPaymentIntent, { auth: 'required' }));
app.post('/validateOrder',       callable(checkout.validateOrder,       { auth: 'required' }));
// Email tracking al cliente (admin via allowlist email)
app.post('/sendTrackingEmail',   callable(checkout.sendTrackingEmail,   { auth: 'adminEmail' }));
// Email conferma ordine al cliente (utente autenticato)
app.post('/sendOrderEmail',      callable(checkout.sendOrderEmail,      { auth: 'required' }));
app.post('/sendCredentialsEmail', callable(checkout.sendCredentialsEmail, { auth: 'adminEmail' }));
// Diagnostica invio email (admin via allowlist email)
app.post('/sendTestEmail',       callable(checkout.sendTestEmail,       { auth: 'adminEmail' }));
// Scraper (admin via allowlist email — non richiede FIREBASE_SERVICE_ACCOUNT)
app.post('/yupooFetch',   callable(scrapers.yupooFetch,   { auth: 'adminEmail' }));
app.post('/yupooAnalyze', callable(scrapers.yupooAnalyze, { auth: 'adminEmail' }));
app.post('/uploadImage',  callable(scrapers.uploadImage,  { auth: 'adminEmail' }));

// Streaming: la riproduzione è l'unico punto da cui esce un URL
// riproducibile, quindi è l'unica rotta del catalogo dietro login.
app.post('/streamPlay',       callable(stream.play,       { auth: 'required' }));

app.post('/streamSaveTitle',   callable(stream.saveTitle,   { auth: 'adminEmail' }));
app.post('/streamDeleteTitle', callable(stream.deleteTitle, { auth: 'adminEmail' }));
app.post('/streamAdminList',   callable(stream.adminList,   { auth: 'adminEmail' }));
app.post('/streamAdminTitle',  callable(stream.adminTitle,  { auth: 'adminEmail' }));
app.post('/streamSaveHome',    callable(stream.saveHome,    { auth: 'adminEmail' }));
app.post('/streamImportMeta',  callable(stream.importMeta,  { auth: 'adminEmail' }));

export default app;

// deploy trigger: attiva email conferma ordine + tracking (build)
