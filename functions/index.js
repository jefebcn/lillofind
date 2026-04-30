/**
 * LilloFind — Cloud Functions
 * Region: europe-west1 (Belgio)
 */

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// Email notification key (non-payment, low risk)
const RESEND_API_KEY_VAL = 're_N8LAPF8P_2Qbq8HuN7F3xdDdXLfxGgwQP';

const NOTIFY_EMAIL = 'yishionvt@gmail.com';

async function sendOrderNotification(order, resendKey) {
  try {
    const itemsHtml = (order.items || []).map(i => {
      const box = i.boxOption==='con_scatola'?'📦 Con Scatola':i.boxOption==='senza_scatola'?'Senza Scatola':'—';
      const sizeBox = [i.size||'—', ['scarpe','scarpe_box'].includes(i.category||'')?box:''].filter(s=>s&&s!=='—').join(' / ') || '—';
      return `<tr><td>${i.name}</td><td>${i.brand||'—'}</td><td>${sizeBox}</td><td>x${i.qty}</td><td>€${(i.price*i.qty).toFixed(2)}</td></tr>`;
    }).join('');
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'LilloFind Orders <onboarding@resend.dev>',
        to: [NOTIFY_EMAIL],
        subject: `🛍 Nuovo Ordine ${order.orderId} — €${order.total}`,
        html: `<h2>Nuovo Ordine: ${order.orderId}</h2>
<p><b>Cliente:</b> ${order.name} — ${order.email}</p>
<p><b>Telefono:</b> ${order.phone||'—'}</p>
<p><b>Indirizzo:</b> ${order.address?.street}, ${order.address?.city} ${order.address?.zip}</p>
<p><b>Pagamento:</b> ${order.payment}</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%">
<tr><th>Prodotto</th><th>Brand</th><th>Taglia</th><th>Qtà</th><th>Prezzo</th></tr>
${itemsHtml}
</table>
<p><b>Subtotale:</b> €${order.subtotal?.toFixed(2)}<br>
<b>Spedizione:</b> €${order.shipping?.toFixed(2)}<br>
<b>Sconto:</b> -€${(order.discount||0).toFixed(2)}<br>
<b>TOTALE:</b> €${order.total?.toFixed(2)}</p>
<p><b>Note:</b> ${order.notes||'—'}</p>`,
      }),
    });
    if (!resp.ok) console.error('Resend error:', await resp.text());
  } catch(e) {
    console.error('Email notification failed:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// proxyImage  — proxy immagini server-side (bypassa hotlink Yupoo)
// Pubblico, cacheable. GET /proxyImage?url=ENCODED_URL
// ══════════════════════════════════════════════════════════════════
exports.proxyImage = onRequest({ cors: true, maxInstances: 20, timeoutSeconds: 15 }, async (req, res) => {
  const url = req.query.url;
  if (!url) { res.status(400).send('Missing url'); return; }

  let parsed;
  try { parsed = new URL(url); } catch(e) { res.status(400).send('Invalid URL'); return; }

  const ok = parsed.hostname.endsWith('.yupoo.com') || parsed.hostname.endsWith('.yunjifen.com')
    || parsed.hostname === 'yupoo.com' || parsed.hostname === 'yunjifen.com';
  if (!ok) { res.status(403).send('Host not allowed'); return; }

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://${parsed.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) { res.status(upstream.status).send('Upstream error'); return; }
    const ct = (upstream.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch(e) {
    res.status(502).send('Fetch failed: ' + e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// yupooFetch
// Proxy server-side per Yupoo — bypassa CORS.
// Solo admin. Accetta URL *.x.yupoo.com e restituisce l'HTML.
//
// Input:  { url: string }  — es. "https://woodtableguy888.x.yupoo.com/categories/4633144?page=1"
// Output: { html: string, status: number }
// ══════════════════════════════════════════════════════════════════
exports.yupooFetch = onCall({ timeoutSeconds: 30 }, async (request) => {
  // 1 — Autenticazione + check admin
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login richiesto.');
  }
  const userSnap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userSnap.data()?.isAdmin !== true) {
    throw new HttpsError('permission-denied', 'Solo gli admin possono usare questo endpoint.');
  }

  const { url } = request.data;
  if (!url || typeof url !== 'string') {
    throw new HttpsError('invalid-argument', 'Parametro url mancante.');
  }

  // 2 — Valida: domini permessi (*.yupoo.com + Taobao + Tmall)
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) {
    throw new HttpsError('invalid-argument', 'URL non valido.');
  }
  const isTaobao = parsedUrl.hostname.endsWith('.taobao.com')
    || parsedUrl.hostname.endsWith('.tmall.com')
    || parsedUrl.hostname.endsWith('.tb.cn')
    || parsedUrl.hostname === 'taobao.com'
    || parsedUrl.hostname === 'tmall.com';
  if (!parsedUrl.hostname.endsWith('.yupoo.com') && !isTaobao) {
    throw new HttpsError('invalid-argument', 'Solo URL *.yupoo.com o Taobao/Tmall sono permessi.');
  }

  // ── BRANCH TAOBAO ─────────────────────────────────────────────
  if (isTaobao) {
    const TB_HEADERS = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15A372 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': 'https://www.taobao.com/',
    };
    // Segui il redirect del short link
    let resolvedUrl = url;
    try {
      const r0 = await fetch(url, { headers: TB_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      resolvedUrl = r0.url || url;
    } catch(e) { /* usa URL originale */ }

    // Estrai item ID
    let itemId = '';
    const idMatch = resolvedUrl.match(/[?&]id=(\d+)/) || resolvedUrl.match(/item\.htm.*?(\d{10,})/);
    if (idMatch) itemId = idMatch[1];

    // Fetch pagina
    const tryUrls = itemId
      ? [`https://item.taobao.com/item.htm?id=${itemId}`, resolvedUrl]
      : [resolvedUrl];
    let html = '', finalUrl = resolvedUrl;
    for (const u of tryUrls) {
      try {
        const r = await fetch(u, { headers: TB_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (r.ok) { html = await r.text(); finalUrl = r.url; break; }
      } catch(e) { continue; }
    }
    if (!html) throw new HttpsError('unavailable', 'Impossibile caricare la pagina Taobao.');

    // Estrai titolo
    let title = '';
    const t1 = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{4,200})["']/i);
    const t2 = html.match(/"title"\s*:\s*"([^"]{10,150})"/);
    const t3 = html.match(/<title[^>]*>([^<]{4,200})<\/title>/i);
    title = ((t1||t2||t3)||[])[1] || '';
    title = title.replace(/[-|–—].*$/, '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();

    // Estrai immagini da alicdn.com
    const imgSet = new Set();
    const imgRe = /https?:\/\/[a-z0-9.\-]*alicdn\.com\/img[^"'\s,>]+\.jpg/gi;
    let mm;
    while ((mm = imgRe.exec(html)) !== null) {
      const base = mm[0].replace(/_\d+x\d+[^.]*\.(jpg|jpeg|png|webp)$/i, '') + '.jpg';
      if (!base.includes('avatar') && !base.includes('logo') && !base.includes('icon')) {
        imgSet.add(base);
        if (imgSet.size >= 8) break;
      }
    }
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (ogImg?.[1]) imgSet.add(ogImg[1].split('?')[0].replace(/_\d+x\d+/, ''));

    // Estrai prezzo
    let priceYuan = 0;
    for (const p of [/"price"\s*:\s*"?([\d.]+)"?/, /¥\s*([\d.]+)/, /"defaultItemPrice"\s*:\s*"?([\d.]+)"?/]) {
      const pm = html.match(p);
      if (pm && parseFloat(pm[1]) > 0) { priceYuan = parseFloat(pm[1]); break; }
    }

    const images = [...imgSet].slice(0, 6);
    return {
      mode: 'taobao',
      itemId,
      title,
      images,
      priceYuan,
      priceEur: priceYuan > 0 ? Math.round(priceYuan * 0.13 * 100) / 100 : 0,
      shop: (html.match(/"shopName"\s*:\s*"([^"]+)"/) || [])[1] || '',
      sourceUrl: finalUrl,
    };
  }

  // 3 — Fetch server-side (Node 20 native fetch — nessun CORS)
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': `https://${parsedUrl.hostname}/`,
      },
      redirect: 'follow',
    });
    const html = await resp.text();

    // Estrai cover URL per album ID — 4 strategie in cascata
    const albumCovers = {};

    // Helper: normalizza URL
    const norm = u => (!u ? null : u.startsWith('//') ? 'https:' + u : u);
    const isImg = u => u && (u.includes('yupoo') || u.includes('yunjifen') || /\.(jpg|jpeg|png|webp)/i.test(u));

    // Strategia 1 — JSON embedded in <script> (React/Next.js/preloaded state)
    const scriptRe = /<script[^>]*>([\s\S]{80,50000}?)<\/script>/gi;
    let sm;
    function crawlJson(obj, depth) {
      if (depth > 7 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(v => crawlJson(v, depth + 1)); return; }
      // Yupoo album object: has numeric id + cover/coverUrl
      const rawId = obj.albumId ?? obj.album_id ?? obj.id;
      const id = rawId != null ? String(rawId) : null;
      if (id && /^\d+$/.test(id)) {
        const co = obj.cover ?? obj.covers?.[0] ?? obj.coverImage ?? obj.thumbnail ?? obj.thumb;
        const cu = typeof co === 'string' ? co : (co?.url ?? co?.imageUrl ?? co?.src ?? null);
        if (cu) { const u = norm(cu); if (u && isImg(u)) albumCovers[id] = u; }
      }
      Object.values(obj).forEach(v => { if (v && typeof v === 'object') crawlJson(v, depth + 1); });
    }
    while ((sm = scriptRe.exec(html)) !== null) {
      const src = sm[1];
      // Look for large JSON-like blobs
      const jsonRe = /(\{[\s\S]{60,}?\})/g;
      let jm;
      while ((jm = jsonRe.exec(src)) !== null) {
        try { crawlJson(JSON.parse(jm[1]), 0); } catch(e) {}
        if (Object.keys(albumCovers).length > 5) break;
      }
    }

    // Strategia 2 — href="/albums/ID" (relativo O assoluto) seguito da <img>
    // Accetta sia /albums/ID sia https://domain.com/albums/ID
    const re2 = /href=["'](?:https?:\/\/[^"']*)?\/albums\/(\w+)[^"']*["'][\s\S]*?<img[^>]+(?:data-src|data-original|data-lazy|data-url|src)=["']((?:https?:)?\/\/[^"'>\s]+)["']/gs;
    let m2;
    while ((m2 = re2.exec(html)) !== null) {
      const u = norm(m2[2]);
      if (!albumCovers[m2[1]] && isImg(u)) albumCovers[m2[1]] = u;
    }

    // Strategia 3 — <img> PRIMA del href (ordine inverso nel DOM)
    const re3 = /<img[^>]+(?:data-src|data-original|data-lazy|src)=["']((?:https?:)?\/\/[^"'>\s]+)["'][\s\S]{0,600}?href=["'](?:https?:\/\/[^"']*)?\/albums\/(\w+)/gs;
    let m3;
    while ((m3 = re3.exec(html)) !== null) {
      const u = norm(m3[1]);
      if (!albumCovers[m3[2]] && isImg(u)) albumCovers[m3[2]] = u;
    }

    // Strategia 4 — Fallback posizionale: accoppia tutti gli URL immagine con tutti gli album ID
    if (!Object.keys(albumCovers).length) {
      const allPhotoUrls = [];
      const photoRe = /["']((?:https?:)?\/\/[^"'?\s]*(?:yupoo|yunjifen)[^"'?\s]{3,})["']/g;
      let pm;
      while ((pm = photoRe.exec(html)) !== null) {
        const u = norm(pm[1]);
        if (u && isImg(u) && !allPhotoUrls.includes(u)) allPhotoUrls.push(u);
      }
      const albumIdRe = /\/albums\/(\w+)/g;
      let ai; const albumIds = [];
      while ((ai = albumIdRe.exec(html)) !== null) {
        if (!albumIds.includes(ai[1])) albumIds.push(ai[1]);
      }
      albumIds.forEach((id, i) => { if (allPhotoUrls[i]) albumCovers[id] = allPhotoUrls[i]; });
    }

    // Debug info per diagnostica quando nessun album trovato
    const albumIdsInHtml = [];
    const debugRe = /\/albums\/(\w+)/g; let di;
    while ((di = debugRe.exec(html)) !== null && albumIdsInHtml.length < 5) {
      if (!albumIdsInHtml.includes(di[1])) albumIdsInHtml.push(di[1]);
    }
    const htmlPreview = html.slice(0, 400).replace(/\s+/g, ' ');

    // ── Estrazione dati album (quando URL è una pagina /albums/ID) ──
    let albumInfo = null;
    const isAlbumPage = /\/albums\/\w+/.test(parsedUrl.pathname);
    if (isAlbumPage) {
      // Titolo pagina
      const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleM ? titleM[1].replace(/\s*[-|—].*$/, '').trim() : '';

      // Testo descrizione album (contiene size + prezzo)
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

      // Taglie scarpe: "size: 40 40.5 41 42..." o "尺码: ..."
      const sizeM = bodyText.match(/(?:size|sizes|尺码|尺寸)[：:\s]+([0-9][0-9\s.\/,]+)/i);
      const sizesRaw = sizeM ? sizeM[1].trim() : '';
      const shoeSizes = sizesRaw
        ? [...new Set(sizesRaw.split(/[\s,\/]+/).filter(s => /^\d{2}(\.\d)?$/.test(s)))]
        : [];

      // Taglie abbigliamento: "S M L XL" o "XS-XXL"
      const clothM = bodyText.match(/(?:size|sizes|尺码)[：:\s]+([A-Z]{1,3}(?:\s+[A-Z]{1,3})+)/i);
      const clothSizes = clothM
        ? clothM[1].split(/\s+/).filter(s => ['XS','S','M','L','XL','XXL','XXXL'].includes(s))
        : [];

      // Prezzo fornitore in dollari
      const priceM = bodyText.match(/(\d{1,4})\s*\$/) || bodyText.match(/\$\s*(\d{1,4})/);
      const supplierPriceUSD = priceM ? parseInt(priceM[1], 10) : null;

      // Prime immagini dell'album (max 8)
      const photos = [];
      const photoRe2 = /(?:data-src|data-original|data-lazy|src)=["']((?:https?:)?\/\/[^"'>\s]+)["']/g;
      let pm2;
      while ((pm2 = photoRe2.exec(html)) !== null && photos.length < 8) {
        const u = norm(pm2[1]);
        if (u && isImg(u) && !photos.includes(u)) photos.push(u);
      }

      albumInfo = { pageTitle, shoeSizes, clothSizes, supplierPriceUSD, photos };
    }

    return { html, status: resp.status, albumCovers, albumInfo, _debug: { albumIdsInHtml, htmlPreview, htmlLen: html.length } };
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch fallito: ' + e.message);
  }
});

const db = admin.firestore();

// ══════════════════════════════════════════════════════════════════
// yupooAnalyze
// Fetcha un'immagine Yupoo server-side e la analizza con Claude Haiku.
// Restituisce: { name, brand, model, category, colors, description }
//
// Input:  { imageUrl: string }  — URL cover album Yupoo
// Output: { name, brand, model, category, colors, description }
// ══════════════════════════════════════════════════════════════════
exports.yupooAnalyze = onCall({ secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 45 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login richiesto.');

  const userSnap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userSnap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Solo admin.');

  const { imageUrl, brandHint = '', modelHint = '' } = request.data;
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
        'x-api-key': ANTHROPIC_API_KEY.value(),
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageBase64 },
            },
            {
              type: 'text',
              text: `Sei un esperto di moda, streetwear e sneaker. Analizza questa immagine prodotto e rispondi SOLO con JSON valido (nessun markdown, nessun testo extra prima o dopo):
{"name":"Brand Modello Colorway dettagliato (es. Nike Dunk Low Panda Bianco Nero)","brand":"Nike","model":"Dunk Low","category":"scarpe","colors":["Bianco","Nero"],"description":"Sneaker Nike Dunk Low colorway Panda, tomaia in pelle bianca e dettagli neri."}

Categorie disponibili (scegli la più adatta): tshirt, tshirt_branded, felpa, scarpe, scarpe_box, pantaloni, shorts, cappello, giacchetto, borsa, accessori
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
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;
  } catch (e) {
    console.error('yupooAnalyze AI error:', e.message);
    throw new HttpsError('internal', 'Analisi AI fallita: ' + e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// taobaoFetch
// Risolve un URL Taobao (anche short link e.tb.cn), scarica la pagina
// prodotto ed estrae: titolo, immagini, prezzo, brand, descrizione.
// Solo admin.
// ══════════════════════════════════════════════════════════════════
exports.taobaoFetch = onCall({ cors: true, timeoutSeconds: 40 }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login richiesto.');
  const userSnap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userSnap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Solo admin.');

  let { url } = request.data;
  if (!url || typeof url !== 'string') throw new HttpsError('invalid-argument', 'URL mancante.');

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15A372 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.taobao.com/',
  };

  // 1 — Risolvi redirect (short link e.tb.cn o m.tb.cn)
  try {
    if (url.includes('e.tb.cn') || url.includes('m.tb.cn') || url.includes('tb.cn/h.')) {
      const r = await fetch(url, { method: 'GET', headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      url = r.url || url;
    }
  } catch (e) { /* usa URL originale */ }

  // Estrai item ID da URL
  let itemId = '';
  const idMatch = url.match(/[?&]id=(\d+)/) || url.match(/item[_\.]htm.*?(\d{10,})/);
  if (idMatch) itemId = idMatch[1];

  // 2 — Prova pagina mobile Taobao (più semplice)
  const fetchUrls = [];
  if (itemId) {
    fetchUrls.push(`https://item.taobao.com/item.htm?id=${itemId}`);
    fetchUrls.push(`https://h5.m.taobao.com/awp/core/detail.htm?id=${itemId}`);
  }
  if (!fetchUrls.includes(url) && url.includes('taobao')) fetchUrls.push(url);

  let html = '';
  let finalUrl = url;
  for (const u of fetchUrls) {
    try {
      const r = await fetch(u, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (r.ok) { html = await r.text(); finalUrl = r.url; break; }
    } catch (e) { continue; }
  }

  if (!html) throw new HttpsError('unavailable', 'Impossibile caricare la pagina Taobao. Riprova o usa URL diretto.');

  // 3 — Estrai titolo
  let title = '';
  const ogTitle  = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const metaTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const jsonTitle = html.match(/"title"\s*:\s*"([^"]{10,150})"/);
  title = (ogTitle?.[1] || jsonTitle?.[1] || metaTitle?.[1] || '').replace(/[-|–—].*$/, '').trim();
  // Pulizia titolo cinese
  title = title.replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();

  // 4 — Estrai immagini (img.alicdn.com)
  const imgSet = new Set();
  const imgRe = /https?:\/\/[a-z0-9\-\.]*alicdn\.com\/img[^"'\s,]+\.jpg(?:[^"'\s,]*)?/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    // Normalizza: rimuovi resize e prendi _1200x1200 o alta risoluzione
    const base = m[0].replace(/_\d+x\d+\.\w+$/, '').replace(/\?.*$/, '');
    if (!base.includes('avatar') && !base.includes('logo') && !base.includes('icon')) {
      imgSet.add(base + '.jpg');
      if (imgSet.size >= 8) break;
    }
  }
  // Fallback: og:image
  const ogImg = html.match(/<meta[^>]+(?:property=["']og:image["']|name=["']og:image["'])[^>]+content=["']([^"']+)["']/i);
  if (ogImg?.[1]) imgSet.add(ogImg[1].split('?')[0]);

  const images = [...imgSet].filter(u => u.length > 10).slice(0, 6);

  // 5 — Estrai prezzo
  let priceYuan = 0;
  const pricePatterns = [
    /"price"\s*:\s*"?([\d.]+)"?/,
    /data-price="([\d.]+)"/,
    /"defaultItemPrice"\s*:\s*"?([\d.]+)"?/,
    /"sale_price"\s*:\s*"?([\d.]+)"?/,
    /¥\s*([\d.]+)/,
  ];
  for (const p of pricePatterns) {
    const pm = html.match(p);
    if (pm && parseFloat(pm[1]) > 0) { priceYuan = parseFloat(pm[1]); break; }
  }
  // Converti yuan → euro (approx 0.13)
  const priceEur = priceYuan > 0 ? Math.round(priceYuan * 0.13 * 100) / 100 : 0;

  // 6 — Estrai shop/brand
  let shop = '';
  const shopMatch = html.match(/"shopName"\s*:\s*"([^"]+)"/) || html.match(/data-seller-name="([^"]+)"/);
  if (shopMatch) shop = shopMatch[1];

  return {
    itemId,
    title,
    images,
    priceYuan,
    priceEur,
    shop,
    sourceUrl: finalUrl,
  };
});

// ══════════════════════════════════════════════════════════════════
// saveProduct
// Salva un prodotto in Firestore usando Admin SDK (bypassa le regole client).
// Solo admin.
// ══════════════════════════════════════════════════════════════════
exports.saveProduct = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login richiesto.');
  const userSnap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (userSnap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Solo admin.');

  const p = request.data;
  if (!p || !p.name || typeof p.price !== 'number' || p.price <= 0) {
    throw new HttpsError('invalid-argument', 'Dati prodotto non validi.');
  }

  const docData = {
    name:        String(p.name).slice(0, 200),
    price:       p.price,
    brand:       String(p.brand || '').slice(0, 100),
    model:       String(p.model || '').slice(0, 100),
    style:       String(p.model || '').slice(0, 100),
    category:    String(p.category || '').slice(0, 50),
    sizes:       Array.isArray(p.sizes) ? p.sizes.slice(0, 50) : ['S','M','L','XL'],
    size:        String(p.size || '').slice(0, 200),
    colors:      Array.isArray(p.colors) ? p.colors.slice(0, 20) : [],
    imageUrl:    String(p.imageUrl || '').slice(0, 500),
    description: String(p.description || '').slice(0, 2000),
    weightKg:    typeof p.weightKg === 'number' ? p.weightKg : 0,
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  };

  const ref = await admin.firestore().collection('products').add(docData);
  return { id: ref.id };
});

// ══════════════════════════════════════════════════════════════════════
// Admin CRUD helpers (tutti usano Admin SDK — bypass regole Firestore)
// ══════════════════════════════════════════════════════════════════════
async function checkAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login richiesto.');
  const snap = await admin.firestore().collection('users').doc(request.auth.uid).get();
  if (snap.data()?.isAdmin !== true) throw new HttpsError('permission-denied', 'Solo admin.');
}

exports.getAdminStats = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);

  const db = admin.firestore();
  const now = Date.now();
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  const cutoff30d = new Date(now - ms30d);
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [usersSnap, ordersSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('orders').get(),
  ]);

  // ── Utenti ──────────────────────────────
  let totalUsers = 0, newUsers30d = 0, usersWithOrders = new Set();
  const tierCount = { none: 0, bronze: 0, silver: 0, gold: 0, platinum: 0 };
  const topSpenders = [];

  usersSnap.forEach(d => {
    const u = d.data();
    totalUsers++;
    const created = u.createdAt?.toDate?.() || null;
    if (created && created >= cutoff30d) newUsers30d++;
    const pts = u.lfpoints || 0;
    if      (pts >= 500) tierCount.platinum++;
    else if (pts >= 200) tierCount.gold++;
    else if (pts >= 80)  tierCount.silver++;
    else if (pts >= 20)  tierCount.bronze++;
    else                 tierCount.none++;
    if ((u.totalSpent || 0) > 0) topSpenders.push({ email: u.email || d.id, spent: u.totalSpent || 0, pts, orders: u.orderCount || 0 });
  });

  topSpenders.sort((a, b) => b.spent - a.spent);
  const topSpendersTop5 = topSpenders.slice(0, 5);

  // ── Ordini ──────────────────────────────
  let totalOrders = 0, pendingOrders = 0, confirmedOrders = 0;
  let totalRevenue = 0, monthlyRevenue = 0, totalShipping = 0;
  let itemsSold = 0;
  const productSales = {};

  ordersSnap.forEach(d => {
    const o = d.data();
    totalOrders++;
    if (o.status === 'pending') pendingOrders++;
    else if (o.status === 'confirmed') confirmedOrders++;
    const rev = o.total || 0;
    totalRevenue += rev;
    totalShipping += o.shipping || 0;
    const created = o.createdAt?.toDate?.() || null;
    if (created && created >= startOfMonth) monthlyRevenue += rev;
    usersWithOrders.add(o.uid || '');
    (o.items || []).forEach(i => {
      const qty = i.qty || 1;
      itemsSold += qty;
      const key = i.name || 'Unknown';
      productSales[key] = (productSales[key] || 0) + qty;
    });
  });

  const topProducts = Object.entries(productSales)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, qty]) => ({ name, qty }));

  return {
    users: { total: totalUsers, new30d: newUsers30d, withOrders: usersWithOrders.size, tiers: tierCount },
    orders: { total: totalOrders, pending: pendingOrders, confirmed: confirmedOrders },
    revenue: { total: Math.round(totalRevenue * 100) / 100, monthly: Math.round(monthlyRevenue * 100) / 100, shipping: Math.round(totalShipping * 100) / 100 },
    itemsSold,
    topProducts,
    topSpenders: topSpendersTop5,
  };
});

