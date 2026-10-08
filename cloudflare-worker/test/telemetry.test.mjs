// Test di /clientError (`node test/telemetry.test.mjs`).
import { parseClientError } from '../src/handlers/telemetry.js';
let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const ALLOWED = 'https://lillofind.shop,https://www.lillofind.shop';
const ok = parseClientError(JSON.stringify({ msg: 'x is not defined', src: 'https://lillofind.shop/', line: 12, col: 3, stack: 'ReferenceError…', page: '/#shop' }), { origin: 'https://lillofind.shop', allowedOrigins: ALLOWED, userAgent: 'Mozilla/5.0', country: 'IT' });
eq([ok.msg, ok.line, ok.col, ok.page, ok.kind, ok.country], ['x is not defined', 12, 3, '/#shop', 'error', 'IT'], 'errore valido');
eq(parseClientError('{"msg":"a"}', { origin: 'https://evil.example', allowedOrigins: ALLOWED }), null, 'origine non ammessa ignorata');
eq(parseClientError('non json', { allowedOrigins: ALLOWED }), null, 'corpo non JSON ignorato');
eq(parseClientError('{"line":1}', { allowedOrigins: ALLOWED }), null, 'senza messaggio ignorato');
const big = parseClientError(JSON.stringify({ msg: 'm'.repeat(1000), stack: 's'.repeat(5000), line: 'abc', kind: 'promise' }), { allowedOrigins: ALLOWED });
eq([big.msg.length, big.stack.length <= 1500, big.line, big.kind], [300, true, 0, 'promise'], 'campi accorciati e normalizzati');
console.log(`${pass} passati, ${fail} falliti`); if (fail) process.exit(1);
