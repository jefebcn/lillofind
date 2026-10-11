// ════════════════════════════════════════════════════════════════
// Promemoria automatici (cron del Worker, ogni 4 ore, vedi index.js):
//   · carrello abbandonato — articoli nel carrello dell'account fermi da
//     24-72 ore e nessun ordine dopo: un'email, al massimo una a settimana,
//     con link per non riceverne più;
//   · ordini non pagati (bonifico / PayPal manuale) — promemoria con i dati
//     di pagamento dopo 24 ore, annullamento dopo 48 (la stessa soglia che
//     prima applicava l'admin solo aprendo il pannello), con avviso al
//     cliente e un riepilogo all'admin.
// Ogni passo segna un campo sul documento, così un giro ripetuto non manda
// doppioni.
// ════════════════════════════════════════════════════════════════
import { escHtml, emailShell, NOTIFY_EMAIL } from './checkout.js';

const H = 3600 * 1000;
export const CART_MIN_H = 24, CART_MAX_H = 72, CART_GAP_DAYS = 7;
export const UNPAID_REMIND_H = 24, UNPAID_EXPIRE_H = 48;
const SITE = 'https://lillofind.shop/';
const PAYPAL_ME = 'https://www.paypal.me/lilconti';
const BANK = { holder: 'ALEX CONTI', iban: 'IE06 SUMU 9903 6511 9972 84', bic: 'SUMUIE22XXX' };

const tsMs = (v) => (v == null ? 0 : typeof v === 'number' ? v : (v.seconds ? v.seconds * 1000 : (v instanceof Date ? v.getTime() : Date.parse(v) || 0)));
const money = (n) => '€' + (Number(n) || 0).toFixed(2);

async function sendMail(env, { to, subject, html, replyTo }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>', to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
}

// ── Link "non ricevere più promemoria" firmato (HMAC sull'uid) ──────
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const unsubSecret = (env) => env.UNSUB_SECRET || env.RESEND_API_KEY || '';
export async function unsubscribeUrl(env, uid, base) {
  return (base || env.WORKER_PUBLIC_BASE || 'https://lillofind.conti9708.workers.dev') + '/unsubscribe?u=' + encodeURIComponent(uid) + '&k=' + (await hmacHex(unsubSecret(env), 'cart:' + uid));
}
// GET /unsubscribe?u=&k= → users/{uid}.cartReminders = false
export async function unsubscribe(env, db, uid, k) {
  if (!uid || !k || !unsubSecret(env)) return false;
  if (k !== await hmacHex(unsubSecret(env), 'cart:' + uid)) return false;
  await db.updateDoc('users', uid, { cartReminders: false, cartRemindersOffAt: new Date() });
  return true;
}

// ── Carrello abbandonato ──────────────────────────────────────────
export function cartNeedsReminder(cart, user, now) {
  const items = Array.isArray(cart && cart.items) ? cart.items.filter((i) => i && i.id) : [];
  const upd = tsMs(cart && cart.updatedAt);
  if (!items.length || !upd) return false;
  const age = now - upd;
  if (age < CART_MIN_H * H || age > CART_MAX_H * H) return false;
  if (!user || !user.email || user.cartReminders === false) return false;
  if (tsMs(user.lastOrderAt) > upd) return false;                  // ha ordinato dopo
  const last = tsMs(user.cartReminderAt);
  if (last && (last > upd || now - last < CART_GAP_DAYS * 24 * H)) return false; // già avvisato
  return true;
}

