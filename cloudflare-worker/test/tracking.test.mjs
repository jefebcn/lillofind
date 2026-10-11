// Tracking automatico (cron): 17TRACK e Resend finti, Firestore in memoria.
import { syncTracking } from '../src/handlers/tracking.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };

function mockDb(seed) {
  const D = JSON.parse(JSON.stringify(seed));
  return {
    D,
    async runQuery(c, { where = [], limit } = {}) {
      let rows = Object.entries(D[c] || {}).map(([id, d]) => ({ id, ...d }));
      for (const [f, op, v] of where) rows = rows.filter((r) => op === '>' ? (r[f] || '') > v : op === '==' ? r[f] === v : true);
      return rows.slice(0, limit || 999);
    },
    async updateDoc(c, id, obj) { D[c][id] = { ...(D[c][id] || {}), ...obj }; return true; },
  };
}

const STATO = { AA1: 'OutForDelivery', BB2: 'InTransit', CC3: 'InTransit', DD4: 'Delivered', EE5: 'Delivered' };
const mails = [];
globalThis.fetch = async (url, opts = {}) => {
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (/17track/.test(url)) {
    const body = JSON.parse(opts.body);
    if (/gettrackinfo/.test(url)) return json({ data: { accepted: body.filter((n) => STATO[n.number]).map((n) => ({ number: n.number, track_info: { latest_status: { status: STATO[n.number] }, latest_event: { description: 'Evento ' + n.number, location: 'Milano' } } })) } });
    return json({ data: {} });
  }
  if (/resend/.test(url)) { mails.push(JSON.parse(opts.body)); return json({ id: 'm' }); }
  return json({});
};

const env = { TRACK17_TOKEN: 't', RESEND_API_KEY: 'k', RESEND_FROM: 'x <a@b.c>' };
const seed = { users: {
  u1: { email: 'a@x.it', trackingCode: 'AA1', trackingStatus: 'in_transito', trackingProduct: 'Felpa' }, // avanza → in_consegna
  u2: { email: 'b@x.it', trackingCode: 'BB2', trackingStatus: 'in_transito' },                          // uguale → niente
  u3: { email: 'c@x.it', trackingCode: 'CC3', trackingStatus: 'in_consegna' },                          // indietro → niente
  u4: { email: 'd@x.it', trackingCode: 'DD4', trackingStatus: 'consegnato' },                           // già consegnato → saltato
  u5: { email: 'e@x.it', trackingCode: 'EE5', trackingStatus: 'spedito', trackingAuto: false },         // automatico spento
  u6: { email: 'f@x.it' },                                                                               // senza codice
} };

{
  const db = mockDb(seed); mails.length = 0;
  const r = await syncTracking(env, db);
  eq(r.ok, true, 'giro completato');
  eq(r.checked, 3, 'controllati solo i codici attivi (no consegnati, no automatico spento, no senza codice)');
  eq(r.updated.map((x) => x.code + ':' + x.from + '>' + x.to), ['AA1:in_transito>in_consegna'], 'aggiornato solo chi è andato avanti');
  eq(db.D.users.u1.trackingStatus, 'in_consegna', 'stato salvato sul cliente');
  eq(db.D.users.u1.trackingLastEvent, 'Evento AA1 · Milano', 'ultimo evento salvato');
  eq(mails.length, 1, 'una sola email');
  eq(mails[0].to, ['a@x.it'], 'email al cliente giusto');
  eq(db.D.users.u2.trackingStatus, 'in_transito', 'stato uguale: invariato');
  eq(db.D.users.u3.trackingStatus, 'in_consegna', 'non torna indietro');
  eq(db.D.users.u5.trackingStatus, 'spedito', 'automatico spento: invariato');
  // secondo giro: niente di nuovo → nessuna email
  mails.length = 0;
  const r2 = await syncTracking(env, db);
  eq(r2.updated.length, 0, 'secondo giro: nessun aggiornamento');
  eq(mails.length, 0, 'secondo giro: nessuna email');
}
{
  const r = await syncTracking({ ...env, TRACK17_TOKEN: '' }, mockDb(seed));
  eq(r.ok, false, 'senza TRACK17_TOKEN: spento');
}

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
