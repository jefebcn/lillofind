// ════════════════════════════════════════════════════════════════
// Handler ADMIN — port fedele delle Cloud Functions admin.
// L'autorizzazione admin è già garantita dal router (auth:'admin').
// ════════════════════════════════════════════════════════════════

import { HttpsError } from '../lib/errors.js';

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
  const docData = {
    name:        String(p.name).slice(0, 200),
    price:       p.price,
    brand:       String(p.brand || '').slice(0, 100),
    model:       String(p.model || '').slice(0, 100),
    style:       String(p.model || '').slice(0, 100),
    category:    String(p.category || '').slice(0, 50),
    gender:      gender,
    sizes:       Array.isArray(p.sizes) ? p.sizes.slice(0, 50) : ['S', 'M', 'L', 'XL'],
    size:        String(p.size || '').slice(0, 200),
    colors:      Array.isArray(p.colors) ? p.colors.slice(0, 20) : [],
    imageUrl:    String(p.imageUrl || '').slice(0, 500),
    description: String(p.description || '').slice(0, 2000),
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
  const products = await db.listAll('products');
  products.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return products.map(p => ({ ...p, createdAt: isoCreatedAt(p) }));
}

// ── deleteAdminProduct ──────────────────────────────────────────
export async function deleteAdminProduct(data, { db }) {
  const { id } = data || {};
  if (!id) throw new HttpsError('invalid-argument', 'ID mancante.');
  await db.deleteDoc('products', id);
  return { ok: true };
}

// ── updateAdminProduct ──────────────────────────────────────────
export async function updateAdminProduct(data, { db }) {
  const { id, data: fields } = data || {};
  if (!id || !fields) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  await db.updateDoc('products', id, fields);
  return { ok: true };
}

// ── updateAdminOrder ────────────────────────────────────────────
export async function updateAdminOrder(data, { db }) {
  const { id, status } = data || {};
  if (!id || !status) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  await db.updateDoc('orders', id, { status });
  return { ok: true };
}