function cartEmailHtml(items, unsubUrl) {
  const rows = items.slice(0, 6).map((i) => `<tr>
      <td width="64" style="padding:8px 0;">${i.img ? `<img src="${escHtml(i.img)}" width="56" height="56" alt="" style="border-radius:8px;object-fit:cover;display:block;">` : ''}</td>
      <td style="padding:8px 12px;font-size:14px;color:#23231f;"><b>${escHtml(i.name || 'Prodotto')}</b>${i.size ? `<br><span style="font-size:12px;color:#8a8a80;">Taglia ${escHtml(i.size)}</span>` : ''}</td>
      <td style="padding:8px 0;font-size:14px;color:#23231f;text-align:right;white-space:nowrap;">${i.price ? money(i.price * (i.qty || 1)) : ''}</td>
    </tr>`).join('');
  const more = items.length > 6 ? `<p style="margin:8px 0 0;font-size:12px;color:#8a8a80;">+ altri ${items.length - 6} articoli</p>` : '';
  const inner = `
    <tr><td style="padding:32px 32px 6px;text-align:center;">
      <h1 style="font-size:24px;color:#23231f;margin:0 0 8px;">Hai lasciato qualcosa nel carrello</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">I tuoi articoli ti aspettano. Le taglie vanno via in fretta: completa l'ordine finché ci sono.</p>
    </td></tr>
    <tr><td style="padding:20px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${more}</td></tr>
    <tr><td style="padding:26px 32px 8px;text-align:center;">
      <a href="${SITE}?go=cart" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 34px;border-radius:999px;">Torna al carrello →</a>
      <p style="margin:12px 0 0;font-size:12px;color:#8a8a80;">Accedi con lo stesso account: il carrello è salvato su tutti i tuoi dispositivi.</p>
    </td></tr>
    <tr><td style="padding:18px 32px 26px;text-align:center;">
      <a href="${escHtml(unsubUrl)}" style="font-size:11px;color:#b3ad9f;">Non voglio più ricevere promemoria sul carrello</a>
    </td></tr>`;
  return emailShell(inner, 'I tuoi articoli sono ancora nel carrello', 'Il tuo carrello');
}

export async function cartReminders(env, db, { now = Date.now(), base } = {}) {
  const out = { checked: 0, sent: 0, errors: [] };
  const carts = await db.runQuery('carts', { where: [['updatedAt', '<', now - CART_MIN_H * H], ['updatedAt', '>', now - CART_MAX_H * H]], limit: 200 });
  out.checked = carts.length;
  if (!carts.length) return out;
  const users = [];
  for (let i = 0; i < carts.length; i += 100) users.push(...await db.getMany('users', carts.slice(i, i + 100).map((c) => c.id)));
  const byId = new Map(users.filter((u) => u.exists).map((u) => [u.id, u.data() || {}]));
  for (const c of carts) {
    const u = byId.get(c.id);
    if (!cartNeedsReminder(c, u, now)) continue;
    try {
      const items = c.items.filter((i) => i && i.id);
      await sendMail(env, { to: u.email, subject: '🛒 Hai lasciato qualcosa nel carrello', html: cartEmailHtml(items, await unsubscribeUrl(env, c.id, base)) });
      await db.updateDoc('users', c.id, { cartReminderAt: now });
      out.sent++;
    } catch (e) { out.errors.push('carrello ' + c.id + ': ' + e.message); }
  }
  return out;
}

// ── Ordini non pagati ─────────────────────────────────────────────
export function unpaidAction(o, now) {
  if (!o || o.status !== 'pending' || o.paymentStatus === 'paid' || o.payment === 'card') return null;
  const ref = tsMs(o.reactivatedAt) || tsMs(o.createdAt);
  if (!ref) return null;
  const age = now - ref;
  if (age >= UNPAID_EXPIRE_H * H) return 'expire';
  if (age >= UNPAID_REMIND_H * H && !(tsMs(o.payReminderAt) > ref)) return 'remind';
  return null;
}