exports.getAdminOrders = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);
  const snap = await admin.firestore().collection('orders').orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ _docId: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
});

exports.getAdminProducts = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);
  const snap = await admin.firestore().collection('products').orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toDate?.()?.toISOString() || null }));
});

exports.deleteAdminProduct = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);
  const { id } = request.data;
  if (!id) throw new HttpsError('invalid-argument', 'ID mancante.');
  await admin.firestore().collection('products').doc(id).delete();
  return { ok: true };
});

exports.updateAdminProduct = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);
  const { id, data } = request.data;
  if (!id || !data) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  await admin.firestore().collection('products').doc(id).update(data);
  return { ok: true };
});

exports.updateAdminOrder = onCall({ cors: true }, async (request) => {
  await checkAdmin(request);
  const { id, status } = request.data;
  if (!id || !status) throw new HttpsError('invalid-argument', 'Dati mancanti.');
  await admin.firestore().collection('orders').doc(id).update({ status });
  return { ok: true };
});

// ── Logica peso e fasce spedizione ─────────────────────────────────
const CATEGORY_WEIGHTS_SV = {
  tshirt:0.35, tshirt_branded:0.40, felpa:0.80,
  scarpe:2.00, scarpe_box:2.50, pantaloni:0.80,
  shorts:0.50, cappello:0.30, giacchetto:1.20,
  borsa:1.50, accessori:0.20,
};
const SHIPPING_TIERS_SV = [
  {maxKg:1,   price:12},
  {maxKg:3,   price:18},
  {maxKg:6,   price:25},
  {maxKg:10,  price:35},
  {maxKg:9999,price:50},
];
function getProductWeightSv(prod){
  if(prod.weightKg && prod.weightKg > 0) return prod.weightKg;
  if(prod.weight_kg && prod.weight_kg > 0) return prod.weight_kg;
  const cat = prod.category || '';
  if(cat === 'scarpe' || cat === 'scarpe_box') {
    const box = prod.boxOption || (cat === 'scarpe_box' ? 'con_scatola' : 'senza_scatola');
    return box === 'con_scatola' ? 2.5 : 2.0;
  }
  return CATEGORY_WEIGHTS_SV[cat] ?? 0.5;
}
function getShippingCostSv(totalWeightKg){
  const tier = SHIPPING_TIERS_SV.find(t => totalWeightKg <= t.maxKg);
  return tier ? tier.price : 50;
}

