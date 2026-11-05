// ════════════════════════════════════════════════════════════════
// Ricerca per foto (POST /visualSearch): il cliente carica una foto di un
// capo (screenshot, foto per strada…), Claude Haiku la descrive in campi
// strutturati (categoria, marchio, squadra, colori, parole chiave); poi qui
// si scelgono i candidati dal catalogo KV e l'AI confronta la foto con le
// loro miniature (lib/visual-match.js). La risposta porta già i prodotti
// (matches), così il telefono non deve scaricare tutto il catalogo per
// cercare. Nessuna lettura da Firestore oltre al limite. La foto non viene salvata.
// Limite: 12 ricerche l'ora per utente, 30 per connessione.
// ════════════════════════════════════════════════════════════════
import { HttpsError } from '../lib/errors.js';
import { limita } from '../lib/limiti.js';
import { visualCandidates, rerankByPhoto, matchView } from '../lib/visual-match.js';

// Le stesse categorie dei filtri dello shop (MODEL_FILTERS in index.html)
export const VS_CATEGORIES = ['Sneakers', 'T-Shirt', 'Polo', 'Camicia', 'Canotta', 'Maglia Manica Lunga', 'Felpa', 'Felpa con Cappuccio',
  'Cardigan', 'Giacchetto', 'Bomber', 'Gilet', 'Piumino', 'Pile', 'Pantaloni', 'Pantaloncini', 'Jogger', 'Cappello', 'Calzini',
  'Sciarpa', 'Zaino / Borsa', 'Occhiali', 'Calcio', 'Basket', 'Ciclismo'];
export const VS_COLORS = ['Nero', 'Bianco', 'Grigio', 'Rosso', 'Bordeaux', 'Rosa', 'Arancione', 'Giallo', 'Oro', 'Marrone', 'Beige',
  'Verde', 'Azzurro', 'Blu', 'Viola', 'Argento'];

const PROMPT = `Sei l'assistente di ricerca di uno shop di streetwear. Guarda la foto e descrivi il capo PRINCIPALE (quello più in evidenza) per trovarlo nel catalogo.
Rispondi SOLO con JSON valido, senza testo prima o dopo:
{"found":true,"category":"Felpa con Cappuccio","brand":"Stüssy","team":"","colors":["Nero","Bianco"],"keywords":["logo","cappuccio"],"label":"Felpa con cappuccio Stüssy nera con logo bianco"}
Regole:
- "category": UNA tra ${VS_CATEGORIES.join(', ')}. Maglie da calcio → "Calcio"; canotte NBA → "Basket"; kit da bici → "Ciclismo".
- "brand": il marchio se è riconoscibile (logo, scritta, modello famoso come Air Jordan 1 → "Jordan", Yeezy → "Yeezy"), altrimenti "". Non inventare.
- "team": la squadra se è una maglia sportiva (es. "Juventus", "Lakers", "UAE Team Emirates"), altrimenti "".
- "colors": 1-3 colori principali, solo tra ${VS_COLORS.join(', ')}.
- "keywords": 0-5 parole utili per la ricerca, in italiano o col nome del modello (es. "dunk", "cargo", "zip", "oversize", "stampa").
- "label": descrizione breve in italiano (max 70 caratteri).
- Se la foto non mostra un capo d'abbigliamento, scarpe o accessori: {"found":false,"label":"motivo breve"}.`;

