// PayPal automatico: createPaypalOrder → (cliente approva su PayPal) → capturePaypalOrder.
// Niente rete: PayPal e Resend sono finti.
import { createPaypalOrder, capturePaypalOrder, validateOrder } from '../src/handlers/checkout.js';
import { DELETE_FIELD } from '../src/lib/firestore.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const throwsCode = async (fn, code, l) => { try { await fn(); fail++; console.error('❌ ' + l + ' (nessun errore)'); } catch (e) { eq(e.code, code, l); } };

function mockDb(seed) {
  const D = JSON.parse(JSON.stringify(seed)); let n = 0;
  const get = (c, id) => (D[c] || {})[id];
  return {
    D,
    async getDoc(c, id) { const d = get(c, id); return { exists: !!d, id, data: () => d || null }; },
    async getMany(c, ids) { return ids.map((id) => { const d = get(c, id); return { exists: !!d, id, data: () => d || null }; }); },
    async setDoc(c, id, obj) { (D[c] = D[c] || {})[id] = obj; return id; },
    async addDoc(c, obj) { const id = 'gen' + (++n); (D[c] = D[c] || {})[id] = obj; return id; },
    async updateDoc(c, id, obj) { const cur = (D[c] = D[c] || {})[id] || {}; for (const k in obj) { if (obj[k] === DELETE_FIELD) delete cur[k]; else cur[k] = obj[k]; } D[c][id] = cur; return true; },
    async runQuery() { return []; },
    async increment(c, id, f, by) { const cur = (D[c] = D[c] || {})[id] || {}; cur[f] = (Number(cur[f]) || 0) + by; D[c][id] = cur; return true; },
    async createAtomic(docs) {
      for (const d of docs) if (d.mustNotExist && get(d.collection, d.id)) { const e = new Error('exists'); e.code = 'already-exists'; throw e; }
      for (const d of docs) (D[d.collection] = D[d.collection] || {})[d.id] = d.fields;
      return true;
    },
  };
}

// PayPal finto: un solo ordine, stato e importo modificabili dai test
const PP = { orders: {}, captures: 0, seq: 0 };
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push(url);
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, text: async () => JSON.stringify(o) });
  if (/oauth2\/token/.test(url)) return json({ access_token: 'tok' });
  if (/\/v2\/checkout\/orders$/.test(url)) {
    const body = JSON.parse(opts.body); const id = 'PP' + (++PP.seq);
    const pu = body.purchase_units[0];
    PP.orders[id] = { id, status: 'CREATED', purchase_units: [{ custom_id: pu.custom_id, amount: pu.amount }] };
    return json({ id, status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve/' + id }] });
  }
  let m = url.match(/\/v2\/checkout\/orders\/([^/]+)\/capture$/);
  if (m) {
    const o = PP.orders[m[1]];
    if (o.status === 'COMPLETED') return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422);
    PP.captures++; o.status = 'COMPLETED';
    o.payer = { email_address: 'buyer@pp.it' };
    o.purchase_units[0].payments = { captures: [{ id: 'CAP' + m[1], status: 'COMPLETED', amount: o.purchase_units[0].amount, seller_receivable_breakdown: { paypal_fee: { value: '1.03' } } }] };
    return json(o);
  }
  m = url.match(/\/v2\/checkout\/orders\/([^/?]+)$/);
  if (m) return PP.orders[m[1]] ? json(PP.orders[m[1]]) : json({}, 404);
  return json({}); // Resend
};

const env = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.c>', ADMIN_EMAILS: 'admin@lillofind.com', ALLOWED_ORIGINS: 'https://lillofind.shop' };
const auth = (uid, email) => ({ uid, email, token: { email, email_verified: true, firebase: { sign_in_provider: 'password' } } });
const seed = { products: { p1: { name: 'Polo', price: 20, weightKg: 0.4 } }, users: { u1: { email: 'u1@x.it', lfpoints: 5 } } };
const order = { items: [{ id: 'p1', qty: 2, size: 'M' }], shippingAddress: { street: 'Via 1', city: 'Roma', zip: '00100' }, name: 'Mario', email: 'u1@x.it', phone: '333333' };

