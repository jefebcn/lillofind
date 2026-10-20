// Diagnosi dei link al fornitore (sourceUrl) usati negli ordini: per ogni
// articolo degli ordini (e per tutto il catalogo) classifica il link e, per
// quelli degli ordini, controlla se la pagina risponde. Nessuna scrittura.
// Il repository è pubblico: nei log solo conteggi e nomi di dominio.
import fs from 'node:fs';
import admin from 'firebase-admin';

const note = (m) => console.log('::notice::' + m);
const fail = (e) => { console.log('::error::' + String((e && (e.code ? e.code + ' ' : '') + e.message) || e).slice(0, 300)); process.exit(1); };
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id });
const db = admin.firestore();

function kind(u) {
  u = String(u || '').trim();
  if (!u) return 'mancante';
  let h; try { h = new URL(u).hostname.toLowerCase(); } catch (_) { return 'non valido'; }
  if (/yupoo\.com$/.test(h)) {
    if (/\/albums\/\d+/.test(u)) return 'yupoo album';
    if (/\/categories\/\d+/.test(u)) return 'yupoo categoria';
    if (h.startsWith('photo.')) return 'yupoo foto';
    return 'yupoo negozio';
  }
  if (/weidian\.com$|koudai\.com$/.test(h)) return /item(?:ID|_id|id)=\d+|\/item\/\d+/i.test(u) ? 'weidian articolo' : 'weidian altro';
  if (/(taobao|tmall)\.com$/.test(h)) return /[?&]id=\d+/.test(u) ? 'taobao articolo' : 'taobao altro';
  if (/workers\.dev$/.test(h)) return 'proxy foto';
  return 'altro: ' + h;
}
const tally = (arr) => Object.entries(arr.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', ');

// Solo gli ordini e i prodotti che vi compaiono (poche letture della quota Firestore)
const orders = await db.collection('orders').get();
const ids = [...new Set(orders.docs.flatMap((o) => (o.data().items || []).filter((i) => !i.isDigital && i.id).map((i) => i.id)))];
const src = new Map(), alive = new Set();
for (let k = 0; k < ids.length; k += 300) {
  const part = ids.slice(k, k + 300);
  (await db.getAll(...part.map((id) => db.collection('products_private').doc(id))))
    .forEach((d) => { if (d.exists) src.set(d.id, d.data().sourceUrl || ''); });
  (await db.getAll(...part.map((id) => db.collection('products').doc(id))))
    .forEach((d) => { if (d.exists) alive.add(d.id); });
}
note('Prodotti negli ordini: ' + ids.length + ' · ancora nel catalogo ' + alive.size + ' · con dati privati ' + src.size);

// Articoli fisici degli ordini: link salvato nell'articolo o, se manca, quello del prodotto
const items = [];
orders.docs.forEach((o) => (o.data().items || []).forEach((i) => {
  if (i.isDigital) return;
  const fromItem = String(i.sourceUrl || '');
  const fromProd = src.get(i.id) || '';
  items.push({ url: fromItem || fromProd, where: fromItem ? 'articolo' : fromProd ? 'prodotto' : 'nessuno', prodExists: src.has(i.id) });
}));
note('Ordini: ' + orders.size + ' · articoli fisici ' + items.length + ' · link da: ' + tally(items.map((x) => x.where)) + ' · tipi: ' + tally(items.map((x) => kind(x.url))));

// Le pagine rispondono?
const HDR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
// Come li apre l'admin: agli album Yupoo si aggiunge ?uid=1 (senza, Yupoo risponde 404)
const ypAlbumUrl = (u) => { try { const x = new URL(u); if (/\.x\.yupoo\.com$/i.test(x.hostname) && /\/albums\/\d+/.test(x.pathname) && !x.searchParams.has('uid')) { x.searchParams.set('uid', '1'); return x.href; } } catch (_) {} return u; };
const uniq = [...new Set(items.map((x) => ypAlbumUrl(x.url)).filter(Boolean))];
const res = [];
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < uniq.length) {
    const u = uniq[i++];
    try {
      const r = await fetch(u, { headers: HDR, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const loc = r.headers.get('location') || '';
      res.push(r.status >= 300 && r.status < 400 ? 'redirect ' + r.status + (loc ? ' → ' + kind(new URL(loc, u).href) : '') : 'HTTP ' + r.status);
    } catch (e) { res.push('errore ' + String(e.name || e.message).slice(0, 30)); }
  }
}));
note('Link degli ordini controllati: ' + uniq.length + ' · ' + tally(res));
