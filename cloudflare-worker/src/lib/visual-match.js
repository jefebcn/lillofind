// ════════════════════════════════════════════════════════════════
// Ricerca per foto lato server: dai campi letti dall'AI (categoria, marchio,
// squadra, colori, parole chiave) i prodotti candidati del catalogo KV, poi
// l'AI confronta la foto del cliente con le miniature dei candidati e mette
// in testa quelli uguali. Prima tutto questo lo faceva il telefono, che per
// cercare doveva scaricare l'intero catalogo (≈7 MB).
// Le stesse funzioni serviranno al bot Telegram.
// ════════════════════════════════════════════════════════════════

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const W = (s) => new RegExp('(?:^|[^a-z0-9])(?:' + s + ')(?![a-z0-9])', 'i');

// Come _CLASSIFY_RULES in index.html (versione ridotta): vince il tipo nominato per primo
const RULES = [
  ['Sneakers', W('sneakers?|scarpe|scarpa|shoes?|air force|air max|dunk|jordan [1-9]\\d?|runners?|trainers?|ciabatt[ae]|slides?|sandal[oi]|sandals?|clogs?|stivali|boots?|mocassin[oi]|loafers?')],
  ['Calzini', W('calzini|calze|socks?')],
  ['Sciarpa', W('sciarp[ae]|scarf|scarves')],
  ['Occhiali', W('occhiali|sunglass(?:es)?|eyewear|glasses')],
  ['Zaino / Borsa', W('zain[oi]|bors[ae]|borsell[oi]|tracolla|bags?|backpacks?|pouch|marsupi[oi]|tote')],
  ['Cappello', W('cappell[oi]|cappellino|berretto|beanie|snapback|caps?|hats?|trucker')],
  ['Jogger', W('joggers?')],
  ['Pantaloncini', W('pantaloncin[oi]|shorts|bermuda')],
  ['Pantaloni', W('pantalon[ei]|pants|trousers|jeans|chinos?')],
  ['Piumino', W('piumin[oi]|puffer|puffy|down jacket|nuptse')],
  ['Bomber', W('bomber')],
  ['Gilet', W('gilet|vests?|smanicat[oi]')],
  ['Giacchetto', W('giacchett[oi]|giubbott[oi]|giacca|giacche|jackets?|windbreaker|parka|cappotto|coat|anorak|track top')],
  ['Cardigan', W('cardigan')],
  ['Pile', W('pile|fleece')],
  ['Felpa con Cappuccio', W('felpa con cappuccio|hoodies?|hoody|hooded|cappuccio')],
  ['Felpa', W('felp[ae]|crewnecks?|sweatshirts?|sweaters?|girocollo|maglione|knit|quarter zip|half zip')],
  ['Maglia Manica Lunga', W('manica lunga|maniche lunghe|longsleeve|long sleeve|long-sleeve')],
  ['Polo', W('polo')],
  ['Canotta', W('canott[ae]|tank top|tank|singlet')],
  ['T-Shirt', W('t-shirts?|tshirts?|t shirts?|tees?|magliett[ae]')],
  ['Camicia', W('camici[ae]|flanell[ae]|flannel|overshirt|shirt')],
  ['T-Shirt', W('maglia|maglie|jersey')],
];
function firstType(t) {
  t = norm(t).replace(/polo\s+(?:by\s+)?ralph\s+lauren/g, 'ralph lauren').replace(/polo\s+bear/g, 'bear');
  let best = '', at = Infinity;
  for (const [label, re] of RULES) { const m = re.exec(t); if (m && m.index < at) { at = m.index; best = label; } }
  return best;
}
export function productCategory(p) {
  const st = norm(p && p.style);
  if (st === 'calcio' || st === 'basket' || st === 'ciclismo') return st[0].toUpperCase() + st.slice(1);
  return firstType(p.name) || firstType(p.model) || firstType(p.category) || '';
}

// Candidati: stessi punteggi della ricerca del sito (lfVisualMatch)
export function visualCandidates(products, r, max = 24) {
  if (!r || !r.found) return [];
  const brand = norm(r.brand), team = norm(r.team);
  const colors = (r.colors || []).map(norm), kws = (r.keywords || []).map(norm);
  const out = [];
  for (const p of products || []) {
    if (!p || p.hidden === true || !p.imageUrl) continue;
    const txt = norm([p.name, p.model, p.brand, String(p.description || '').slice(0, 160)].join(' '));
    const pb = norm(p.brand);
    let sc = 0, catOk = false;
    if (r.category && productCategory(p) === r.category) { sc += 4; catOk = true; }
    if (brand && (pb === brand || (brand.length >= 3 && txt.includes(brand)))) sc += 5;
    if (team && (pb === team || txt.includes(team))) sc += 6;
    const pcol = (Array.isArray(p.colors) ? p.colors : []).map(norm);
    colors.forEach((c) => { if (pcol.includes(c) || txt.includes(c)) sc += 1.2; });
    kws.forEach((k) => { if (k.length >= 3 && txt.includes(k)) sc += 1; });
    if (sc >= 4 && (catOk || sc >= 5)) out.push({ p, sc: sc - (p.soldOut === true ? 2 : 0) });
  }
  out.sort((a, b) => b.sc - a.sc);
  return out.slice(0, max).map((x) => x.p);
}

