// Test catalogo KV con KV e cache finti (`node test/catalog.test.mjs`).
import { getCatalog, publishCatalog, markCatalogDirty } from '../src/handlers/catalog.js';
let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const store = new Map();
const kv = { get: async k => store.has(k) ? store.get(k) : null, put: async (k, v) => { store.set(k, v); } };
const cstore = new Map();
globalThis.caches = { default: { match: async r => cstore.get(r.url) || null, put: async (r, res) => { cstore.set(r.url, res); }, delete: async r => cstore.delete(r.url) } };
const ctx = (url, env) => ({ env, req: { url, query: k => new URL(url).searchParams.get(k) }, executionCtx: { waitUntil: p => p } });
const env = { CATALOG: kv };
let r = await getCatalog(ctx('https://w.dev/catalog', env));
eq(r.status, 404, 'non pubblicato → 404');
const meta = await publishCatalog({ products: [{ id: 'p1', name: 'A', price: 10, costEUR: 4, sourceUrl: 'https://x/albums/1', supplierPriceCNY: 30 }, { id: 'p2', name: 'B' }, { nope: 1 }] }, { env });
eq(meta.count, 2, 'conta solo prodotti validi');
r = await getCatalog(ctx('https://w.dev/catalog', env));
const j = await r.json();
eq(j.products.map(p => p.id), ['p1', 'p2'], 'prodotti serviti');
eq('costEUR' in j.products[0] || 'sourceUrl' in j.products[0] || 'supplierPriceCNY' in j.products[0], false, 'dati interni rimossi');
eq(r.headers.get('Cache-Control'), 'public, max-age=120', 'cache 2 min');
r = await getCatalog(ctx('https://w.dev/catalog?meta=1', env));
eq((await r.json()).dirty, false, 'meta pulita');
await markCatalogDirty({}, { env });
r = await getCatalog(ctx('https://w.dev/catalog?meta=1', env));
eq((await r.json()).dirty, true, 'meta sporca');
let err = null; try { await publishCatalog({ products: [] }, { env }); } catch (e) { err = e.code; }
eq(err, 'invalid-argument', 'catalogo vuoto rifiutato');
r = await getCatalog(ctx('https://w.dev/catalog', {}));
eq(r.status, 503, 'senza KV → 503');
console.log(`${pass} passati, ${fail} falliti`); if (fail) process.exit(1);