// ══════════════════════════════════════════════════════════════════
// createPaymentIntent
// Crea un Stripe PaymentIntent con il totale verificato server-side.
// Il client usa il clientSecret per confermare il pagamento via Stripe.js.
// ══════════════════════════════════════════════════════════════════
exports.createPaymentIntent = onCall({ secrets: [STRIPE_SECRET_KEY], cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Login richiesto.');
  }
  const { items } = request.data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError('invalid-argument', 'Carrello vuoto.');
  }

  // Valida prima di fetchare
  for (const item of items) {
    if (!item.id || typeof item.id !== 'string') {
      throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    }
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) {
      throw new HttpsError('invalid-argument', `Quantità non valida: ${item.id}`);
    }
  }

  // Leggi prezzi reali da Firestore
  let productDocs;
  try {
    productDocs = await Promise.all(items.map(item => db.collection('products').doc(item.id).get()));
  } catch (e) {
    console.error('Firestore error in createPaymentIntent:', e);
    throw new HttpsError('internal', 'Errore lettura prodotti.');
  }

  const verifiedItems = productDocs.map((snap, idx) => {
    if (!snap.exists) throw new HttpsError('not-found', `Prodotto non trovato: ${items[idx].id}`);
    const prod = snap.data();
    return {
      price: prod.price || 0,
      category: prod.category || '',
      weightKg: prod.weightKg || prod.weight_kg || 0,
      boxOption: items[idx].boxOption || '',
      qty: parseInt(items[idx].qty, 10),
      isDigital: prod.isDigital || false,
    };
  });

  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeightSv(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCostSv(totalWeight);

  // Leggi eventuale reward attivo
  let discountAmount = 0;
  try {
    const userSnap = await db.collection('users').doc(request.auth.uid).get();
    if (userSnap.exists) {
      const ar = userSnap.data().activeReward || null;
      if (ar) {
        if (ar.type === 'fisso') discountAmount = Math.min(ar.val, subtotal);
        else if (ar.type === 'percentuale') discountAmount = subtotal * (ar.val / 100);
        if (ar.freeShipping) discountAmount += shipping;
        discountAmount = Math.round(discountAmount * 100) / 100;
      }
    }
  } catch (e) { /* non bloccante */ }

  const total = Math.max(0, Math.round((subtotal + shipping - discountAmount) * 100) / 100);
  const amountCents = Math.round(total * 100);

  if (amountCents < 50) {
    throw new HttpsError('invalid-argument', 'Importo minimo €0.50 non raggiunto.');
  }

  // Crea PaymentIntent Stripe
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY.value());
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { uid: request.auth.uid, subtotal: String(subtotal), shipping: String(shipping) },
    });
    return { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id };
  } catch (e) {
    console.error('Stripe createPaymentIntent error:', e.message);
    throw new HttpsError('internal', 'Errore Stripe: ' + e.message);
  }
});

