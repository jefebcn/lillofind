// Foto rotte, abbonamenti in scadenza, riepilogo del mattino.
import { photoScanStep, subEnd, subStage, subscriptionReminders, digestData, morningDigest, isYupoo } from '../src/handlers/daily.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const H = 3600e3, DAY = 24 * H, NOW = Date.UTC(2026, 9, 11, 6);
const ts = (ms) => ({ seconds: Math.floor(ms / 1000), _ts: new Date(ms).toISOString() });
const mails = [];
globalThis.fetch = async (url, opts = {}) => { if (/resend/.test(url)) mails.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; };
globalThis.caches = { default: { delete: async () => true } };
const env0 = () => { const store = {}; return { store, env: { RESEND_API_KEY: 'k', CATALOG: { get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } } } }; };

// ── foto rotte ──
eq([isYupoo('https://photo.yupoo.com/a/b/medium.jpg'), isYupoo('https://i.ibb.co/x.jpg')], [true, false], 'riconosce le foto Yupoo');
{
  const { store, env } = env0();
  const prods = Array.from({ length: 5 }, (_, i) => ({ id: 'p' + i, name: 'Prodotto ' + i, imageUrl: 'https://photo.yupoo.com/s/' + i + '/medium.jpg' }));
  prods.push({ id: 'h', hidden: true, imageUrl: 'https://photo.yupoo.com/s/h/m.jpg' }, { id: 'x', imageUrl: 'https://i.ibb.co/x.jpg' });
  store.catalog = JSON.stringify({ builtAtMs: 1, products: prods });
  const commits = [];
  const db = { async commitUpdates(w) { if (w[0].id === 'p3') throw new Error('non esiste'); commits.push(w[0]); return 1; } };
  const check = async (u) => (/\/(1|3)\//.test(u) ? 'gone' : /\/4\//.test(u) ? 'error' : 'ok');
  const r1 = await photoScanStep(env, db, { now: NOW, batch: 3, check });
  eq([r1.checked, r1.hidden, r1.progress, !!r1.done], [3, 1, '3/5', false], 'primo gruppo: 3 controllati, 1 rotto');
  eq([commits[0].id, commits[0].fields.hidden, commits[0].fields.hiddenReason], ['p1', true, 'yupoo_removed'], 'prodotto rotto nascosto');
  const r2 = await photoScanStep(env, db, { now: NOW + 15 * 60e3, batch: 3, check });
  eq([r2.checked, !!r2.done], [2, true], 'secondo gruppo: giro finito');
  eq(JSON.parse(store.catalog).products.find((p) => p.id === 'p1').hidden, true, 'nascosto anche nel catalogo pubblicato');
  eq(JSON.parse(store.catalog).products.find((p) => p.id === 'p4').hidden, undefined, 'errore di rete ≠ foto rotta');
  eq(mails.length === 1 && /1 prodotti nascosti/.test(mails[0].subject) && /Prodotto 1/.test(mails[0].html), true, 'email all\'admin con l\'elenco');
  eq((await photoScanStep(env, db, { now: NOW + DAY, batch: 3, check })).skipped, 'attesa', 'giro dopo: aspetta una settimana');
  const r4 = await photoScanStep(env, db, { now: NOW + 8 * DAY, batch: 3, check });
  eq(r4.progress, '3/4', 'dopo una settimana riparte (senza i già nascosti)');
  mails.length = 0;
}

// ── abbonamenti ──
eq(new Date(subEnd('2026-01-31', 1) + 2 * H).toISOString().slice(0, 10), '2026-02-28', 'fine mese corto come nel pannello admin');
eq(new Date(subEnd('2026-09-15', 3) + 2 * H).toISOString().slice(0, 10), '2026-12-15', '3 mesi');
const startFor = (daysLeft, months = 1) => { const end = new Date(NOW + daysLeft * DAY); const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate())); return d.toISOString().slice(0, 10); };
eq(subStage({ startISO: startFor(5) }, NOW).stage, 'd7', '5 giorni: avviso settimana');
eq(subStage({ startISO: startFor(1) }, NOW).stage, 'd1', '1 giorno: ultimo avviso');
eq(subStage({ startISO: startFor(20) }, NOW).stage, null, '20 giorni: niente');
eq(subStage({ startISO: startFor(-3) }, NOW).stage, null, 'scaduto: niente');
{
  const marks = {};
  const db = { async getMany(c, ids) { return ids.map((id) => ({ exists: !!marks[id], id, data: () => marks[id] })); }, async updateDoc(c, id, o) { marks[id] = { ...(marks[id] || {}), ...o }; } };
  const rows = [
    { src: 'order', id: 'o1', email: 'a@x.it', c: { service: 'Netflix', startISO: startFor(5), months: 1, login: 'l' } },
    { src: 'user', id: 'u1', email: 'b@x.it', c: { service: 'Spotify', startISO: startFor(1), months: 1, login: 'l' } },
    { src: 'user', id: 'u2', email: 'c@x.it', c: { service: 'DAZN', startISO: startFor(30), months: 1, login: 'l' } },
  ];
  mails.length = 0;
  const r = await subscriptionReminders({ RESEND_API_KEY: 'k' }, db, { now: NOW, rows });
  eq([r.sent, mails.map((m) => m.to[0])], [2, ['a@x.it', 'b@x.it']], 'avvisi a chi scade');
  eq(/scade tra 5 giorni/.test(mails[0].subject) && /q=Netflix/.test(mails[0].html), true, 'email con giorni e link per rinnovare');
  eq(r.expiring.length, 2, 'elenco in scadenza per il riepilogo');
  mails.length = 0;
  const r2 = await subscriptionReminders({ RESEND_API_KEY: 'k' }, db, { now: NOW + H, rows });
  eq([r2.sent, mails.length], [0, 0], 'stesso giorno: nessun doppione');
  const r3 = await subscriptionReminders({ RESEND_API_KEY: 'k' }, db, { now: NOW + 4 * DAY, rows });
  eq([r3.sent, mails[0] && mails[0].to[0]], [1, 'a@x.it'], 'Netflix al giorno prima: secondo avviso');
  mails.length = 0;
}

