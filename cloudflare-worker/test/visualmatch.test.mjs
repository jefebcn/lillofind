// Ricerca per foto lato server: candidati dal catalogo e confronto delle miniature.
import { productCategory, visualCandidates, thumbUrl, orderByVerdict, rerankByPhoto, matchView } from '../src/lib/visual-match.js';
import { visualSearch, visualIndex, buildIndex, _resetVisualIndex } from '../src/handlers/visual.js';

let pass = 0, fail = 0;
const eq = (a, e, l) => { const A = JSON.stringify(a), E = JSON.stringify(e); if (A === E) pass++; else { fail++; console.error('❌ ' + l + '\n   atteso ' + E + '\n   ottenuto ' + A); } };

// Categoria come i filtri dello shop
eq(productCategory({ name: 'Air Jordan 4 Retro Black Cat' }), 'Sneakers', 'sneakers dal nome');
eq(productCategory({ name: 'Ralph Lauren Polo Bear Felpa' }), 'Felpa', 'Polo Bear = disegno, non polo');
eq(productCategory({ name: 'Maglia Inter 24/25', style: 'calcio' }), 'Calcio', 'kit calcio dallo stile');
eq(productCategory({ name: 'Stussy 8 Ball', model: 'Hoodie' }), 'Felpa con Cappuccio', 'dal modello se il nome non basta');

const P = [
  { id: 'a', name: 'Air Jordan 4 Retro Black Cat', brand: 'Jordan', colors: ['Nero'], price: 120, imageUrl: 'https://photo.yupoo.com/x/aa/medium.jpg' },
  { id: 'b', name: 'Air Jordan 1 High Chicago', brand: 'Jordan', colors: ['Rosso', 'Bianco'], price: 110, imageUrl: 'https://photo.yupoo.com/x/bb/medium.jpg' },
  { id: 'c', name: 'Nike Dunk Low Panda', brand: 'Nike', colors: ['Nero', 'Bianco'], price: 90, imageUrl: 'https://photo.yupoo.com/x/cc/medium.jpg' },
  { id: 'd', name: 'Stussy Hoodie Nera', brand: 'Stussy', colors: ['Nero'], price: 60, imageUrl: 'https://photo.yupoo.com/x/dd/medium.jpg' },
  { id: 'e', name: 'Jordan 4 nascosta', brand: 'Jordan', hidden: true, imageUrl: 'https://photo.yupoo.com/x/ee/medium.jpg' },
];
const r = { found: true, category: 'Sneakers', brand: 'Jordan', team: '', colors: ['Nero'], keywords: ['jordan 4'], label: '' };
eq(visualCandidates(P, r).map((p) => p.id), ['a', 'b', 'c'], 'candidati: marchio e colore prima, nascosti esclusi, felpa fuori');
eq(visualCandidates(P, { found: false }), [], 'foto senza capo: niente');
// Kit sportivi: conta anche il tipo di capo (felpa del Milan ≠ maglia del Milan)
const K = [
  { id: 'j', name: '2004-05 AC Milan retro jersey', style: 'calcio', imageUrl: 'x' },
  { id: 'h', name: '25-26 AC Milan Hoodie', style: 'calcio', imageUrl: 'x' },
];
eq(visualCandidates(K, { found: true, category: 'Felpa', team: 'AC Milan', colors: [], keywords: [] }).map((p) => p.id), ['h', 'j'], 'felpa del Milan prima della maglia');

eq(thumbUrl('https://yupoo-proxy.conti9708.workers.dev/?url=https%3A%2F%2Fphoto.yupoo.com%2Fhusky%2F405b%2Fmedium.jpg'), 'https://photo.yupoo.com/husky/405b/small.jpg', 'proxy tolto, miniatura small');
eq(thumbUrl('https://si.geilicdn.com/open1_800_800.jpg'), 'https://si.geilicdn.com/open1_800_800.jpg', 'altri host invariati');
eq(thumbUrl('non è un url'), '', 'url non valido');

const L = [P[0], P[1], P[2]];
eq(orderByVerdict(L, L, { same: [2], similar: [3, 2] }).map((x) => x.p.id + ':' + x.match), ['b:same', 'c:similar', 'a:'], 'uguali, poi simili, poi gli altri');
eq(orderByVerdict(L, L, { same: [9, 'x'] }).map((x) => x.p.id), ['a', 'b', 'c'], 'numeri sbagliati ignorati');

