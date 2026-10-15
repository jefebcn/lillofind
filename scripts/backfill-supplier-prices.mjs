// Recupera il prezzo fornitore (¥) dei prodotti che non ce l'hanno, rileggendo
// l'album Yupoo da cui sono stati importati (sourceUrl in products_private) con
// la stessa regola dell'importer (albumPagePriceCNY). Serve allo strumento
// "Prezzi sotto il minimo" di Costi & Margini, che senza ¥ né ricevuta non può
// controllare un prodotto. Non cambia nessun prezzo di vendita.
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
const MAX = parseInt(process.env.MAX || '8000', 10);
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();

const total = (await db.collection('products').count().get()).data().count;
const priv = await db.collection('products_private').get();
const stat = { conRicevuta: 0, conYuan: 0, senzaLink: 0, linkNonYupoo: 0, daCercare: 0 };
const byAlbum = new Map();
priv.docs.forEach((d) => {
  const p = d.data();
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
console.log(`Prodotti: ${total} · con dati privati: ${priv.size}`);
console.log(`Con ricevuta: ${stat.conRicevuta} · con ¥ già salvato: ${stat.conYuan} · senza link: ${stat.senzaLink + Math.max(0, total - priv.size)} · link non Yupoo: ${stat.linkNonYupoo}`);
note(`Prodotti: ${total} · con ricevuta: ${stat.conRicevuta} · con ¥: ${stat.conYuan} · senza link: ${stat.senzaLink + Math.max(0, total - priv.size)} · link non Yupoo: ${stat.linkNonYupoo} · da cercare: ${stat.daCercare} (${byAlbum.size} album)`);
console.log(`Da cercare: ${stat.daCercare} prodotti in ${byAlbum.size} album${DRY ? ' (solo anteprima)' : ''}`);

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
let writer = db.batch(), pending = 0, i = 0;
async function flush() { const b = writer, n = pending; writer = db.batch(); pending = 0; if (n && !DRY) await b.commit(); }
async function worker() {
  while (i < albums.length) {
    const [url, ids] = albums[i++];
    const r = await albumPrice(url);
    if (r.cny) {
      res.trovati++; res.prodotti += ids.length;
      ids.forEach((id) => { writer.set(db.collection('products_private').doc(id), { supplierPriceCNY: r.cny, supplierPriceFrom: 'album', supplierPriceAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); pending++; });
      if (pending >= 400) await flush();
    } else if (r.gone) res.rimossi++;
    else if (r.error) { res.errori++; errs[r.error] = (errs[r.error] || 0) + 1; }
    else res.senzaPrezzo++;
    const n = res.trovati + res.rimossi + res.errori + res.senzaPrezzo;
    if (n % 250 === 0) console.log(`  … ${n}/${albums.length} album`);
    await new Promise((ok) => setTimeout(ok, 250));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
await flush();
console.log(`Album con prezzo: ${res.trovati} (${res.prodotti} prodotti${DRY ? ', non salvati' : ' aggiornati'})`);
console.log(`Album senza prezzo scritto: ${res.senzaPrezzo} · rimossi dal fornitore: ${res.rimossi} · errori: ${res.errori}`);
note(`Album con prezzo: ${res.trovati} (${res.prodotti} prodotti) · senza prezzo: ${res.senzaPrezzo} · rimossi: ${res.rimossi} · errori: ${res.errori}`);
if (res.errori) note('Errori: ' + Object.entries(errs).map(([k, v]) => `${k} ×${v}`).join(', '));
