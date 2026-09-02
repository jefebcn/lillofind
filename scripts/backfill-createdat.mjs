// Backfill una-tantum: imposta `createdAt` sui prodotti che non ce l'hanno.
// I documenti privi del campo venivano esclusi dalle query orderBy('createdAt').
// Usa un timestamp "legacy" fisso (2025-01-01) così i prodotti storici restano
// SOTTO gli import recenti nell'ordinamento "Più Recenti".
// Eseguito da GitHub Actions con il service account (GOOGLE_APPLICATION_CREDENTIALS).
import admin from 'firebase-admin';

admin.initializeApp({ projectId: 'lillofind-c455c' });
const db = admin.firestore();
const LEGACY = admin.firestore.Timestamp.fromDate(new Date('2025-01-01T00:00:00Z'));

const snap = await db.collection('products').get();
console.log('Totale prodotti:', snap.size);

let batch = db.batch();
let inBatch = 0, updated = 0, already = 0;

for (const d of snap.docs) {
  if (d.get('createdAt') != null) { already++; continue; }
  batch.update(d.ref, { createdAt: LEGACY });
  inBatch++; updated++;
  if (inBatch >= 400) {
    await batch.commit();
    batch = db.batch();
    inBatch = 0;
    console.log('…commit intermedio, aggiornati finora:', updated);
  }
}
if (inBatch > 0) await batch.commit();

console.log(`FATTO. Totale=${snap.size} · già_con_createdAt=${already} · aggiornati=${updated}`);
process.exit(0);
