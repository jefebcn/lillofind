// Album Yupoo: le foto con QR/contatti del fornitore escono dalla galleria.
import { applyPromoFilter, filterPromoPhotos } from '../src/handlers/scrapers.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };

const P = ['a', 'b', 'c', 'd'].map((x) => `https://photo.yupoo.com/shop/${x}1234567/medium.jpg`);
eq(applyPromoFilter(P, [0, 2]).photos, [P[1], P[3]], 'tolte le foto indicate');
eq(applyPromoFilter(P, [0, 2]).removed, [P[0], P[2]], 'foto tolte elencate');
eq(applyPromoFilter(P, [0, 1, 2, 3]).photos, P, 'mai svuotare la galleria');
eq(applyPromoFilter(P, [9, -1, 'x']).photos, P, 'indici non validi ignorati');

let seen = [], aiBody = null, aiReply = '{"remove":[0,2]}', aiOk = true;
globalThis.fetch = async (url, opts = {}) => {
  if (/anthropic/.test(url)) { aiBody = JSON.parse(opts.body); return { ok: aiOk, json: async () => ({ content: [{ text: aiReply }] }) }; }
  seen.push({ url, ref: opts.headers.Referer });
  if (/c1234567/.test(url)) return { ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
};
const env = { ANTHROPIC_API_KEY: 'k' };
{
  const r = await filterPromoPhotos(env, P, 'https://shop.x.yupoo.com/albums/1?uid=1');
  eq(seen.every((x) => /\/small\.jpg$/.test(x.url)), true, 'scarica le miniature small');
  eq(seen[0].ref, 'https://shop.x.yupoo.com/', 'con il referer del negozio');
  eq(aiBody.messages[0].content.filter((c) => c.type === 'image').length, 3, 'all\'AI solo le miniature lette');
  eq(r.photos, [P[1], P[2], P[3]], 'QR tolto; la foto non letta (2) resta');
}
{ aiReply = 'boh'; const r = await filterPromoPhotos(env, P, 'x'); eq(r.photos, P, 'risposta non valida: tutte tenute'); }
{ aiOk = false; const r = await filterPromoPhotos(env, P, 'x'); eq(r.photos, P, 'errore AI: tutte tenute'); aiOk = true; }
{ const r = await filterPromoPhotos({}, P, 'x'); eq(r.photos, P, 'senza chiave AI: nessun filtro'); }

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
