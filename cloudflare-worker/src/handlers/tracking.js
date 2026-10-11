// Tracking automatico: ogni 4 ore (cron del Worker, vedi wrangler.toml) legge
// i clienti con un codice di spedizione non ancora consegnato, chiede lo stato
// a 17TRACK (a gruppi di 40) e, se la spedizione è andata AVANTI, aggiorna il
// profilo del cliente e gli manda l'email di aggiornamento. Niente email se lo
// stato non cambia o torna indietro; niente lavoro senza TRACK17_TOKEN.
// L'admin può lanciarlo a mano (POST /trackingSync) e spegnerlo per un cliente
// mettendo trackingAuto:false sul profilo.
import { TRACK17_MAP, sendTrackingEmail } from './checkout.js';

export const RANK = { confermato: 0, preparazione: 1, spedito: 2, in_transito: 3, in_consegna: 4, consegnato: 5 };
const LABEL = { spedito: 'Spedito', in_transito: 'In transito', in_consegna: 'In consegna', consegnato: 'Consegnato' };

async function api17(env, path, body) {
  const r = await fetch('https://api.17track.net/track/v2.2/' + path, {
    method: 'POST',
    headers: { '17token': env.TRACK17_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return r.json().catch(() => ({}));
}

export async function syncTracking(env, db, { max = 200 } = {}) {
  if (!env.TRACK17_TOKEN) return { ok: false, reason: 'TRACK17_TOKEN mancante: tracking automatico spento' };
  const rows = await db.runQuery('users', { where: [['trackingCode', '>', '']], limit: max });
  const active = rows.filter((u) => u.trackingCode && u.trackingStatus !== 'consegnato' && u.trackingAuto !== false);
  const out = { ok: true, checked: active.length, updated: [], emailed: 0, errors: [] };
  for (let i = 0; i < active.length; i += 40) {
    const group = active.slice(i, i + 40);
    const nums = [...new Set(group.map((u) => String(u.trackingCode).trim()))].map((number) => ({ number }));
    // register: i numeri già registrati vengono "rifiutati" da 17TRACK, va bene
    await api17(env, 'register', nums).catch(() => null);
    const info = await api17(env, 'gettrackinfo', nums).catch((e) => { out.errors.push('17track: ' + (e && e.message)); return null; });
    const byNum = {};
    ((info && info.data && info.data.accepted) || []).forEach((a) => { byNum[a.number] = a.track_info || {}; });
    for (const u of group) {
      const ti = byNum[String(u.trackingCode).trim()];
      if (!ti) continue;
      const s17 = (ti.latest_status && ti.latest_status.status) || '';
      const next = TRACK17_MAP[s17] || '';
      const cur = u.trackingStatus || 'confermato';
      const ev = ti.latest_event || {};
      const last = [ev.description, ev.location].filter(Boolean).join(' · ').slice(0, 200);
      if (!next || (RANK[next] ?? -1) <= (RANK[cur] ?? -1)) {
        // nessun passo avanti: aggiorno solo l'ultimo evento, se è cambiato
        if (last && last !== u.trackingLastEvent) await db.updateDoc('users', u.id, { trackingLastEvent: last, trackingCheckedAt: new Date() }).catch(() => {});
        continue;
      }
      try {
        await db.updateDoc('users', u.id, { trackingStatus: next, trackingUpdatedAt: new Date(), trackingCheckedAt: new Date(), trackingLastEvent: last, trackingAutoAt: new Date() });
        out.updated.push({ uid: u.id, code: u.trackingCode, from: cur, to: next });
        if (u.email && env.RESEND_API_KEY) {
          await sendTrackingEmail({ email: u.email, code: u.trackingCode, product: u.trackingProduct || '', status: next, note: last ? 'Ultimo aggiornamento: ' + last : '' }, { env });
          out.emailed++;
        }
      } catch (e) { out.errors.push(u.id + ': ' + (e && e.message)); }
    }
  }
  if (out.updated.length || out.errors.length) console.log('tracking auto:', JSON.stringify({ ...out, updated: out.updated.map((x) => x.code + ' ' + x.from + '→' + x.to) }));
  return out;
}

// POST /trackingSync (solo admin): lo stesso giro, lanciato a mano dall'admin.
export async function trackingSyncNow(_data, { env, db }) {
  const r = await syncTracking(env, db);
  return { ...r, updated: (r.updated || []).map((x) => ({ ...x, label: LABEL[x.to] || x.to })) };
}
