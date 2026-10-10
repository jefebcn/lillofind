// ════════════════════════════════════════════════════════════════
// Handler ADMIN — port fedele delle Cloud Functions admin.
// L'autorizzazione admin è già garantita dal router (auth:'admin').
// ════════════════════════════════════════════════════════════════

import { HttpsError } from '../lib/errors.js';
import { DELETE_FIELD } from '../lib/firestore.js';
import { PRIVATE_FIELDS, splitPrivate, hasPrivate } from '../lib/product-private.js';

// createdAt (timestamp Firestore → ISO string), come gli originali
function isoCreatedAt(row) {
  return row.createdAt?._ts || null;
}

// ── saveProduct ─────────────────────────────────────────────────
export async function saveProduct(p, { db }) {
  if (!p || !p.name || typeof p.price !== 'number' || p.price <= 0) {
    throw new HttpsError('invalid-argument', 'Dati prodotto non validi.');
  }
  const gender = String(p.gender || 'unisex').toLowerCase();
  if (!['uomo', 'donna', 'unisex'].includes(gender)) {
    throw new HttpsError('invalid-argument', 'gender non valido');
  }
  // Niente HTML nei testi del fornitore (lo shop li mostra escapati, ma
  // meglio non salvarli proprio).
  const txt = (v, n) => String(v || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').slice(0, n);
  const docData = {
    name:        txt(p.name, 200),
    price:       p.price,
    brand:       txt(p.brand, 100),
    model:       txt(p.model, 100),
    style:       txt(p.model, 100),
    category:    String(p.category || '').slice(0, 50),
    gender:      gender,
    sizes:       Array.isArray(p.sizes) ? p.sizes.slice(0, 50) : ['S', 'M', 'L', 'XL'],
    size:        String(p.size || '').slice(0, 200),
    colors:      Array.isArray(p.colors) ? p.colors.slice(0, 20) : [],
    imageUrl:    String(p.imageUrl || '').slice(0, 500),
    description: txt(p.description, 2000),
    weightKg:    typeof p.weightKg === 'number' ? p.weightKg : 0,
    createdAt:   new Date(),
  };
  const id = await db.addDoc('products', docData);
  return { id };
}

// ── batchSetGender ──────────────────────────────────────────────
export async function batchSetGender(data, { db }) {
  const updates = data?.updates;
  if (!Array.isArray(updates) || updates.length === 0) throw new HttpsError('invalid-argument', 'Array updates vuoto.');
  if (updates.length > 6000) throw new HttpsError('invalid-argument', 'Massimo 6000 prodotti per chiamata.');

  const writes = [];
  for (const { id, gender } of updates) {
    if (!id || !['uomo', 'donna', 'unisex'].includes(gender)) continue;
    writes.push({ collection: 'products', id, fields: { gender } });
  }
  const updated = await db.commitUpdates(writes);
  return { updated };
}

// ── getAdminStats ───────────────────────────────────────────────
export async function getAdminStats(_data, { db }) {
  const now = Date.now();
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  const cutoff30d = now - ms30d;
  const d0 = new Date();
  const startOfMonth = new Date(d0.getFullYear(), d0.getMonth(), 1).getTime();

  const [users, orders] = await Promise.all([
    db.listAll('users'),
    db.listAll('orders'),
  ]);

  let totalUsers = 0, newUsers30d = 0;
  const usersWithOrders = new Set();
  const tierCount = { none: 0, bronze: 0, silver: 0, gold: 0, platinum: 0 };
  const topSpenders = [];

  for (const u of users) {
    totalUsers++;
    const createdMs = u.createdAt?.seconds ? u.createdAt.seconds * 1000 : 0;
    if (createdMs && createdMs >= cutoff30d) newUsers30d++;
    const pts = u.lfpoints || 0;
    if      (pts >= 500) tierCount.platinum++;
    else if (pts >= 200) tierCount.gold++;
    else if (pts >= 80)  tierCount.silver++;
    else if (pts >= 20)  tierCount.bronze++;
    else                 tierCount.none++;
    if ((u.totalSpent || 0) > 0) topSpenders.push({ email: u.email || u.id, spent: u.totalSpent || 0, pts, orders: u.orderCount || 0 });
  }
  topSpenders.sort((a, b) => b.spent - a.spent);

  let totalOrders = 0, pendingOrders = 0, confirmedOrders = 0;
  let totalRevenue = 0, monthlyRevenue = 0, totalShipping = 0, itemsSold = 0;
  const productSales = {};

  for (const o of orders) {
    totalOrders++;
    if (o.status === 'pending') pendingOrders++;
    else if (o.status === 'confirmed') confirmedOrders++;
    const rev = o.total || 0;
    totalRevenue += rev;
    totalShipping += o.shipping || 0;
    const createdMs = o.createdAt?.seconds ? o.createdAt.seconds * 1000 : 0;
    if (createdMs && createdMs >= startOfMonth) monthlyRevenue += rev;
    usersWithOrders.add(o.uid || '');
    (o.items || []).forEach(i => {
      const qty = i.qty || 1;
      itemsSold += qty;
      const key = i.name || 'Unknown';
      productSales[key] = (productSales[key] || 0) + qty;
    });
  }

  const topProducts = Object.entries(productSales)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, qty]) => ({ name, qty }));

  return {
    users: { total: totalUsers, new30d: newUsers30d, withOrders: usersWithOrders.size, tiers: tierCount },
    orders: { total: totalOrders, pending: pendingOrders, confirmed: confirmedOrders },
    revenue: { total: Math.round(totalRevenue * 100) / 100, monthly: Math.round(monthlyRevenue * 100) / 100, shipping: Math.round(totalShipping * 100) / 100 },
    itemsSold,
    topProducts,
    topSpenders: topSpenders.slice(0, 5),
  };
}

