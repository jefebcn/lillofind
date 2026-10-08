// Pubblica il catalogo dello shop su Cloudflare KV leggendo i prodotti UNA volta
// da Firestore (service account). Usato dal workflow catalog-publish.yml.
// Scrive catalog.json e catalog-meta.json nello stesso formato di
// POST /publishCatalog del Worker (cloudflare-worker/src/handlers/catalog.js).
import fs from 'node:fs';
import admin from 'firebase-admin';

const PRIVATE_FIELDS = ['costEUR', 'costFx', 'costFxDate', 'costUpdatedAt', 'supplierPriceCNY', 'sourceUrl'];
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });

// Timestamp Firestore → {seconds, nanoseconds} come nel client web
const plain = (v) => {
  if (v && typeof v.toMillis === 'function' && 'seconds' in v) return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = plain(v[k]); return o; }
  return v;
};

const snap = await admin.firestore().collection('products').get();
const products = snap.docs.map(d => {
  const o = plain(d.data()); o.id = d.id;
  for (const f of PRIVATE_FIELDS) delete o[f];
  return o;
});
if (!products.length) { console.error('Nessun prodotto letto: niente da pubblicare.'); process.exit(1); }
const version = Date.now();
const body = JSON.stringify({ version, builtAtMs: version, count: products.length, products });
const bytes = Buffer.byteLength(body);
if (bytes > 24 * 1024 * 1024) { console.error('Catalogo troppo grande:', bytes); process.exit(1); }
fs.writeFileSync('catalog.json', body);
fs.writeFileSync('catalog-meta.json', JSON.stringify({ version, builtAtMs: version, count: products.length, bytes, dirty: false }));
console.log(`Catalogo pronto: ${products.length} prodotti, ${(bytes / 1048576).toFixed(1)} MB`);
