// Applica al catalogo pubblico (KV `catalog`) solo le modifiche appena salvate
// su Firestore (applied.json di fix-catalog-categories.mjs), senza rileggere
// tutti i prodotti: la ripubblicazione completa costava ~7000 letture della
// quota giornaliera. Uso: node patch-catalog-kv.mjs <catalogo attuale> <applied.json>
// Scrive catalog.json e catalog-meta.json accanto allo script. Esce con 2 se
// non c'è niente da aggiornare.
import fs from 'node:fs';

const [catPath, appliedPath] = process.argv.slice(2);
const applied = JSON.parse(fs.readFileSync(appliedPath, 'utf8') || '{}');
const ids = Object.keys(applied);
if (!ids.length) { console.log('Nessuna modifica da applicare al catalogo.'); process.exit(2); }
const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
if (!Array.isArray(cat.products) || !cat.products.length) { console.error('Catalogo nel KV non valido: niente da aggiornare.'); process.exit(1); }
let n = 0;
for (const p of cat.products) {
  const upd = applied[p.id];
  if (!upd) continue;
  for (const [k, v] of Object.entries(upd)) { if (v === null) delete p[k]; else p[k] = v; }
  n++;
}
const version = Date.now();
const body = JSON.stringify({ ...cat, version, builtAtMs: version, count: cat.products.length });
const out = new URL('.', import.meta.url);
fs.writeFileSync(new URL('catalog.json', out), body);
fs.writeFileSync(new URL('catalog-meta.json', out), JSON.stringify({ version, builtAtMs: version, count: cat.products.length, bytes: Buffer.byteLength(body), dirty: false }));
console.log(`Catalogo aggiornato: ${n} prodotti modificati su ${cat.products.length}`);