// ── getAdminOrders ──────────────────────────────────────────────
export async function getAdminOrders(_data, { db }) {
  const orders = await db.listAll('orders');
  orders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return orders.map(o => ({ ...o, _docId: o.id, createdAt: isoCreatedAt(o) }));
}

// ── getAdminProducts ────────────────────────────────────────────
export async function getAdminProducts(_data, { db }) {
  const [products, priv] = await Promise.all([db.listAll('products'), db.listAll('products_private').catch(() => [])]);
  const privById = Object.fromEntries(priv.map(({ id, ...rest }) => [id, rest]));
  products.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return products.map(p => ({ ...p, ...(privById[p.id] || {}), createdAt: isoCreatedAt(p) }));
}

// ── deleteAdminProduct ──────────────────────────────────────────
export async function deleteAdminProduct(data, { db }) {
  const { id } = data || {};
  if (!id) throw new HttpsError('invalid-argument', 'ID mancante.');
  await db.deleteDoc('products', id);
  await db.deleteDoc('products_private', id).catch(() => null);
  return { ok: true };
}

// ── updateAdminProduct ──────────────────────────────────────────
export async function updateAdminProduct(data, { db }) {
  const { id, data: fields } = data || {};
  if (!id || !fields) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  const { pub, priv } = splitPrivate(fields);
  if (Object.keys(pub).length) await db.updateDoc('products', id, pub);
  if (Object.keys(priv).length) await db.updateDoc('products_private', id, priv);
  return { ok: true };
}

// ── updateAdminOrder ────────────────────────────────────────────
export async function updateAdminOrder(data, { db }) {
  const { id, status } = data || {};
  if (!id || !status) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  await db.updateDoc('orders', id, { status });
  return { ok: true };
}

// Sposta una volta sola i campi privati dai vecchi documenti `products` a
// `products_private`. Si lancia dall'admin (pulsante «Sposta i costi
// fornitore» o lfCallable('migratePrivateFields')()); rilanciarlo non fa
// danni: tocca solo i prodotti che hanno ancora qualche campo privato.
export async function migratePrivateFields(_data, { db }) {
  const products = await db.listAll('products');
  let moved = 0;
  for (const p of products) {
    if (!hasPrivate(p)) continue;
    const { priv } = splitPrivate(p);
    await db.updateDoc('products_private', p.id, priv);
    const togli = {};
    for (const f of PRIVATE_FIELDS) if (f in p) togli[f] = DELETE_FIELD;
    await db.updateDoc('products', p.id, togli);
    moved++;
  }
  return { moved, total: products.length };
}
