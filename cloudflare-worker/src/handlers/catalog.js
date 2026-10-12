// ════════════════════════════════════════════════════════════════
// Catalogo per lo shop servito da Cloudflare (KV), NON da Firestore.
// Prima ogni visita leggeva da Firestore tutti i ~6.400 prodotti: la quota
// gratuita (50.000 letture/giorno) finiva con ~8 visite e lo shop restava
// vuoto. Ora l'admin pubblica il catalogo qui (POST /publishCatalog) e lo
// shop lo scarica da GET /catalog: 0 letture Firestore per visita.
// ════════════════════════════════════════════════════════════════
import { HttpsError } from '../lib/errors.js';

const KEY = 'catalog';
const META = 'catalog:meta';
// Id degli album Yupoo già importati (dal sourceUrl, che nel catalogo
// pubblico non c'è): l'importer li usa per non creare doppioni senza
// rileggere tutti i prodotti da Firestore (≈6.500 letture a pagina).
const ALBUMS = 'catalog:albums';
export const albumIdOf = (u) => { const m = String(u || '').match(/yupoo\.com\/albums\/(\d+)/i); return m ? m[1] : ''; };
async function addAlbums(kv, ids) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  let cur = [];
  try { cur = JSON.parse((await kv.get(ALBUMS)) || '[]') || []; } catch (_) {}
  await kv.put(ALBUMS, JSON.stringify([...new Set([...cur, ...ids])]));
}
const MAX_BYTES = 24 * 1024 * 1024;           // limite valore KV: 25 MiB
// Dati interni che non devono finire nel catalogo pubblico.
// Elenco unico in lib/product-private.js: ora quei campi stanno in
// products_private, ma i documenti non ancora migrati li hanno ancora qui.
import { PRIVATE_FIELDS } from '../lib/product-private.js';

function cacheKey(reqUrl) { const u = new URL(reqUrl); return new Request(u.origin + '/catalog?__cache=1'); }

// GET /catalog          → { version, builtAtMs, count, products:[...] }
// GET /catalog?meta=1   → { version, builtAtMs, count, dirty }
export async function getCatalog(c) {
  const kv = c.env.CATALOG;
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (!kv) return new Response(JSON.stringify({ error: 'catalog-kv-missing' }), { status: 503, headers: { 'Content-Type': 'application/json', ...cors } });
  if (c.req.query('meta') === '1') {
    const meta = await kv.get(META);
    return new Response(meta || 'null', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  }
  const cache = caches.default;
  const ck = cacheKey(c.req.url);
  const hit = await cache.match(ck);
  if (hit) return hit;
  const body = await kv.get(KEY);
  if (!body) return new Response(JSON.stringify({ error: 'not-published' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors } });
  const resp = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120', ...cors } });
  try { c.executionCtx.waitUntil(cache.put(ck, resp.clone())); } catch (_) {}
  return resp;
}

// POST /publishCatalog (solo admin) — { products:[...] }
export async function publishCatalog(data, { env }) {
  const kv = env.CATALOG;
  if (!kv) throw new HttpsError('unavailable', 'Spazio catalogo (KV) non configurato sul Worker.');
  const list = data && Array.isArray(data.products) ? data.products : null;
  if (!list || !list.length) throw new HttpsError('invalid-argument', 'Catalogo vuoto.');
  const valid = list.filter(p => p && typeof p === 'object' && typeof p.id === 'string');
  // l'admin manda il catalogo completo con sourceUrl: si aggiungono i suoi album
  // all'indice (quelli già noti restano: i prodotti migrati hanno sourceUrl in products_private)
  try { await addAlbums(kv, valid.map((p) => albumIdOf(p.sourceUrl))); } catch (_) {}
  const products = valid.map(p => {
    const o = { ...p };
    for (const f of PRIVATE_FIELDS) delete o[f];
    return o;
  });
  const version = Date.now();
  const body = JSON.stringify({ version, builtAtMs: version, count: products.length, products });
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > MAX_BYTES) throw new HttpsError('invalid-argument', 'Catalogo troppo grande (' + Math.round(bytes / 1048576) + ' MB).');
  await kv.put(KEY, body);
  const meta = { version, builtAtMs: version, count: products.length, bytes, dirty: false };
  await kv.put(META, JSON.stringify(meta));
  try { await caches.default.delete(new Request('https://lillofind.conti9708.workers.dev/catalog?__cache=1')); } catch (_) {}
  return meta;
}

