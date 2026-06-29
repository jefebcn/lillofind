// ════════════════════════════════════════════════════════════════
// Calcolo peso e spedizione — identico alla logica server-side
// originale (functions/index.js) per garantire prezzi coerenti.
// ════════════════════════════════════════════════════════════════

const CATEGORY_WEIGHTS = {
  tshirt: 0.35, tshirt_branded: 0.40, felpa: 0.80,
  scarpe: 2.00, scarpe_box: 2.50, pantaloni: 0.80,
  shorts: 0.50, cappello: 0.30, giacchetto: 1.20,
  borsa: 1.50, accessori: 0.20,
};

const SHIPPING_TIERS = [
  { maxKg: 1, price: 12 },
  { maxKg: 3, price: 18 },
  { maxKg: 6, price: 25 },
  { maxKg: 10, price: 35 },
  { maxKg: 9999, price: 50 },
];

export function getProductWeight(prod) {
  if (prod.weightKg && prod.weightKg > 0) return prod.weightKg;
  if (prod.weight_kg && prod.weight_kg > 0) return prod.weight_kg;
  const cat = prod.category || '';
  if (cat === 'scarpe' || cat === 'scarpe_box') {
    const box = prod.boxOption || (cat === 'scarpe_box' ? 'con_scatola' : 'senza_scatola');
    return box === 'con_scatola' ? 2.5 : 2.0;
  }
  return CATEGORY_WEIGHTS[cat] ?? 0.5;
}

export function getShippingCost(totalWeightKg) {
  const tier = SHIPPING_TIERS.find(t => totalWeightKg <= t.maxKg);
  return tier ? tier.price : 50;
}
