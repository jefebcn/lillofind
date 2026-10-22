// ════════════════════════════════════════════════════════════════
// Peso e spedizione — STESSA logica in index.html (carrello/checkout):
// se cambi qui, cambia anche lì (il test logic.test.mjs fissa i valori).
//
// Pesi presi dalle ricevute reali dell'agente (GW per pezzo, ago–set 2026):
// t-shirt 0,3–0,4 · felpe/pantaloni/jeans 0,8 · maglioni 1,0 · sneakers 2,0
// (1,5 le piccole) · ciabatte 1,3 · piumini 3,0 · set felpa+pantaloni 1,6.
// I pesi salvati sui prodotti dall'importer erano più bassi (sneakers 1,2,
// felpe 0,7…): ora contano solo se più alti del peso reale del tipo di capo.
//
// Tariffa: l'agente fa pagare ~$10,3–13,5/kg (≈ €9/kg). Il sito fa pagare
// €12 fino a 1 kg, poi €5 ogni 0,5 kg in più (€10/kg): 2 kg = €22, 6 kg = €62.
// ════════════════════════════════════════════════════════════════

export const CATEGORY_WEIGHTS = {
  tshirt: 0.35, tshirt_branded: 0.40, felpa: 0.80,
  scarpe: 2.00, scarpe_box: 2.50, pantaloni: 0.80,
  shorts: 0.40, cappello: 0.30, giacchetto: 1.20,
  borsa: 1.50, accessori: 0.30,
};

// Capi che pesano diversamente dalla loro categoria (riconosciuti dal nome)
const TYPE_WEIGHTS = [
  [/piumin|puffer|down ?jacket|parka|nuptse|\bdown\b/i, 2.8],
  [/ciabatt|slides?\b|clog|sandal|infradito/i, 1.3],
  [/\bset\b|\btuta\b|tracksuit|completo/i, 1.4],
  [/maglion|knit|cardigan/i, 1.0],
  [/airpods?|auricolar|earbuds?|cuffie|headphone/i, 0.5],
];

export const SHIP_BASE_EUR = 12, SHIP_BASE_KG = 1, SHIP_STEP_KG = 0.5, SHIP_STEP_EUR = 5;

export function getProductWeight(prod) {
  const p = prod || {};
  const txt = (p.name || '') + ' ' + (p.model || '');
  let base = null;
  for (const [re, w] of TYPE_WEIGHTS) { if (re.test(txt)) { base = w; break; } }
  if (base == null) {
    const cat = p.category || '';
    if (cat === 'scarpe' || cat === 'scarpe_box') {
      const box = p.boxOption || (cat === 'scarpe_box' ? 'con_scatola' : 'senza_scatola');
      base = box === 'con_scatola' ? 2.5 : 2.0;
    } else base = CATEGORY_WEIGHTS[cat] ?? 0.5;
  }
  const saved = +(p.weightKg || p.weight_kg) || 0;
  return Math.max(saved, base);
}

export function getShippingCost(totalWeightKg) {
  const kg = Math.max(0, +totalWeightKg || 0);
  if (kg <= SHIP_BASE_KG) return SHIP_BASE_EUR;
  const steps = Math.ceil(Math.round((kg - SHIP_BASE_KG) * 1000) / 1000 / SHIP_STEP_KG);
  return SHIP_BASE_EUR + steps * SHIP_STEP_EUR;
}