// ══════════════════════════════════════════════════════════════════
// validateOrder
// Valida i prezzi del carrello server-side, crea l'ordine e
// restituisce il totale verificato. Impedisce la price manipulation.
//
// Input:
//   items          [{id, qty, size, color}]  — solo id+qtà, NO prezzi
//   paymentMethod  'card'|'paypal'|'bonifico'
//   shippingAddress {street, city, zip, country}
//   name           string
//   phone          string
//   notes          string
//
// Output:
//   { orderId, subtotal, shipping, discount, total }
// ══════════════════════════════════════════════════════════════════
exports.validateOrder = onCall({ secrets: [STRIPE_SECRET_KEY] }, async (request) => {
  // 1 — Autenticazione obbligatoria
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Devi essere autenticato per completare un ordine.');
  }

  const uid = request.auth.uid;
  const { items, paymentMethod, shippingAddress, name, phone, notes } = request.data;

  // 2 — Validazione input base
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpsError('invalid-argument', 'Il carrello è vuoto.');
  }
  if (items.length > 100) {
    throw new HttpsError('invalid-argument', 'Troppi articoli nel carrello.');
  }

  // 3 — Leggi i prezzi REALI da Firestore (server-side, non dal client)
  const productFetches = items.map(item => {
    if (!item.id || typeof item.id !== 'string') {
      throw new HttpsError('invalid-argument', 'ID prodotto non valido.');
    }
    const qty = parseInt(item.qty, 10);
    if (!qty || qty < 1 || qty > 50) {
      throw new HttpsError('invalid-argument', `Quantità non valida per il prodotto ${item.id}.`);
    }
    return db.collection('products').doc(item.id).get();
  });

  let productDocs;
  try {
    productDocs = await Promise.all(productFetches);
  } catch (e) {
    console.error('Errore lettura prodotti:', e);
    throw new HttpsError('internal', 'Errore nel caricamento dei prodotti.');
  }

  // 4 — Costruisci gli item verificati con prezzi da Firestore
  const verifiedItems = productDocs.map((snap, idx) => {
    if (!snap.exists) {
      throw new HttpsError('not-found', `Prodotto non trovato: ${items[idx].id}`);
    }
    const prod = snap.data();
    const qty = parseInt(items[idx].qty, 10);
    return {
      id: snap.id,
      name: prod.name || '',
      price: prod.price || 0,        // prezzo REALE da Firestore
      brand: prod.brand || '',
      category: prod.category || '',
      weightKg: prod.weightKg || prod.weight_kg || 0,
      boxOption: items[idx].boxOption || '',
      qty,
      size: items[idx].size || '',
      color: items[idx].color || '',
      img: prod.imageUrl || '',
      isDigital: prod.isDigital || false,
    };
  });

  // 5 — Calcola totali (stessa logica di index.html ma server-side)
  const allDigital = verifiedItems.every(i => i.isDigital);
  const subtotal = verifiedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const physItems = verifiedItems.filter(i => !i.isDigital);
  const totalWeight = physItems.reduce((s, i) => s + getProductWeightSv(i) * i.qty, 0);
  const shipping = allDigital ? 0 : getShippingCostSv(totalWeight);
  const lfpoints = Math.floor(subtotal);

  // 6 — Leggi eventuale activeReward dell'utente da Firestore
  let discountAmount = 0;
  let activeReward = null;
  try {
    const userSnap = await db.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const udata = userSnap.data();
      activeReward = udata.activeReward || null;
      if (activeReward) {
        if (activeReward.type === 'fisso') {
          discountAmount = Math.min(activeReward.val, subtotal);
        } else if (activeReward.type === 'percentuale') {
          discountAmount = subtotal * (activeReward.val / 100);
        }
        // Se il reward include spedizione gratuita
        if (activeReward.freeShipping) {
          discountAmount += shipping;
        }
        discountAmount = Math.round(discountAmount * 100) / 100;
      }
    }
  } catch (e) {
    console.error('Errore lettura utente:', e);
    // Non bloccare l'ordine per un errore reward — procedi senza sconto
  }

  const total = Math.max(0, Math.round((subtotal + shipping - discountAmount) * 100) / 100);

  // 6b — Per pagamenti con carta, verifica PaymentIntent Stripe server-side
  if (paymentMethod === 'card') {
    const { stripePaymentIntentId } = request.data;
    if (!stripePaymentIntentId) {
      throw new HttpsError('invalid-argument', 'Pagamento con carta non completato correttamente.');
    }
    const stripe = require('stripe')(STRIPE_SECRET_KEY.value());
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(stripePaymentIntentId);
    } catch (e) {
      throw new HttpsError('invalid-argument', 'PaymentIntent non valido.');
    }
    if (pi.status !== 'succeeded') {
      throw new HttpsError('failed-precondition', 'Il pagamento non è stato completato.');
    }
    if (pi.metadata?.uid !== uid) {
      throw new HttpsError('permission-denied', 'PaymentIntent non appartiene a questo utente.');
    }
    // Verifica che l'importo corrisponda (tolleranza 1 cent per arrotondamenti)
    if (Math.abs(pi.amount - Math.round(total * 100)) > 1) {
      throw new HttpsError('failed-precondition', 'Importo del pagamento non corrisponde al totale ordine.');
    }
  }

  // 7 — Genera orderId
  const orderId = 'LILLO-' + Date.now().toString(36).toUpperCase().slice(-6);

  // 8 — Salva l'ordine in Firestore (lato server — sicuro)
  const orderData = {
    orderId,
    uid,
    email: request.auth.token.email || '',
    name: String(name || '').slice(0, 120),
    phone: String(phone || '').slice(0, 30),
    address: {
      street: String(shippingAddress?.street || '').slice(0, 200),
      city:   String(shippingAddress?.city   || '').slice(0, 100),
      zip:    String(shippingAddress?.zip    || '').slice(0, 20),
      country:String(shippingAddress?.country|| 'Italia').slice(0, 60),
    },
    notes: String(notes || '').slice(0, 500),
    items: verifiedItems,
    subtotal,
    shipping,
    discount: discountAmount,
    total,
    payment: ['card','paypal','bonifico'].includes(paymentMethod) ? paymentMethod : 'card',
    lfpoints,
    isDigitalOrder: allDigital,
    deliveryType: allDigital ? 'digital' : 'physical',
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection('orders').add(orderData);
  } catch (e) {
    console.error('Errore salvataggio ordine:', e);
    throw new HttpsError('internal', 'Errore nel salvataggio dell\'ordine. Riprova.');
  }

  // 9 — Aggiorna utente: credita LFPOINTS, aggiorna totalSpent, rimuovi reward usato
  try {
    const userRef = db.collection('users').doc(uid);
    const userSnap2 = await userRef.get();
    const currentData = userSnap2.exists ? userSnap2.data() : {};
    const newLfpoints = (currentData.lfpoints || 0) + lfpoints;
    const newTotalSpent = (currentData.totalSpent || 0) + subtotal;

    const userUpdate = {
      lfpoints: newLfpoints,
      totalSpent: newTotalSpent,
    };
    if (activeReward) {
      userUpdate.activeReward = admin.firestore.FieldValue.delete();
    }
    await userRef.update(userUpdate);
  } catch (e) {
    console.error('Errore aggiornamento utente (non critico):', e);
    // Non bloccare — l'ordine è già stato creato
  }

  // 10 — Invia notifica email (fire-and-forget)
  sendOrderNotification({ ...orderData, orderId, subtotal, shipping, discount: discountAmount, total }, RESEND_API_KEY_VAL);

  // 11 — Ritorna al client i dati verificati
  return { orderId, subtotal, shipping, discount: discountAmount, total, lfpoints };
});
