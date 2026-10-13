// Ricerca per foto: risposta dell'AI ripulita, limiti, errori.
import { visualSearch, cleanResult } from '../src/handlers/visual.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };
const throwsCode = async (fn, code, l) => { try { await fn(); fail++; console.error('❌ ' + l + ' (nessun errore)'); } catch (e) { eq(e.code, code, l); } };

eq(cleanResult({ found: true, category: 'felpa con cappuccio', brand: 'Stüssy', colors: ['nero', 'Fucsia', 'Bianco'], keywords: ['Logo', 'x', 'cappuccio'], label: '<b>Felpa</b>' }),
  { found: true, category: 'Felpa con Cappuccio', brand: 'Stüssy', team: '', colors: ['Nero', 'Bianco'], keywords: ['logo', 'cappuccio'], label: 'bFelpa/b' },
  'categoria e colori solo dagli elenchi, niente tag HTML');
eq(cleanResult({ found: false, label: 'un gatto' }), { found: false, label: 'un gatto' }, 'non è un capo');
eq(cleanResult({ found: true, category: 'Astronave' }).category, '', 'categoria sconosciuta scartata');

let reply = '{"found":true,"category":"Sneakers","brand":"Jordan","team":"","colors":["Rosso","Bianco"],"keywords":["air jordan 1"],"label":"Air Jordan 1 rosse"}', ok = true, sent = null;
globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return { ok, status: ok ? 200 : 500, json: async () => ({ content: [{ text: 'Ecco: ' + reply }] }) }; };
const limits = {};
const db = { async getDoc(c, id) { return { exists: !!limits[id], data: () => limits[id] }; }, async setDoc(c, id, o) { limits[id] = o; } };
const ctx = { env: { ANTHROPIC_API_KEY: 'k' }, db, auth: { uid: 'u1' }, ip: '1.2.3.4' };
{
  const r = await visualSearch({ imageBase64: 'data:image/jpeg;base64,AAAA', mediaType: 'image/jpeg' }, ctx);
  eq([r.found, r.category, r.brand, r.colors], [true, 'Sneakers', 'Jordan', ['Rosso', 'Bianco']], 'foto riconosciuta');
  eq(sent.messages[0].content[0].source.data, 'AAAA', 'prefisso data: tolto');
  eq(sent.model.startsWith('claude-haiku'), true, 'modello economico');
}
await throwsCode(() => visualSearch({}, ctx), 'invalid-argument', 'senza foto');
await throwsCode(() => visualSearch({ imageBase64: 'A'.repeat(3 * 1024 * 1024) }, ctx), 'invalid-argument', 'foto troppo grande');
await throwsCode(() => visualSearch({ imageBase64: 'AAAA' }, { ...ctx, env: {} }), 'unavailable', 'senza chiave AI');
ok = false; await throwsCode(() => visualSearch({ imageBase64: 'AAAA' }, ctx), 'unavailable', 'errore AI: messaggio chiaro'); ok = true;
{
  for (let i = 0; i < 12; i++) await visualSearch({ imageBase64: 'AAAA' }, { ...ctx, auth: { uid: 'u2' } }).catch(() => {});
  await throwsCode(() => visualSearch({ imageBase64: 'AAAA' }, { ...ctx, auth: { uid: 'u2' } }), 'resource-exhausted', '13ª ricerca in un\'ora: limite');
}

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
