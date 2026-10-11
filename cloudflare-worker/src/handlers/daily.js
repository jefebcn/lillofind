// ════════════════════════════════════════════════════════════════
// Lavori automatici del Worker (cron, vedi index.js e wrangler.toml):
//   · scansione foto rotte — ogni 15 minuti controlla un gruppo di prodotti
//     con foto Yupoo; quelle eliminate dal fornitore vengono nascoste dallo
//     shop. Un giro completo del catalogo richiede ~2 giorni, poi riparte
//     dopo una settimana. A fine giro: email all'admin con l'elenco.
//   · abbonamenti in scadenza — email al cliente 7 giorni e 1 giorno prima.
//   · riepilogo del mattino all'admin — ordini da confermare, da ordinare
//     all'agente, non pagati, pacchi fermi, incasso di ieri, abbonamenti
//     in scadenza, foto rotte trovate.
// ════════════════════════════════════════════════════════════════
import { escHtml, emailShell, NOTIFY_EMAIL } from './checkout.js';

const H = 3600 * 1000, DAY = 24 * H;
const SITE = 'https://lillofind.shop/';
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

// ── 5. Foto rotte ─────────────────────────────────────────────────
// Yupoo non dà errore per una foto eliminata: serve un PNG segnaposto da
// 17.670 byte (o l'header x-errno). Stessa regola di /proxyImage.
export const YUPOO_PLACEHOLDER_BYTES = 17670;
export const isYupoo = (u) => /(^|\.)yupoo\.com\/|(^|\.)yunjifen\.com\//i.test(String(u || '').replace(/^https?:\/\//, ''));
export async function checkYupooImage(url) {
  try {
    const host = new URL(url).hostname;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://' + host + '/', Accept: 'image/*' }, signal: AbortSignal.timeout(12000) });
    if (r.status === 404 || r.status === 410) return 'gone';
    if (!r.ok) return 'error';
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    const buf = await r.arrayBuffer();
    if (r.headers.get('x-errno') || (ct === 'image/png' && buf.byteLength === YUPOO_PLACEHOLDER_BYTES)) return 'gone';
    return 'ok';
  } catch (_) { return 'error'; }
}

const SCAN_KEY = 'scan:photos', SCAN_LIST = 'scan:list';
export const SCAN_BATCH = 40, SCAN_EVERY_DAYS = 7;

export async function photoScanStep(env, db, { now = Date.now(), batch = SCAN_BATCH, check = checkYupooImage } = {}) {
  const kv = env.CATALOG;
  if (!kv) return { skipped: 'kv' };
  let st = {};
  try { st = JSON.parse((await kv.get(SCAN_KEY)) || '{}') || {}; } catch (_) {}
  if (!st.running) {
    if (st.doneAt && now - st.doneAt < SCAN_EVERY_DAYS * DAY) return { skipped: 'attesa' };
    // Nuovo giro: elenco compatto dal catalogo pubblicato (zero letture Firestore)
    const body = await kv.get('catalog');
    if (!body) return { skipped: 'catalogo' };
    const cat = JSON.parse(body);
    const list = (cat.products || []).filter((p) => p && p.id && p.hidden !== true && isYupoo(p.imageUrl)).map((p) => [p.id, p.imageUrl, String(p.name || '').slice(0, 80)]);
    await kv.put(SCAN_LIST, JSON.stringify(list));
    st = { running: true, i: 0, total: list.length, broken: [], startedAt: now };
  }
  const list = JSON.parse((await kv.get(SCAN_LIST)) || '[]');
  const slice = list.slice(st.i, st.i + batch);
  const found = [];
  let k = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (k < slice.length) {
      const it = slice[k++];
      if ((await check(it[1])) === 'gone') found.push(it);
    }
  }));
  for (const [id, , name] of found) {
    try {
      // commitUpdates: aggiorna solo se il prodotto esiste ancora
      await db.commitUpdates([{ collection: 'products', id, fields: { hidden: true, hiddenReason: 'yupoo_removed', hiddenAt: new Date(now), hiddenBy: 'auto' } }]);
      st.broken.push([id, name]);
    } catch (_) { /* prodotto eliminato nel frattempo */ }
  }
  st.i += slice.length;
  const out = { checked: slice.length, hidden: found.length, progress: st.i + '/' + st.total };
  if (st.i >= st.total) {
    st.running = false; st.doneAt = now;
    if (st.broken.length) {
      // Nasconde subito anche nel catalogo pubblicato (lo shop non le mostra più)
      try {
        const body = await kv.get('catalog');
        if (body) {
          const ids = new Set(st.broken.map((b) => b[0]));
          const cat = JSON.parse(body);
          cat.products.forEach((p) => { if (ids.has(p.id)) p.hidden = true; });
          await kv.put('catalog', JSON.stringify(cat));
          try { await caches.default.delete(new Request((env.WORKER_PUBLIC_BASE || 'https://lillofind.conti9708.workers.dev') + '/catalog?__cache=1')); } catch (_) {}
        }
      } catch (e) { out.error = 'snapshot: ' + e.message; }
      if (env.RESEND_API_KEY) {
        const li = st.broken.slice(0, 200).map((b) => `<li>${escHtml(b[1] || b[0])}</li>`).join('');
        await sendMail(env, {
          to: NOTIFY_EMAIL,
          subject: `🧹 Foto rotte: ${st.broken.length} prodotti nascosti dallo shop`,
          html: `<p>Il controllo settimanale ha trovato ${st.broken.length} prodotti con la foto eliminata da Yupoo e li ha <b>nascosti</b> dallo shop (non eliminati).</p><p>Per rimetterli visibili: Admin → Prodotti → strumento foto rotte → ↩︎ Ripristina nascosti.</p><ul>${li}</ul>`,
        }).catch((e) => { out.error = 'email: ' + e.message; });
      }
    }
    await kv.put('scan:last', JSON.stringify({ doneAt: now, total: st.total, broken: st.broken.length }));
    out.done = true;
  }
  await kv.put(SCAN_KEY, JSON.stringify(st));
  return out;
}

