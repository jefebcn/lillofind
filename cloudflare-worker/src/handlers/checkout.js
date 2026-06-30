// ════════════════════════════════════════════════════════════════
// Handler CHECKOUT — createPaymentIntent + validateOrder.
// Port fedele con verifica prezzi server-side (anti price-manipulation).
// ════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { HttpsError } from '../lib/errors.js';
import { DELETE_FIELD } from '../lib/firestore.js';
import { getProductWeight, getShippingCost } from '../lib/shipping.js';

const NOTIFY_EMAIL = 'yishionvt@gmail.com';

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripeClient(env) {
  // httpClient fetch-based: lo SDK Stripe gira così su Workers
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

async function sendOrderNotification(order, resendKey) {
  if (!resendKey) return;
  try {
    const itemsHtml = (order.items || []).map(i => {
      const box = i.boxOption === 'con_scatola' ? '📦 Con Scatola' : i.boxOption === 'senza_scatola' ? 'Senza Scatola' : '—';
      const sizeBox = [i.size || '—', ['scarpe', 'scarpe_box'].includes(i.category || '') ? box : ''].filter(s => s && s !== '—').join(' / ') || '—';
      return `<tr><td>${escHtml(i.name)}</td><td>${escHtml(i.brand || '—')}</td><td>${escHtml(sizeBox)}</td><td>x${escHtml(i.qty)}</td><td>€${(i.price * i.qty).toFixed(2)}</td></tr>`;
    }).join('');
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'LilloFind Orders <onboarding@resend.dev>',
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

  const statusLabels = {
    confermato: '✅ Ordine confermato', preparazione: '📦 In preparazione',
    spedito: '🚀 Spedito', in_transito: '✈️ In transito',
    in_consegna: '🚚 In consegna', consegnato: '🎉 Consegnato',
  };
  const statusLabel = statusLabels[status] || '📦 Aggiornamento spedizione';
  const from = env.RESEND_FROM || 'LilloFind <onboarding@resend.dev>';
  const trackUrl = 'https://www.dhl.com/it-it/home/tracciabilita.html?tracking-id=' + encodeURIComponent(code);

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `📦 La tua spedizione LilloFind — ${escHtml(statusLabel)}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111;">
<h2 style="color:#111;">${escHtml(statusLabel)}</h2>
<p>Ciao,<br>il tuo ordine LilloFind è stato aggiornato.</p>
${product ? `<p><b>Prodotto:</b> ${escHtml(product)}</p>` : ''}
<p style="font-size:15px;"><b>Codice tracking:</b><br>
<span style="font-size:20px;letter-spacing:1px;background:#f4f4f4;padding:8px 14px;display:inline-block;margin-top:6px;border-radius:4px;">${escHtml(code)}</span></p>
${note ? `<p><b>Note:</b> ${escHtml(note)}</p>` : ''}
<p style="margin:24px 0;">
<a href="${escHtml(trackUrl)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:4px;display:inline-block;">Traccia il pacco →</a></p>
<p style="font-size:12px;color:#888;">Puoi seguire la spedizione anche dalla sezione "Traccia Pacco" del tuo profilo su LilloFind.</p>
</div>`,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new HttpsError('internal', 'Invio email fallito: ' + (t || resp.status));
  }
  return { sent: true };
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
      price: prod.price || 0,
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
    return {
      id: snap.id, name: prod.name || '', price: prod.price || 0, brand: prod.brand || '',
      category: prod.category || '', weightKg: prod.weightKg || prod.weight_kg || 0,
      boxOption: prodItems[idx].boxOption || '', qty, size: prodItems[idx].size || '',
      color: prodItems[idx].color || '', img: prod.imageUrl || '', isDigital: prod.isDigital || false,
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
  sendOrderNotification({ ...orderData, orderId, subtotal, shipping, discount: discountAmount, total }, env.RESEND_API_KEY);

  return { orderId, subtotal, shipping, discount: discountAmount, total, lfpoints: paymentVerified ? lfpoints : 0, paymentMethod };
}
