// ════════════════════════════════════════════════════════════════
// LFPoints lato server — riscatto premi e accredito inviti.
// Prima erano scritture dirette del browser sul proprio profilo: chiunque
// poteva darsi punti o sconti dalla console. Ora i campi lfpoints /
// activeReward sono protetti dalle regole Firestore e li scrive solo il Worker.
// ════════════════════════════════════════════════════════════════
import { HttpsError } from '../lib/errors.js';

// Deve restare allineato a REWARDS in index.html (solo per la UI).
export const REWARDS = [
  { pts: 50,   label: '−€5',  type: 'fisso',       val: 5 },
  { pts: 150,  label: '−€15', type: 'fisso',       val: 15 },
  { pts: 300,  label: '−€35', type: 'fisso',       val: 35 },
  { pts: 500,  label: '−10%', type: 'percentuale', val: 10 },
  { pts: 750,  label: '−20%', type: 'percentuale', val: 20 },
  { pts: 1000, label: '−30%', type: 'percentuale', val: 30 },
];
export const REFERRAL_POINTS = 50;

function isAnonymous(auth) {
  return !!(auth && auth.token && auth.token.firebase && auth.token.firebase.sign_in_provider === 'anonymous');
}

export async function claimReward(data, { db, auth }) {
  if (isAnonymous(auth)) throw new HttpsError('permission-denied', 'Accedi con un account per riscattare.');
  const label = String((data && data.label) || '');
  const r = REWARDS.find(x => x.label === label);
  if (!r) throw new HttpsError('invalid-argument', 'Premio non valido.');
  const snap = await db.getDoc('users', auth.uid);
  const u = snap.exists ? snap.data() : {};
  if (u.discountUsed === true) throw new HttpsError('failed-precondition', 'Hai già usato il tuo sconto (uno solo per account).');
  if (u.activeReward) throw new HttpsError('failed-precondition', 'Hai già un bonus attivo nel carrello!');
  const pts = Number(u.lfpoints) || 0;
  if (pts < r.pts) throw new HttpsError('failed-precondition', 'Punti insufficienti.');
  const activeReward = { label: r.label, type: r.type, val: r.val, pts: r.pts, redeemedAt: Date.now() };
  const lfpoints = pts - r.pts;
  await db.updateDoc('users', auth.uid, { lfpoints, activeReward });
  return { lfpoints, activeReward };
}

// Accredita al referrer gli inviti non ancora accreditati.
//
// Un invito vale SOLO se l'invitato:
//   - ha un account reale (non ospite anonimo, con email sul profilo), e
//   - ha almeno un ordine PAGATO (paymentStatus 'paid', scritto solo dal
//     Worker per le carte e dall'admin per bonifico/PayPal).
// Prima bastavano campi che l'utente scrive da sé: si creavano account
// finti e si incassavano 50 punti l'uno. Con un ordine pagato di mezzo,
// fabbricarsi inviti costa più di quanto rende.
//
// E l'accredito e' atomico: ogni invitato si "consuma" con
// referral_credits/{uid dell'invitato} creato con la precondizione "non deve
// esistere", e i punti si sommano con un incremento atomico. Due chiamate
// parallele non accreditano due volte (prima si'), e un invitato conta una
// volta sola anche se due persone dicono di averlo invitato.
async function haOrdinePagato(db, uid) {
  try {
    const rows = await db.runQuery('orders', { where: [['uid', '==', uid], ['paymentStatus', '==', 'paid']], limit: 1 });
    return rows.length > 0;
  } catch (e) { console.error('referral: verifica ordini', e && e.message); return false; }
}

export async function claimReferrals(data, { db, auth }) {
  if (isAnonymous(auth)) return { gained: 0 };
  const refs = await db.runQuery('referrals', { where: [['referrer', '==', auth.uid]], limit: 200 });
  const pending = refs.filter(r => r.credited !== true && r.referred && r.referred !== auth.uid);
  if (!pending.length) return { gained: 0 };
  const referredIds = [...new Set(pending.map(r => r.referred))];
  const referredDocs = await db.getMany('users', referredIds);
  const conAccount = new Set(referredDocs.filter(s => s.exists && (s.data().email || '') && s.data().isGuest !== true).map(s => s.id));
  const pagati = new Set();
  for (const id of conAccount) if (await haOrdinePagato(db, id)) pagati.add(id);

  let gained = 0;
  const seen = new Set();
  const writes = [];
  for (const r of pending) {
    if (seen.has(r.referred)) { writes.push({ collection: 'referrals', id: r.id, fields: { credited: true, rejected: true } }); continue; }
    seen.add(r.referred);
    // Senza ordine pagato l'invito resta in attesa: si riprova al prossimo giro.
    if (!conAccount.has(r.referred) || !pagati.has(r.referred)) continue;
    let ok = false;
    try {
      await db.createAtomic([{ collection: 'referral_credits', id: r.referred, mustNotExist: true,
        fields: { referrer: auth.uid, referralId: r.id, points: REFERRAL_POINTS, creditedAt: new Date() } }]);
      ok = true;
    } catch (e) {
      if (!(e && e.code === 'already-exists')) throw e;
    }
    writes.push({ collection: 'referrals', id: r.id, fields: { credited: true, ...(ok ? {} : { rejected: true }) } });
    if (ok) gained += REFERRAL_POINTS;
  }
  if (writes.length) await db.commitUpdates(writes);
  if (gained) await db.increment('users', auth.uid, 'lfpoints', gained);
  const snap = await db.getDoc('users', auth.uid);
  const pts = snap.exists ? Number(snap.data().lfpoints) || 0 : gained;
  return { gained, lfpoints: pts };
}