// 1) giro completo
{
  const db = mockDb(seed); const ctx = { env, db, auth: auth('u1', 'u1@x.it') };
  const c = await createPaypalOrder({ items: order.items, order, returnUrl: 'https://lillofind.shop/' }, ctx);
  eq(c.approveUrl.startsWith('https://paypal.test/approve/'), true, 'link di approvazione PayPal');
  eq(typeof c.amount === 'number' && c.amount > 40, true, 'totale verificato dal server (prodotti + spedizione)');
  eq(!!db.D.pending_orders['pp_' + c.id], true, 'ordine in attesa salvato');
  eq(PP.captures, 0, 'nessun incasso prima dell\'approvazione');
  PP.orders[c.id].status = 'APPROVED';
  const r = await capturePaypalOrder({ paypalOrderId: c.id }, ctx);
  const o = Object.values(db.D.orders)[0];
  eq(o.paymentStatus, 'paid', 'ordine PAGATO in automatico');
  eq(o.payment, 'paypal', 'metodo paypal');
  eq(o.paymentFee, 1.03, 'commissione PayPal reale salvata');
  eq(o.paypalCaptureId, 'CAP' + c.id, 'id incasso salvato');
  eq(db.D.users.u1.lfpoints, 5 + 40, 'punti accreditati subito');
  eq(r.lfpoints, 40, 'punti restituiti al sito');
  eq(PP.captures, 1, 'incassato una volta');
  // 1b) ritorno ripetuto (refresh): nessun doppione, nessun secondo incasso
  const r2 = await capturePaypalOrder({ paypalOrderId: c.id }, ctx);
  eq(r2.alreadyCreated, true, 'ritorno ripetuto: stesso ordine');
  eq(Object.keys(db.D.orders).length, 1, 'un solo ordine');
  eq(db.D.users.u1.lfpoints, 45, 'punti non raddoppiati');
  eq(PP.captures, 1, 'nessun secondo incasso');
}
// 2) importo diverso dal totale: niente incasso, niente ordine
{
  const db = mockDb(seed); const ctx = { env, db, auth: auth('u1', 'u1@x.it') };
  const c = await createPaypalOrder({ items: order.items, order }, ctx);
  PP.orders[c.id].status = 'APPROVED'; PP.orders[c.id].purchase_units[0].amount.value = '1.00';
  const before = PP.captures;
  await throwsCode(() => capturePaypalOrder({ paypalOrderId: c.id }, ctx), 'failed-precondition', 'importo diverso: rifiutato');
  eq(PP.captures, before, 'importo diverso: nessun incasso');
  eq(Object.keys(db.D.orders || {}).length, 0, 'importo diverso: nessun ordine');
}
// 3) pagamento di un altro account
{
  const db = mockDb(seed);
  const c = await createPaypalOrder({ items: order.items, order }, { env, db, auth: auth('u1', 'u1@x.it') });
  PP.orders[c.id].status = 'APPROVED';
  await throwsCode(() => capturePaypalOrder({ paypalOrderId: c.id }, { env, db, auth: auth('u9', 'u9@x.it') }), 'permission-denied', 'altro account: rifiutato');
  // anche passando direttamente da validateOrder
  await throwsCode(() => validateOrder({ ...order, paymentMethod: 'paypal', paypalOrderId: c.id }, { env, db, auth: auth('u9', 'u9@x.it') }), 'permission-denied', 'validateOrder con PayPal di un altro: rifiutato');
}
// 4) non approvato
{
  const db = mockDb(seed); const ctx = { env, db, auth: auth('u1', 'u1@x.it') };
  const c = await createPaypalOrder({ items: order.items, order }, ctx);
  await throwsCode(() => capturePaypalOrder({ paypalOrderId: c.id }, ctx), 'failed-precondition', 'non approvato: rifiutato');
}
// 5) PayPal spento: come prima (ordine da pagare, conferma manuale)
{
  const db = mockDb(seed); const env0 = { ...env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' };
  await throwsCode(() => createPaypalOrder({ items: order.items, order }, { env: env0, db, auth: auth('u1', 'u1@x.it') }), 'failed-precondition', 'paypal spento: niente checkout automatico');
  await validateOrder({ ...order, paymentMethod: 'paypal' }, { env: env0, db, auth: auth('u1', 'u1@x.it') });
  const o = Object.values(db.D.orders)[0];
  eq(o.paymentStatus, 'unpaid', 'paypal manuale: resta da pagare');
}

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