// ── riepilogo ──
{
  const it = [{ id: 'p', isDigital: false }];
  const d = digestData({
    pending: [{ orderId: 'A', paymentStatus: 'paid', payment: 'card', total: 50 }, { orderId: 'B', paymentStatus: 'unpaid', payment: 'bonifico', total: 30 }],
    confirmed: [{ orderId: 'C', items: it, total: 40 }, { orderId: 'D', items: it, supplierOrdered: true }, { orderId: 'E', items: [{ isDigital: true }] }],
    recent: [{ createdAt: ts(NOW - 10 * H), status: 'confirmed', total: 40, paymentFee: 1.5 }, { createdAt: ts(NOW - 10 * H), status: 'pending', paymentStatus: 'unpaid', total: 99 }, { createdAt: ts(NOW - 2 * H), status: 'confirmed', total: 10 }],
    users: [{ email: 'u@x.it', trackingCode: 'T1', trackingStatus: 'in_transito', trackingUpdatedAt: ts(NOW - 15 * DAY) }, { trackingCode: 'T2', trackingStatus: 'consegnato', trackingUpdatedAt: ts(NOW - 30 * DAY) }, { trackingCode: 'T3', trackingStatus: 'spedito', trackingUpdatedAt: ts(NOW - 2 * DAY) }],
  }, NOW);
  eq([d.toConfirm.map((o) => o.orderId), d.unpaid.map((o) => o.orderId), d.toOrder.map((o) => o.orderId)], [['A'], ['B'], ['C']], 'da confermare, non pagati, da ordinare');
  eq(d.stuck.map((u) => u.trackingCode), ['T1'], 'pacco fermo da 15 giorni');
  eq(d.yesterday, { n: 1, gross: 40, fees: 1.5 }, 'incasso di ieri (solo pagati, solo ieri)');
  const { env } = env0();
  const db = { async runQuery(c, o) { return c === 'orders' && o.where[0][2] === 'confirmed' ? [{ orderId: 'C', items: it, total: 40 }] : []; } };
  mails.length = 0;
  await morningDigest(env, db, { now: NOW });
  eq(mails.length === 1 && mails[0].to[0] === 'yishionvt@gmail.com' && /1 da ordinare/.test(mails[0].subject) && /C<\/b>/.test(mails[0].html), true, 'email del mattino all\'admin');
}

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
