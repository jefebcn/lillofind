// Lettura ricevuta: numeri con virgola e riquadro totali che deve tornare.
import { quoteNum, fixQuotationSummary } from '../src/handlers/scrapers.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };

eq(quoteNum('$33.8'), 33.8, 'punto decimale');
eq(quoteNum('-$33,8'), -33.8, 'virgola decimale (non 338)');
eq(quoteNum('33,80'), 33.8, 'virgola con due decimali');
eq(quoteNum('1,234.50'), 1234.5, 'migliaia con virgola');
eq(quoteNum('1.234,50'), 1234.5, 'migliaia con punto');
eq(quoteNum('1,234'), 1234, 'migliaia senza decimali');
eq(quoteNum(269.8), 269.8, 'numero già numero');
eq(quoteNum(''), null, 'vuoto');

// Ricevuta del 10-Sep: 237.1 + 71.6 − 5.2 − 33.8 = 269.7 ≈ 269.8
const base = { goodsUsd: 237.1, estFreightUsd: 71.6, discountUsd: 5.2, totalUsd: 269.8 };
eq(fixQuotationSummary({ ...base, refundUsd: 33.8 }).refundFixed, undefined, 'letta giusta: invariata');
const f = fixQuotationSummary({ ...base, refundUsd: 338 });
eq([f.refundUsd, f.refundRead, f.refundFixed], [33.8, 338, true], 'rimborso 338 → 33.8');
const g = fixQuotationSummary({ ...base, discountUsd: 52, refundUsd: 33.8 });
eq([g.discountUsd, g.discountFixed], [5.2, true], 'sconto 52 → 5.2');
const h = fixQuotationSummary({ ...base, refundUsd: 99 });
eq([h.refundUsd, h.refundFixed], [99, undefined], 'non torna in nessun modo: lasciato com\'è (avviso in admin)');
eq(fixQuotationSummary({ goodsUsd: 10, refundUsd: 338 }).refundUsd, 338, 'senza totale: niente correzione');

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
