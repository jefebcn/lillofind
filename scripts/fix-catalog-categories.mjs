// Corregge categoria, taglie, marchio, modello, genere e stile dei prodotti
// catalogati male (verifica del catalogo di ottobre 2026: catalog-fixes.json,
// { id: { campo: { from, to } } }; to = null toglie il campo).
// Ogni campo si cambia SOLO se oggi vale ancora quello atteso ("from"): se
// qualcuno l'ha già modificato a mano, resta com'è. Poi il workflow ripubblica
// il catalogo. DRY=1 mostra solo i conteggi.
// Il repository è pubblico: nei log solo conteggi.
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

const ids = Object.keys(FIX);
const snaps = [];
for (let i = 0; i < ids.length; i += 300) {
  snaps.push(...await db.getAll(...ids.slice(i, i + 300).map((id) => db.collection('products').doc(id))));
}

const count = {}, skipped = { mancante: 0, giaCambiato: 0 };
let batch = db.batch(), ops = 0, updated = 0;
for (const s of snaps) {
  if (!s.exists) { skipped.mancante++; continue; }
  const cur = s.data(), upd = {};
  for (const [field, { from, to }] of Object.entries(FIX[s.id])) {
    if (!same(cur[field], from)) { skipped.giaCambiato++; continue; }
    upd[field] = to === null ? DEL : to;
    if (field === 'sizes' && Array.isArray(to)) upd.size = to.join(', ');
    count[field] = (count[field] || 0) + 1;
  }
  if (!Object.keys(upd).length) continue;
  upd.catalogFixedAt = admin.firestore.FieldValue.serverTimestamp();
  batch.update(s.ref, upd); ops++; updated++;
  if (ops >= 400) { if (!DRY) await batch.commit(); batch = db.batch(); ops = 0; }
}
if (ops && !DRY) await batch.commit();
note(`Prodotti corretti: ${DRY ? 0 : updated} su ${ids.length} in elenco${DRY ? ' (solo anteprima)' : ''} · campi: ${Object.entries(count).map(([k, v]) => k + ' ' + v).join(', ') || 'nessuno'} · saltati: già cambiati a mano ${skipped.giaCambiato}, prodotti non più presenti ${skipped.mancante}`);
