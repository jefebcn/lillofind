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

// Accredita al referrer gli inviti non ancora accreditati. Un invitato conta
// una sola volta e solo se è un account reale (non ospite anonimo).
export async function claimReferrals(data, { db, auth }) {
  if (isAnonymous(auth)) return { gained: 0 };
  const refs = await db.runQuery('referrals', { where: [['referrer', '==', auth.uid]], limit: 200 });
  const pending = refs.filter(r => r.credited !== true && r.referred && r.referred !== auth.uid);
  if (!pending.length) return { gained: 0 };
  const credited = await db.runQuery('referrals', { where: [['referrer', '==', auth.uid], ['credited', '==', true]], limit: 500 });
  const already = new Set(credited.map(r => r.referred));
  const referredDocs = await db.getMany('users', [...new Set(pending.map(r => r.referred))]);
  const real = new Set(referredDocs.filter(s => s.exists && (s.data().email || '') && s.data().isGuest !== true).map(s => s.id));
  let gained = 0;
  const seen = new Set();
  const writes = [];
  for (const r of pending) {
    const ok = real.has(r.referred) && !already.has(r.referred) && !seen.has(r.referred);
    seen.add(r.referred);
    writes.push({ collection: 'referrals', id: r.id, fields: { credited: true, ...(ok ? {} : { rejected: true }) } });
    if (ok) gained += REFERRAL_POINTS;
  }
  const snap = await db.getDoc('users', auth.uid);
  const pts = (snap.exists ? Number(snap.data().lfpoints) || 0 : 0) + gained;
  if (writes.length) await db.commitUpdates(writes);
  if (gained) await db.updateDoc('users', auth.uid, { lfpoints: pts });
  return { gained, lfpoints: pts };
}
