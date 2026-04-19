/**
 * LilloFind — Cloud Functions
 * Region: europe-west1 (Belgio)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');

// ══════════════════════════════════════════════════════════════════
// yupooFetch
// Proxy server-side per Yupoo — bypassa CORS.
// Solo admin. Accetta URL *.x.yupoo.com e restituisce l'HTML.
//
// Input:  { url: string }  — es. "https://woodtableguy888.x.yupoo.com/categories/4633144?page=1"
// Output: { html: string, status: number }
// ══════════════════════════════════════════════════════════════════
exports.yupooFetch = onCall({ timeoutSeconds: 30 }, async (request) => {
  // 1 — Autenticazione + check admin
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login richiesto.');
  }
  const userSnap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userSnap.data()?.isAdmin !== true) {
    throw new HttpsError('permission-denied', 'Solo gli admin possono usare questo endpoint.');
  }

  const { url } = request.data;
  if (!url || typeof url !== 'string') {
    throw new HttpsError('invalid-argument', 'Parametro url mancante.');
  }

  // 2 — Valida: solo domini *.yupoo.com
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) {
    throw new HttpsError('invalid-argument', 'URL non valido.');
  }
  if (!parsedUrl.hostname.endsWith('.yupoo.com')) {
    throw new HttpsError('invalid-argument', 'Solo URL *.yupoo.com sono permessi.');
  }

  // 3 — Fetch server-side (Node 20 native fetch — nessun CORS)
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': `https://${parsedUrl.hostname}/`,
      },
      redirect: 'follow',
    });
    const html = await resp.text();

    // Estrai cover URL per album ID via regex (server-side — ha il Referer corretto)
    const albumCovers = {};

    // Pattern A: href="/albums/ID" seguito da <img data-src/src="//...photo/img...">
    const anchorImgRe =
      /href=["']\/albums\/(\w+)["'][^]*?<img[^>]+(?:data-src|data-original|data-lazy|src)=["'](\/\/[^"'>\s]+)["']/gs;
    let m;
    while ((m = anchorImgRe.exec(html)) !== null) {
      const u = m[2];
      if (!albumCovers[m[1]] && (u.includes('photo.yupoo') || u.includes('img.yupoo') || u.includes('.jpg') || u.includes('.png') || u.includes('.webp'))) {
        albumCovers[m[1]] = u.startsWith('//') ? 'https:' + u : u;
      }
    }

    // Pattern B: fallback — abbina tutti gli URL photo.yupoo.com per posizione agli album ID
    if (!Object.keys(albumCovers).length) {
      const allPhotoUrls = [];
      const photoRe = /["'](\/\/(?:photo|img)\.yupoo\.com\/[^"'?\s]{20,})["']/g;
      let pm;
      while ((pm = photoRe.exec(html)) !== null) allPhotoUrls.push('https:' + pm[1]);
      const albumIdRe = /\/albums\/(\w+)/g;
      let ai; const albumIds = [];
      while ((ai = albumIdRe.exec(html)) !== null) {
        if (!albumIds.includes(ai[1])) albumIds.push(ai[1]);
      }
      albumIds.forEach((id, i) => { if (allPhotoUrls[i]) albumCovers[id] = allPhotoUrls[i]; });
    }

    return { html, status: resp.status, albumCovers };
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch fallito: ' + e.message);
  }
});

const db = admin.firestore();

// ── Logica peso e fasce spedizione ─────────────────────────────────
const CATEGORY_WEIGHTS_SV = {
  tshirt:0.35, tshirt_branded:0.40, felpa:0.80,
  scarpe:2.00, scarpe_box:2.50, pantaloni:0.80,
  shorts:0.50, cappello:0.30, giacchetto:1.20,
  borsa:1.50, accessori:0.20,
};
const SHIPPING_TIERS_SV = [
  {maxKg:1,   price:12},
  {maxKg:3,   price:18},
  {maxKg:6,   price:25},
  {maxKg:10,  price:35},
  {maxKg:9999,price:50},
];
function getProductWeightSv(prod){
  if(prod.weightKg && prod.weightKg > 0) return prod.weightKg;
  if(prod.weight_kg && prod.weight_kg > 0) return prod.weight_kg;
  return CATEGORY_WEIGHTS_SV[prod.category] ?? 0.5;
}
function getShippingCostSv(totalWeightKg){
  const tier = SHIPPING_TIERS_SV.find(t => totalWeightKg <= t.maxKg);
  return tier ? tier.price : 50;
}

// ══════════════════════════════════════════════════════════════════
// createPaymentIntent
// Crea un Stripe PaymentIntent con il totale verificato server-side.
// Il client usa il clientSecret per confermare il pagamento via Stripe.js.
// ══════════════════════════════════════════════════════════════════
exports.createPaymentIntent = onCall({ secrets: [STRIPE_SECRET_KEY], cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login richiesto.');
  }
  const { items } = request.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError('invalid-argument', 'Carrello vuoto.');
  }

  // Valida prima di fetchare
  for (const item of items) {
    if (!item.id || typeof item.id !== 'string') {
      throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    }
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) {
      throw new HttpsError('invalid-argument', `Quantità non valida: ${item.id}`);
    }
  }

  // Leggi prezzi reali da Firestore
  let productDocs;
  try {
    productDocs = await Promise.all(items.map(item => db.collection('products').doc(item.id).get()));
  } catch (e) {
    console.error('Firestore error in createPaymentIntent:', e);
    throw new HttpsError('internal', 'Errore lettura prodotti.');
  }

  const verifiedItems = productDocs.map((snap, idx) => {
    if (!snap.exists) throw new HttpsError('not-found', `Prodotto non trovato: ${items[idx].id}`);
    const prod = snap.data();
    return {
      price: prod.price || 0,
      category: prod.category || '',
      weightKg: prod.weightKg || prod.weight_kg || 0,
      qty: parseInt(items[idx].qty, 10),
      isDigital: prod.isDigital || false,
    };
  });

  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeightSv(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCostSv(totalWeight);

  // Leggi eventuale reward attivo
  let discountAmount = 0;
  try {
    const userSnap = await db.collection('users').doc(request.auth.uid).get();
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

  if (amountCents < 50) {
    throw new HttpsError('invalid-argument', 'Importo minimo €0.50 non raggiunto.');
  }

  // Crea PaymentIntent Stripe
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY.value());
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { uid: request.auth.uid, subtotal: String(subtotal), shipping: String(shipping) },
    });
    return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  } catch (e) {
    console.error('Stripe createPaymentIntent error:', e.message);
    throw new HttpsError('internal', 'Errore Stripe: ' + e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// validateOrder
// Valida i prezzi del carrello server-side, crea l'ordine e
// restituisce il totale verificato. Impedisce la price manipulation.
//
// Input:
//   items          [{id, qty, size, color}]  — solo id+qtà, NO prezzi
//   paymentMethod  'card'|'paypal'|'bonifico'
//   shippingAddress {street, city, zip, country}
//   name           string
//   phone          string
//   notes          string
//
// Output:
//   { orderId, subtotal, shipping, discount, total }
// ══════════════════════════════════════════════════════════════════
exports.validateOrder = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  // 1 — Autenticazione obbligatoria
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Devi essere autenticato per completare un ordine.');
  }

  const uid = request.auth.uid;
  const { items, paymentMethod, shippingAddress, name, phone, notes } = request.data;

  // 2 — Validazione input base
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError('invalid-argument', 'Il carrello è vuoto.');
  }
  if (items.length > 100) {
    throw new HttpsError('invalid-argument', 'Troppi articoli nel carrello.');
  }

  // 3 — Leggi i prezzi REALI da Firestore (server-side, non dal client)
  const productFetches = items.map(item => {
    if (!item.id || typeof item.id !== 'string') {
      throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    }
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) {
      throw new HttpsError('invalid-argument', `Quantità non valida per il prodotto ${item.id}.`);
    }
    return db.collection('products').doc(item.id).get();
  });

  let productDocs;
  try {
    productDocs = await Promise.all(productFetches);
  } catch (e) {
    console.error('Errore lettura prodotti:', e);
    throw new HttpsError('internal', 'Errore nel caricamento dei prodotti.');
  }

  // 4 — Costruisci gli item verificati con prezzi da Firestore
  const verifiedItems = productDocs.map((snap, idx) => {
    if (!snap.exists) {
      throw new HttpsError('not-found', `Prodotto non trovato: ${items[idx].id}`);
    }
    const prod = snap.data();
    const qty = parseInt(items[idx].qty, 10);
    return {
      id: snap.id,
      name: prod.name || '',
      price: prod.price || 0,        // prezzo REALE da Firestore
      brand: prod.brand || '',
      category: prod.category || '',
      weightKg: prod.weightKg || prod.weight_kg || 0,
      qty,
      size: items[idx].size || '',
      color: items[idx].color || '',
      img: prod.imageUrl || '',
      isDigital: prod.isDigital || false,
    };
  });

  // 5 — Calcola totali (stessa logica di index.html ma server-side)
  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeightSv(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCostSv(totalWeight);
  const lfpoints = Math.floor(subtotal);

  // 6 — Leggi eventuale activeReward dell'utente da Firestore
  let discountAmount = 0;
  let activeReward = null;
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const udata = userSnap.data();
      activeReward = udata.activeReward || null;
      if (activeReward) {
        if (activeReward.type === 'fisso') {
          discountAmount = Math.min(activeReward.val, subtotal);
        } else if (activeReward.type === 'percentuale') {
          discountAmount = subtotal * (activeReward.val / 100);
        }
        // Se il reward include spedizione gratuita
        if (activeReward.freeShipping) {
          discountAmount += shipping;
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
      }
    }
  } catch (e) {
    console.error('Errore lettura utente:', e);
    // Non bloccare l'ordine per un errore reward — procedi senza sconto
  }

  const total = Math.max(0, Math.round((subtotal + shipping - discountAmount) * 100) / 100);

  // 6b — Per pagamenti con carta, verifica PaymentIntent Stripe server-side
  if (paymentMethod === 'card') {
    const { stripePaymentIntentId } = request.data;
    if (!stripePaymentIntentId) {
      throw new HttpsError('invalid-argument', 'Pagamento con carta non completato correttamente.');
    }
    const stripe = require('stripe')(STRIPE_SECRET_KEY.value());
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    } catch (e) {
      throw new HttpsError('invalid-argument', 'PaymentIntent non valido.');
    }
    if (pi.status !== 'succeeded') {
      throw new HttpsError('failed-precondition', 'Il pagamento non è stato completato.');
    }
    if (pi.metadata?.uid !== uid) {
      throw new HttpsError('permission-denied', 'PaymentIntent non appartiene a questo utente.');
    }
    // Verifica che l'importo corrisponda (tolleranza 1 cent per arrotondamenti)
    if (Math.abs(pi.amount - Math.round(total * 100)) > 1) {
      throw new HttpsError('failed-precondition', 'Importo del pagamento non corrisponde al totale ordine.');
    }
  }

  // 7 — Genera orderId
  const orderId = 'LILLO-' + Date.now().toString(36).toUpperCase().slice(-6);

  // 8 — Salva l'ordine in Firestore (lato server — sicuro)
  const orderData = {
    orderId,
    uid,
    email: request.auth.token.email || '',
    name: String(name || '').slice(0, 120),
    phone: String(phone || '').slice(0, 30),
    address: {
      street: String(shippingAddress?.street || '').slice(0, 200),
      city:   String(shippingAddress?.city   || '').slice(0, 100),
      zip:    String(shippingAddress?.zip    || '').slice(0, 20),
      country:String(shippingAddress?.country|| 'Italia').slice(0, 60),
    },
    notes: String(notes || '').slice(0, 500),
    items: verifiedItems,
    subtotal,
    shipping,
    discount: discountAmount,
    total,
    payment: ['card','paypal','bonifico'].includes(paymentMethod) ? paymentMethod : 'card',
    lfpoints,
    isDigitalOrder: allDigital,
    deliveryType: allDigital ? 'digital' : 'physical',
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection('orders').add(orderData);
  } catch (e) {
    console.error('Errore salvataggio ordine:', e);
    throw new HttpsError('internal', 'Errore nel salvataggio dell\'ordine. Riprova.');
  }

  // 9 — Aggiorna utente: credita LFPOINTS, aggiorna totalSpent, rimuovi reward usato
  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap2 = await userRef.get();
    const currentData = userSnap2.exists ? userSnap2.data() : {};
    const newLfpoints = (currentData.lfpoints || 0) + lfpoints;
    const newTotalSpent = (currentData.totalSpent || 0) + subtotal;

    const userUpdate = {
      lfpoints: newLfpoints,
      totalSpent: newTotalSpent,
    };
    if (activeReward) {
      userUpdate.activeReward = admin.firestore.FieldValue.delete();
    }
    await userRef.update(userUpdate);
  } catch (e) {
    console.error('Errore aggiornamento utente (non critico):', e);
    // Non bloccare — l'ordine è già stato creato
  }

  // 10 — Ritorna al client i dati verificati
  return { orderId, subtotal, shipping, discount: discountAmount, total, lfpoints };
});
