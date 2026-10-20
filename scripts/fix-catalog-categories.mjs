// Corregge categoria, taglie, marchio, modello, genere e stile dei prodotti
// catalogati male (verifica del catalogo di ottobre 2026: catalog-fixes.json,
// { id: { campo: { from, to } } }; to = null toglie il campo).
// Ogni campo si cambia SOLO se oggi vale ancora quello atteso ("from"): se
// qualcuno l'ha già modificato a mano, resta com'è. Poi il workflow ripubblica
// il catalogo. DRY=1 mostra solo i conteggi.
// Il repository è pubblico: nei log solo conteggi.
//
// Quota Firestore (piano Spark: 50.000 letture e 20.000 scritture al giorno,
// le stesse che servono al checkout): al massimo MAX_DOCS prodotti per giro
// (una lettura e una scrittura ciascuno). Quelli già a posto nel catalogo
// pubblico si saltano senza leggerli, così i giri successivi proseguono da
// dove si era arrivati. Il catalogo dello shop si aggiorna poi nel KV
// applicando solo le modifiche fatte (applied.json), senza rileggere tutti i
// prodotti da Firestore come faceva la ripubblicazione completa.
import fs from 'node:fs';
import admin from 'firebase-admin';

const DRY = process.env.DRY === '1';
const note = (m) => console.log('::notice::' + m);
const fail = (e) => {
  const msg = String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 300);
  // quota giornaliera di Firestore finita: nessuna scrittura fatta, si rilancia dopo le 9:00 (ora di Roma)
  console.log('::error::' + (/RESOURCE_EXHAUSTED|quota/i.test(msg) ? 'Quota Firestore esaurita: rilanciare dopo il reset (09:00 ora di Roma), i campi già corretti vengono saltati. ' : '') + msg);
  process.exit(1);
};
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

const FIX = JSON.parse(fs.readFileSync(new URL('./catalog-fixes.json', import.meta.url), 'utf8'));
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();
const DEL = admin.firestore.FieldValue.delete();
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const MAX_DOCS = Math.max(1, parseInt(process.env.MAX_DOCS || '400', 10));
const CATALOG_URL = process.env.CATALOG_URL || 'https://lillofind.conti9708.workers.dev/catalog';

// Catalogo pubblico (KV, nessuna lettura Firestore): cosa resta da fare
let pub = null;
try { pub = new Map(((await (await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60000) })).json()).products || []).map((p) => [p.id, p])); }
catch (e) { console.log('Catalogo pubblico non leggibile, si controllano tutti: ' + String(e.message || e).slice(0, 120)); }
const pending = Object.keys(FIX).filter((id) => {
  if (!pub) return true;
  const p = pub.get(id);
  if (!p) return false;                       // non più nel catalogo
  return Object.entries(FIX[id]).some(([f, { from }]) => same(p[f], from));
});
const ids = pending.slice(0, MAX_DOCS);
console.log(`Da fare: ${pending.length} su ${Object.keys(FIX).length} · in questo giro: ${ids.length} (tetto ${MAX_DOCS})`);
const snaps = [];
for (let i = 0; i < ids.length; i += 300) {
  snaps.push(...await db.getAll(...ids.slice(i, i + 300).map((id) => db.collection('products').doc(id))));
}

const count = {}, skipped = { mancante: 0, giaCambiato: 0 };
const applied = {};   // per aggiornare il catalogo nel KV: { id: { campo: nuovo valore | null } }
let batch = db.batch(), ops = 0, updated = 0;
for (const s of snaps) {
  if (!s.exists) { skipped.mancante++; continue; }
  const cur = s.data(), upd = {};
  for (const [field, { from, to }] of Object.entries(FIX[s.id])) {
    if (!same(cur[field], from)) { skipped.giaCambiato++; continue; }
    upd[field] = to === null ? DEL : to;
    (applied[s.id] = applied[s.id] || {})[field] = to;
    if (field === 'sizes' && Array.isArray(to)) { upd.size = to.join(', '); applied[s.id].size = upd.size; }
    count[field] = (count[field] || 0) + 1;
  }
  if (!Object.keys(upd).length) continue;
  upd.catalogFixedAt = admin.firestore.FieldValue.serverTimestamp();
  batch.update(s.ref, upd); ops++; updated++;
  if (ops >= 400) { if (!DRY) await batch.commit(); batch = db.batch(); ops = 0; }
}
if (ops && !DRY) await batch.commit();
fs.writeFileSync(new URL('./applied.json', import.meta.url), JSON.stringify(DRY ? {} : applied));
note(`Prodotti corretti: ${DRY ? 0 : updated} su ${ids.length} in questo giro (ancora da fare dopo: ${Math.max(0, pending.length - ids.length)})${DRY ? ' (solo anteprima)' : ''} · campi: ${Object.entries(count).map(([k, v]) => k + ' ' + v).join(', ') || 'nessuno'} · saltati: già cambiati a mano ${skipped.giaCambiato}, prodotti non più presenti ${skipped.mancante}`);
