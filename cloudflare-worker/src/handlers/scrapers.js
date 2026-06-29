// ════════════════════════════════════════════════════════════════
// Handler SCRAPER (admin import) — yupooAnalyze + yupooFetch.
//
// yupooAnalyze: portato (fetch immagine + analisi Claude).
// yupooFetch:   da migrare (570 righe con 9 strategie auth Yupoo +
//               branch Taobao/AliExpress). È admin-only e fragile:
//               viene portato come ultima fase. Vedi README.
// ════════════════════════════════════════════════════════════════

import { HttpsError } from '../lib/errors.js';

// ── yupooAnalyze ────────────────────────────────────────────────
export async function yupooAnalyze(data, { env }) {
  const { imageUrl, brandHint = '', modelHint = '' } = data || {};
  if (!imageUrl || typeof imageUrl !== 'string') throw new HttpsError('invalid-argument', 'imageUrl mancante.');

  const url = imageUrl.startsWith('//') ? 'https:' + imageUrl : imageUrl;

  // 1 — Fetch immagine server-side (bypassa CORS Yupoo)
  let imageBase64, mediaType;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.yupoo.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    mediaType = ct.split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) mediaType = 'image/jpeg';
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 4.5 * 1024 * 1024) throw new Error('Immagine troppo grande (>4.5MB)');
    imageBase64 = Buffer.from(buf).toString('base64');
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch immagine fallito: ' + e.message);
  }

  // 2 — Analisi con Claude Haiku via API diretta
  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 420,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            {
              type: 'text',
              text: `Sei un esperto di moda, streetwear e sneaker. Analizza questa immagine prodotto e rispondi SOLO con JSON valido (nessun markdown, nessun testo extra prima o dopo):
{"name":"Brand Modello Colorway dettagliato (es. Nike Dunk Low Panda Bianco Nero)","brand":"Nike","model":"Dunk Low","category":"scarpe","colors":["Bianco","Nero"],"description":"Sneaker Nike Dunk Low colorway Panda, tomaia in pelle bianca e dettagli neri.","supplierPrice":null,"supplierCurrency":null}

Categorie disponibili (scegli la più adatta): tshirt, tshirt_branded, felpa, scarpe, scarpe_box, pantaloni, shorts, cappello, giacchetto, borsa, accessori
PREZZO: Se nell'immagine è visibile un prezzo (cartellino, etichetta, testo sovrapposto con ¥ $ €), inserisci il valore numerico in "supplierPrice" e la valuta in "supplierCurrency" (CNY, USD o EUR). Esempio: prezzo "¥128" → "supplierPrice":128,"supplierCurrency":"CNY". Se non visibile lascia null.
${brandHint || modelHint ? `\nL'utente indica che questo prodotto è probabilmente: ${[brandHint, modelHint].filter(Boolean).join(' — ')}. Usa questo come riferimento forte e identifica il modello e colorway specifici dall'immagine.` : 'Se non identificabile con certezza, usa valori plausibili in base a ciò che vedi.'}`,
            },
          ],
        }],
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      throw new Error('Anthropic ' + aiResp.status + ': ' + errText.slice(0, 300));
    }
    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '{}').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Risposta AI non contiene JSON: ' + text.slice(0, 100));
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('yupooAnalyze AI error:', e.message);
    throw new HttpsError('internal', 'Analisi AI fallita: ' + e.message);
  }
}

// ── yupooFetch (da migrare — ultima fase) ───────────────────────
export async function yupooFetch(_data, _ctx) {
  throw new HttpsError('unavailable',
    'Lo scraper Yupoo/Taobao non è ancora stato migrato su Cloudflare. ' +
    'È in arrivo nella fase finale. Nel frattempo puoi aggiungere prodotti ' +
    'manualmente dal pannello admin.');
}
