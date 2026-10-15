// Recupera il prezzo fornitore (¥) dei prodotti che non ce l'hanno, rileggendo
// l'album Yupoo da cui sono stati importati (sourceUrl) con la stessa regola
// dell'importer (albumPagePriceCNY). Serve allo strumento "Prezzi sotto il
// minimo" di Costi & Margini, che senza ¥ né ricevuta non può controllare un
// prodotto. Non cambia nessun prezzo di vendita.
// Intanto completa lo spostamento dei campi privati (costi, ¥, link alla
// fonte) da `products`, leggibile da chiunque, a `products_private`: il
// pulsante del Worker (migratePrivateFields) si fermava dopo pochi prodotti.
// Gira da GitHub Actions (backfill-supplier-prices.yml); DRY=1 non salva.
// Il repository è pubblico: nei log solo conteggi, mai prezzi o link.
import fs from 'node:fs';
import admin from 'firebase-admin';

const DRY = process.env.DRY === '1';
// Errori e riepilogo anche come annotazioni di GitHub Actions (leggibili senza i log)
const note = (m) => console.log('::notice::' + m);
const fail = (e) => { console.log('::error::' + String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 300)); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const { albumPagePriceCNY } = await import('../cloudflare-worker/src/handlers/scrapers.js');
const { PRIVATE_FIELDS } = await import('../cloudflare-worker/src/lib/product-private.js');
const MAX = parseInt(process.env.MAX || '8000', 10);
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();
const DEL = admin.firestore.FieldValue.delete();

const [pubSnap, privSnap] = await Promise.all([db.collection('products').get(), db.collection('products_private').get()]);
const privOf = new Map(privSnap.docs.map((d) => [d.id, d.data()]));
// Per prodotto: campi privati ancora nel documento pubblico da spostare (senza
// sovrascrivere quelli già in products_private, che hanno la precedenza) e ¥ trovato.
const plan = new Map();
const stat = { conRicevuta: 0, conYuan: 0, senzaLink: 0, linkNonYupoo: 0, daCercare: 0, daSpostare: 0 };
const byAlbum = new Map();
pubSnap.docs.forEach((d) => {
  const pub = d.data(), priv = privOf.get(d.id) || {};
  const leftover = PRIVATE_FIELDS.filter((f) => f in pub);
  if (leftover.length) {
    stat.daSpostare++;
    const move = {};
    leftover.forEach((f) => { if (!(f in priv)) move[f] = pub[f]; });
    plan.set(d.id, { move, clear: leftover, cny: null });
  }
  const p = { ...pub, ...priv };
  if (+p.costUnitPriceUsd > 0) { stat.conRicevuta++; return; }
  if (+p.supplierPriceCNY > 0) { stat.conYuan++; return; }
  let u;
  try { u = new URL(String(p.sourceUrl || '')); } catch (_) { stat.senzaLink++; return; }
  if (!u.hostname.endsWith('.yupoo.com') || !/\/albums\/\d+/.test(u.pathname)) { stat.linkNonYupoo++; return; }
  const key = u.origin + u.pathname.replace(/\/$/, '');
  if (!byAlbum.has(key)) byAlbum.set(key, []);
  byAlbum.get(key).push(d.id);
  stat.daCercare++;
});
console.log(`Prodotti: ${pubSnap.size} · con dati privati separati: ${privSnap.size}`);
note(`Prodotti: ${pubSnap.size} · con ricevuta: ${stat.conRicevuta} · con ¥: ${stat.conYuan} · senza link: ${stat.senzaLink} · link non Yupoo: ${stat.linkNonYupoo} · da cercare: ${stat.daCercare} (${byAlbum.size} album) · campi privati da spostare: ${stat.daSpostare}${DRY ? ' (solo anteprima)' : ''}`);

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
async function albumPrice(url) {
  for (let t = 0; t < 2; t++) {
    try {
      const r = await fetch(url + '?uid=1', { headers: { ...HDR, Referer: new URL(url).origin + '/' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404 || r.status === 410) return { gone: true };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      const h1 = html.match(/<h1[^>]*>([^<]{2,220})<\/h1>/i), tt = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const rawTitle = (h1 ? h1[1] : (tt ? tt[1] : '')) || '';
      const v = albumPagePriceCNY(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), rawTitle);
      return { cny: v >= 10 && v <= 5000 ? v : null };
    } catch (e) {
      if (t) return { error: e.message };
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}

const albums = [...byAlbum.entries()].slice(0, MAX);
const res = { trovati: 0, prodotti: 0, senzaPrezzo: 0, rimossi: 0, errori: 0 };
const errs = {};
let i = 0;
async function worker() {
  while (i < albums.length) {
    const [url, ids] = albums[i++];
    const r = await albumPrice(url);
    if (r.cny) {
      res.trovati++; res.prodotti += ids.length;
      ids.forEach((id) => { const e = plan.get(id) || { move: {}, clear: [] }; e.cny = r.cny; plan.set(id, e); });
    } else if (r.gone) res.rimossi++;
    else if (r.error) { res.errori++; errs[r.error] = (errs[r.error] || 0) + 1; }
    else res.senzaPrezzo++;
    const n = res.trovati + res.rimossi + res.errori + res.senzaPrezzo;
    if (n % 250 === 0) console.log(`  … ${n}/${albums.length} album`);
    await new Promise((ok) => setTimeout(ok, 250));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

// Scritture: per ogni prodotto, privato + pulizia del pubblico nello stesso batch
// (atomico: un campo non resta mai senza copia). Max 2 scritture a prodotto.
let batch = db.batch(), ops = 0, scritti = 0;
const ts = admin.firestore.FieldValue.serverTimestamp();
for (const [id, e] of plan) {
  const data = { ...e.move };
  if (e.cny) Object.assign(data, { supplierPriceCNY: e.cny, supplierPriceFrom: 'album', supplierPriceAt: ts });
  if (Object.keys(data).length) { batch.set(db.collection('products_private').doc(id), data, { merge: true }); ops++; }
  if (e.clear.length) { batch.update(db.collection('products').doc(id), Object.fromEntries(e.clear.map((f) => [f, DEL]))); ops++; }
  scritti++;
  if (ops >= 400) { if (!DRY) await batch.commit(); batch = db.batch(); ops = 0; }
}
if (ops && !DRY) await batch.commit();
note(`Album con prezzo: ${res.trovati} (${res.prodotti} prodotti) · senza prezzo scritto: ${res.senzaPrezzo} · rimossi dal fornitore: ${res.rimossi} · errori: ${res.errori} · prodotti aggiornati: ${DRY ? 0 : scritti}`);
if (res.errori) note('Errori: ' + Object.entries(errs).map(([k, v]) => `${k} ×${v}`).join(', '));
