// Test dei handler checkout/loyalty con un Firestore finto in memoria.
// Eseguibile con `node test/handlers.test.mjs` (niente rete: fetch è finto).
import { validateOrder, sendOrderEmail, track17, rewardDiscount } from '../src/handlers/checkout.js';
import { claimReward, claimReferrals } from '../src/handlers/loyalty.js';
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
    async getMany(c, ids) { return ids.map(id => { const d = get(c, id); return { exists: !!d, id, data: () => d || null }; }); },
    async addDoc(c, obj) { const id = 'gen' + (++n); (D[c] = D[c] || {})[id] = obj; return id; },
    async updateDoc(c, id, obj) { const cur = (D[c] = D[c] || {})[id] || {}; for (const k in obj) { if (obj[k] === DELETE_FIELD) delete cur[k]; else cur[k] = obj[k]; } D[c][id] = cur; return true; },
    async runQuery(c, { where = [], limit } = {}) {
      let rows = Object.entries(D[c] || {}).map(([id, d]) => ({ id, ...d }));
      for (const [f, op, v] of where) rows = rows.filter(r => op === '==' ? r[f] === v : true);
      return rows.slice(0, limit || 999);
    },
    async commitUpdates(ws) { for (const w of ws) await this.updateDoc(w.collection, w.id, w.fields); return ws.length; },
  };
}
const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body || '{}') }); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
const env = { RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.c>', ADMIN_EMAILS: 'admin@lillofind.com' };
const anonAuth = { uid: 'anon1', email: '', token: { firebase: { sign_in_provider: 'anonymous' } } };
const userAuth = (uid, email) => ({ uid, email, token: { email, firebase: { sign_in_provider: 'password' } } });

const seed = {
  products: { p1: { name: 'Polo', price: 20, imageUrl: 'https://photo.yupoo.com/s/abc/medium.jpg', sourceUrl: 'https://s.x.yupoo.com/albums/1', supplierPriceCNY: 80, weightKg: 0.4 } },
  users: { u1: { email: 'u1@x.it', lfpoints: 600, activeReward: { label: '−10%', type: 'percentuale', val: 10 } },
           u2: { email: 'u2@x.it', lfpoints: 600, discountUsed: true, activeReward: { label: '−99%', type: 'percentuale', val: 99 } } },
};

// 1) PayPal da ospite anonimo: email digitata, prezzi dal catalogo, ignora prezzi del client
{
  const db = mockDb(seed); sent.length = 0;
  const r = await validateOrder({ items: [{ id: 'p1', qty: 2, price: 0.01, size: 'M', color: 'Nero' }], paymentMethod: 'paypal', email: 'Guest@Mail.it', name: 'Mario Rossi', phone: '333', shippingAddress: { street: 'Via 1', city: 'Roma', zip: '00100' } }, { env, db, auth: anonAuth });
  const o = Object.values(db.D.orders)[0];
  eq(o.subtotal, 40, 'subtotale ricalcolato dal catalogo');
  eq(o.email, 'guest@mail.it', 'email ospite dal checkout');
  eq(o.status + '/' + o.paymentStatus, 'pending/unpaid', 'paypal → pending/unpaid');
  eq(o.items[0].sourceUrl, 'https://s.x.yupoo.com/albums/1', 'link fornitore sull\'ordine');
  eq(o.items[0].supplierPriceCNY, 80, 'prezzo CNY sull\'ordine');
  eq(db.D.users.anon1.isGuest, true, 'profilo ospite creato');
  eq(db.D.users.anon1.email, 'guest@mail.it', 'email profilo ospite');
  eq(sent.filter(s => /resend/.test(s.url)).length, 2, 'email cliente + admin');
  eq(sent[0].body.to, ['guest@mail.it'], 'conferma al cliente');
  eq(r.lfpoints, 0, 'nessun punto prima del pagamento');
  eq(o.customerEmailSent, true, 'flag email inviata');
}
// 2) Sconto: consumato anche con bonifico e uno solo per account
{
  const db = mockDb(seed);
  const r = await validateOrder({ items: [{ id: 'p1', qty: 1 }], paymentMethod: 'bonifico', shippingAddress: { street: 'a' } }, { env, db, auth: userAuth('u1', 'u1@x.it') });
  eq(r.discount, 2, 'sconto 10% applicato');
  eq(db.D.users.u1.discountUsed, true, 'discountUsed impostato');
  eq('activeReward' in db.D.users.u1, false, 'premio consumato');
  const r2 = await validateOrder({ items: [{ id: 'p1', qty: 1 }], paymentMethod: 'paypal' }, { env, db, auth: userAuth('u2', 'u2@x.it') });
  eq(r2.discount, 0, 'premio ignorato se sconto già usato');
}
eq(rewardDiscount({ activeReward: { type: 'percentuale', val: 500 } }, 10, 5).discount, 10, 'percentuale limitata a 100%');
// 3) sendOrderEmail: solo il proprio ordine, contenuto dal DB
{
  const db = mockDb({ orders: { o1: { orderId: 'LILLO-1', uid: 'u1', email: 'u1@x.it', items: [], subtotal: 1, total: 1, payment: 'paypal' } } });
  sent.length = 0;
  eq((await sendOrderEmail({ orderId: 'LILLO-1', email: 'victim@x.it', items: [{ name: 'SPAM' }] }, { env, db, auth: userAuth('u9', 'evil@x.it') })).reason, 'not_found', 'ordine altrui non trovato');
  eq(sent.length, 0, 'nessuna email per ordine altrui');
  eq((await sendOrderEmail({ orderId: 'LILLO-1' }, { env, db, auth: userAuth('u1', 'u1@x.it') })).sent, true, 'proprio ordine inviato');
  eq(sent[0].body.to, ['u1@x.it'], 'inviata all\'email dell\'ordine');
  eq((await sendOrderEmail({ orderId: 'LILLO-1' }, { env, db, auth: userAuth('u1', 'u1@x.it') })).reason, 'already_sent', 'niente doppioni');
}
// 4) claimReward
{
  const db = mockDb({ users: { a: { lfpoints: 200, email: 'a@a.it' }, b: { lfpoints: 900, discountUsed: true } } });
  const r = await claimReward({ label: '−€15' }, { db, auth: userAuth('a', 'a@a.it') });
  eq([r.lfpoints, db.D.users.a.activeReward.val], [50, 15], 'premio riscattato');
  await throwsCode(() => claimReward({ label: '−€5' }, { db, auth: userAuth('a', 'a@a.it') }), 'failed-precondition', 'un premio alla volta');
  await throwsCode(() => claimReward({ label: '−30%' }, { db, auth: userAuth('b', 'b@b.it') }), 'failed-precondition', 'sconto già usato');
  await throwsCode(() => claimReward({ label: '−€5' }, { db, auth: anonAuth }), 'permission-denied', 'anonimo no');
  await throwsCode(() => claimReward({ label: 'gratis' }, { db, auth: userAuth('a', 'a@a.it') }), 'invalid-argument', 'premio inventato');
}
// 5) claimReferrals: solo invitati reali, una volta sola
{
  const db = mockDb({
    users: { r: { lfpoints: 10, email: 'r@r.it' }, n1: { email: 'n1@x.it' }, n2: { isGuest: true }, },
    referrals: { x1: { referrer: 'r', referred: 'n1', credited: false }, x2: { referrer: 'r', referred: 'n1', credited: false }, x3: { referrer: 'r', referred: 'n2', credited: false }, x4: { referrer: 'r', referred: 'ghost', credited: false } },
  });
  const r = await claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') });
  eq([r.gained, db.D.users.r.lfpoints], [50, 60], 'un solo invitato reale accreditato');
  eq(Object.values(db.D.referrals).every(x => x.credited), true, 'tutti marcati');
  eq((await claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') })).gained, 0, 'niente doppio accredito');
}
// 6) track17: solo admin o il proprio codice
{
  const db = mockDb({ users: { c: { trackingCode: 'TR1' } } });
  const e2 = { ...env };
  eq((await track17({ code: 'TR1' }, { env: e2, db, auth: userAuth('c', 'c@c.it') })).error, 'not-configured', 'proprio codice ok');
  await throwsCode(() => track17({ code: 'TR2' }, { env: e2, db, auth: userAuth('c', 'c@c.it') }), 'permission-denied', 'codice altrui bloccato');
  eq((await track17({ code: 'ANY' }, { env: e2, db, auth: userAuth('z', 'admin@lillofind.com') })).error, 'not-configured', 'admin ok');
}
console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