function payBox(o) {
  const causale = (o.orderId || '') + (o.phone ? ' ' + o.phone : '');
  const row = (k, v) => `<tr><td style="padding:6px 0;font-size:12px;color:#8a8a80;">${k}</td><td style="padding:6px 0;font-size:13px;color:#23231f;font-weight:700;text-align:right;">${escHtml(v)}</td></tr>`;
  if (o.payment === 'paypal') {
    return `<a href="${PAYPAL_ME}/${(Number(o.total) || 0).toFixed(2)}EUR" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 34px;border-radius:999px;">Paga ${money(o.total)} con PayPal →</a>
      <p style="margin:12px 0 0;font-size:12px;color:#8a8a80;">Nella nota del pagamento scrivi il numero ordine <b>${escHtml(o.orderId || '')}</b>.</p>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f3;border:1px solid #e7e2d8;border-radius:12px;padding:6px 18px;">
      ${row('Importo', money(o.total))}${row('Intestatario', BANK.holder)}${row('IBAN', BANK.iban)}${row('BIC/SWIFT', BANK.bic)}${row('Causale', causale)}
    </table>`;
}

function reminderHtml(o) {
  const inner = `
    <tr><td style="padding:32px 32px 6px;text-align:center;">
      <div style="display:inline-block;background:#fff4e0;color:#a0660a;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;padding:7px 16px;border-radius:999px;">⏳ In attesa di pagamento</div>
      <h1 style="font-size:24px;color:#23231f;margin:18px 0 6px;">Il tuo ordine ti aspetta</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">L'ordine <b style="color:#23231f;">${escHtml(o.orderId || '')}</b> è prenotato ma non abbiamo ancora ricevuto il pagamento. Hai ancora <b>24 ore</b>: poi l'ordine si annulla da solo.</p>
    </td></tr>
    <tr><td style="padding:22px 32px 6px;text-align:center;">${payBox(o)}</td></tr>
    <tr><td style="padding:16px 32px 28px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#8a8a80;line-height:1.6;">Hai già pagato? Perfetto, non devi fare nulla: lo verifichiamo noi. Per qualsiasi dubbio rispondi a questa email.</p>
    </td></tr>`;
  return emailShell(inner, 'Completa il pagamento entro 24 ore', 'Pagamento in attesa');
}

function expiredHtml(o) {
  const inner = `
    <tr><td style="padding:32px 32px 6px;text-align:center;">
      <h1 style="font-size:24px;color:#23231f;margin:0 0 8px;">Ordine annullato</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">Non abbiamo ricevuto il pagamento dell'ordine <b style="color:#23231f;">${escHtml(o.orderId || '')}</b> entro 48 ore, quindi l'abbiamo annullato.</p>
    </td></tr>
    <tr><td style="padding:22px 32px 28px;text-align:center;">
      <p style="margin:0 0 18px;font-size:13px;color:#6b6b63;line-height:1.6;"><b>Hai già pagato?</b> Rispondi a questa email con la ricevuta e lo riattiviamo subito.</p>
      <a href="${SITE}?go=shop" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 34px;border-radius:999px;">Torna allo shop →</a>
    </td></tr>`;
  return emailShell(inner, 'Il tuo ordine è stato annullato per mancato pagamento', 'Ordine annullato');
}

export async function unpaidOrders(env, db, { now = Date.now() } = {}) {
  const out = { checked: 0, reminded: 0, expired: [], errors: [] };
  const rows = await db.runQuery('orders', { where: [['status', '==', 'pending']], limit: 300 });
  out.checked = rows.length;
  for (const o of rows) {
    const act = unpaidAction(o, now);
    if (!act) continue;
    try {
      if (act === 'remind') {
        await db.updateDoc('orders', o.id, { payReminderAt: new Date(now) });
        if (o.email) await sendMail(env, { to: o.email, subject: `⏳ Ordine ${o.orderId || ''}: completa il pagamento`, html: reminderHtml(o), replyTo: NOTIFY_EMAIL });
        out.reminded++;
      } else {
        await db.updateDoc('orders', o.id, { status: 'expired', paymentStatus: 'unpaid', expiredAt: new Date(now), expiredBy: 'auto' });
        // Ordini dimenticati da più di una settimana: annullati senza scrivere al cliente
        const fresh = now - (tsMs(o.reactivatedAt) || tsMs(o.createdAt)) < 7 * 24 * H;
        if (o.email && fresh) await sendMail(env, { to: o.email, subject: `Ordine ${o.orderId || ''} annullato`, html: expiredHtml(o), replyTo: NOTIFY_EMAIL }).catch((e) => out.errors.push('email annullo ' + o.id + ': ' + e.message));
        out.expired.push(o);
      }
    } catch (e) { out.errors.push('ordine ' + o.id + ': ' + e.message); }
  }
  if (out.expired.length) {
    const list = out.expired.map((o) => `<li><b>${escHtml(o.orderId || o.id)}</b> — ${escHtml(o.name || '')} (${escHtml(o.email || '')}) · ${money(o.total)} · ${escHtml(o.payment || '')}</li>`).join('');
    await sendMail(env, {
      to: NOTIFY_EMAIL,
      subject: `⏰ ${out.expired.length} ordini non pagati annullati in automatico`,
      html: `<p>Questi ordini non risultano pagati dopo ${UNPAID_EXPIRE_H} ore e sono stati annullati. Se un pagamento è arrivato, riattivali dall'admin (Ordini → Scaduti → ↩️ Riattiva).</p><ul>${list}</ul>`,
    }).catch((e) => out.errors.push('riepilogo admin: ' + e.message));
  }
  out.expired = out.expired.map((o) => o.orderId || o.id);
  return out;
}

export async function runReminders(env, db, opts = {}) {
  if (!env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY mancante' };
  const r = {};
  try { r.carts = await cartReminders(env, db, opts); } catch (e) { r.carts = { error: e.message }; }
  try { r.unpaid = await unpaidOrders(env, db, opts); } catch (e) { r.unpaid = { error: e.message }; }
  return r;
}
