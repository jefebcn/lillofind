// Sposta in `products_private` i campi privati (costi, ¥, link alla fonte)
// rimasti nel documento pubblico di `products`: l'importer li scriveva lì
// anche dopo la migrazione, finché non è stato corretto (ottobre 2026).
// Quota Firestore: niente lettura di tutto il catalogo. Per ogni campo
// privato una query ordinata su quel campo, che restituisce solo i prodotti
// che ce l'hanno; poi i loro documenti privati. DRY=1 non salva.
// Il repository è pubblico: nei log solo conteggi.
import fs from 'node:fs';
import admin from 'firebase-admin';

const DRY = process.env.DRY === '1';
const note = (m) => console.log('::notice::' + m);
const fail = (e) => { console.log('::error::' + String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 300)); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const { PRIVATE_FIELDS } = await import('../cloudflare-worker/src/lib/product-private.js');
const MAX_DOCS = Math.max(1, parseInt(process.env.MAX_DOCS || '2000', 10));
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();
const DEL = admin.firestore.FieldValue.delete();

// Prodotti con almeno un campo privato nel documento pubblico
const pub = new Map();
for (const f of PRIVATE_FIELDS) {
  const snap = await db.collection('products').orderBy(f).limit(MAX_DOCS).get();
  snap.docs.forEach((d) => pub.set(d.id, d.data()));
  if (pub.size >= MAX_DOCS) break;
}
const ids = [...pub.keys()].slice(0, MAX_DOCS);
const privOf = new Map();
for (let k = 0; k < ids.length; k += 300) {
  (await db.getAll(...ids.slice(k, k + 300).map((id) => db.collection('products_private').doc(id))))
    .forEach((d) => { if (d.exists) privOf.set(d.id, d.data()); });
}

// Privato + pulizia del pubblico nello stesso batch: un campo non resta mai senza copia.
// Quello già in products_private ha la precedenza e non si sovrascrive.
const count = {};
let batch = db.batch(), ops = 0, moved = 0;
for (const id of ids) {
  const p = pub.get(id), priv = privOf.get(id) || {};
  const leftover = PRIVATE_FIELDS.filter((f) => f in p);
  if (!leftover.length) continue;
  const move = {};
  leftover.forEach((f) => { count[f] = (count[f] || 0) + 1; if (!(f in priv)) move[f] = p[f]; });
  if (Object.keys(move).length) { batch.set(db.collection('products_private').doc(id), move, { merge: true }); ops++; }
  batch.update(db.collection('products').doc(id), Object.fromEntries(leftover.map((f) => [f, DEL]))); ops++;
  moved++;
  if (ops >= 400) { if (!DRY) await batch.commit(); batch = db.batch(); ops = 0; }
}
if (ops && !DRY) await batch.commit();
note(`Prodotti con campi privati nel documento pubblico: ${ids.length}${pub.size > ids.length ? ' (tetto ' + MAX_DOCS + ', rilanciare per i successivi)' : ''} · sistemati: ${DRY ? 0 : moved}${DRY ? ' (solo anteprima)' : ''} · campi: ${Object.entries(count).map(([k, v]) => k + ' ' + v).join(', ') || 'nessuno'}`);
