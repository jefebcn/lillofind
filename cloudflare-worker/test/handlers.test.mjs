// Test dei handler checkout/loyalty con un Firestore finto in memoria.
// Eseguibile con `node test/handlers.test.mjs` (niente rete: fetch è finto).
import { validateOrder, sendOrderEmail, track17, rewardDiscount, stripeWebhook } from '../src/handlers/checkout.js';
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
    async setDoc(c, id, obj) { (D[c] = D[c] || {})[id] = obj; return id; },
    async addDoc(c, obj) { const id = 'gen' + (++n); (D[c] = D[c] || {})[id] = obj; return id; },
    async updateDoc(c, id, obj) { const cur = (D[c] = D[c] || {})[id] || {}; for (const k in obj) { if (obj[k] === DELETE_FIELD) delete cur[k]; else cur[k] = obj[k]; } D[c][id] = cur; return true; },
    async runQuery(c, { where = [], limit } = {}) {
      let rows = Object.entries(D[c] || {}).map(([id, d]) => ({ id, ...d }));
      for (const [f, op, v] of where) rows = rows.filter(r => op === '==' ? r[f] === v : true);
      return rows.slice(0, limit || 999);
    },
    async commitUpdates(ws) { for (const w of ws) await this.updateDoc(w.collection, w.id, w.fields); return ws.length; },
    async increment(c, id, f, by) { const cur = (D[c] = D[c] || {})[id] || {}; cur[f] = (Number(cur[f]) || 0) + by; D[c][id] = cur; return true; },
    async createAtomic(docs) {
      for (const d of docs) if (d.mustNotExist && get(d.collection, d.id)) { const e = new Error('exists'); e.code = 'already-exists'; throw e; }
      for (const d of docs) (D[d.collection] = D[d.collection] || {})[d.id] = d.fields;
      return true;
    },
  };
}
const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body || '{}') }); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
const env = { RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.c>', ADMIN_EMAILS: 'admin@lillofind.com' };
const anonAuth = { uid: 'anon1', email: '', token: { firebase: { sign_in_provider: 'anonymous' } } };
const userAuth = (uid, email, verified = true) => ({ uid, email, token: { email, email_verified: verified, firebase: { sign_in_provider: 'password' } } });

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
  // ospite anonimo, ordine NON pagato, email digitata (non verificata):
  // nessuna email al cliente (sarebbe spam verso un indirizzo qualsiasi),
  // solo la notifica all'admin
  eq(sent.filter(s => /resend/.test(s.url)).length, 1, 'solo la notifica admin');
  eq(sent[0].body.to.includes('guest@mail.it'), false, 'niente email all\'indirizzo non verificato');
  eq(r.lfpoints, 0, 'nessun punto prima del pagamento');
  eq(o.customerEmailSent, undefined, 'flag email non impostato');
}
// 1b) account con email verificata, ordine non pagato: email al cliente + admin
{
  const db = mockDb(seed); sent.length = 0;
  await validateOrder({ items: [{ id: 'p1', qty: 1 }], paymentMethod: 'bonifico', shippingAddress: { street: 'a' } }, { env, db, auth: userAuth('u5', 'u5@x.it') });
  eq(sent.filter(s => /resend/.test(s.url)).length, 2, 'verificato: email cliente + admin');
  eq(sent[0].body.to, ['u5@x.it'], 'conferma all\'indirizzo verificato');
}
// 1c) tetto agli ordini non pagati: il sesto in un'ora e' rifiutato
{
  const db = mockDb(seed);
  const ord = () => validateOrder({ items: [{ id: 'p1', qty: 1 }], paymentMethod: 'bonifico', shippingAddress: { street: 'a' } }, { env, db, auth: userAuth('u6', 'u6@x.it'), ip: '1.2.3.4' });
  for (let i = 0; i < 5; i++) await ord();
  await throwsCode(ord, 'resource-exhausted', 'sesto ordine non pagato in un\'ora: rifiutato');
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
// 5) claimReferrals: solo invitati reali CON un ordine pagato, una volta sola
{
  const db = mockDb({
    users: { r: { lfpoints: 10, email: 'r@r.it' }, n1: { email: 'n1@x.it' }, n2: { isGuest: true }, n3: { email: 'n3@x.it' } },
    orders: { o1: { uid: 'n1', paymentStatus: 'paid' }, o3: { uid: 'n3', paymentStatus: 'unpaid' } },
    referrals: { x1: { referrer: 'r', referred: 'n1', credited: false }, x2: { referrer: 'r', referred: 'n1', credited: false }, x3: { referrer: 'r', referred: 'n2', credited: false }, x4: { referrer: 'r', referred: 'ghost', credited: false }, x5: { referrer: 'r', referred: 'n3', credited: false } },
  });
  const r = await claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') });
  eq([r.gained, db.D.users.r.lfpoints], [50, 60], 'un solo invitato reale (con ordine pagato) accreditato');
  eq([db.D.referrals.x1.credited, db.D.referrals.x2.rejected], [true, true], 'il doppione dello stesso invitato e\' scartato');
  eq(db.D.referrals.x5.credited, false, 'invitato senza ordine pagato: resta in attesa, niente punti');
  eq((await claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') })).gained, 0, 'niente doppio accredito');
  // l'invitato paga: al giro dopo l'invito vale
  db.D.orders.o3.paymentStatus = 'paid';
  eq((await claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') })).gained, 50, 'pagato l\'ordine, l\'invito vale');
}
// 5b) due chiamate in parallelo non accreditano due volte
{
  const db = mockDb({
    users: { r: { lfpoints: 0, email: 'r@r.it' }, n1: { email: 'n1@x.it' } },
    orders: { o1: { uid: 'n1', paymentStatus: 'paid' } },
    referrals: { x1: { referrer: 'r', referred: 'n1', credited: false } },
  });
  const [a, b] = await Promise.all([claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') }), claimReferrals({}, { db, auth: userAuth('r', 'r@r.it') })]);
  eq([a.gained + b.gained, db.D.users.r.lfpoints], [50, 50], 'in parallelo: 50 punti, non 100');
}
// 6) track17: solo admin o il proprio codice
{
  const db = mockDb({ users: { c: { trackingCode: 'TR1' } } });
  const e2 = { ...env };
  eq((await track17({ code: 'TR1' }, { env: e2, db, auth: userAuth('c', 'c@c.it') })).error, 'not-configured', 'proprio codice ok');
  await throwsCode(() => track17({ code: 'TR2' }, { env: e2, db, auth: userAuth('c', 'c@c.it') }), 'permission-denied', 'codice altrui bloccato');
  eq((await track17({ code: 'ANY' }, { env: e2, db, auth: userAuth('z', 'admin@lillofind.com') })).error, 'not-configured', 'admin ok');
}
// 7) admin: un'email della lista NON verificata non basta
{
  const db = mockDb({ users: {} });
  await throwsCode(() => track17({ code: 'ANY' }, { env, db, auth: userAuth('z', 'admin@lillofind.com', false) }), 'permission-denied', 'admin con email non verificata bloccato');
  eq((await track17({ code: 'ANY' }, { env, db, auth: { uid: 'k', email: 'x@x.it', token: { admin: true } } })).error, 'not-configured', 'claim admin:true ok');
}
// 8) un PaymentIntent paga UN ordine solo
{
  const db = mockDb(seed);
  const pi = { id: 'pi_1', status: 'succeeded', metadata: { uid: 'u3' }, amount: 0 };
  const e8 = { ...env, __stripeFinto: { paymentIntents: { retrieve: async () => pi } } };
  const ordine = { items: [{ id: 'p1', qty: 2 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_1', shippingAddress: { street: 'Via 1' } };
  // l'importo che Stripe ha incassato: 2 × 20 € + la spedizione per 0,8 kg
  const { getShippingCost, getProductWeight } = await import('../src/lib/shipping.js');
  pi.amount = Math.round((40 + getShippingCost(getProductWeight({ weightKg: 0.4, category: '' }) * 2)) * 100);
  const r1 = await validateOrder(ordine, { env: e8, db, auth: userAuth('u3', 'u3@x.it') });
  eq(r1.total * 100, pi.amount, 'primo ordine col PaymentIntent creato');
  eq(Object.values(db.D.orders).filter(o => o.stripePaymentIntentId === 'pi_1').length, 1, 'l\'ordine porta il PaymentIntent');
  eq(!!db.D.used_payment_intents.pi_1, true, 'il PaymentIntent e\' segnato come usato');
  // lo stesso cliente che ritenta (o torna dopo il webhook) riceve lo stesso ordine, non un altro
  const r2 = await validateOrder(ordine, { env: e8, db, auth: userAuth('u3', 'u3@x.it') });
  eq([r2.alreadyCreated, r2.orderId, r2.lfpoints], [true, r1.orderId, 0], 'stesso PaymentIntent: si riottiene lo stesso ordine');
  eq(Object.values(db.D.orders).filter(o => o.stripePaymentIntentId === 'pi_1').length, 1, 'e gli ordini restano uno');
  eq(db.D.users.u3.lfpoints, 40, 'LFPoints accreditati una volta sola');
  // un altro utente con lo stesso PaymentIntent: rifiutato
  await throwsCode(() => validateOrder(ordine, { env: e8, db, auth: userAuth('u4', 'u4@x.it') }), 'permission-denied', 'PaymentIntent di un altro: rifiutato');
}
// 9) webhook Stripe: un pagamento riuscito senza ordine viene completato
{
  const db = mockDb(seed); sent.length = 0;
  const { getShippingCost, getProductWeight } = await import('../src/lib/shipping.js');
  const amount = Math.round((20 + getShippingCost(getProductWeight({ weightKg: 0.4, category: '' }))) * 100);
  const pi = { id: 'pi_9', status: 'succeeded', metadata: { uid: 'u9' }, amount };
  const finto = { paymentIntents: { retrieve: async () => pi },
    webhooks: { constructEventAsync: async (body, sig) => { if (sig !== 'firma-ok') throw new Error('firma'); return JSON.parse(body); } } };
  const e9 = { ...env, STRIPE_WEBHOOK_SECRET: 'whsec_x', __stripeFinto: finto };
  db.D.pending_orders = { pi_9: { uid: 'u9', order: JSON.stringify({ items: [{ id: 'p1', qty: 1 }], email: 'cliente9@x.it', name: 'Nove', shippingAddress: { street: 'Via 9' } }) } };
  const evento = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: pi } });
  eq((await stripeWebhook(evento, 'firma-falsa', { env: e9, db })).status, 400, 'webhook con firma falsa: rifiutato');
  const w1 = await stripeWebhook(evento, 'firma-ok', { env: e9, db });
  eq([w1.status, !!w1.body.orderId], [200, true], 'webhook: ordine creato dal pagamento');
  const o9 = Object.values(db.D.orders).find(o => o.stripePaymentIntentId === 'pi_9');
  eq([o9 && o9.email, o9 && o9.paymentStatus], ['cliente9@x.it', 'paid'], 'ordine con i dati salvati al pagamento, pagato');
  eq((await stripeWebhook(evento, 'firma-ok', { env: e9, db })).body.already, true, 'webhook ripetuto: niente doppione');
  // il cliente torna dopo il redirect: riottiene l'ordine già creato
  const back = await validateOrder({ items: [{ id: 'p1', qty: 1 }], paymentMethod: 'card', stripePaymentIntentId: 'pi_9', shippingAddress: { street: 'Via 9' } }, { env: e9, db, auth: userAuth('u9', 'c9@x.it') });
  eq([back.alreadyCreated, back.orderId], [true, w1.body.orderId], 'ritorno dal redirect: stesso ordine del webhook');
  eq(Object.values(db.D.orders).filter(o => o.stripePaymentIntentId === 'pi_9').length, 1, 'un solo ordine in tutto');
}
console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
