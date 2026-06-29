// Test locale delle parti a logica pura (eseguibile con `node test/logic.test.mjs`).
// Non tocca rete/Firestore: valida convertitori e calcolo spedizione.
import { toFsFields, fromFsFields } from '../src/lib/firestore.js';
import { getProductWeight, getShippingCost } from '../src/lib/shipping.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`❌ ${label}\n   atteso: ${e}\n   ottenuto: ${a}`); }
}

// ── Round-trip convertitori Firestore ──────────────────────────
const order = {
  orderId: 'LILLO-ABC123',
  total: 42.10,
  qty: 3,
  isDigital: false,
  items: [
    { name: 'Nike Dunk', price: 20, qty: 1, sizes: ['40', '41'] },
    { name: 'Sub', price: 2.5, isDigital: true },
  ],
  address: { street: 'Via Roma 1', city: 'Milano', zip: '20100' },
  notes: '',
};
const round = fromFsFields(toFsFields(order));
eq(round.orderId, 'LILLO-ABC123', 'string round-trip');
eq(round.total, 42.10, 'double round-trip');
eq(round.qty, 3, 'integer round-trip');
eq(round.isDigital, false, 'boolean round-trip');
eq(round.items.length, 2, 'array length');
eq(round.items[0].sizes, ['40', '41'], 'nested array');
eq(round.items[1].isDigital, true, 'nested boolean');
eq(round.address.city, 'Milano', 'nested map');
eq(round.notes, '', 'empty string');

// integerValue arriva come stringa da Firestore: deve tornare number
eq(typeof round.qty, 'number', 'integer is number');

// undefined deve essere omesso (non serializzato)
const withUndef = toFsFields({ a: 1, b: undefined });
eq(Object.keys(withUndef), ['a'], 'undefined omitted');

// ── Calcolo peso ────────────────────────────────────────────────
eq(getProductWeight({ weightKg: 1.2 }), 1.2, 'peso esplicito');
eq(getProductWeight({ category: 'tshirt' }), 0.35, 'peso categoria tshirt');
eq(getProductWeight({ category: 'scarpe', boxOption: 'con_scatola' }), 2.5, 'scarpe con scatola');
eq(getProductWeight({ category: 'scarpe', boxOption: 'senza_scatola' }), 2.0, 'scarpe senza scatola');
eq(getProductWeight({ category: 'scarpe_box' }), 2.5, 'scarpe_box default');
eq(getProductWeight({ category: 'sconosciuta' }), 0.5, 'categoria sconosciuta → 0.5');

// ── Fasce spedizione ────────────────────────────────────────────
eq(getShippingCost(0.5), 12, 'spedizione <=1kg');
eq(getShippingCost(2), 18, 'spedizione <=3kg');
eq(getShippingCost(5), 25, 'spedizione <=6kg');
eq(getShippingCost(8), 35, 'spedizione <=10kg');
eq(getShippingCost(50), 50, 'spedizione oltre');

// ── Esito ───────────────────────────────────────────────────────
console.log(`\n${pass} passati, ${fail} falliti`);
if (fail > 0) process.exit(1);
console.log('✅ Tutta la logica pura è corretta');
