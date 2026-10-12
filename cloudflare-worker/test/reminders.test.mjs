// Automazioni: novità nel catalogo pubblicato, carrello abbandonato, ordini non pagati.
import { cartNeedsReminder, unpaidAction, cartReminders, unpaidOrders, unsubscribeUrl, unsubscribe } from '../src/handlers/reminders.js';
import { mergeNewProducts, catalogAlbums, publishCatalog } from '../src/handlers/catalog.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const H = 3600e3, NOW = Date.UTC(2026, 9, 11, 12);
const ts = (ms) => ({ seconds: Math.floor(ms / 1000), _ts: new Date(ms).toISOString() });

function mockDb(seed) {
  const D = JSON.parse(JSON.stringify(seed));
  const cmp = (v, op, x) => { const a = typeof v === 'object' && v ? v.seconds * 1000 : v, b = x instanceof Date ? x.getTime() : x; return op === '<' ? a < b : op === '>' ? a > b : op === '==' ? v === x : true; };
  return {
    D,
    async runQuery(c, { where = [], limit } = {}) {
      let rows = Object.entries(D[c] || {}).map(([id, d]) => ({ id, ...d }));
      for (const [f, op, v] of where) rows = rows.filter((r) => r[f] != null && cmp(r[f], op, v));
      return rows.slice(0, limit || 999);
    },
    async getMany(c, ids) { return ids.map((id) => ({ exists: !!(D[c] || {})[id], id, data: () => (D[c] || {})[id] })); },
    async updateDoc(c, id, obj) { D[c][id] = { ...(D[c][id] || {}), ...JSON.parse(JSON.stringify(obj)) }; return true; },
  };
}
const mails = [];
globalThis.fetch = async (url, opts = {}) => { if (/resend/.test(url)) mails.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; };
const env = { RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.c>' };

// ── carrello ──
const item = { id: 'p1', name: 'Felpa', price: 40, qty: 1, img: 'https://x/i.jpg', size: 'M' };
const u = { email: 'a@x.it' };
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, u, NOW), true, 'carrello fermo da 30h: promemoria');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 5 * H }, u, NOW), false, 'troppo recente');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 100 * H }, u, NOW), false, 'troppo vecchio');
eq(cartNeedsReminder({ items: [], updatedAt: NOW - 30 * H }, u, NOW), false, 'carrello vuoto');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, { ...u, lastOrderAt: ts(NOW - 2 * H) }, NOW), false, 'ha ordinato dopo');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, { ...u, cartReminders: false }, NOW), false, 'disiscritto');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, { ...u, cartReminderAt: NOW - 3 * 24 * H }, NOW), false, 'avvisato 3 giorni fa');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, { ...u, cartReminderAt: NOW - 10 * 24 * H }, NOW), true, 'ultimo avviso 10 giorni fa');
eq(cartNeedsReminder({ items: [item], updatedAt: NOW - 30 * H }, {}, NOW), false, 'senza email');
{
  const db = mockDb({ carts: { u1: { items: [item], updatedAt: NOW - 30 * H }, u2: { items: [item], updatedAt: NOW - 2 * H } }, users: { u1: { email: 'a@x.it' }, u2: { email: 'b@x.it' } } });
  mails.length = 0;
  const r = await cartReminders(env, db, { now: NOW });
  eq([r.sent, mails.length, mails[0] && mails[0].to], [1, 1, ['a@x.it']], 'una email al carrello fermo');
  eq(/Felpa/.test(mails[0].html) && /go=cart/.test(mails[0].html) && /unsubscribe\?u=u1&amp;k=/.test(mails[0].html), true, 'email con articolo, link carrello e disiscrizione');
  eq(db.D.users.u1.cartReminderAt, NOW, 'avviso segnato');
  mails.length = 0;
  const r2 = await cartReminders(env, db, { now: NOW + H });
  eq([r2.sent, mails.length], [0, 0], 'giro dopo: nessun doppione');
}
{
  const db = mockDb({ users: { u1: { email: 'a@x.it' } } });
  const url = await unsubscribeUrl(env, 'u1');
  const k = new URL(url).searchParams.get('k');
  eq(await unsubscribe(env, db, 'u1', 'sbagliato'), false, 'firma sbagliata: rifiutata');
  eq(await unsubscribe(env, db, 'u1', k), true, 'firma giusta: disiscritto');
  eq(db.D.users.u1.cartReminders, false, 'preferenza salvata');
}

