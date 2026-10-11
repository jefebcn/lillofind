// Tracking automatico: ogni 4 ore (cron del Worker, vedi wrangler.toml) legge
// i clienti con un codice di spedizione non ancora consegnato, chiede lo stato
// a un servizio di tracking e, se la spedizione è andata AVANTI, aggiorna il
// profilo del cliente e gli manda l'email di aggiornamento. Niente email se lo
// stato non cambia o torna indietro.
//
// Fonti, in ordine (si usano quelle configurate, tutte gratuite tranne 17TRACK):
//   1. 17TRACK      — se c'è TRACK17_TOKEN (a pagamento, 2.800+ corrieri)
//   2. DHL Unified  — se c'è DHL_API_KEY (gratis, 250 controlli/giorno):
//                     DHL, Deutsche Post (codici …DE), DHL eCommerce
//   3. Cainiao      — sempre, senza chiave: pacchi dalla Cina (rete Alibaba)
// L'admin può lanciarlo a mano (POST /trackingSync) e spegnerlo per un cliente
// mettendo trackingAuto:false sul profilo.
import { TRACK17_MAP, sendTrackingEmail } from './checkout.js';

export const RANK = { confermato: 0, preparazione: 1, spedito: 2, in_transito: 3, in_consegna: 4, consegnato: 5 };
const LABEL = { spedito: 'Spedito', in_transito: 'In transito', in_consegna: 'In consegna', consegnato: 'Consegnato' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_FOR_DELIVERY = /out for delivery|in consegna|in zustellung|zugestellt wird|wird zugestellt|consegna in corso|派送中|派件/i;
const DELIVERED = /delivered|consegnat|zugestellt|签收|已妥投/i;

// ── 17TRACK (a gruppi di 40) ─────────────────────────────────────
async function api17(env, path, body) {
  const r = await fetch('https://api.17track.net/track/v2.2/' + path, {
    method: 'POST',
    headers: { '17token': env.TRACK17_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return r.json().catch(() => ({}));
}
async function from17track(env, codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 40) {
    const nums = codes.slice(i, i + 40).map((number) => ({ number }));
    await api17(env, 'register', nums).catch(() => null); // già registrati = rifiutati, va bene
    const info = await api17(env, 'gettrackinfo', nums).catch(() => null);
    ((info && info.data && info.data.accepted) || []).forEach((a) => {
      const ti = a.track_info || {}, ev = ti.latest_event || {};
      const s = TRACK17_MAP[(ti.latest_status && ti.latest_status.status) || ''] || '';
      if (s) out[a.number] = { status: s, last: [ev.description, ev.location].filter(Boolean).join(' · '), source: '17track' };
    });
  }
  return out;
}

// ── DHL Shipment Tracking Unified (gratis con chiave) ────────────
export function mapDhl(sh) {
  const st = sh && sh.status ? sh.status : {};
  const txt = [st.status, st.description].filter(Boolean).join(' ');
  const code = String(st.statusCode || '').toLowerCase();
  let s = '';
  if (code === 'delivered' || DELIVERED.test(txt) && code !== 'transit') s = 'consegnato';
  else if (OUT_FOR_DELIVERY.test(txt)) s = 'in_consegna';
  else if (code === 'transit' || code === 'failure') s = 'in_transito';
  else if (code === 'pre-transit') s = 'spedito';
  const loc = st.location && st.location.address ? (st.location.address.addressLocality || st.location.address.countryCode || '') : '';
  return s ? { status: s, last: [st.description || st.status, loc].filter(Boolean).join(' · '), source: 'dhl' } : null;
}
async function fromDhl(env, code) {
  const r = await fetch('https://api-eu.dhl.com/track/shipments?trackingNumber=' + encodeURIComponent(code) + '&language=it', {
    headers: { 'DHL-API-Key': env.DHL_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 429) { const e = new Error('dhl-limit'); e.limit = true; throw e; }
  if (!r.ok) return null; // 404 = DHL non lo conosce
  const j = await r.json().catch(() => ({}));
  return mapDhl((j.shipments || [])[0]);
}

// ── Cainiao (pubblico, senza chiave) ─────────────────────────────
export function mapCainiao(mod) {
  const list = (mod && mod.detailList) || [];
  if (!list.length) return null;
  const ev = list[0] || {}; // il più recente per primo
  const txt = [mod.status, mod.statusDesc, ev.standerdDesc, ev.desc, ev.actionCode].filter(Boolean).join(' ');
  let s = 'in_transito';
  if (/DELIVERED|SIGN/i.test(String(mod.status || '') + ' ' + String(ev.actionCode || '')) || DELIVERED.test(txt)) s = 'consegnato';
  else if (/DELIVERING|OUT_FOR_DELIVERY/i.test(String(mod.status || '') + ' ' + String(ev.actionCode || '')) || OUT_FOR_DELIVERY.test(txt)) s = 'in_consegna';
  else if (list.length === 1 && /ACCEPT|CREATE|PICKUP|GTMS_ACCEPT/i.test(String(ev.actionCode || ''))) s = 'spedito';
  return { status: s, last: String(ev.standerdDesc || ev.desc || '').slice(0, 160), source: 'cainiao' };
}
async function fromCainiao(code) {
  const r = await fetch('https://global.cainiao.com/global/detail.json?lang=it-IT&mailNos=' + encodeURIComponent(code), {
    headers: { 'User-Agent': 'Mozilla/5.0 LilloFind', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return mapCainiao(((j && j.module) || [])[0]);
}

export function trackingSources(env) {
  return [env.TRACK17_TOKEN && '17track', env.DHL_API_KEY && 'dhl', 'cainiao'].filter(Boolean);
}

export async function syncTracking(env, db, { max = 200, pauseMs = 1200 } = {}) {
  const rows = await db.runQuery('users', { where: [['trackingCode', '>', '']], limit: max });
  const active = rows.filter((u) => u.trackingCode && u.trackingStatus !== 'consegnato' && u.trackingAuto !== false);
  const out = { ok: true, sources: trackingSources(env), checked: active.length, updated: [], emailed: 0, unknown: [], errors: [] };
  const codes = [...new Set(active.map((u) => String(u.trackingCode).trim()))];
  const res = {};
  if (env.TRACK17_TOKEN) Object.assign(res, await from17track(env, codes).catch((e) => { out.errors.push('17track: ' + e.message); return {}; }));
  let dhlOff = !env.DHL_API_KEY;
  for (const code of codes) {
    if (res[code]) continue;
    if (!dhlOff) {
      try { const d = await fromDhl(env, code); if (d) { res[code] = d; await sleep(pauseMs); continue; } }
      catch (e) { if (e.limit) { dhlOff = true; out.errors.push('DHL: limite giornaliero raggiunto'); } else out.errors.push('DHL ' + code + ': ' + e.message); }
      await sleep(pauseMs);
    }
    try { const c = await fromCainiao(code); if (c) res[code] = c; } catch (e) { out.errors.push('Cainiao ' + code + ': ' + e.message); }
  }
  for (const u of active) {
    const code = String(u.trackingCode).trim(), r = res[code];
    if (!r) { out.unknown.push(code); continue; }
    const next = r.status, cur = u.trackingStatus || 'confermato', last = String(r.last || '').slice(0, 200);
    if ((RANK[next] ?? -1) <= (RANK[cur] ?? -1)) {
      // nessun passo avanti: aggiorno solo l'ultimo evento, se è cambiato
      if (last && last !== u.trackingLastEvent) await db.updateDoc('users', u.id, { trackingLastEvent: last, trackingSource: r.source, trackingCheckedAt: new Date() }).catch(() => {});
      continue;
    }
    try {
      await db.updateDoc('users', u.id, { trackingStatus: next, trackingUpdatedAt: new Date(), trackingCheckedAt: new Date(), trackingLastEvent: last, trackingSource: r.source, trackingAutoAt: new Date() });
      out.updated.push({ uid: u.id, code, from: cur, to: next, source: r.source });
      if (u.email && env.RESEND_API_KEY) {
        await sendTrackingEmail({ email: u.email, code, product: u.trackingProduct || '', status: next, note: last ? 'Ultimo aggiornamento: ' + last : '' }, { env });
        out.emailed++;
      }
    } catch (e) { out.errors.push(u.id + ': ' + (e && e.message)); }
  }
  if (out.updated.length || out.errors.length) console.log('tracking auto:', JSON.stringify({ ...out, updated: out.updated.map((x) => x.code + ' ' + x.from + '→' + x.to + ' (' + x.source + ')') }));
  return out;
}

// POST /trackingSync (solo admin): lo stesso giro, lanciato a mano dall'admin.
export async function trackingSyncNow(_data, { env, db }) {
  const r = await syncTracking(env, db);
  return { ...r, updated: (r.updated || []).map((x) => ({ ...x, label: LABEL[x.to] || x.to })) };
}
