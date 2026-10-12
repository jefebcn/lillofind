// Corregge il marchio dei prodotti ciclismo (style "ciclismo") con la stessa
// regola dell'importer (LFCatalog.cyclingBrand in catalog-qc.js): squadra se
// c'è nel titolo, altrimenti marchio del capo, refusi compresi ("Naap" → Maap).
// I prodotti senza marchio riconoscibile restano come sono.
// Gira da GitHub Actions (fix-cycling-brands.yml); DRY=1 mostra solo le modifiche.
import fs from 'node:fs';
import vm from 'node:vm';
import admin from 'firebase-admin';

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../catalog-qc.js', import.meta.url), 'utf8'), ctx);
const { cyclingBrand } = ctx.window.LFCatalog;

const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();

// Refuso del marchio anche nel titolo ("NAAP Los Angeles…", "MAAPPR Cycling…"):
// si corregge solo quando il vecchio marchio è chiaramente un refuso del nuovo.
const typo = (a, b) => { a = a.toLowerCase(); b = b.toLowerCase(); if (a === b || a.length < 3) return false;
  if (a.startsWith(b)) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let d = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; } }
  return d + (a.length - i) + (b.length - j) <= 1; };
const fixText = (txt, from, to) => (from && typo(from, to)) ? String(txt || '').replace(new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), to) : txt;

const snap = await db.collection('products').where('style', '==', 'ciclismo').get();
const changes = [], unknown = [];
snap.docs.forEach((d) => {
  const p = d.data();
  const b = cyclingBrand(p.name || '', p.brand || '');
  if (!b) unknown.push(`${p.brand || '—'} | ${p.name || d.id}`);
  else if (b !== p.brand) {
    const name = fixText(p.name, p.brand, b), description = fixText(p.description, p.brand, b);
    changes.push({ id: d.id, from: p.brand || '', to: b, name: p.name || '', newName: name !== p.name ? name : null, newDesc: description !== p.description ? description : null });
  }
});
console.log(`Prodotti ciclismo: ${snap.size} · da correggere: ${changes.length} · non riconosciuti (invariati): ${unknown.length}`);
changes.forEach((c) => console.log(`  ${c.from || '—'} → ${c.to}   (${c.name})${c.newName ? '  · titolo → ' + c.newName : ''}`));
if (unknown.length) console.log('Non riconosciuti:\n  ' + unknown.join('\n  '));
if (process.env.DRY === '1' || !changes.length) process.exit(0);
for (let i = 0; i < changes.length; i += 400) {
  const b = db.batch();
  changes.slice(i, i + 400).forEach((c) => b.update(db.collection('products').doc(c.id), { brand: c.to, brandFixedFrom: c.from, brandFixedAt: admin.firestore.FieldValue.serverTimestamp(), ...(c.newName ? { name: c.newName } : {}), ...(c.newDesc ? { description: c.newDesc } : {}) }));
  await b.commit();
}
console.log(`Fatto: ${changes.length} marchi corretti.`);