// ── ordini non pagati ──
const ord = (h, extra = {}) => ({ status: 'pending', paymentStatus: 'unpaid', payment: 'bonifico', createdAt: ts(NOW - h * H), orderId: 'LILLO-1', email: 'c@x.it', total: 55.5, phone: '333', ...extra });
eq(unpaidAction(ord(10), NOW), null, '10h: niente');
eq(unpaidAction(ord(30), NOW), 'remind', '30h: promemoria');
eq(unpaidAction(ord(30, { payReminderAt: ts(NOW - H) }), NOW), null, 'promemoria già mandato');
eq(unpaidAction(ord(50), NOW), 'expire', '50h: annullo');
eq(unpaidAction(ord(50, { reactivatedAt: ts(NOW - 2 * H) }), NOW), null, 'riattivato dall\'admin: riparte da zero');
eq(unpaidAction(ord(50, { payment: 'card' }), NOW), null, 'carta: mai');
eq(unpaidAction(ord(50, { paymentStatus: 'paid' }), NOW), null, 'pagato: mai');
eq(unpaidAction(ord(50, { status: 'confirmed' }), NOW), null, 'confermato: mai');
{
  const db = mockDb({ orders: { a: ord(30), b: ord(60, { orderId: 'LILLO-2', payment: 'paypal' }), c: ord(2), d: ord(60, { status: 'confirmed' }) } });
  mails.length = 0;
  const r = await unpaidOrders(env, db, { now: NOW });
  eq([r.reminded, r.expired], [1, ['LILLO-2']], 'un promemoria e un annullo');
  eq(db.D.orders.b.status, 'expired', 'ordine scaduto annullato');
  eq(!!db.D.orders.a.payReminderAt, true, 'promemoria segnato');
  eq(db.D.orders.c.status, 'pending', 'ordine recente intatto');
  const to = mails.map((m) => m.to[0] + ':' + m.subject.slice(0, 14));
  eq(mails.length, 3, 'promemoria + annullo al cliente + riepilogo admin');
  eq(/IE06 SUMU/.test(mails.find((m) => /completa il pagamento/.test(m.subject)).html), true, 'promemoria bonifico con IBAN');
  eq(/paypal\.me\/lilconti\/55\.50EUR/.test(mails.find((m) => /annullato/.test(m.subject) && m.to[0] === 'c@x.it').html) === false, true, 'annullo senza link di pagamento');
  eq(mails.some((m) => m.to[0] === 'yishionvt@gmail.com' && /LILLO-2/.test(m.html)), true, 'riepilogo all\'admin');
  mails.length = 0;
  const r2 = await unpaidOrders(env, db, { now: NOW + H });
  eq([r2.reminded, r2.expired.length, mails.length], [0, 0, 0], 'giro dopo: niente doppioni');
}
{
  const db = mockDb({ orders: { z: ord(24 * 30, { orderId: 'LILLO-OLD' }) } });
  mails.length = 0;
  const r = await unpaidOrders(env, db, { now: NOW });
  eq([r.expired, db.D.orders.z.status], [['LILLO-OLD'], 'expired'], 'ordine vecchio di un mese: annullato');
  eq(mails.map((m) => m.to[0]), ['yishionvt@gmail.com'], 'ordine vecchio: nessuna email al cliente, solo riepilogo admin');
}

// ── catalogo: novità aggiunte dal server ──
{
  const store = {};
  const kv = { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } };
  globalThis.caches = { default: { delete: async () => true } };
  const built = NOW - 10 * H;
  store.catalog = JSON.stringify({ version: built, builtAtMs: built, count: 1, products: [{ id: 'old', name: 'Vecchio', createdAt: { seconds: (built - H) / 1000, nanoseconds: 0 } }] });
  store['catalog:meta'] = JSON.stringify({ builtAtMs: built, count: 1, dirty: true });
  const db = mockDb({ products: {
    old: { name: 'Vecchio', createdAt: ts(built - H) },
    n1: { name: 'Kit EF', createdAt: ts(NOW - 2 * H), style: 'ciclismo', costEUR: 12, sourceUrl: 'https://x.yupoo.com/albums/1' },
    n2: { name: 'Kit UAE', createdAt: ts(NOW - H) },
  } });
  const r = await mergeNewProducts({ CATALOG: kv }, db);
  const cat = JSON.parse(store.catalog);
  eq([r.added, cat.count], [2, 3], 'due novità aggiunte');
  eq(cat.products.map((p) => p.id), ['n2', 'n1', 'old'], 'novità in cima, più recenti prima');
  eq('costEUR' in cat.products[1] || 'sourceUrl' in cat.products[1], false, 'campi privati tolti');
  eq(cat.products[0].createdAt, { seconds: (NOW - H) / 1000, nanoseconds: 0 }, 'data nella forma dell\'admin');
  eq(cat.builtAtMs > built, true, 'data di pubblicazione avanzata');
  eq(JSON.parse(store['catalog:meta']).dirty, true, 'segnale "da ripubblicare" dell\'admin invariato');
  eq(JSON.parse(store['catalog:albums']), ['1'], 'album della novità nell\'indice per l\'importer');
  eq((await catalogAlbums({}, { env: { CATALOG: kv } })).ids, ['1'], 'l\'importer legge l\'indice album');
  await publishCatalog({ products: [{ id: 'a', sourceUrl: 'https://s.x.yupoo.com/albums/77?uid=1' }, { id: 'b' }] }, { env: { CATALOG: kv } });
  eq(JSON.parse(store['catalog:albums']).sort(), ['1', '77'], 'la pubblicazione admin aggiunge i suoi album');
  eq('sourceUrl' in JSON.parse(store.catalog).products[0], false, 'sourceUrl resta fuori dal catalogo pubblico');
  const r2 = await mergeNewProducts({ CATALOG: kv }, db);
  eq(r2.added, 0, 'secondo giro: niente da aggiungere');
}

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
