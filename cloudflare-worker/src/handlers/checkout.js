// ════════════════════════════════════════════════════════════════
// Handler CHECKOUT — createPaymentIntent + validateOrder.
// Port fedele con verifica prezzi server-side (anti price-manipulation).
// ════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { HttpsError } from '../lib/errors.js';
import { DELETE_FIELD } from '../lib/firestore.js';
import { getProductWeight, getShippingCost } from '../lib/shipping.js';

const NOTIFY_EMAIL = 'yishionvt@gmail.com';

// Add-on personalizzazione maglie calcio — prezzi calcolati SEMPRE lato server
// (mai fidarsi del prezzo del client). Deve restare allineato a index.html.
// Rispecchia le 3 opzioni del fornitore: Badges, Player e Custom Name/Number.
const LF_BADGES_PRICE = 5;   // toppe/badges campionato
const LF_PLAYER_PRICE = 8;   // nome + numero giocatore ufficiale
const LF_CUSTOM_PRICE = 12;  // nome + numero personalizzato
function addonPriceOf(addons) {
  if (!addons || typeof addons !== 'object') return 0;
  let p = 0;
  if (addons.badges || addons.patch) p += LF_BADGES_PRICE; // patch = vecchio nome
  if (addons.nameType === 'player') p += LF_PLAYER_PRICE;
  else if (addons.nameType === 'custom') p += LF_CUSTOM_PRICE;
  else if (!addons.nameType && ((addons.name && String(addons.name).trim()) || (addons.number && String(addons.number).trim()))) {
    p += LF_PLAYER_PRICE; // retrocompatibilità col vecchio modello (nome/numero senza tipo)
  }
  return p;
}
function addonSummaryOf(addons) {
  if (!addons || typeof addons !== 'object') return '';
  const name = String(addons.name || '').trim().toUpperCase().replace(/[^A-Z0-9 .]/g, '').slice(0, 14);
  const num = String(addons.number || '').replace(/[^0-9]/g, '').slice(0, 2);
  const parts = [];
  if (addons.badges || addons.patch) parts.push('Toppe campionato');
  const typeLbl = addons.nameType === 'player' ? 'Giocatore' : addons.nameType === 'custom' ? 'Personalizzato' : ((name || num) ? 'Stampa' : '');
  if (typeLbl) parts.push((typeLbl + ' ' + [name, num].filter(Boolean).join(' ')).trim());
  return parts.join(' · ');
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Logo ospitato pubblicamente (usato nell'header delle email).
const EMAIL_LOGO = 'https://lillofind.shop/icon-512.png';

// Header brandizzato con logo immagine + wordmark. `tagline` opzionale.
function emailHeader(tagline) {
  return `<tr><td style="background:#23231f;padding:24px 32px;text-align:center;">
    <img src="${EMAIL_LOGO}" width="52" height="52" alt="LilloFind" style="display:inline-block;border-radius:14px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;margin-bottom:10px;"/>
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:26px;font-weight:800;letter-spacing:4px;color:#f5f2ec;">LILLOFIND</div>
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;letter-spacing:3px;color:#99a074;text-transform:uppercase;margin-top:4px;">${escHtml(tagline || 'Drop your style')}</div>
  </td></tr>`;
}

// Footer brandizzato coerente per tutte le email.
function emailFooter() {
  return `<tr><td style="background:#23231f;padding:26px 32px;text-align:center;">
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:16px;font-weight:800;letter-spacing:3px;color:#f5f2ec;margin-bottom:10px;">LILLOFIND</div>
    <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 12px;"><tr>
      <td style="padding:0 10px;"><a href="https://lillofind.shop" style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#99a074;text-decoration:none;letter-spacing:1px;">Shop</a></td>
      <td style="color:#4a4a44;">·</td>
      <td style="padding:0 10px;"><a href="https://lillofind.shop/#/profilo" style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#99a074;text-decoration:none;letter-spacing:1px;">Il mio profilo</a></td>
      <td style="color:#4a4a44;">·</td>
      <td style="padding:0 10px;"><a href="mailto:noreply@lillofind.shop" style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#99a074;text-decoration:none;letter-spacing:1px;">Assistenza</a></td>
    </tr></table>
    <p style="margin:0 0 6px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#8a8a80;line-height:1.7;">Spedizione DHL Express · Reso 30 giorni · Qualità 1:1 verificata</p>
    <p style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#66665e;">Hai domande? Rispondi a questa email.<br>© 2026 LilloFind — lillofind.shop</p>
  </td></tr>`;
}

// Preheader nascosto: il testo che Gmail mostra in anteprima accanto all'oggetto.
function emailPreheader(text) {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f5f2ec;opacity:0;">${escHtml(text)}</div>`;
}

// Guscio completo: <html> + tabella centrata + header + footer.
function emailShell(innerHtml, preheaderText, tagline) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f2ec;">
${emailPreheader(preheaderText || '')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:24px 12px;font-family:'Helvetica Neue',Arial,sans-serif;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e2d8;border-radius:16px;overflow:hidden;">
    ${emailHeader(tagline)}
    ${innerHtml}
    ${emailFooter()}
  </table>
</td></tr>
</table>
</body></html>`;
}

function stripeClient(env) {
  // httpClient fetch-based: lo SDK Stripe gira così su Workers
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

async function sendOrderNotification(order, resendKey, fromAddr) {
  if (!resendKey) return;
  try {
    const itemsHtml = (order.items || []).map(i => {
      const box = i.boxOption === 'con_scatola' ? '📦 Con Scatola' : i.boxOption === 'senza_scatola' ? 'Senza Scatola' : '—';
      const sizeBox = [i.size || '—', ['scarpe', 'scarpe_box'].includes(i.category || '') ? box : ''].filter(s => s && s !== '—').join(' / ') || '—';
      const addonRow = i.addonSummary ? `<tr><td colspan="5" style="font-size:12px;color:#8a6d00;background:#fbf7e6;padding:4px 8px;">⚽ Personalizzazione: ${escHtml(i.addonSummary)}</td></tr>` : '';
      return `<tr><td>${escHtml(i.name)}</td><td>${escHtml(i.brand || '—')}</td><td>${escHtml(sizeBox)}</td><td>x${escHtml(i.qty)}</td><td>€${(i.price * i.qty).toFixed(2)}</td></tr>${addonRow}`;
    }).join('');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr || 'LilloFind Orders <onboarding@resend.dev>',
        to: [NOTIFY_EMAIL],
        subject: `🛍 Nuovo Ordine ${escHtml(order.orderId)} — €${order.total}`,
        html: `<h2>Nuovo Ordine: ${escHtml(order.orderId)}</h2>
<p><b>Cliente:</b> ${escHtml(order.name)} — ${escHtml(order.email)}</p>
<p><b>Telefono:</b> ${escHtml(order.phone || '—')}</p>
<p><b>Indirizzo:</b> ${escHtml(order.address?.street)}, ${escHtml(order.address?.city)} ${escHtml(order.address?.zip)}</p>
<p><b>Pagamento:</b> ${escHtml(order.payment)}</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<tr><th>Prodotto</th><th>Brand</th><th>Taglia</th><th>Qtà</th><th>Prezzo</th></tr>
${itemsHtml}
</table>
<p><b>Subtotale:</b> €${order.subtotal?.toFixed(2)}<br>
<b>Spedizione:</b> €${order.shipping?.toFixed(2)}<br>
<b>Sconto:</b> -€${(order.discount || 0).toFixed(2)}<br>
<b>TOTALE:</b> €${order.total?.toFixed(2)}</p>
<p><b>Note:</b> ${escHtml(order.notes || '—')}</p>`,
      }),
    });
  } catch (e) {
    console.error('Email notification failed:', e.message);
  }
}

// ── sendTrackingEmail ───────────────────────────────────────────
// Invia al cliente l'email col codice di tracking. Auth: adminEmail
// (verifica solo il token + email admin, NON richiede il service account).
export async function sendTrackingEmail(data, { env }) {
  const email   = String(data?.email || '').trim();
  const code    = String(data?.code || '').trim();
  const product = String(data?.product || '').trim();
  const status  = String(data?.status || '').trim();
  const note    = String(data?.note || '').trim();
  if (!email || !code) throw new HttpsError('invalid-argument', 'Email e codice tracking obbligatori.');
  if (!env.RESEND_API_KEY) throw new HttpsError('unavailable', 'Invio email non configurato (RESEND_API_KEY mancante).');

  const steps = [
    { key: 'confermato',  emoji: '✅', label: 'Ordine confermato', desc: 'Abbiamo ricevuto e confermato il tuo ordine.' },
    { key: 'preparazione', emoji: '📦', label: 'In preparazione',  desc: 'Stiamo preparando e imballando il tuo pacco con cura.' },
    { key: 'spedito',     emoji: '🚀', label: 'Spedito',           desc: 'Il pacco è stato affidato al corriere ed è in viaggio.' },
    { key: 'in_transito', emoji: '✈️', label: 'In transito',       desc: 'Il pacco sta viaggiando verso di te. Segui gli aggiornamenti live.' },
    { key: 'in_consegna', emoji: '🚚', label: 'In consegna',       desc: 'Il corriere sta consegnando il pacco: tienilo d’occhio oggi!' },
    { key: 'consegnato',  emoji: '🎉', label: 'Consegnato',        desc: 'Il pacco è stato consegnato. Buon drop! Ci lasci una recensione?' },
  ];
  const curIdx = Math.max(0, steps.findIndex(s => s.key === status));
  const cur = steps[curIdx] || { emoji: '📦', label: 'Aggiornamento spedizione', desc: 'Il tuo ordine è stato aggiornato.' };
  const statusLabel = cur.emoji + ' ' + cur.label;
  const from = env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>';
  const trackUrl = 'https://t.17track.net/it#nums=' + encodeURIComponent(code);

  // Timeline verticale (email-safe): step completati / attuale / futuri.
  const timelineHtml = steps.map((s, i) => {
    const done = i < curIdx, active = i === curIdx;
    const dotBg = active ? '#6f7552' : done ? '#23231f' : '#ffffff';
    const dotBorder = (active || done) ? '#6f7552' : '#d8d3c7';
    const dotInner = done
      ? '<span style="color:#99a074;font-size:13px;line-height:1;">&#10003;</span>'
      : active ? '<span style="color:#f5f2ec;font-size:13px;line-height:1;">&#10003;</span>'
      : `<span style="color:#c4bfb3;font-size:11px;line-height:1;">${i + 1}</span>`;
    const line = i < steps.length - 1
      ? `<div style="width:2px;height:22px;background:${i < curIdx ? '#6f7552' : '#e7e2d8'};margin:2px auto 0;"></div>` : '';
    const titleColor = (active || done) ? '#23231f' : '#b3ad9f';
    return `<tr>
      <td width="40" valign="top" style="text-align:center;">
        <div style="width:30px;height:30px;border-radius:999px;background:${dotBg};border:2px solid ${dotBorder};text-align:center;line-height:28px;margin:0 auto;">${dotInner}</div>
        ${line}
      </td>
      <td valign="top" style="padding:2px 0 ${i < steps.length - 1 ? '18px' : '0'} 12px;">
        <div style="font-size:14px;font-weight:${active ? '700' : '600'};color:${titleColor};">${s.emoji} ${escHtml(s.label)}</div>
        ${active ? `<div style="font-size:12px;color:#6b6b63;line-height:1.6;margin-top:3px;">${escHtml(s.desc)}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  const inner = `
    <!-- Hero -->
    <tr><td style="padding:32px 32px 6px;text-align:center;">
      <div style="display:inline-block;background:#eef0e6;color:#6f7552;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;padding:7px 16px;border-radius:999px;">${escHtml(statusLabel)}</div>
      <h1 style="font-size:24px;color:#23231f;margin:18px 0 6px;">La tua spedizione è aggiornata</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">Ciao, ecco lo stato più recente del tuo ordine LilloFind${product ? ` — <b style="color:#23231f;">${escHtml(product)}</b>` : ''}.</p>
    </td></tr>
    <!-- Tracking code -->
    <tr><td style="padding:24px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f3;border:1px solid #e7e2d8;border-radius:12px;">
        <tr><td style="padding:16px 20px;text-align:center;">
          <p style="margin:0 0 6px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8a8a80;font-weight:700;">Codice tracking</p>
          <p style="margin:0;font-size:22px;letter-spacing:3px;color:#23231f;font-weight:800;font-family:'Courier New',monospace;">${escHtml(code)}</p>
        </td></tr>
      </table>
    </td></tr>
    ${note ? `<!-- Note -->
    <tr><td style="padding:14px 32px 0;">
      <div style="background:#fffceb;border:1px solid #f4ecc9;border-radius:10px;padding:12px 16px;font-size:13px;color:#6b6b63;line-height:1.6;">💬 ${escHtml(note)}</div>
    </td></tr>` : ''}
    <!-- Timeline -->
    <tr><td style="padding:26px 32px 0;">
      <p style="margin:0 0 16px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a80;font-weight:700;">Stato della spedizione</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${timelineHtml}</table>
    </td></tr>
    <!-- CTA -->
    <tr><td style="padding:28px 32px 6px;text-align:center;">
      <a href="${escHtml(trackUrl)}" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 34px;border-radius:999px;">📡 Traccia il pacco in tempo reale →</a>
      <p style="margin:14px 0 0;font-size:12px;color:#8a8a80;line-height:1.6;">Puoi seguire la spedizione anche dalla sezione <b style="color:#6b6b63;">Traccia Pacco</b> del tuo profilo, con aggiornamento live dal corriere.</p>
    </td></tr>
    <!-- Reassurance -->
    <tr><td style="padding:20px 32px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #ece7db;">
        <tr>
          <td width="33%" style="padding:16px 6px 0;text-align:center;vertical-align:top;"><div style="font-size:20px;">🚚</div><div style="font-size:11px;color:#6b6b63;line-height:1.5;margin-top:4px;">Spedizione<br>tracciata</div></td>
          <td width="33%" style="padding:16px 6px 0;text-align:center;vertical-align:top;"><div style="font-size:20px;">↩️</div><div style="font-size:11px;color:#6b6b63;line-height:1.5;margin-top:4px;">Reso entro<br>30 giorni</div></td>
          <td width="33%" style="padding:16px 6px 0;text-align:center;vertical-align:top;"><div style="font-size:20px;">💬</div><div style="font-size:11px;color:#6b6b63;line-height:1.5;margin-top:4px;">Assistenza<br>dedicata</div></td>
        </tr>
      </table>
    </td></tr>`;

  const html = emailShell(inner, `${cur.label} · codice ${code}`, 'La tua spedizione');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${cur.emoji} La tua spedizione LilloFind — ${cur.label} (${code})`,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new HttpsError('internal', 'Invio email fallito: ' + (t || resp.status));
  }
  return { sent: true };
}

// ── track17 ─────────────────────────────────────────────────────
// Stato pacco in tempo reale via 17TRACK (multi-corriere). Registra il
// numero (idempotente) e restituisce l'ultimo stato, mappato sugli stati
// LilloFind. Auth: adminEmail. Richiede il secret TRACK17_TOKEN.
const TRACK17_MAP = {
  InfoReceived: 'spedito', InTransit: 'in_transito', OutForDelivery: 'in_consegna',
  AvailableForPickup: 'in_consegna', PickUp: 'in_consegna', Delivered: 'consegnato',
  DeliveryFailure: 'in_transito', Undelivered: 'in_transito', Exception: 'in_transito', Expired: 'in_transito',
  NotFound: '', InfoReceived_2: 'spedito',
};
export async function track17(data, { env }) {
  const code = String((data && data.code) || '').trim();
  if (!code) throw new HttpsError('invalid-argument', 'Codice tracking mancante.');
  const token = env.TRACK17_TOKEN;
  if (!token) return { ok: false, error: 'not-configured' };
  const carrier = (data && data.carrier) ? Number(data.carrier) : undefined;
  const api = async (path, body) => {
    const r = await fetch('https://api.17track.net/track/v2.2/' + path, {
      method: 'POST',
      headers: { '17token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return r.json();
  };
  try {
    // 1) registra (se già registrato 17TRACK risponde "rejected: already registered" → ignora)
    await api('register', [carrier ? { number: code, carrier } : { number: code }]).catch(() => {});
    // 2) info
    const info = await api('gettrackinfo', [{ number: code }]);
    const acc = info && info.data && info.data.accepted && info.data.accepted[0];
    const rej = info && info.data && info.data.rejected && info.data.rejected[0];
    if (!acc) {
      const msg = rej && rej.error ? (rej.error.message || String(rej.error.code || '')) : 'no-data';
      return { ok: false, error: msg };
    }
    const ti = acc.track_info || {};
    const status17 = (ti.latest_status && ti.latest_status.status) || 'NotFound';
    const latest = ti.latest_event || {};
    const providers = (ti.tracking && ti.tracking.providers) || [];
    let events = [];
    if (providers[0] && Array.isArray(providers[0].events)) {
      events = providers[0].events.slice(0, 12).map(e => ({
        time: e.time_iso || e.time_utc || '', desc: e.description || '', location: e.location || '',
      }));
    }
    const carrierName = (providers[0] && providers[0].provider && providers[0].provider.name) || '';
    const est = (ti.time_metrics && ti.time_metrics.estimated_delivery_date && ti.time_metrics.estimated_delivery_date.to) || '';
    return {
      ok: true, code,
      status17, statusMapped: TRACK17_MAP[status17] || '',
      lastEvent: latest.description || '', lastTime: latest.time_iso || latest.time_utc || '', lastLocation: latest.location || '',
      carrier: carrierName, estDelivery: est, delivered: status17 === 'Delivered',
      events,
    };
  } catch (e) {
    return { ok: false, error: 'fetch-failed:' + (e.message || '') };
  }
}

// ── sendOrderEmail ──────────────────────────────────────────────
// Email di conferma ordine al cliente (+ notifica admin). Auth: required
// (verifica solo il token, NON richiede il service account Firestore).
export async function sendOrderEmail(data, { env, auth }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'no_key' };
  const to = (auth && auth.email) ? auth.email : (data && data.email) || '';
  if (!to) return { sent: false, reason: 'no_email' };
  const o = data || {};
  const from = env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>';
  const payLabel = { bonifico: 'Bonifico bancario', paypal: 'PayPal', card: 'Carta' }[o.payment] || o.payment || '—';
  const nextStep = {
    bonifico: 'Per completare l\'ordine effettua il bonifico indicando come <b>causale il numero ordine</b>. Trovi le coordinate bancarie nella pagina di conferma sul sito. L\'ordine viene evaso entro 24h dalla ricezione del pagamento.',
    paypal: 'Completa il pagamento su <b>PayPal</b> seguendo le istruzioni mostrate al checkout. Appena ricevuto, prepariamo la spedizione.',
    card: 'Pagamento ricevuto correttamente. Stiamo preparando il tuo ordine.',
  }[o.payment] || 'Riceverai un aggiornamento appena il pagamento sarà confermato.';

  const itemsHtml = (o.items || []).map(i =>
    `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #ece7db;font-size:14px;color:#23231f;">
        <span style="font-weight:600;">${escHtml(i.name)}</span>${i.brand ? `<br><span style="font-size:12px;color:#8a8a80;">${escHtml(i.brand)}</span>` : ''}${i.size ? `<span style="font-size:12px;color:#8a8a80;"> · Taglia ${escHtml(i.size)}</span>` : ''}${i.addonSummary ? `<br><span style="font-size:12px;color:#8a6d00;">⚽ ${escHtml(i.addonSummary)}</span>` : ''}
      </td>
      <td style="padding:12px 8px;border-bottom:1px solid #ece7db;text-align:center;font-size:13px;color:#6b6b63;white-space:nowrap;">×${escHtml(i.qty)}</td>
      <td style="padding:12px 0;border-bottom:1px solid #ece7db;text-align:right;font-size:14px;font-weight:600;color:#23231f;white-space:nowrap;">€${((i.price || 0) * (i.qty || 1)).toFixed(2)}</td>
    </tr>`
  ).join('');
  const addr = o.address || {};
  const totalRow = (label, val, opts = {}) =>
    `<tr><td style="padding:4px 0;font-size:${opts.big ? '16px' : '13px'};color:${opts.big ? '#23231f' : '#6b6b63'};font-weight:${opts.big ? '700' : '400'};">${label}</td><td style="padding:4px 0;text-align:right;font-size:${opts.big ? '18px' : '13px'};color:${opts.accent ? '#6f7552' : '#23231f'};font-weight:${opts.big ? '700' : '600'};">${val}</td></tr>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f2ec;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:24px 12px;font-family:'Helvetica Neue',Arial,sans-serif;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e7e2d8;border-radius:16px;overflow:hidden;">
    <!-- Header -->
    <tr><td style="background:#23231f;padding:26px 32px;text-align:center;">
      <div style="font-size:26px;font-weight:800;letter-spacing:4px;color:#f5f2ec;">LILLOFIND</div>
      <div style="font-size:10px;letter-spacing:3px;color:#99a074;text-transform:uppercase;margin-top:4px;">Drop your style</div>
    </td></tr>
    <!-- Hero -->
    <tr><td style="padding:32px 32px 8px;">
      <div style="display:inline-block;background:#eef0e6;color:#6f7552;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;padding:6px 14px;border-radius:999px;">Ordine ricevuto</div>
      <h1 style="font-size:24px;color:#23231f;margin:16px 0 6px;">Grazie, ${escHtml((o.name || '').split(' ')[0] || '')}! 🎉</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">Abbiamo ricevuto il tuo ordine <b style="color:#23231f;">${escHtml(o.orderId || '')}</b>. Ecco il riepilogo.</p>
    </td></tr>
    <!-- Items -->
    <tr><td style="padding:20px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemsHtml}</table>
    </td></tr>
    <!-- Totals -->
    <tr><td style="padding:16px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${totalRow('Subtotale', '€' + (o.subtotal || 0).toFixed(2))}
        ${totalRow('Spedizione DHL', (o.shipping ? '€' + (o.shipping).toFixed(2) : 'Gratis'))}
        ${o.discount ? totalRow('Sconto', '-€' + (o.discount).toFixed(2), { accent: true }) : ''}
        <tr><td colspan="2" style="border-top:1px solid #e7e2d8;padding-top:8px;"></td></tr>
        ${totalRow('Totale', '€' + (o.total || 0).toFixed(2), { big: true })}
      </table>
      <div style="background:#eef0e6;border-radius:10px;padding:10px 14px;margin-top:14px;font-size:12px;color:#6f7552;font-weight:600;">⬡ +${Math.floor(o.subtotal || 0)} LFPOINTS verranno accreditati alla conferma del pagamento</div>
    </td></tr>
    <!-- Payment / next steps -->
    <tr><td style="padding:20px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f3;border:1px solid #e7e2d8;border-radius:12px;">
        <tr><td style="padding:16px 18px;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a80;font-weight:700;">Pagamento · ${escHtml(payLabel)}</p>
          <p style="margin:0;font-size:13px;color:#4a4a44;line-height:1.6;">${nextStep}</p>
        </td></tr>
      </table>
    </td></tr>
    ${(addr.street) ? `<!-- Shipping -->
    <tr><td style="padding:18px 32px 0;">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a80;font-weight:700;">Spedizione a</p>
      <p style="margin:0;font-size:13px;color:#4a4a44;line-height:1.6;">${escHtml(o.name || '')}<br>${escHtml(addr.street)}<br>${escHtml(addr.zip || '')} ${escHtml(addr.city || '')}<br>${escHtml(addr.country || 'Italia')}</p>
    </td></tr>` : ''}
    <!-- CTA -->
    <tr><td style="padding:24px 32px;">
      <a href="https://lillofind.shop" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:13px 28px;border-radius:999px;">Continua lo shopping →</a>
    </td></tr>
    <!-- Footer -->
    <tr><td style="background:#23231f;padding:24px 32px;text-align:center;">
      <div style="font-size:16px;font-weight:800;letter-spacing:3px;color:#f5f2ec;margin-bottom:8px;">LILLOFIND</div>
      <p style="margin:0 0 6px;font-size:11px;color:#8a8a80;line-height:1.7;">Spedizione DHL Express · Reso 30 giorni · Qualità 1:1 verificata</p>
      <p style="margin:0;font-size:11px;color:#66665e;">Hai domande? Rispondi a questa email.<br>© 2026 LilloFind — lillofind.shop</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  try {
    const cResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: `Conferma ordine ${o.orderId || ''} — LilloFind`, html }),
    });
    if (!cResp.ok) {
      const errTxt = (await cResp.text()).slice(0, 300);
      console.error('Resend conferma ordine FALLITA:', cResp.status, errTxt);
      return { sent: false, status: cResp.status, reason: errTxt };
    }
    // Blocco "ordine fornitore" per l'agente d'acquisto (solo articoli fisici):
    // link prodotto, nome, specifiche, quantità, prezzo CNY, immagine.
    const physItems = (o.items || []).filter(i => !i.isDigital);
    const supplierBlockHtml = physItems.length ? (
      '<div style="margin:16px 0;padding:14px 16px;border:1px solid #e7e2d8;border-radius:10px;background:#faf8f3;">' +
      '<p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#23231f;">🛒 Ordine fornitore (per l\'agente d\'acquisto)</p>' +
      physItems.map((i, idx) => {
        const specs = [i.size ? ('Taglia ' + i.size) : '', i.color ? ('Colore ' + i.color) : '', i.addonSummary || ''].filter(Boolean).join(' · ');
        const cny = (i.supplierPriceCNY != null && i.supplierPriceCNY !== '') ? String(i.supplierPriceCNY) : '10 (da confermare)';
        const link = i.sourceUrl || '';
        const img = i.img ? (String(i.img).startsWith('//') ? 'https:' + i.img : i.img) : '';
        const row = (l, v) => '<tr><td style="padding:2px 10px 2px 0;font-size:11px;color:#8a8a80;white-space:nowrap;vertical-align:top;">' + l + '</td><td style="padding:2px 0;font-size:12px;color:#23231f;word-break:break-all;">' + v + '</td></tr>';
        return '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #ece7db;">' +
          '<p style="margin:0 0 4px;font-size:11px;color:#6b6b63;font-weight:700;">Articolo ' + (idx + 1) + '</p>' +
          '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;">' +
            (link ? row('Link prodotto', '<a href="' + escHtml(link) + '" style="color:#2b57d6;">' + escHtml(link) + '</a>') : '') +
            row('Nome prodotto', escHtml(i.name || '')) +
            row('Specifiche', escHtml(specs || '-')) +
            row('Quantità', String(i.qty || 1)) +
            row('Prezzo unit. (CNY)', escHtml(cny)) +
            (img ? row('Immagine', '<a href="' + escHtml(img) + '" style="color:#2b57d6;">apri foto</a>') : '') +
          '</table></div>';
      }).join('') +
      '</div>'
    ) : '';
    // Notifica admin (best-effort)
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [NOTIFY_EMAIL], subject: `🛍 Nuovo ordine ${o.orderId || ''} — €${(o.total || 0).toFixed(2)} (${escHtml(payLabel)})`, html: `<p><b>Nuovo ordine</b> da ${escHtml(o.name || '')} — ${escHtml(to)}</p>` + supplierBlockHtml + html }),
    });
  } catch (e) {
    return { sent: false, reason: e.message };
  }
  return { sent: true };
}

// ── sendCredentialsEmail ────────────────────────────────────────
// Invia al cliente le credenziali degli abbonamenti (Netflix/Spotify…),
// con data inizio/fine. Auth: adminEmail (lo scatena l'admin al salvataggio).
export async function sendCredentialsEmail(data, { env }) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'no_key' };
  const to = (data && data.email) || '';
  if (!to) return { sent: false, reason: 'no_email' };
  const creds = Array.isArray(data.credentials) ? data.credentials.filter(c => c && (c.login || c.password || c.link)) : [];
  if (!creds.length) return { sent: false, reason: 'no_creds' };
  const from = env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>';
  const name = ((data.name || '').split(' ')[0]) || '';
  const fmt = (iso, addMonths) => {
    try { const d = new Date((iso || '') + 'T00:00:00'); if (isNaN(d)) return '—'; if (addMonths) d.setMonth(d.getMonth() + addMonths); return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }); }
    catch (e) { return '—'; }
  };
  const blocks = creds.map(c => {
    const months = parseInt(c.months, 10) || 1;
    const row = (l, v, red) => v ? `<tr><td style="padding:8px 0;font-size:12px;color:#8a8a80;">${escHtml(l)}</td><td style="padding:8px 0;text-align:right;font-family:'Courier New',monospace;font-size:14px;color:${red ? '#e5484d' : '#23231f'};font-weight:600;word-break:break-all;">${escHtml(v)}</td></tr>` : '';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f3;border:1px solid #e7e2d8;border-radius:12px;margin-bottom:14px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:16px;font-weight:700;color:#23231f;margin-bottom:6px;">🔑 ${escHtml(c.service || 'Abbonamento')}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row('Nome utente', c.login)}${row("Parola d'ordine", c.password, true)}${c.profile ? row('Profilo', c.profile) : ''}</table>
        ${c.link ? `<div style="margin-top:10px;"><div style="font-size:12px;color:#8a8a80;margin-bottom:5px;">🔗 Link di attivazione</div><a href="${escHtml(c.link)}" style="display:block;background:#f3f6ff;border:1px solid #e0e6ff;border-radius:10px;padding:10px 12px;font-family:'Courier New',monospace;font-size:12px;color:#2b57d6;word-break:break-all;text-decoration:none;">${escHtml(c.link)}</a>
          <a href="${escHtml(c.link)}" style="display:inline-block;margin-top:10px;background:#2b57d6;color:#ffffff;font-weight:700;font-size:13px;text-decoration:none;padding:11px 24px;border-radius:999px;">Apri link &rarr;</a></div>` : ''}
        ${c.note ? `<div style="margin-top:10px;background:#fffceb;border:1px solid #f4ecc9;border-radius:8px;padding:8px 10px;font-size:12px;color:#6b6b63;">📝 ${escHtml(c.note)}</div>` : ''}
        <div style="margin-top:10px;font-size:12px;color:#6b6b63;">Inizio <b style="color:#23231f;">${fmt(c.startISO)}</b> · Fine <b style="color:#23231f;">${fmt(c.startISO, months)}</b> · Durata ${months} ${months > 1 ? 'mesi' : 'mese'}</div>
      </td></tr>
    </table>`;
  }).join('');
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f2ec;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f2ec;padding:24px 12px;font-family:'Helvetica Neue',Arial,sans-serif;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border:1px solid #e7e2d8;border-radius:16px;overflow:hidden;">
  <tr><td style="background:#23231f;padding:26px 32px;text-align:center;"><div style="font-size:26px;font-weight:800;letter-spacing:4px;color:#f5f2ec;">LILLOFIND</div><div style="font-size:10px;letter-spacing:3px;color:#99a074;text-transform:uppercase;margin-top:4px;">I tuoi abbonamenti</div></td></tr>
  <tr><td style="padding:30px 32px 8px;"><h1 style="font-size:22px;color:#23231f;margin:0 0 6px;">Ciao ${escHtml(name)}! 🔑</h1><p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">Ecco le credenziali dei tuoi abbonamenti${data.orderId ? ' (ordine <b>' + escHtml(data.orderId) + '</b>)' : ''}. Le ritrovi sempre nel tuo profilo sul sito, nella sezione <b>I Miei Abbonamenti</b>.</p></td></tr>
  <tr><td style="padding:18px 32px 0;">${blocks}</td></tr>
  <tr><td style="padding:8px 32px 30px;"><a href="https://lillofind.shop/" style="display:inline-block;background:#C8FF00;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:999px;">Vai al mio profilo →</a><p style="font-size:11px;color:#a8a89e;margin-top:16px;line-height:1.6;">Tieni riservate queste credenziali. Per assistenza, rispondi a questa email.</p></td></tr>
</table></td></tr></table></body></html>`;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: '🔑 Le tue credenziali abbonamento — LilloFind', html }),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); return { sent: false, reason: 'resend_' + resp.status, detail: t.slice(0, 200) }; }
    return { sent: true };
  } catch (e) { return { sent: false, reason: 'exception', detail: (e && e.message) || '' }; }
}

// ── sendTestEmail ───────────────────────────────────────────────
// Diagnostica: invia una email di prova via Resend e restituisce la
// risposta reale dell'API (status/id/errore). Serve a capire se il
// dominio è verificato e se l'invio funziona. Auth: adminEmail.
export async function sendTestEmail(data, { env }) {
  if (!env.RESEND_API_KEY) return { ok: false, reason: 'RESEND_API_KEY non configurato sul Worker.' };
  const to = String((data && data.to) || NOTIFY_EMAIL || '').trim();
  const from = env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>';
  if (!to) return { ok: false, reason: 'Nessun destinatario.' };
  let status = 0, body = '';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [to],
        subject: '✅ Test email — LilloFind',
        html: '<div style="font-family:Arial,sans-serif"><h2>Test riuscito 🎉</h2><p>Se ricevi questa email, Resend è configurato correttamente e il dominio mittente funziona.</p><p style="color:#888;font-size:12px">Mittente: ' + escHtml(from) + '</p></div>',
      }),
    });
    status = resp.status;
    body = await resp.text();
  } catch (e) {
    return { ok: false, from, to, error: e.message };
  }
  let parsed = null; try { parsed = JSON.parse(body); } catch (_) {}
  const ok = status >= 200 && status < 300;
  return {
    ok, status, from, to,
    id: parsed && parsed.id ? parsed.id : null,
    error: ok ? null : ((parsed && (parsed.message || parsed.name)) || body.slice(0, 300)),
    hint: ok ? 'Email inviata: controlla la casella (anche spam).'
             : (status === 403 || /domain/i.test(body) ? 'Il dominio del mittente non risulta VERIFICATO su Resend: aggiungi e verifica lillofind.shop (record DNS SPF/DKIM) nella dashboard Resend.' : 'Invio rifiutato da Resend — vedi campo error.'),
  };
}

// ── createPaymentIntent ─────────────────────────────────────────
export async function createPaymentIntent(data, { env, db, auth }) {
  const { items } = data || {};
  if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'Carrello vuoto.');

  for (const item of items) {
    if (!item.id || typeof item.id !== 'string') throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) throw new HttpsError('invalid-argument', `Quantità non valida: ${item.id}`);
  }

  // Gli abbonamenti (sub-*) non sono in Firestore: il loro prezzo è gestito
  // in validateOrder. Qui per il PaymentIntent leggiamo solo i prodotti reali.
  const SUBSCRIPTION_PRICES = {
    'sub-netflix': 3.90, 'sub-youtube': 2.50, 'sub-spotify': 1.99, 'sub-disney': 1.90,
    'sub-paramount': 1.50, 'sub-canva': 2.00, 'sub-crunchyroll': 1.50,
  };
  const prodItems = items.filter(i => !i.id.startsWith('sub-'));
  const subItems = items.filter(i => i.id.startsWith('sub-'));

  let snaps = [];
  if (prodItems.length) {
    try { snaps = await db.getMany('products', prodItems.map(i => i.id)); }
    catch (e) { throw new HttpsError('internal', 'Errore lettura prodotti.'); }
  }

  const verifiedItems = snaps.map((snap, idx) => {
    if (!snap.exists) throw new HttpsError('not-found', `Prodotto non trovato: ${prodItems[idx].id}`);
    const prod = snap.data();
    return {
      price: (prod.price || 0) + addonPriceOf(prodItems[idx].addons),
      category: prod.category || '',
      weightKg: prod.weightKg || prod.weight_kg || 0,
      boxOption: prodItems[idx].boxOption || '',
      qty: parseInt(prodItems[idx].qty, 10),
      isDigital: prod.isDigital || false,
    };
  });
  for (const s of subItems) {
    const price = SUBSCRIPTION_PRICES[s.id];
    if (price == null) throw new HttpsError('not-found', `Abbonamento non trovato: ${s.id}`);
    verifiedItems.push({ price, category: 'Subscriptions', weightKg: 0, boxOption: '', qty: parseInt(s.qty, 10), isDigital: true });
  }

  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeight(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCost(totalWeight);

  let discountAmount = 0;
  try {
    const userSnap = await db.getDoc('users', auth.uid);
    if (userSnap.exists) {
      const ar = userSnap.data().activeReward || null;
      if (ar) {
        if (ar.type === 'fisso') discountAmount = Math.min(ar.val, subtotal);
        else if (ar.type === 'percentuale') discountAmount = subtotal * (ar.val / 100);
        if (ar.freeShipping) discountAmount += shipping;
        discountAmount = Math.round(discountAmount * 100) / 100;
      }
    }
  } catch (e) { /* non bloccante */ }

  const total = Math.max(0, Math.round((subtotal + shipping - discountAmount) * 100) / 100);
  const amountCents = Math.round(total * 100);
  if (amountCents < 50) throw new HttpsError('invalid-argument', 'Importo minimo €0.50 non raggiunto.');

  try {
    const stripe = stripeClient(env);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { uid: auth.uid, subtotal: String(subtotal), shipping: String(shipping) },
    });
    return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  } catch (e) {
    console.error('Stripe createPaymentIntent error:', e.message);
    throw new HttpsError('internal', 'Errore Stripe: ' + e.message);
  }
}

// ── validateOrder ───────────────────────────────────────────────
export async function validateOrder(data, { env, db, auth }) {
  const SUBSCRIPTION_CATALOG = {
    'sub-netflix':     { name: 'Netflix Premium UHD',  price: 3.90, isDigital: true },
    'sub-youtube':     { name: 'YouTube Premium',      price: 2.50, isDigital: true },
    'sub-spotify':     { name: 'Spotify Premium',      price: 1.99, isDigital: true },
    'sub-disney':      { name: 'Disney+',              price: 1.90, isDigital: true },
    'sub-paramount':   { name: 'Paramount+',           price: 1.50, isDigital: true },
    'sub-canva':       { name: 'Canva Pro',            price: 2.00, isDigital: true },
    'sub-crunchyroll': { name: 'Crunchyroll Mega Fan', price: 1.50, isDigital: true },
  };

  const uid = auth.uid;
  const { items, paymentMethod, shippingAddress, name, phone, notes } = data || {};

  if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'Il carrello è vuoto.');
  if (items.length > 100) throw new HttpsError('invalid-argument', 'Troppi articoli nel carrello.');

  const subItems = [], prodItems = [];
  items.forEach(item => {
    if (!item.id || typeof item.id !== 'string') throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) throw new HttpsError('invalid-argument', `Quantità non valida per il prodotto ${item.id}.`);
    if (item.id.startsWith('sub-')) subItems.push({ ...item, qty });
    else prodItems.push({ ...item, qty });
  });

  const verifiedSubs = subItems.map(item => {
    const sub = SUBSCRIPTION_CATALOG[item.id];
    if (!sub) throw new HttpsError('not-found', `Abbonamento non trovato: ${item.id}`);
    return {
      id: item.id, name: sub.name, price: sub.price, brand: 'Lillo-Life',
      category: 'Subscriptions', weightKg: 0, boxOption: '', qty: item.qty,
      size: '', color: '', img: '', isDigital: true,
    };
  });

  let productDocs = [];
  if (prodItems.length > 0) {
    try { productDocs = await db.getMany('products', prodItems.map(i => i.id)); }
    catch (e) { throw new HttpsError('internal', 'Errore nel caricamento dei prodotti.'); }
  }

  const verifiedProds = productDocs.map((snap, idx) => {
    if (!snap.exists) throw new HttpsError('not-found', `Prodotto non trovato: ${prodItems[idx].id}`);
    const prod = snap.data();
    const qty = prodItems[idx].qty;
    const addonPrice = addonPriceOf(prodItems[idx].addons);
    const addonSummary = addonSummaryOf(prodItems[idx].addons);
    return {
      id: snap.id, name: prod.name || '', price: (prod.price || 0) + addonPrice, brand: prod.brand || '',
      category: prod.category || '', weightKg: prod.weightKg || prod.weight_kg || 0,
      boxOption: prodItems[idx].boxOption || '', qty, size: prodItems[idx].size || '',
      color: prodItems[idx].color || '', img: prod.imageUrl || '', isDigital: prod.isDigital || false,
      ...(addonPrice ? { addonPrice, addonSummary } : {}),
    };
  });

  const verifiedItems = [...verifiedProds, ...verifiedSubs];

  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeight(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCost(totalWeight);
  const lfpoints = Math.floor(subtotal);

  let discountAmount = 0, activeReward = null;
  try {
    const userSnap = await db.getDoc('users', uid);
    if (userSnap.exists) {
      const udata = userSnap.data();
      activeReward = udata.activeReward || null;
      if (activeReward) {
        if (activeReward.type === 'fisso') discountAmount = Math.min(activeReward.val, subtotal);
        else if (activeReward.type === 'percentuale') discountAmount = subtotal * (activeReward.val / 100);
        if (activeReward.freeShipping) discountAmount += shipping;
        discountAmount = Math.round(discountAmount * 100) / 100;
      }
    }
  } catch (e) { console.error('Errore lettura utente:', e.message); }

  const total = Math.max(0, Math.round((subtotal + shipping - discountAmount) * 100) / 100);

  // Verifica PaymentIntent Stripe per pagamenti con carta
  if (paymentMethod === 'card') {
    const { stripePaymentIntentId } = data;
    if (!stripePaymentIntentId) throw new HttpsError('invalid-argument', 'Pagamento con carta non completato correttamente.');
    const stripe = stripeClient(env);
    let pi;
    try { pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId); }
    catch (e) { throw new HttpsError('invalid-argument', 'PaymentIntent non valido.'); }
    if (pi.status !== 'succeeded') throw new HttpsError('failed-precondition', 'Il pagamento non è stato completato.');
    if (pi.metadata?.uid !== uid) throw new HttpsError('permission-denied', 'PaymentIntent non appartiene a questo utente.');
    if (Math.abs(pi.amount - Math.round(total * 100)) > 1) throw new HttpsError('failed-precondition', 'Importo del pagamento non corrisponde al totale ordine.');
  }

  const orderId = 'LILLO-' + Date.now().toString(36).toUpperCase().slice(-6);

  const orderData = {
    orderId, uid,
    email: auth.token.email || auth.email || '',
    name: String(name || '').slice(0, 120),
    phone: String(phone || '').slice(0, 30),
    address: {
      street:  String(shippingAddress?.street  || '').slice(0, 200),
      city:    String(shippingAddress?.city    || '').slice(0, 100),
      zip:     String(shippingAddress?.zip     || '').slice(0, 20),
      country: String(shippingAddress?.country || 'Italia').slice(0, 60),
    },
    notes: String(notes || '').slice(0, 500),
    items: verifiedItems,
    subtotal, shipping, discount: discountAmount, total,
    payment: ['card', 'paypal', 'bonifico'].includes(paymentMethod) ? paymentMethod : 'card',
    lfpoints,
    isDigitalOrder: allDigital,
    deliveryType: allDigital ? 'digital' : 'physical',
    status: 'pending',
    createdAt: new Date(),
  };

  try { await db.addDoc('orders', orderData); }
  catch (e) { throw new HttpsError('internal', 'Errore nel salvataggio dell\'ordine. Riprova.'); }

  const paymentVerified = paymentMethod === 'card';
  try {
    const userSnap2 = await db.getDoc('users', uid);
    const currentData = userSnap2.exists ? userSnap2.data() : {};
    const userUpdate = { totalSpent: (currentData.totalSpent || 0) + subtotal };
    if (paymentVerified) userUpdate.lfpoints = (currentData.lfpoints || 0) + lfpoints;
    if (activeReward && paymentVerified) userUpdate.activeReward = DELETE_FIELD;
    await db.updateDoc('users', uid, userUpdate);
  } catch (e) { console.error('Errore aggiornamento utente (non critico):', e.message); }

  // Notifica email (fire-and-forget; non blocca la risposta)
  sendOrderNotification({ ...orderData, orderId, subtotal, shipping, discount: discountAmount, total }, env.RESEND_API_KEY, env.RESEND_FROM);

  return { orderId, subtotal, shipping, discount: discountAmount, total, lfpoints: paymentVerified ? lfpoints : 0, paymentMethod };
}