// ── Novità aggiunte dal server ──────────────────────────────────────
// I prodotti creati dopo l'ultima pubblicazione li leggeva ogni visitatore
// da Firestore (vedi _loadCatalogSnapshot in index.html): dopo un import da
// centinaia di album ogni visita costava centinaia di letture e la quota
// gratuita finiva in poche visite. Qui il server legge SOLO i prodotti nuovi
// (non tutto il catalogo) e li aggiunge allo snapshot. Le modifiche ai
// prodotti già pubblicati restano all'admin (ripubblica completa).

// Timestamp letti dal Worker ({seconds,_ts}) nella stessa forma che pubblica
// l'admin ({seconds,nanoseconds}), così lo shop li ordina allo stesso modo.
function plainTs(v) {
  if (Array.isArray(v)) return v.map(plainTs);
  if (v && typeof v === 'object') {
    if (typeof v.seconds === 'number' && typeof v._ts === 'string') return { seconds: v.seconds, nanoseconds: 0 };
    const o = {};
    for (const k of Object.keys(v)) o[k] = plainTs(v[k]);
    return o;
  }
  return v;
}

export async function mergeNewProducts(env, db, { max = 3000 } = {}) {
  const kv = env.CATALOG;
  if (!kv) return { ok: false, reason: 'kv' };
  const body = await kv.get(KEY);
  if (!body) return { ok: false, reason: 'not-published' };
  const cat = JSON.parse(body);
  if (!cat || !Array.isArray(cat.products) || !cat.builtAtMs) return { ok: false, reason: 'snapshot' };
  // builtAtMs = inizio di questa lettura: un prodotto creato nel frattempo lo
  // vede comunque lo shop (createdAt > builtAtMs) e il giro dopo lo aggiunge.
  const startedAt = Date.now();
  const rows = await db.runQuery('products', { where: [['createdAt', '>', new Date(cat.builtAtMs)]], limit: max });
  if (!rows.length) return { ok: true, added: 0 };
  const have = new Set(cat.products.map((p) => p.id));
  try { await addAlbums(kv, rows.map((p) => albumIdOf(p.sourceUrl))); } catch (_) {}
  const fresh = rows
    .filter((p) => p && p.id && !have.has(p.id))
    .map((p) => { const o = plainTs(p); for (const f of PRIVATE_FIELDS) delete o[f]; return o; })
    .sort((a, b) => ((b.createdAt && b.createdAt.seconds) || 0) - ((a.createdAt && a.createdAt.seconds) || 0));
  const products = [...fresh, ...cat.products];
  const out = JSON.stringify({ version: startedAt, builtAtMs: startedAt, count: products.length, products });
  const bytes = new TextEncoder().encode(out).length;
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too-big' };
  let meta = {};
  try { meta = JSON.parse((await kv.get(META)) || '{}') || {}; } catch (_) {}
  await kv.put(KEY, out);
  // "dirty" resta com'era: le modifiche ai prodotti esistenti le ripubblica l'admin
  await kv.put(META, JSON.stringify({ ...meta, version: startedAt, builtAtMs: startedAt, count: products.length, bytes, mergedAt: startedAt, merged: fresh.length }));
  try { await caches.default.delete(new Request('https://lillofind.conti9708.workers.dev/catalog?__cache=1')); } catch (_) {}
  return { ok: true, added: fresh.length, count: products.length };
}

// POST /catalogMergeNew (solo admin): l'importer lo chiama a fine salvataggio.
export async function catalogMergeNew(_data, { env, db }) {
  return await mergeNewProducts(env, db);
}

// POST /catalogAlbums (solo admin) → { ids: [...] } album Yupoo già in catalogo
export async function catalogAlbums(_data, { env }) {
  const kv = env.CATALOG;
  if (!kv) return { ids: [] };
  let ids = [];
  try { ids = JSON.parse((await kv.get(ALBUMS)) || '[]') || []; } catch (_) {}
  return { ids };
}

// POST /markCatalogDirty (solo admin) — l'importer segnala modifiche: alla
// prossima apertura l'admin ripubblica il catalogo.
export async function markCatalogDirty(data, { env }) {
  const kv = env.CATALOG;
  if (!kv) return { ok: false };
  let meta = {};
  try { meta = JSON.parse((await kv.get(META)) || '{}') || {}; } catch (_) {}
  meta.dirty = true;
  await kv.put(META, JSON.stringify(meta));
  return { ok: true };
}