// Indice compatto del catalogo per la ricerca (≈1/5 del catalogo completo),
// ricostruito quando il catalogo pubblicato cambia o dopo 6 ore, e tenuto in
// memoria tra una richiesta e l'altra.
const IDX = 'catalog:visual', IDX_TTL = 6 * 3600 * 1000;
let _mem = null;
export function buildIndex(cat) {
  return (cat && Array.isArray(cat.products) ? cat.products : [])
    .filter((p) => p && p.id && p.hidden !== true && p.imageUrl)
    .map((p) => ({ id: String(p.id), name: String(p.name || '').slice(0, 140), brand: p.brand || '', model: p.model || '', category: p.category || '',
      style: p.style || '', colors: Array.isArray(p.colors) ? p.colors.slice(0, 4) : [], price: Number(p.price) || 0, imageUrl: p.imageUrl,
      description: String(p.description || '').slice(0, 160), ...(p.soldOut === true ? { soldOut: true } : {}) }));
}
export async function visualIndex(env, now = Date.now()) {
  const kv = env.CATALOG;
  if (!kv) return [];
  let ver = 0;
  try { ver = (JSON.parse((await kv.get('catalog:meta')) || 'null') || {}).version || 0; } catch (_) {}
  if (_mem && _mem.ver === ver && now - _mem.at < IDX_TTL) return _mem.list;
  try {
    const saved = JSON.parse((await kv.get(IDX)) || 'null');
    if (saved && saved.ver === ver && now - saved.at < IDX_TTL && Array.isArray(saved.list)) { _mem = saved; return saved.list; }
  } catch (_) {}
  const body = await kv.get('catalog');
  if (!body) return [];
  const list = buildIndex(JSON.parse(body));
  _mem = { ver, at: now, list };
  try { await kv.put(IDX, JSON.stringify(_mem)); } catch (e) { console.error('visualIndex:', e.message); }
  return list;
}
export const _resetVisualIndex = () => { _mem = null; };

function firstJson(text) {
  const s = String(text || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('risposta senza JSON');
  return JSON.parse(s.slice(i, j + 1));
}

export function cleanResult(r) {
  const str = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, n);
  if (!r || r.found === false) return { found: false, label: str(r && r.label, 120) || 'Nella foto non vedo un capo da cercare.' };
  const cat = VS_CATEGORIES.find((c) => c.toLowerCase() === str(r.category, 40).toLowerCase()) || '';
  const colors = (Array.isArray(r.colors) ? r.colors : []).map((c) => VS_COLORS.find((x) => x.toLowerCase() === str(c, 20).toLowerCase())).filter(Boolean).slice(0, 3);
  const keywords = (Array.isArray(r.keywords) ? r.keywords : []).map((k) => str(k, 24).toLowerCase()).filter((k) => k.length >= 2).slice(0, 5);
  return { found: true, category: cat, brand: str(r.brand, 40), team: str(r.team, 40), colors, keywords, label: str(r.label, 90) };
}

export async function visualSearch(data, { env, db, auth, ip }) {
  const { imageBase64, mediaType } = data || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') throw new HttpsError('invalid-argument', 'Foto mancante.');
  if (imageBase64.length > 2.5 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Foto troppo grande.');
  if (!env.ANTHROPIC_API_KEY) throw new HttpsError('unavailable', 'Ricerca per foto non disponibile al momento.');
  const msg = 'Hai fatto molte ricerche per foto: riprova tra un po\'.';
  if (auth && auth.uid) await limita(db, 'vs_uid_' + auth.uid, 12, 3600, msg);
  if (ip) await limita(db, 'vs_ip_' + ip, 30, 3600, msg);
  let mt = String(mediaType || 'image/jpeg').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mt)) mt = 'image/jpeg';
  const b64 = imageBase64.replace(/^data:[^,]*,/, '');
  let r;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data: b64 } }, { type: 'text', text: PROMPT }] }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error('Anthropic ' + resp.status);
    const j = await resp.json();
    r = firstJson(j.content && j.content[0] && j.content[0].text);
  } catch (e) {
    console.error('visualSearch:', e.message);
    throw new HttpsError('unavailable', 'Non sono riuscito a leggere la foto: riprova.');
  }
  const out = cleanResult(r);
  if (!out.found || (data && data.matches) === false) return out;
  // Prodotti dal catalogo: candidati per punteggio, poi confronto delle foto
  try {
    const cands = visualCandidates(await visualIndex(env), out, 24);
    const ranked = await rerankByPhoto(env, { media_type: mt, data: b64 }, cands, { max: 8 });
    const seen = new Set(ranked.map((x) => x.p));
    out.matches = [...ranked, ...cands.filter((p) => !seen.has(p)).map((p) => ({ p, match: '' }))].slice(0, 16).map(matchView);
  } catch (e) {
    console.error('visualSearch matches:', e.message);  // il sito ripiega sulla sua ricerca
  }
  return out;
}
