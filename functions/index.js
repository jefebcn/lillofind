/**
 * LilloFind — Cloud Functions
 * Region: europe-west1 (Belgio)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const db = admin.firestore();

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
exports.validateOrder = onCall(async (request) => {
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
  const shipping = allDigital ? 0 : (subtotal >= 80 ? 0 : 6.90);
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