// ── 4. Abbonamenti in scadenza ────────────────────────────────────
// Stessa regola del pannello admin (subDaysInfo): fine = inizio + N mesi.
export function subEnd(startISO, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startISO || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const n = parseInt(months, 10) || 1;
  const ty = y + Math.floor((mo + n) / 12), tm = (mo + n) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return Date.UTC(ty, tm, Math.min(d, last)) - 2 * H; // mezzanotte italiana (circa)
}
export function subStage(c, now) {
  const end = subEnd(c && c.startISO, c && c.months);
  if (!end) return null;
  const rem = Math.ceil((end - now) / DAY);
  if (rem >= 2 && rem <= 7) return { stage: 'd7', rem, end };
  if (rem >= 0 && rem <= 1) return { stage: 'd1', rem, end };
  return { stage: null, rem, end };
}
async function keyOf(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const fmtDate = (ms) => new Date(ms + 2 * H).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function subEmailHtml(service, rem, end) {
  const when = rem <= 0 ? 'oggi' : rem === 1 ? 'domani' : 'tra ' + rem + ' giorni';
  const inner = `
    <tr><td style="padding:32px 32px 6px;text-align:center;">
      <div style="display:inline-block;background:#fff4e0;color:#a0660a;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;padding:7px 16px;border-radius:999px;">⏳ In scadenza</div>
      <h1 style="font-size:24px;color:#23231f;margin:18px 0 6px;">Il tuo ${escHtml(service)} scade ${when}</h1>
      <p style="font-size:14px;color:#6b6b63;line-height:1.6;margin:0;">L'abbonamento termina il <b style="color:#23231f;">${escHtml(fmtDate(end))}</b>. Rinnovalo ora per non restare senza.</p>
    </td></tr>
    <tr><td style="padding:24px 32px 28px;text-align:center;">
      <a href="${SITE}?q=${encodeURIComponent(service)}" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 34px;border-radius:999px;">Rinnova ${escHtml(service)} →</a>
      <p style="margin:14px 0 0;font-size:12px;color:#8a8a80;">Per qualsiasi dubbio rispondi a questa email.</p>
    </td></tr>`;
  return emailShell(inner, `Il tuo ${service} scade ${when}`, 'Il tuo abbonamento');
}

export async function collectSubscriptions(db) {
  const rows = [];
  const warn = (what) => (e) => { console.warn('abbonamenti ' + what + ':', e && e.message); return []; };
  const orders = await db.runQuery('orders', { orderBy: [['credentials', 'asc']], limit: 1000 }).catch(warn('ordini'));
  orders.forEach((o) => (Array.isArray(o.credentials) ? o.credentials : []).forEach((c) => {
    if (c && (c.login || c.password || c.link) && o.email && o.status !== 'cancelled' && o.status !== 'expired') rows.push({ src: 'order', id: o.id, email: o.email, name: o.name || '', c });
  }));
  const users = await db.runQuery('users', { orderBy: [['subscriptions', 'asc']], limit: 1000 }).catch(warn('utenti'));
  users.forEach((u) => (Array.isArray(u.subscriptions) ? u.subscriptions : []).forEach((c) => {
    if (c && (c.login || c.password || c.link) && u.email) rows.push({ src: 'user', id: u.id, email: u.email, name: u.name || u.displayName || '', c });
  }));
  return rows;
}

export async function subscriptionReminders(env, db, { now = Date.now(), rows } = {}) {
  const out = { checked: 0, sent: 0, expiring: [], errors: [] };
  rows = rows || await collectSubscriptions(db);
  out.checked = rows.length;
  const due = [];
  for (const r of rows) {
    const s = subStage(r.c, now);
    if (!s) continue;
    if (s.rem >= 0 && s.rem <= 7) out.expiring.push({ service: r.c.service || 'Abbonamento', email: r.email, name: r.name, rem: s.rem });
    if (s.stage) due.push({ r, s, key: await keyOf([r.src, r.id, r.c.service || '', r.c.startISO, r.c.months || 1].join('|')) });
  }
  if (!due.length) return out;
  const marks = await db.getMany('sub_reminders', due.map((d) => d.key));
  const done = new Map(marks.filter((m) => m.exists).map((m) => [m.id, m.data() || {}]));
  for (const d of due) {
    const m = done.get(d.key) || {};
    if (m[d.s.stage]) continue;
    try {
      const service = d.r.c.service || 'abbonamento';
      await sendMail(env, { to: d.r.email, subject: `⏳ Il tuo ${service} scade ${d.s.rem <= 0 ? 'oggi' : d.s.rem === 1 ? 'domani' : 'tra ' + d.s.rem + ' giorni'}`, html: subEmailHtml(service, d.s.rem, d.s.end), replyTo: NOTIFY_EMAIL });
      await db.updateDoc('sub_reminders', d.key, { [d.s.stage]: new Date(now), email: d.r.email, service });
      out.sent++;
    } catch (e) { out.errors.push(d.r.email + ': ' + e.message); }
  }
  return out;
}

// ── 6. Riepilogo del mattino per l'admin ──────────────────────────
const isPhysical = (o) => (o.items || []).some((i) => !i.isDigital);
const isPaidOrder = (o) => o.status !== 'cancelled' && o.status !== 'expired' && (o.status === 'confirmed' || o.paymentStatus === 'paid');

export function digestData({ pending = [], confirmed = [], recent = [], users = [], subs = [], scan = null }, now) {
  const yStart = (() => { const d = new Date(now + 2 * H); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 2 * H - DAY; })();
  const yEnd = yStart + DAY;
  const yesterday = recent.filter((o) => { const t = tsMs(o.createdAt); return t >= yStart && t < yEnd && isPaidOrder(o); });
  return {
    toConfirm: pending.filter((o) => o.paymentStatus === 'paid'),
    unpaid: pending.filter((o) => o.paymentStatus !== 'paid' && o.payment !== 'card'),
    toOrder: confirmed.filter((o) => !o.supplierOrdered && isPhysical(o)),
    stuck: users.filter((u) => u.trackingCode && u.trackingStatus !== 'consegnato' && now - (tsMs(u.trackingUpdatedAt) || tsMs(u.trackingCheckedAt) || now) > 10 * DAY),
    yesterday: { n: yesterday.length, gross: yesterday.reduce((s, o) => s + (Number(o.total) || 0), 0), fees: yesterday.reduce((s, o) => s + (Number(o.paymentFee) || 0), 0) },
    subs: subs.filter((s) => s.rem >= 0 && s.rem <= 7).sort((a, b) => a.rem - b.rem),
    scan,
  };
}

function digestHtml(d) {
  const sec = (title, n, body) => `<tr><td style="padding:16px 28px 0;"><p style="margin:0 0 6px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#8a8a80;font-weight:700;">${title} · <span style="color:${n ? '#23231f' : '#b3ad9f'};">${n}</span></p>${n ? body : '<p style="margin:0;font-size:13px;color:#b3ad9f;">Niente da fare.</p>'}</td></tr>`;
  const ul = (arr) => `<ul style="margin:0;padding-left:18px;font-size:13px;color:#23231f;line-height:1.7;">${arr.slice(0, 15).join('')}${arr.length > 15 ? `<li>… e altri ${arr.length - 15}</li>` : ''}</ul>`;
  const ord = (o) => `<li><b>${escHtml(o.orderId || o.id)}</b> — ${escHtml(o.name || o.email || '')} · ${money(o.total)}</li>`;
  const inner = `
    <tr><td style="padding:28px 28px 4px;">
      <h1 style="font-size:22px;color:#23231f;margin:0 0 4px;">Buongiorno ☀️</h1>
      <p style="font-size:14px;color:#6b6b63;margin:0;">Ieri: <b style="color:#23231f;">${d.yesterday.n} ordini pagati · ${money(d.yesterday.gross)} lordi</b>${d.yesterday.fees ? ` (commissioni PayPal ${money(d.yesterday.fees)})` : ''}. Il netto con i costi è nella dashboard.</p>
    </td></tr>
    ${sec('✅ Pagati da confermare', d.toConfirm.length, ul(d.toConfirm.map(ord)))}
    ${sec('🛒 Da ordinare all\'agente', d.toOrder.length, ul(d.toOrder.map(ord)))}
    ${sec('⏳ In attesa di pagamento', d.unpaid.length, ul(d.unpaid.map(ord)))}
    ${sec('📦 Pacchi fermi da oltre 10 giorni', d.stuck.length, ul(d.stuck.map((u) => `<li>${escHtml(u.email || u.id)} — <b>${escHtml(u.trackingCode)}</b> (${escHtml(u.trackingStatus || '—')})</li>`)))}
    ${sec('🔑 Abbonamenti in scadenza (7 giorni)', d.subs.length, ul(d.subs.map((s) => `<li>${escHtml(s.service)} — ${escHtml(s.email)} · ${s.rem <= 0 ? 'oggi' : s.rem === 1 ? 'domani' : 'tra ' + s.rem + ' giorni'}</li>`)) + '<p style="margin:6px 0 0;font-size:12px;color:#8a8a80;">Il promemoria al cliente parte da solo.</p>')}
    ${d.scan && d.scan.recent ? `<tr><td style="padding:16px 28px 0;font-size:13px;color:#6b6b63;">🧹 Controllo foto: ${d.scan.broken} prodotti con foto rotta nascosti nell'ultimo giro (${d.scan.total} controllati).</td></tr>` : ''}
    <tr><td style="padding:22px 28px 28px;text-align:center;">
      <a href="${SITE}admin.html" style="display:inline-block;background:#6f7552;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:13px 30px;border-radius:999px;">Apri l'admin →</a>
    </td></tr>`;
  return emailShell(inner, `Ieri ${d.yesterday.n} ordini · ${d.toOrder.length} da ordinare · ${d.toConfirm.length} da confermare`, 'Riepilogo del mattino');
}

export async function morningDigest(env, db, { now = Date.now(), subs = [] } = {}) {
  const q = (c, o) => db.runQuery(c, o).catch((e) => { console.warn('riepilogo ' + c + ':', e && e.message); return []; });
  const [pending, confirmed, recent, users] = await Promise.all([
    q('orders', { where: [['status', '==', 'pending']], limit: 300 }),
    q('orders', { where: [['status', '==', 'confirmed']], limit: 1000 }),
    q('orders', { where: [['createdAt', '>', new Date(now - 3 * DAY)]], limit: 500 }),
    q('users', { where: [['trackingCode', '>', '']], limit: 500 }),
  ]);
  let scan = null;
  try { scan = JSON.parse((await env.CATALOG.get('scan:last')) || 'null'); } catch (_) {}
  if (scan) scan.recent = now - scan.doneAt < DAY;
  const d = digestData({ pending, confirmed, recent, users, subs, scan }, now);
  await sendMail(env, { to: NOTIFY_EMAIL, subject: `☀️ LilloFind oggi: ${d.toOrder.length} da ordinare · ${d.toConfirm.length} da confermare · ieri ${money(d.yesterday.gross)}`, html: digestHtml(d) });
  return { toConfirm: d.toConfirm.length, toOrder: d.toOrder.length, unpaid: d.unpaid.length, stuck: d.stuck.length, subs: d.subs.length, yesterday: d.yesterday };
}

export async function runMorning(env, db, opts = {}) {
  if (!env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY mancante' };
  const r = {};
  let subs = [];
  try { r.subs = await subscriptionReminders(env, db, opts); subs = r.subs.expiring; } catch (e) { r.subs = { error: e.message }; }
  try { r.digest = await morningDigest(env, db, { ...opts, subs }); } catch (e) { r.digest = { error: e.message }; }
  return r;
}