// Confronto: miniature scaricate e mandate all'AI insieme alla foto
const IMG = new Uint8Array(2000).fill(7).buffer;
let aiBody = null, aiReply = '{"same":[2],"similar":[1]}', thumbFails = new Set();
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('api.anthropic.com')) { aiBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ text: aiReply }] }) }; }
  if (thumbFails.has(String(url))) return { ok: false, status: 404 };
  return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => IMG };
};
const env = { ANTHROPIC_API_KEY: 'k' };
{
  const out = await rerankByPhoto(env, { media_type: 'image/jpeg', data: 'AAAA' }, L);
  eq(out.map((x) => x.p.id + ':' + x.match), ['b:same', 'a:similar', 'c:'], 'ordine dal confronto');
  eq(aiBody.messages[0].content.filter((c) => c.type === 'image').length, 4, 'foto + 3 miniature');
  eq(aiBody.model.startsWith('claude-haiku'), true, 'modello economico');
}
{
  thumbFails = new Set(['https://photo.yupoo.com/x/aa/small.jpg']);
  aiReply = '{"same":[1],"similar":[]}';
  const out = await rerankByPhoto(env, { media_type: 'image/jpeg', data: 'AAAA' }, L);
  eq(out[0].p.id + ':' + out[0].match, 'b:same', 'miniatura rotta saltata: i numeri seguono quelle mostrate');
  thumbFails = new Set();
}
{
  aiReply = 'boh';
  eq((await rerankByPhoto(env, { media_type: 'image/jpeg', data: 'AAAA' }, L)).map((x) => x.p.id + ':' + x.match), ['a:', 'b:', 'c:'], 'risposta AI illeggibile: ordine dei punteggi');
  eq((await rerankByPhoto({}, { media_type: 'image/jpeg', data: 'AAAA' }, L)).length, 3, 'senza chiave: niente confronto');
}
eq(matchView({ p: { ...P[0], description: 'x', colors: ['Nero'] }, match: 'same' }), { id: 'a', name: 'Air Jordan 4 Retro Black Cat', brand: 'Jordan', price: 120, imageUrl: 'https://photo.yupoo.com/x/aa/medium.jpg', soldOut: false, match: 'same' }, 'solo i campi da mostrare');

// visualSearch completa: descrizione, indice dal KV (in memoria alla seconda), prodotti
{
  _resetVisualIndex();
  const store = { 'catalog:meta': JSON.stringify({ version: 5 }), catalog: JSON.stringify({ products: P }) };
  let kvGets = 0;
  const kv = { async get(k) { kvGets++; return store[k] ?? null; }, async put(k, v) { store[k] = v; } };
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      const b = JSON.parse(opts.body); calls.push(b);
      const text = calls.length % 2 ? JSON.stringify({ found: true, category: 'Sneakers', brand: 'Jordan', colors: ['Nero'], keywords: [], label: 'Jordan 4 nere' }) : '{"same":[1],"similar":[2]}';
      return { ok: true, json: async () => ({ content: [{ text }] }) };
    }
    return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => IMG };
  };
  const ctx = { env: { ANTHROPIC_API_KEY: 'k', CATALOG: kv }, db: null, auth: { uid: 'u9' } };
  const res = await visualSearch({ imageBase64: 'AAAA', mediaType: 'image/jpeg' }, ctx);
  eq(res.matches.map((m) => m.id + ':' + m.match), ['a:same', 'b:similar', 'c:'], 'risposta con i prodotti già ordinati');
  eq(JSON.parse(store['catalog:visual']).list.length, 4, 'indice salvato nel KV (senza nascosti)');
  kvGets = 0;
  await visualIndex(ctx.env);
  eq(kvGets, 1, 'seconda volta: solo il meta, indice dalla memoria');
  store['catalog:meta'] = JSON.stringify({ version: 6 });
  store.catalog = JSON.stringify({ products: [P[3]] });
  eq((await visualIndex(ctx.env)).map((p) => p.id), ['d'], 'catalogo ripubblicato: indice rifatto');
  const noM = await visualSearch({ imageBase64: 'AAAA', matches: false }, ctx);
  eq(noM.matches, undefined, 'matches:false = solo descrizione');
}
eq(buildIndex({ products: [{ id: 1, name: 'x', imageUrl: 'u', soldOut: true, sourceUrl: 'segreto' }] }), [{ id: '1', name: 'x', brand: '', model: '', category: '', style: '', colors: [], price: 0, imageUrl: 'u', description: '', soldOut: true }], 'indice: solo campi pubblici utili');

console.log(`\n${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);
