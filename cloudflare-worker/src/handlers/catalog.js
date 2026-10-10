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
  const products = list.filter(p => p && typeof p === 'object' && typeof p.id === 'string').map(p => {
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