// Miniatura leggera per il confronto: le foto Yupoo passano dal proxy del
// sito, qui si va diretti all'originale in formato "small"
export function thumbUrl(u) {
  let s = String(u || '').trim();
  try {
    const x = new URL(s);
    if (x.hostname.endsWith('.workers.dev') && x.searchParams.get('url')) s = x.searchParams.get('url');
  } catch (_) { return ''; }
  return s.replace(/(photo\.yupoo\.com\/[^?#]+\/)(?:medium|big|large|raw|square)\.(jpe?g|png|webp)/i, '$1small.$2');
}

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export async function fetchThumb(u) {
  const url = thumbUrl(u);
  if (!/^https:\/\//i.test(url)) return null;
  const h = new URL(url).hostname;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Referer: 'https://' + h + '/', Accept: 'image/webp,image/jpeg,image/png,image/*' },
      signal: AbortSignal.timeout(5000),
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!r.ok) return null;
    const mt = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mt)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 800 || buf.byteLength > 1.5 * 1024 * 1024) return null;
    if (mt === 'image/png' && buf.byteLength === 17670) return null; // segnaposto Yupoo "foto rimossa"
    return { media_type: mt, data: b64(buf) };
  } catch (_) { return null; }
}

export function firstJson(text) {
  const s = String(text || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('risposta senza JSON');
  return JSON.parse(s.slice(i, j + 1));
}

// L'AI confronta la foto con le miniature numerate. Torna i candidati
// riordinati: prima gli uguali (match 'same'), poi i simili, poi gli altri.
// Se il confronto non riesce si tiene l'ordine dei punteggi.
export async function rerankByPhoto(env, photo, cands, { model = 'claude-haiku-4-5-20251001', max = 8 } = {}) {
  const list = cands.slice(0, max);
  if (list.length < 2 || !env.ANTHROPIC_API_KEY) return list.map((p) => ({ p, match: '' }));
  const thumbs = await Promise.all(list.map((p) => fetchThumb(p.imageUrl)));
  const shown = list.map((p, i) => ({ p, t: thumbs[i] })).filter((x) => x.t);
  if (shown.length < 2) return list.map((p) => ({ p, match: '' }));
  const content = [{ type: 'text', text: 'FOTO DEL CLIENTE:' }, { type: 'image', source: { type: 'base64', media_type: photo.media_type, data: photo.data } }];
  shown.forEach((x, i) => {
    content.push({ type: 'text', text: 'Prodotto ' + (i + 1) + ': ' + String(x.p.name || '').slice(0, 80) });
    content.push({ type: 'image', source: { type: 'base64', ...x.t } });
  });
  content.push({ type: 'text', text: `Confronta il capo principale nella FOTO DEL CLIENTE con i ${shown.length} prodotti.
"same" = stesso modello (stessa forma, stesso disegno/logo, stesso colore principale). "similar" = stesso tipo di capo e stile simile, ma modello o colore diversi.
Rispondi SOLO con JSON: {"same":[numeri],"similar":[numeri]} in ordine dal più simile. Elenchi vuoti se nessuno corrisponde.` });
  let res;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) throw new Error('Anthropic ' + resp.status);
    const j = await resp.json();
    res = firstJson(j.content && j.content[0] && j.content[0].text);
  } catch (e) {
    console.error('rerankByPhoto:', e.message);
    return list.map((p) => ({ p, match: '' }));
  }
  return orderByVerdict(list, shown.map((x) => x.p), res);
}

export function orderByVerdict(list, shown, res) {
  const pick = (arr) => (Array.isArray(arr) ? arr : []).map((n) => shown[Number(n) - 1]).filter(Boolean);
  const same = pick(res && res.same), similar = pick(res && res.similar).filter((p) => !same.includes(p));
  const rest = list.filter((p) => !same.includes(p) && !similar.includes(p));
  return [...same.map((p) => ({ p, match: 'same' })), ...similar.map((p) => ({ p, match: 'similar' })), ...rest.map((p) => ({ p, match: '' }))];
}

// Solo i campi che servono per mostrare il risultato
export const matchView = ({ p, match }) => ({
  id: String(p.id), name: String(p.name || '').slice(0, 140), brand: String(p.brand || '').slice(0, 60),
  price: Number(p.price) || 0, imageUrl: p.imageUrl || '', soldOut: p.soldOut === true, match,
});
