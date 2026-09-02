// ════════════════════════════════════════════════════════════════
// Handler SCRAPER (admin import) — yupooFetch + yupooAnalyze.
// Port fedele delle Cloud Functions. Quasi tutto è fetch + regex,
// compatibile con i Workers (Buffer via nodejs_compat).
// ════════════════════════════════════════════════════════════════

import { HttpsError } from '../lib/errors.js';

const IMGBB_KEY = '4e0f0e5bfe97cdcf39838aa5a82abb75';

// ════════════════════════════════════════════════════════════════
// Helper: autenticazione Yupoo password-protected
// → { cookies, html?, apiAlbums?, debug }
// ════════════════════════════════════════════════════════════════
async function yupooPasswordAuth(baseUrl, password) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const dbg = [];

  let initHtml = '', initCookies = [];
  try {
    const r = await fetch(baseUrl, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'follow', signal: AbortSignal.timeout(25000),
    });
    initHtml = await r.text();
    initCookies = r.headers.getSetCookie?.() || [];
    dbg.push(`GET → ${r.status}, ${initHtml.length} chars, cookies: [${initCookies.map(c => c.split('=')[0]).join(',')}]`);
  } catch (e) {
    dbg.push(`GET failed: ${e.message}`);
  }

  const isPasswordPage = /type=["']password["']|name=["']password["']|id=["']password["']/i.test(initHtml);
  const isSpaShell = !isPasswordPage && (
    initHtml.includes('opacity: 0') || initHtml.includes('//undefined') ||
    (initHtml.length < 40000 && initHtml.includes('yupoo') && initHtml.includes('<script'))
  );
  dbg.push(`template: isPasswordPage=${isPasswordPage} isSpaShell=${isSpaShell}`);

  if (!isPasswordPage && !isSpaShell && initHtml.length > 0) {
    dbg.push('Pagina classic già aperta — nessun form password trovato');
    return { cookies: initCookies.map(c => c.split(';')[0]).join('; '), debug: dbg };
  }

  let csrfToken = '';
  for (const p of [
    /name=["']_token["'][^>]*value=["']([^"']+)["']/,
    /value=["']([^"']+)["'][^>]*name=["']_token["']/,
    /<meta[^>]+name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i,
    /"csrfToken"\s*:\s*"([^"]{20,})"/,
    /"_token"\s*:\s*"([^"]{20,})"/,
  ]) { const m = initHtml.match(p); if (m) { csrfToken = m[1]; break; } }

  const xsrfRaw = initCookies.find(c => /^XSRF-TOKEN=/i.test(c));
  const xsrfVal = xsrfRaw ? decodeURIComponent(xsrfRaw.split(';')[0].split('=').slice(1).join('=')) : '';

  let formAction = baseUrl;
  const actionM = initHtml.match(/<form[^>]*method=["']post["'][^>]*action=["']([^"']+)["']/i)
               || initHtml.match(/<form[^>]*action=["']([^"']+)["'][^>]*method=["']post["']/i);
  if (actionM) {
    const a = actionM[1];
    formAction = a.startsWith('http') ? a : new URL(a, baseUrl).href;
  }
  const parsedBase = new URL(baseUrl);
  const categoryId = parsedBase.pathname.split('/').filter(Boolean).pop();

  dbg.push(`csrf="${csrfToken.slice(0, 16)}…" xsrf="${xsrfVal.slice(0, 16)}…" catId="${categoryId}"`);

  function mergeCookies(arrays) {
    const map = {};
    arrays.flat().forEach(c => {
      const nv = c.split(';')[0].trim();
      const eq = nv.indexOf('=');
      if (eq > 0) map[nv.slice(0, eq).trim()] = nv;
    });
    return Object.values(map).join('; ');
  }

  const initCookieStr = initCookies.map(c => c.split(';')[0]).join('; ');
  const baseHeaders = {
    'User-Agent': UA, 'Accept': 'text/html,application/json,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Referer': baseUrl,
    ...(initCookieStr ? { 'Cookie': initCookieStr } : {}),
    ...(xsrfVal ? { 'X-XSRF-TOKEN': xsrfVal } : {}),
  };

  const albumsApiUrl = `${parsedBase.origin}/api/v2/albums?categoryId=${categoryId}&page=1&limit=10`;

  const strategies = [
    { url: `${parsedBase.origin}/api/v2/categories/${categoryId}/authorize`, body: JSON.stringify({ password }), ct: 'json' },
    { url: `${parsedBase.origin}/api/v2/categories/${categoryId}/verify`,    body: JSON.stringify({ password }), ct: 'json' },
    { url: `${parsedBase.origin}/api/categories/${categoryId}/authorize`,    body: JSON.stringify({ password }), ct: 'json' },
    { url: `${parsedBase.origin}/api/v2/authorize`, body: JSON.stringify({ id: categoryId, type: 'category', password }), ct: 'json' },
    { url: formAction, body: new URLSearchParams({ _token: csrfToken, password }), ct: 'form' },
    { url: baseUrl,    body: new URLSearchParams({ password }), ct: 'form' },
    { url: `${parsedBase.origin}/categories/${categoryId}/password`, body: new URLSearchParams({ _token: csrfToken, password }), ct: 'form' },
    { url: `${parsedBase.origin}/albums/${categoryId}/password`,     body: new URLSearchParams({ _token: csrfToken, password }), ct: 'form' },
    { url: `${parsedBase.origin}/api/v2/verify_password`, body: JSON.stringify({ id: categoryId, password }), ct: 'json' },
  ];

  for (const [i, s] of strategies.entries()) {
    const label = String.fromCharCode(65 + i);
    try {
      const authResp = await fetch(s.url, {
        method: 'POST',
        headers: { ...baseHeaders, 'Content-Type': s.ct === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
        body: s.ct === 'json' ? s.body : s.body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
      });
      const authCookies = authResp.headers.getSetCookie?.() || [];
      const loc = authResp.headers.get('location') || '';
      const authBodyRaw = await authResp.text().catch(() => '');
      dbg.push(`[${label}] POST ${s.url} → ${authResp.status} loc="${loc.slice(0, 50)}" body="${authBodyRaw.slice(0, 100)}" cookies=[${authCookies.map(c => c.split('=')[0]).join(',')}]`);

      const gotCookies = authCookies.length > 0;
      const redirected = authResp.status === 302 || authResp.status === 301;
      const jsonOk = authResp.status === 200 && s.ct === 'json' && /success|"code"\s*:\s*0|"ok"\s*:\s*true/i.test(authBodyRaw);
      if (!gotCookies && !redirected && !jsonOk) continue;

      const merged = mergeCookies([initCookies, authCookies]);

      try {
        const vApiResp = await fetch(albumsApiUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'application/json, */*', 'X-Requested-With': 'XMLHttpRequest', 'Referer': baseUrl, 'Cookie': merged },
          signal: AbortSignal.timeout(8000),
        });
        const vApiCt = vApiResp.headers.get('content-type') || '';
        const vApiCookies = vApiResp.headers.getSetCookie?.() || [];
        const vApiBody = await vApiResp.text().catch(() => '');
        dbg.push(`[${label}] verify albums API → ${vApiResp.status} ct="${vApiCt}" body="${vApiBody.slice(0, 150)}"`);
        if (vApiResp.ok && vApiCt.includes('json')) {
          const finalCookies = mergeCookies([initCookies, authCookies, vApiCookies]);
          dbg.push(`[${label}] ✅ AUTH OK (via API)`);
          let apiAlbums = null;
          try { apiAlbums = JSON.parse(vApiBody); } catch (e) {}
          return { cookies: finalCookies, apiAlbums, debug: dbg };
        }
      } catch (e) { dbg.push(`[${label}] verify API failed: ${e.message}`); }

      try {
        const vResp = await fetch(baseUrl, {
          headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Cookie': merged },
          redirect: 'follow', signal: AbortSignal.timeout(12000),
        });
        const vHtml = await vResp.text();
        const vCookies = vResp.headers.getSetCookie?.() || [];
        const stillForm = /type=["']password["']|name=["']password["']/i.test(vHtml);
        dbg.push(`[${label}] verify HTML → ${vResp.status}, ${vHtml.length} chars, stillForm=${stillForm}`);
        if (!stillForm) {
          const finalCookies = mergeCookies([initCookies, authCookies, vCookies]);
          dbg.push(`[${label}] ✅ AUTH OK (HTML verify)`);
          return { cookies: finalCookies, html: vHtml, debug: dbg };
        }
      } catch (e) { dbg.push(`[${label}] verify HTML failed: ${e.message}`); }
    } catch (e) { dbg.push(`[${label}] errore: ${e.message}`); }
  }

  dbg.push('❌ tutte le strategie fallite');
  return { cookies: initCookieStr, debug: dbg };
}

// ════════════════════════════════════════════════════════════════
// uploadImage — carica un'immagine (base64) su imgbb e ritorna l'URL.
// Sostituisce Firebase Storage (che richiede Blaze) per yupoo-scraper.html.
// Input:  { imageBase64: string }  (base64 puro, senza prefisso data:)
// Output: { url: string }
// ════════════════════════════════════════════════════════════════
export async function uploadImage(data, { env }) {
  let b64 = (data && data.imageBase64) || '';
  if (!b64) throw new HttpsError('invalid-argument', 'Immagine mancante.');
  // togli eventuale prefisso data:...;base64,
  const comma = b64.indexOf('base64,');
  if (comma >= 0) b64 = b64.slice(comma + 7);
  if (b64.length > 40 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Immagine troppo grande.');

  const form = new URLSearchParams();
  form.append('key', env.IMGBB_KEY || IMGBB_KEY);
  form.append('image', b64);
  try {
    const res = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST', body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json?.error?.message || 'imgbb error');
    return { url: json.data.url };
  } catch (e) {
    throw new HttpsError('internal', 'Upload immagine fallito: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// yupooFetch — proxy/scraper Yupoo + Taobao/Tmall/AliExpress
// ════════════════════════════════════════════════════════════════
// Estrae l'URL prodotto ORIGINALE (Weidian/Taobao/1688/Tmall) da un link di
// un "agent" (Kakobuy, CNFans, Mulebuy, Hoobuy, AcBuy, Sifukj…): questi link
// incapsulano l'articolo originale in un query param (?url=…, itemUrl, goodsUrl)
// oppure in id + piattaforma (shop_type/platform=weidian&id=…). Ritorna null se
// non è un link agent riconosciuto.
function unwrapAgentUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const AGENT = /(?:^|\.)(kakobuy|cnfans|mulebuy|hoobuy|acbuy|allchinabuy|sifukj|kameymall|orientdig|joyabuy|ponybuy|superbuy|pandabuy|basetao|cssbuy|wegobuy|hagobuy|loongbuy|itaobuy|oopbuy|lovegobuy|eastmallbuy)\.com$/i;
  if (!AGENT.test(u.hostname)) return null;
  // Deve essere un URL di un SINGOLO PRODOTTO (non un negozio): richiede un
  // token da articolo ed esclude i link negozio (userid=/shopId=).
  const isItem = (s) => /(?:weidian|koudai|taobao|tmall|1688|jd)\.com/i.test(s)
    && /(item\.html|item\.htm|itemID=|itemid=|goodsId=|goods_id=|\/item\/|\/offer\/|offerId=)/i.test(s)
    && !/userid=|shopId=|shop_id=/i.test(s);
  // 1) un query param che contiene direttamente l'URL originale
  for (const [, v] of u.searchParams) {
    let dec = v; try { dec = decodeURIComponent(v); } catch (_) {}
    if (isItem(dec)) return dec.startsWith('http') ? dec : ('https://' + dec.replace(/^\/+/, ''));
  }
  // 2) id + piattaforma → ricostruisci l'URL item
  const gid = u.searchParams.get('id') || u.searchParams.get('goodsId') || u.searchParams.get('goods_id')
    || u.searchParams.get('itemID') || u.searchParams.get('itemId') || u.searchParams.get('offerId');
  const plat = (u.searchParams.get('shop_type') || u.searchParams.get('platform') || u.searchParams.get('channel')
    || u.searchParams.get('shopType') || u.searchParams.get('mall') || '').toLowerCase();
  if (gid && /^\d{5,}$/.test(gid)) {
    if (/weidian|koudai|wd/.test(plat)) return `https://weidian.com/item.html?itemID=${gid}`;
    if (/taobao|tmall|tb/.test(plat))   return `https://item.taobao.com/item.htm?id=${gid}`;
    if (/1688|ali/.test(plat))          return `https://detail.1688.com/offer/${gid}.html`;
  }
  return null;
}

export async function yupooFetch(data, _ctx) {
  const { url: rawUrl, password } = data || {};
  if (!rawUrl || typeof rawUrl !== 'string') throw new HttpsError('invalid-argument', 'Parametro url mancante.');
  // Se è un link di un agent (Kakobuy & simili), scarta il wrapper e usa
  // l'URL prodotto originale che c'è dentro.
  const url = unwrapAgentUrl(rawUrl) || rawUrl;

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) { throw new HttpsError('invalid-argument', 'URL non valido.'); }
  const isTaobao = parsedUrl.hostname.endsWith('.taobao.com')
    || parsedUrl.hostname.endsWith('.tmall.com')
    || parsedUrl.hostname.endsWith('.tb.cn')
    || parsedUrl.hostname.endsWith('.aliexpress.com')
    || parsedUrl.hostname === 'taobao.com'
    || parsedUrl.hostname === 'tmall.com'
    || parsedUrl.hostname === 'aliexpress.com';
  const isWeidian = parsedUrl.hostname.endsWith('.weidian.com')
    || parsedUrl.hostname === 'weidian.com'
    || parsedUrl.hostname.endsWith('.koudai.com')
    || parsedUrl.hostname === 'koudai.com';
  if (!parsedUrl.hostname.endsWith('.yupoo.com') && !isTaobao && !isWeidian) {
    throw new HttpsError('invalid-argument', 'Solo URL Yupoo, Taobao/Tmall, AliExpress, Weidian o link agent (Kakobuy, CNFans…) di un singolo prodotto.');
  }

  // ── BRANCH WEIDIAN ────────────────────────────────────────────
  if (isWeidian) {
    return await weidianFetch(url);
  }

  // ── BRANCH TAOBAO / ALIEXPRESS ────────────────────────────────
  if (isTaobao) {
    const UA_BAIDU = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';
    const UA_DESK  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const UA_MOB   = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const HDR_ZH   = { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,it;q=0.7', 'Accept': 'text/html,*/*;q=0.8' };

    function extractId(u) {
      if (!u) return '';
      const m = u.match(/[?&]id=(\d{8,})/)
             || u.match(/\/item\/(\d{10,})/)
             || u.match(/[?&]itemId=(\d{8,})/)
             || u.match(/\/(\d{10,})[.?#]/);
      return m ? m[1] : '';
    }

    let itemId = extractId(url);
    let resolvedUrl = url;
    if (!itemId) {
      let currentUrl = url;
      for (let hop = 0; hop < 6 && currentUrl; hop++) {
        try {
          const r = await fetch(currentUrl, { headers: { 'User-Agent': UA_DESK, ...HDR_ZH }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
          const loc = r.headers.get('location') || '';
          const next = loc.startsWith('http') ? loc : (loc ? new URL(loc, currentUrl).href : '');
          itemId = extractId(currentUrl) || extractId(loc) || extractId(next);
          resolvedUrl = next || currentUrl;
          if (itemId || !next || next === currentUrl) break;
          currentUrl = next;
        } catch (e) { break; }
      }
    }
    if (!itemId) {
      for (const ua of [UA_DESK, UA_BAIDU, UA_MOB]) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': ua, ...HDR_ZH }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
          itemId = extractId(r.url);
          if (itemId) { resolvedUrl = r.url; break; }
        } catch (e) {}
      }
    }
    console.log(`[TB] url=${url} resolved=${resolvedUrl} itemId=${itemId}`);

    let html = '', htmlSource = '';
    const isResolvedAliExpress = resolvedUrl && resolvedUrl.includes('aliexpress.com');
    const isInputAliExpress = url.includes('aliexpress.com');
    const fetchAttempts = [];
    if (isResolvedAliExpress) fetchAttempts.push({ url: resolvedUrl, ua: UA_DESK, ref: 'https://www.aliexpress.com/' });
    if (isInputAliExpress) fetchAttempts.push({ url, ua: UA_DESK, ref: 'https://www.aliexpress.com/' });
    if (resolvedUrl && resolvedUrl !== url && !isResolvedAliExpress) {
      fetchAttempts.push({ url: resolvedUrl, ua: UA_DESK });
      fetchAttempts.push({ url: resolvedUrl, ua: UA_BAIDU });
    }
    if (itemId) {
      fetchAttempts.push(
        { url: `https://detail.tmall.com/item.htm?id=${itemId}`, ua: UA_BAIDU },
        { url: `https://detail.tmall.com/item.htm?id=${itemId}`, ua: UA_DESK },
        { url: `https://www.aliexpress.com/item/${itemId}.html`, ua: UA_DESK, ref: 'https://www.aliexpress.com/' },
        { url: `https://it.aliexpress.com/item/${itemId}.html`,  ua: UA_DESK, ref: 'https://www.aliexpress.com/' },
        { url: `https://world.taobao.com/item/${itemId}.htm`, ua: UA_DESK },
        { url: `https://world.taobao.com/item/${itemId}.htm`, ua: UA_BAIDU },
        { url: `https://item.taobao.com/item.htm?id=${itemId}`, ua: UA_BAIDU },
        { url: `https://item.taobao.com/item.htm?id=${itemId}`, ua: UA_DESK },
        { url: `https://h5.m.taobao.com/awp/core/detail.htm?id=${itemId}`, ua: UA_MOB },
      );
    }

    for (const att of fetchAttempts) {
      if (html) break;
      try {
        const ref = att.ref || 'https://www.taobao.com/';
        const r = await fetch(att.url, { headers: { 'User-Agent': att.ua, ...HDR_ZH, 'Referer': ref }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
        const txt = r.ok ? await r.text() : '';
        const looksUseful = txt.length > 3000 && (
          txt.includes('alicdn') || txt.includes('ae01.alicdn') ||
          txt.includes('og:title') || txt.includes('og:image') ||
          txt.includes('"title"') || txt.includes('item')
        );
        if (looksUseful) { html = txt; htmlSource = att.url; }
      } catch (e) {}
    }

    let title = '';
    if (html) {
      const ogT = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{4,300})["']/i)
               || html.match(/<meta[^>]+content=["']([^"']{4,300})["'][^>]*property=["']og:title["']/i);
      if (ogT) title = ogT[1];
      if (!title) {
        const patterns = [
          /"title"\s*:\s*"([^"]{8,200})"/, /"itemTitle"\s*:\s*"([^"]{8,200})"/,
          /"name"\s*:\s*"([^"]{8,200})"/, /data-title="([^"]{8,200})"/,
        ];
        for (const p of patterns) {
          const m = html.match(p);
          if (m && !m[1].includes('taobao') && !m[1].includes('淘宝')) { title = m[1]; break; }
        }
      }
      if (!title) { const tM = html.match(/<title[^>]*>([^<]{6,300})<\/title>/i); if (tM) title = tM[1]; }
      if (!title) { const descM = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{8,})["']/i); if (descM) title = descM[1].split('。')[0].split(',')[0].trim(); }
    }
    title = (title || '')
      .replace(/[-–—|]?\s*(淘宝|天猫|Taobao|Tmall|AliExpress|tmall\.com).*$/gi, '')
      .replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();

    const imgSet = new Set();
    if (html) {
      const imgRe = /(?:https?:)?\/\/(?:[a-z0-9\-]+\.)?(?:alicdn|ae01\.alicdn|aechoice)\.com\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp)/gi;
      let mm;
      while ((mm = imgRe.exec(html)) !== null && imgSet.size < 8) {
        let u = mm[0]; if (u.startsWith('//')) u = 'https:' + u;
        const clean = u.replace(/[?#_!].*$/, '').replace(/_\d+x\d+[a-z]*\.\w+$/, '');
        if (!clean.includes('avatar') && !clean.includes('logo') && !clean.includes('icon') &&
            !clean.includes('placeholder') && !clean.includes('default') && clean.length > 30)
          imgSet.add(clean + (clean.match(/\.(jpg|jpeg|png|webp)$/i) ? '' : '.jpg'));
      }
      const ogI = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
               || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
      if (ogI?.[1]) { let u = ogI[1]; if (u.startsWith('//')) u = 'https:' + u; imgSet.add(u.replace(/[?#].*$/, '')); }
    }
    let images = [...imgSet].filter(u => u.length > 20).slice(0, 6);

    let priceYuan = 0;
    if (html) {
      const isAliEx = htmlSource.includes('aliexpress');
      const pricePs = [
        ...(isAliEx ? [
          /"minActivityAmount"\s*:\s*\{"value"\s*:\s*"?([\d.]+)"?/,
          /"formatedPrice"\s*:\s*"(?:US )?\$?([\d.]+)"/,
          /"salePrice"\s*:\s*\{"value"\s*:\s*"?([\d.]+)"?/,
          /"price"\s*:\s*\{"value"\s*:\s*"?([\d.]+)"?/,
        ] : []),
        /"price"\s*:\s*"([\d]+(?:\.\d{1,2})?)"/,
        /"defaultItemPrice"\s*:\s*"([\d]+(?:\.\d{1,2})?)"/,
        /"sale_price"\s*:\s*"([\d]+(?:\.\d{1,2})?)"/,
        /data-price="([\d]+(?:\.\d{1,2})?)"/,
        /\\"price\\":\\"([\d]+(?:\.\d{1,2})?)\\"/,
        /¥\s*([\d]{1,5}(?:\.\d{2})?)/,
        /"priceWap"\s*:\s*"([\d]+(?:\.\d{1,2})?)"/,
      ];
      for (const p of pricePs) {
        const pm = html.match(p);
        const v = pm ? parseFloat(pm[1]) : 0;
        if (v > 0 && v < 100000) { priceYuan = v; break; }
      }
    }
    if (!priceYuan) {
      const urlPriceM = (resolvedUrl || url).match(/[?&]price=([\d.]+)/);
      if (urlPriceM) priceYuan = parseFloat(urlPriceM[1]);
    }

    let imgbbUrl = '';
    const firstImg = images[0] || '';
    if (firstImg) {
      try {
        const imgResp = await fetch(firstImg, { headers: { 'User-Agent': UA_DESK, 'Referer': 'https://www.taobao.com/', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
        if (imgResp.ok) {
          const buf = Buffer.from(await imgResp.arrayBuffer());
          const form = new URLSearchParams();
          form.append('key', IMGBB_KEY);
          form.append('image', buf.toString('base64'));
          const ibRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000) });
          const ibJson = await ibRes.json();
          if (ibJson.success) imgbbUrl = ibJson.data.url;
        }
      } catch (e) { console.warn('[TB] imgbb failed:', e.message); }
    }

    const shop = html ? ((html.match(/"shopName"\s*:\s*"([^"]{2,60})"/) || [])[1] || '') : '';
    console.log(`[TB] result: title="${title}" images=${images.length} price=${priceYuan} itemId=${itemId} htmlLen=${html.length}`);

    return {
      mode: 'taobao', itemId, title,
      images: imgbbUrl ? [imgbbUrl, ...images.slice(1)] : images,
      imgbbUrl, priceYuan,
      priceEur: priceYuan > 0
        ? (htmlSource.includes('aliexpress') ? Math.round(priceYuan * 100) / 100 : Math.round(priceYuan * 0.13 * 100) / 100)
        : 0,
      shop, sourceUrl: resolvedUrl || url,
      _debug: { htmlLen: html.length, htmlSource, imgCount: images.length, itemId, resolvedUrl, hasTitle: !!title, hasImages: images.length > 0, hasPrice: priceYuan > 0 },
    };
  }

  // ── BRANCH YUPOO ──────────────────────────────────────────────
  let authCookieStr = '', authDebug = [], authHtml = null, authApiAlbums = null;
  if (password && typeof password === 'string' && password.trim().length > 0) {
    const pwd = password.trim();
    // Yupoo moderno (website 4.x): la protezione password è LATO CLIENT.
    // Il server restituisce l'HTML sbloccato se si invia il cookie in chiaro.
    // Due livelli di gate (vedi common.js): "indexlockcode" sblocca la lista
    // categorie/album, "lockcode" sblocca la PAGINA del singolo album. Le pagine
    // /albums/{id} protette restano bloccate (niente nome/prezzo) se manca
    // "lockcode": impostiamo entrambi con la stessa password.
    const pe = encodeURIComponent(pwd);
    authCookieStr = `indexlockcode=${pe}; lockcode=${pe}; language=zh-CN`;
    authDebug.push(`gate moderno: set Cookie indexlockcode+lockcode (password len ${pwd.length})`);
    console.log('[yupoo auth]', JSON.stringify(authDebug));
  }

  try {
    let html, resp;
    if (authHtml) {
      html = authHtml;
      resp = { status: 200 };
    } else {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Referer': `https://${parsedUrl.hostname}/`,
          ...(authCookieStr ? { 'Cookie': authCookieStr } : {}),
        },
        redirect: 'follow',
      });
      html = await resp.text();
      // Yupoo moderno: le pagine album richiedono ?uid=<owner> — senza il
      // parametro rispondono 404 "页面未找到" (niente nome/prezzo). Se manca,
      // riprova aggiungendo uid=1 (l'owner più comune degli store single-user).
      if ((resp.status === 404 || /页面未找到/.test(html))
          && /\/albums\/\w+/.test(parsedUrl.pathname) && !parsedUrl.searchParams.has('uid')) {
        const retryUrl = url + (url.includes('?') ? '&' : '?') + 'uid=1';
        authDebug.push(`album 404 senza uid → retry ${retryUrl}`);
        const r2 = await fetch(retryUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': `https://${parsedUrl.hostname}/`,
            ...(authCookieStr ? { 'Cookie': authCookieStr } : {}),
          },
          redirect: 'follow',
        });
        if (r2.ok) { resp = r2; html = await r2.text(); }
      }
    }

    const albumCovers = {};
    const albumPrices = {};
    // uid dell'owner dello store: gli href album sono "/albums/{id}?uid={N}".
    // Serve al client per costruire URL album validi (senza uid → 404).
    const uidM = html.match(/\/albums\/\w+\?uid=(\d+)/);
    const albumUid = uidM ? uidM[1] : null;
    const norm = u => (!u ? null : u.startsWith('//') ? 'https:' + u : u);
    const isImg = u => u && (u.includes('yupoo') || u.includes('yunjifen') || /\.(jpg|jpeg|png|webp)/i.test(u));

    const scriptRe = /<script[^>]*>([\s\S]{80,50000}?)<\/script>/gi;
    let sm;
    function crawlJson(obj, depth) {
      if (depth > 8 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(v => crawlJson(v, depth + 1)); return; }
      const rawId = obj.albumId ?? obj.album_id ?? obj.id;
      const id = rawId != null ? String(rawId) : null;
      if (id && /^\d{5,}$/.test(id)) {
        const co = obj.cover ?? obj.covers?.[0] ?? obj.coverImage ?? obj.thumbnail ?? obj.thumb ?? obj.image ?? obj.img;
        const cu = typeof co === 'string' ? co : (co?.url ?? co?.imageUrl ?? co?.src ?? co?.path ?? null);
        if (cu) { const u = norm(cu); if (u && isImg(u)) albumCovers[id] = u; }
        const rawPrice = obj.price ?? obj.priceYuan ?? obj.sellingPrice ?? obj.salePrice ?? obj.originalPrice ?? null;
        const priceNum = typeof rawPrice === 'number' ? rawPrice : (typeof rawPrice === 'string' ? parseFloat(rawPrice) : null);
        if (priceNum && priceNum > 0 && priceNum < 50000 && !albumPrices[id]) albumPrices[id] = { value: priceNum, currency: 'CNY' };
      }
      Object.values(obj).forEach(v => { if (v && typeof v === 'object') crawlJson(v, depth + 1); });
    }

    if (authApiAlbums) crawlJson(authApiAlbums, 0);

    const nextDataM = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/i);
    if (nextDataM) { try { crawlJson(JSON.parse(nextDataM[1]), 0); } catch (e) {} }

    while ((sm = scriptRe.exec(html)) !== null && Object.keys(albumCovers).length < 3) {
      const src = sm[1];
      const jsonRe = /(\{[\s\S]{60,}?\})/g;
      let jm;
      while ((jm = jsonRe.exec(src)) !== null) {
        try { crawlJson(JSON.parse(jm[1]), 0); } catch (e) {}
        if (Object.keys(albumCovers).length > 5) break;
      }
    }

    const re2 = /href=["'](?:https?:\/\/[^"']*)?\/albums\/(\w+)[^"']*["'][\s\S]*?<img[^>]+(?:data-src|data-original|data-lazy|data-url|src)=["']((?:https?:)?\/\/[^"'>\s]+)["']/gs;
    let m2;
    while ((m2 = re2.exec(html)) !== null) {
      const u = norm(m2[2]);
      if (!albumCovers[m2[1]] && isImg(u)) albumCovers[m2[1]] = u;
    }

    const re3 = /<img[^>]+(?:data-src|data-original|data-lazy|src)=["']((?:https?:)?\/\/[^"'>\s]+)["'][\s\S]{0,600}?href=["'](?:https?:\/\/[^"']*)?\/albums\/(\w+)/gs;
    let m3;
    while ((m3 = re3.exec(html)) !== null) {
      const u = norm(m3[1]);
      if (!albumCovers[m3[2]] && isImg(u)) albumCovers[m3[2]] = u;
    }

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
      while ((ai = albumIdRe.exec(html)) !== null) { if (!albumIds.includes(ai[1])) albumIds.push(ai[1]); }
      albumIds.forEach((id, i) => { if (allPhotoUrls[i]) albumCovers[id] = allPhotoUrls[i]; });
    }

    if (!Object.keys(albumCovers).length) {
      const UA_API = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      const shopName = parsedUrl.hostname.split('.')[0];
      const catMatch = parsedUrl.pathname.match(/\/categories\/(\d+)/);
      const catId = catMatch?.[1] || '';
      const apiCandidates = catId ? [
        `https://${parsedUrl.hostname}/api/v2/albums?categoryId=${catId}&page=1&limit=100`,
        `https://${parsedUrl.hostname}/api/v2/albums?category_id=${catId}&page=1&limit=100`,
        `https://api.yupoo.com/yupoo/album/listbycategory?categoryId=${catId}&owner=${shopName}&page=1&pageSize=100`,
        `https://${parsedUrl.hostname}/api/albums?cid=${catId}&page=1`,
        `https://${parsedUrl.hostname}/categories/${catId}/albums?page=1`,
      ] : [];
      const ajaxHeaders = {
        'User-Agent': UA_API, 'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://${parsedUrl.hostname}/categories/${catId}`,
        ...(authCookieStr ? { 'Cookie': authCookieStr } : {}),
      };
      const apiResults = await Promise.allSettled(
        apiCandidates.map(async apiUrl => {
          const r = await fetch(apiUrl, { headers: ajaxHeaders, signal: AbortSignal.timeout(8000) });
          const ct = r.headers.get('content-type') || '';
          const body = ct.includes('json') ? await r.json() : null;
          console.log(`[yupoo api] ${apiUrl.split('?')[0]} → ${r.status} json=${!!body}`);
          return { apiUrl, body };
        })
      );
      for (const res of apiResults) {
        if (res.status === 'fulfilled' && res.value?.body) {
          crawlJson(res.value.body, 0);
          if (Object.keys(albumCovers).length > 0) break;
        }
      }
    }

    const albumIdsInHtml = [];
    const debugRe = /\/albums\/(\w+)/g; let di;
    while ((di = debugRe.exec(html)) !== null && albumIdsInHtml.length < 5) {
      if (!albumIdsInHtml.includes(di[1])) albumIdsInHtml.push(di[1]);
    }
    const hrefCount = (html.match(/href=/gi) || []).length;
    const hasAlbumsPath = html.includes('/albums/');
    const hrefSamples = [];
    const hrefRe = /href=["']([^"']{1,120})["']/gi; let hm;
    while ((hm = hrefRe.exec(html)) !== null && hrefSamples.length < 5) hrefSamples.push(hm[1]);
    const aIdx = html.toLowerCase().indexOf('album');
    const firstAlbumContext = aIdx >= 0 ? html.slice(Math.max(0, aIdx - 100), aIdx + 400).replace(/\s+/g, ' ') : null;

    let nextDataInfo = null;
    const ndM = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/i);
    if (ndM) {
      try {
        const nd = JSON.parse(ndM[1]);
        const ndStr = JSON.stringify(nd);
        nextDataInfo = {
          topKeys: Object.keys(nd),
          pagePropsKeys: nd.props?.pageProps ? Object.keys(nd.props.pageProps) : [],
          hasAlbum: ndStr.includes('album'), hasCover: ndStr.includes('cover'),
          preview: ndStr.slice(0, 800),
        };
      } catch (e) { nextDataInfo = { parseError: e.message, raw: ndM[1].slice(0, 200) }; }
    } else { nextDataInfo = { found: false }; }

    const apiUrlsInHtml = [...new Set((html.match(/["']\/api\/[^"'<>\s]{3,}["']/g) || []).map(u => u.replace(/["']/g, '')))].slice(0, 20);
    const mid = Math.floor(html.length / 2);
    const htmlPreview = {
      head: html.slice(0, 300).replace(/\s+/g, ' '),
      mid: html.slice(mid, mid + 600).replace(/\s+/g, ' '),
      tail: html.slice(-400).replace(/\s+/g, ' '),
    };

    if (!Object.keys(albumPrices).length) {
      // [~～≈约\s]* tra il simbolo ¥ e il numero: molti store (es. huskyreps)
      // scrivono il prezzo saldo come "￥~135" / "￥ ~ 298".
      const fwdRe = /\/albums\/(\w+)[^<]{0,400}?[¥￥]\s*[~～≈约\s]*(\d{1,5})/g;
      let fwd;
      while ((fwd = fwdRe.exec(html)) !== null) { if (!albumPrices[fwd[1]]) albumPrices[fwd[1]] = { value: parseInt(fwd[2], 10), currency: 'CNY' }; }
      const revRe = /[¥￥]\s*[~～≈约\s]*(\d{1,5})[^<]{0,400}?\/albums\/(\w+)/g;
      let rev;
      while ((rev = revRe.exec(html)) !== null) { if (!albumPrices[rev[2]]) albumPrices[rev[2]] = { value: parseInt(rev[1], 10), currency: 'CNY' }; }
      const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const stripRe = /\/albums\/(\w+)[^¥￥]{0,200}?[¥￥]\s*[~～≈约\s]*(\d{1,5})/g;
      let sp;
      while ((sp = stripRe.exec(stripped)) !== null) { if (!albumPrices[sp[1]]) albumPrices[sp[1]] = { value: parseInt(sp[2], 10), currency: 'CNY' }; }
    }

    let albumInfo = null;
    const isAlbumPage = /\/albums\/\w+/.test(parsedUrl.pathname);
    if (isAlbumPage) {
      const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleM ? titleM[1].replace(/\s*[-|—].*$/, '').trim() : '';
      // Nome prodotto: preferisci l'h1 descrittivo dell'album (es.
      // "25-26 Juventus away player version shorts【ID:...】S-2XL 尤文…"),
      // poi pulisci ID tra parentesi, CJK/fullwidth e range taglie.
      const h1M = html.match(/<h1[^>]*>([^<]{6,220})<\/h1>/i);
      let rawTitle = (h1M ? h1M[1] : (titleM ? titleM[1] : '')) || '';
      const cleanName = rawTitle
        .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
        .replace(/[　-〿一-鿿＀-￯]/g, ' ')
        .replace(/\bID\s*[:：]?\s*\d+\b/gi, ' ')
        .replace(/\b(XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)(-(XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL))?\b/gi, ' ')
        .replace(/[|｜/\\]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const sizeM = bodyText.match(/(?:size|sizes|尺码|尺寸)[：:\s]+([0-9][0-9\s.\/,]+)/i);
      const sizesRaw = sizeM ? sizeM[1].trim() : '';
      const shoeSizes = sizesRaw ? [...new Set(sizesRaw.split(/[\s,\/]+/).filter(s => /^\d{2}(\.\d)?$/.test(s)))] : [];
      const clothM = bodyText.match(/(?:size|sizes|尺码)[：:\s]+([A-Z]{1,3}(?:\s+[A-Z]{1,3})+)/i);
      const clothSizes = clothM ? clothM[1].split(/\s+/).filter(s => ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'].includes(s)) : [];
      // Prezzo fornitore: prendi il prezzo BASE in CNY, ignorando gli
      // add-on tipo "+ 15 CNY/pcs" (numero/personalizzazione).
      let supplierPriceCNY = null;
      const cnyAll = [...bodyText.matchAll(/(\+\s*)?(\d{1,5})\s*(?:元|CNY|cny|RMB|rmb)/g)];
      const cnyBases = cnyAll.filter(m => !m[1]).map(m => parseInt(m[2], 10)).filter(v => v > 0 && v < 100000);
      if (cnyBases.length) supplierPriceCNY = Math.max(...cnyBases);
      else if (cnyAll.length) supplierPriceCNY = parseInt(cnyAll[0][2], 10);
      // Simbolo ¥/￥ (es. "¥128", "￥ 128", "￥~135", "￥ ~ 298" → prezzo saldo)
      if (supplierPriceCNY == null) { const y = bodyText.match(/[¥￥]\s*[~～≈约\s]*(\d{1,5})/); if (y) supplierPriceCNY = parseInt(y[1], 10); }
      // Parole chiave cinesi: 价格/售价/价/单价/批发价 seguite da un numero
      if (supplierPriceCNY == null) {
        const kw = [...bodyText.matchAll(/(?:价格|售价|单价|批发价|价)\s*[:：]?\s*(\d{1,5})/g)]
          .map(m => parseInt(m[1], 10)).filter(v => v >= 5 && v < 100000);
        if (kw.length) supplierPriceCNY = Math.max(...kw);
      }
      // Ultima risorsa: un numero prezzo nel titolo album (es. "… 65" / "价65")
      if (supplierPriceCNY == null && rawTitle) {
        const tp = rawTitle.match(/(?:¥|￥|价格?|售价)\s*[~～≈约\s]*(\d{2,5})/) || rawTitle.match(/\b(\d{2,4})\s*(?:元|cny|rmb)\b/i);
        if (tp) { const v = parseInt(tp[1], 10); if (v >= 5 && v < 100000) supplierPriceCNY = v; }
      }
      // Prezzo assente nel testo ma l'album linka un prodotto Weidian
      // (es. "Weidian link : https://weidian.com/item.html?itemID=…"): apri il
      // link e leggi il prezzo da lì (in yuan), che poi il client converte.
      let priceFromWeidian = false;
      if (supplierPriceCNY == null) {
        const wdM = html.match(/https?:\/\/(?:[a-z0-9.\-]*\.)?weidian\.com\/item\.html\?item[iI][dD]=\d+/i)
                 || html.match(/https?:\/\/(?:[a-z0-9.\-]*\.)?(?:weidian|koudai)\.com\/[^\s"'<>]*?item[iI][dD]=\d+/i);
        if (wdM) {
          try { const wp = await weidianPriceCNY(wdM[0]); if (wp && wp > 0) { supplierPriceCNY = wp; priceFromWeidian = true; } }
          catch (e) { /* best-effort */ }
        }
      }
      const usdM = bodyText.match(/(\d{1,4})\s*\$/) || bodyText.match(/\$\s*(\d{1,4})/);
      const supplierPriceUSD = usdM ? parseInt(usdM[1], 10) : null;
      // Foto prodotto dell'album: SOLO gli host foto reali (photo*.yupoo.com /
      // yunjifen), escludendo loghi/icone del sito (s.yupoo.com). Deduplica per
      // ID foto (Yupoo espone la stessa foto in small/medium/big/hash → una sola
      // versione per hash) e normalizza a "medium". Limite alto: gli album
      // occhiali hanno molte varianti colore, tutte utili in galleria.
      const photos = [];
      const seenPid = new Set();
      const photoRe2 = /(?:data-src|data-original|data-lazy|src)=["']((?:https?:)?\/\/[^"'>\s]+)["']/g;
      let pm2;
      while ((pm2 = photoRe2.exec(html)) !== null && photos.length < 20) {
        let u = norm(pm2[1]);
        if (!u) continue;
        if (!/\/\/photo[0-9]*\.yupoo\.com\//i.test(u) && !/yunjifen/i.test(u)) continue; // no loghi/icone
        const idm = u.match(/yupoo\.com\/[^/]+\/([0-9a-f]{6,})\//i);
        const pid = idm ? idm[1] : u;
        if (seenPid.has(pid)) continue;
        seenPid.add(pid);
        u = u.replace(/\/(small|big|square|thumb|large|original)\.(jpe?g|png|webp)(\?|$)/i, '/medium.$2$3');
        photos.push(u);
      }
      // Diagnostica prezzo: piccoli estratti del testo che contengono cifre
      // vicino a marcatori di valuta, per capire il formato se il parse fallisce.
      const priceCtx = (bodyText.match(/.{0,14}\d{1,5}\s*(?:元|CNY|cny|RMB|rmb|[¥￥]|价格?|售价)/gi) || [])
        .concat(bodyText.match(/(?:¥|￥|价格?|售价)\s*\d{1,5}/g) || []).slice(0, 6);
      albumInfo = { pageTitle, name: cleanName || pageTitle, shoeSizes, clothSizes, supplierPriceCNY, supplierPriceUSD, photos, priceCtx, priceFromWeidian };
    }

    return { html, status: resp.status, albumCovers, albumPrices, albumInfo, albumUid, _debug: { albumIdsInHtml, htmlPreview, htmlLen: html.length, authDebug, authOk: authHtml !== null || authApiAlbums !== null || (!!authCookieStr && Object.keys(albumCovers).length > 0), authApiAlbumsKeys: authApiAlbums ? Object.keys(authApiAlbums) : null, nextDataInfo, apiUrlsInHtml, hrefCount, hasAlbumsPath, hrefSamples, firstAlbumContext } };
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch fallito: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// weidianFetch — estrae un prodotto da una pagina item Weidian
// Ritorna lo stesso formato del branch Taobao (mode/title/images/prezzo)
// così l'importer lo tratta con lo stesso flusso.
// ════════════════════════════════════════════════════════════════
async function weidianFetch(url) {
  const UA_MOB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
  const UA_DESK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const HDR_ZH = { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,it;q=0.7', 'Accept': 'text/html,application/json,*/*;q=0.8' };

  // itemID dalla URL
  let itemId = '';
  const m = url.match(/[?&]item[iI][dD]=(\d{5,})/) || url.match(/\/item\/(\d{5,})/) || url.match(/(\d{9,})/);
  if (m) itemId = m[1];

  const attempts = [];
  if (itemId) {
    // API JSON "thor" (se disponibile) — vari path noti, best-effort
    const param = encodeURIComponent(JSON.stringify({ itemId: itemId }));
    attempts.push({ url: `https://thor.weidian.com/detail/getItemInfo/1.0?param=${param}`, ua: UA_MOB, json: true });
    attempts.push({ url: `https://thor.weidian.com/detailfast/getItemDetailPageInfo/1.0?param=${param}`, ua: UA_MOB, json: true });
    attempts.push({ url: `https://weidian.com/item.html?itemID=${itemId}`, ua: UA_MOB });
    attempts.push({ url: `https://weidian.com/item.html?itemID=${itemId}`, ua: UA_DESK });
  }
  attempts.push({ url, ua: UA_MOB });
  attempts.push({ url, ua: UA_DESK });

  let body = '', htmlSource = '', wasJson = false;
  for (const att of attempts) {
    if (body) break;
    try {
      const r = await fetch(att.url, { headers: { 'User-Agent': att.ua, ...HDR_ZH, 'Referer': 'https://weidian.com/' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const txt = await r.text();
      if (att.json) {
        // Risposta API: usiamo il JSON grezzo come testo per l'estrazione regex
        if (txt.includes('itemName') || txt.includes('"price"') || txt.includes('geilicdn')) { body = txt; htmlSource = att.url; wasJson = true; }
      } else {
        const ok = txt.length > 1500 && (txt.includes('geilicdn') || txt.includes('og:image') || txt.includes('itemName') || txt.includes('"title"'));
        if (ok) { body = txt; htmlSource = att.url; }
      }
    } catch (e) { /* prova il prossimo */ }
  }

  // ── Titolo ──
  let title = '';
  if (body) {
    const ogT = body.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']{3,300})["']/i)
             || body.match(/<meta[^>]+content=["']([^"']{3,300})["'][^>]*property=["']og:title["']/i);
    if (ogT) title = ogT[1];
    if (!title) {
      const ps = [/"itemName"\s*:\s*"([^"]{3,200})"/, /"title"\s*:\s*"([^"]{3,200})"/, /"item_name"\s*:\s*"([^"]{3,200})"/];
      for (const p of ps) { const mm = body.match(p); if (mm) { title = mm[1]; break; } }
    }
    if (!title) { const tM = body.match(/<title[^>]*>([^<]{3,300})<\/title>/i); if (tM) title = tM[1]; }
  }
  title = (title || '').replace(/[-–—|]?\s*(微店|weidian|Weidian).*$/gi, '').replace(/【[^】]*】/g, '').replace(/\\u[0-9a-f]{4}/gi, ' ').replace(/\s+/g, ' ').trim();

  // ── Immagini (CDN geilicdn) ──
  const imgSet = new Set();
  if (body) {
    const imgRe = /(?:https?:)?\/\/(?:[a-z0-9\-]+\.)?geilicdn\.com\/[^\s"'<>\\)]+?\.(?:jpg|jpeg|png|webp)/gi;
    let mm;
    while ((mm = imgRe.exec(body)) !== null && imgSet.size < 10) {
      let u = mm[0]; if (u.startsWith('//')) u = 'https:' + u;
      const clean = u.replace(/[?#!].*$/, '').replace(/@[^/]*$/, '');
      if (!clean.includes('avatar') && !clean.includes('logo') && !clean.includes('icon') && clean.length > 30) imgSet.add(clean);
    }
    const ogI = body.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
             || body.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogI && ogI[1]) { let u = ogI[1]; if (u.startsWith('//')) u = 'https:' + u; imgSet.add(u.replace(/[?#].*$/, '')); }
  }
  let images = [...imgSet].filter(u => u.length > 20).slice(0, 8);

  // ── Prezzo (CNY) ── Weidian a volte esprime il prezzo in centesimi (fen)
  let priceYuan = 0;
  if (body) {
    const ps = [
      /"price"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/,
      /"itemPrice"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/,
      /"minPrice"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/,
      /"sku_price"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/,
      /¥\s*([\d]{1,6}(?:\.\d{1,2})?)/,
    ];
    for (const p of ps) {
      const pm = body.match(p);
      let v = pm ? parseFloat(pm[1]) : 0;
      // Se sembra espresso in centesimi (intero grande e multiplo plausibile), converti
      if (v > 2000 && Number.isInteger(v) && !pm[0].includes('.')) v = v / 100;
      if (v > 0 && v < 100000) { priceYuan = Math.round(v * 100) / 100; break; }
    }
  }

  // ── Re-upload della cover su imgbb (le immagini geilicdn possono bloccare l'hotlink) ──
  let imgbbUrl = '';
  const firstImg = images[0] || '';
  if (firstImg) {
    try {
      const imgResp = await fetch(firstImg, { headers: { 'User-Agent': UA_DESK, 'Referer': 'https://weidian.com/', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
      if (imgResp.ok) {
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const form = new URLSearchParams();
        form.append('key', IMGBB_KEY);
        form.append('image', buf.toString('base64'));
        const ibRes = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000) });
        const ibJson = await ibRes.json();
        if (ibJson.success) imgbbUrl = ibJson.data.url;
      }
    } catch (e) { console.warn('[WD] imgbb failed:', e.message); }
  }

  console.log(`[WD] itemId=${itemId} title="${title}" images=${images.length} price=${priceYuan} src=${htmlSource} len=${body.length}`);

  return {
    mode: 'weidian', itemId, title,
    images: imgbbUrl ? [imgbbUrl, ...images.slice(1)] : images,
    imgbbUrl, priceYuan,
    priceEur: priceYuan > 0 ? Math.round(priceYuan * 0.13 * 100) / 100 : 0,
    shop: '', sourceUrl: itemId ? `https://weidian.com/item.html?itemID=${itemId}` : url,
    _debug: { bodyLen: body.length, htmlSource, wasJson, imgCount: images.length, itemId, hasTitle: !!title, hasImages: images.length > 0, hasPrice: priceYuan > 0, bodyPreview: body.slice(0, 300) },
  };
}

// Legge SOLO il prezzo (CNY) da una pagina prodotto Weidian. Usato come
// fallback quando un album Yupoo non ha il prezzo nel testo ma linka Weidian.
async function weidianPriceCNY(itemUrl) {
  const UA_MOB = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
  const HDR_ZH = { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept': 'text/html,application/json,*/*;q=0.8' };
  const idm = itemUrl.match(/item[iI][dD]=(\d{5,})/) || itemUrl.match(/(\d{9,})/);
  const itemId = idm ? idm[1] : '';
  const urls = [];
  if (itemId) {
    const param = encodeURIComponent(JSON.stringify({ itemId }));
    urls.push(`https://thor.weidian.com/detail/getItemInfo/1.0?param=${param}`);
    urls.push(`https://weidian.com/item.html?itemID=${itemId}`);
  }
  urls.push(itemUrl);
  const PS = [/"price"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/, /"itemPrice"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/, /"minPrice"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/, /"sku_price"\s*:\s*"?([\d]+(?:\.\d{1,2})?)"?/, /[¥￥]\s*([\d]{1,6}(?:\.\d{1,2})?)/];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': UA_MOB, ...HDR_ZH, 'Referer': 'https://weidian.com/' }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const txt = await r.text();
      for (const p of PS) {
        const pm = txt.match(p);
        if (!pm) continue;
        let v = parseFloat(pm[1]);
        if (v > 2000 && Number.isInteger(v) && !pm[0].includes('.')) v = v / 100; // centesimi → yuan
        if (v > 0 && v < 100000) return Math.round(v);
      }
    } catch (e) { /* prova il prossimo */ }
  }
  return null;
}

// Estrae e fa il parse del PRIMO oggetto JSON completo da una risposta AI,
// ignorando fence markdown, testo/prosa in coda o un eventuale secondo oggetto
// (causa del "Unexpected non-whitespace character after JSON"). Conta le
// parentesi rispettando le stringhe, così si ferma alla chiusura del 1° oggetto.
function parseFirstJson(text) {
  let s = String(text == null ? '' : text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) throw new Error('Risposta AI senza JSON: ' + s.slice(0, 120));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  // Brace non bilanciate: ultimo tentativo greedy.
  const m = s.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('JSON incompleto nella risposta AI');
}

// ════════════════════════════════════════════════════════════════
// yupooAnalyze — fetch immagine + analisi Claude Haiku
// ════════════════════════════════════════════════════════════════
export async function yupooAnalyze(data, { env }) {
  const { imageUrl, brandHint = '', modelHint = '' } = data || {};
  if (!imageUrl || typeof imageUrl !== 'string') throw new HttpsError('invalid-argument', 'imageUrl mancante.');
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY non configurato sul Worker (secret mancante).');
  }

  const url = imageUrl.startsWith('//') ? 'https:' + imageUrl : imageUrl;
  let imgHost = ''; try { imgHost = new URL(url).hostname; } catch (_) {}

  let imageBase64, mediaType;
  try {
    // Referer basato sull'host reale dell'immagine (Yupoo blocca referer generici)
    // + retry con backoff su 403/429/5xx.
    const imgHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': imgHost ? `https://${imgHost}/` : 'https://www.yupoo.com/',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let resp = null;
    for (let a = 0; a < 3; a++) {
      try { resp = await fetch(url, { headers: imgHeaders, signal: AbortSignal.timeout(12000) }); }
      catch (fe) { if (a < 2) { await sleep(300 * (a + 1)); continue; } throw fe; }
      if (resp.ok) break;
      if ((resp.status >= 500 || resp.status === 403 || resp.status === 429) && a < 2) { await sleep(300 * (a + 1)); continue; }
      break;
    }
    if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : '?'));
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    mediaType = ct.split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) mediaType = 'image/jpeg';
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 4.5 * 1024 * 1024) throw new Error('Immagine troppo grande (>4.5MB)');
    imageBase64 = Buffer.from(buf).toString('base64');
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch immagine fallito: ' + e.message);
  }

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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
    if (!aiResp.ok) { const errText = await aiResp.text(); throw new Error('Anthropic ' + aiResp.status + ': ' + errText.slice(0, 300)); }
    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '{}').trim();
    return parseFirstJson(text);
  } catch (e) {
    console.error('yupooAnalyze AI error:', e.message);
    throw new HttpsError('internal', 'Analisi AI fallita: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// parseQuotation — legge una "quotation sheet" dell'agente (immagine)
// ed estrae le righe prodotto con costo/spedizione unitari in USD.
// L'admin carica lo screenshot; l'AI restituisce dati che l'admin
// conferma/corregge prima di salvarli come costo sul prodotto.
// ════════════════════════════════════════════════════════════════
export async function parseQuotation(data, { env }) {
  const { imageBase64, mediaType } = data || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new HttpsError('invalid-argument', 'imageBase64 mancante.');
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY non configurato sul Worker (secret mancante).');
  }
  let mt = (mediaType || 'image/png').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mt)) mt = 'image/png';
  // base64 ~ 4/3 della dimensione binaria; limite pratico ~5MB immagine.
  if (imageBase64.length > 7 * 1024 * 1024) throw new HttpsError('invalid-argument', 'Immagine troppo grande (>5MB).');

  const prompt = `Sei un assistente che legge le "QUOTATION SHEET" degli agenti di acquisto cinesi (Weidian/Taobao/1688/Yupoo).
Estrai le righe prodotto numerate della tabella E il riepilogo dei totali in fondo. Rispondi ESCLUSIVAMENTE con JSON valido (nessun markdown, nessun testo prima o dopo):
{"rows":[{"line":1,"link":"https://...","itemId":"742989298","remarks":"no box","size":"42 eu","quantity":"1","rmb":280,"freightRmb":12,"totalRmb":292,"gw":2,"unitPriceUsd":49.01,"unitFreightUsd":21.22}],"summary":{"goodsUsd":265.5,"estFreightUsd":139.0,"discountUsd":8.6,"totalUsd":396.0,"receivedUsd":473.0,"balanceUsd":-77.0,"totalRmb":1582.0},"currency":"USD"}
Regole IMPORTANTI:
- "rows": una riga per ogni prodotto numerato (1,2,3...). NON includere righe di totale/subtotale/spedizione stimata/pagamenti tra le rows.
- "unitPriceUsd" = colonna "UNIT PRICE" (valori in $). "unitFreightUsd" = colonna "UNIT FREIGHT" (in $). Solo numeri, senza simboli. Se "$0.00" o vuoto → 0.
- "itemId" = SOLO le cifre dell'itemID/id nel link (es. da "...itemID=742989298" → "742989298"; da un album yupoo, l'ultimo numero). Serve per abbinare al prodotto: cattura sempre le cifre finali, anche se il resto del link è tagliato/illeggibile.
- "link": riporta l'URL come lo leggi (anche parziale).
- "rmb","freightRmb","totalRmb","gw" = numeri delle rispettive colonne (RMB, FREIGHT TO WAREHOUSE, TOTAL RMB, GW). Se assenti → null.
- Se una riga è un rimborso/"refund" o senza prezzo, metti unitPriceUsd:0 e unitFreightUsd:0.
- "summary" = il riquadro dei totali in basso (di solito a destra/sotto). Leggi i valori in USD ($):
  · "goodsUsd" = subtotale merce in USD (spesso la riga "USD" vicino a "RMB"/"TOTAL");
  · "estFreightUsd" = "ESTIMATED FREIGHT"; "discountUsd" = "DISCOUNT" (valore assoluto, sempre positivo);
  · "totalUsd" = "TOTAL" finale in $; "receivedUsd" = "RECEIVED PAYMENT"; "balanceUsd" = "BALANCE PAYMENT" (può essere negativo);
  · "totalRmb" = "TOTAL" in RMB. Metti null i campi non presenti/illeggibili.
- Numeri con punto decimale. Non inventare dati non presenti.`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mt, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!aiResp.ok) { const errText = await aiResp.text(); throw new Error('Anthropic ' + aiResp.status + ': ' + errText.slice(0, 300)); }
    const aiData = await aiResp.json();
    const text = (aiData.content?.[0]?.text || '{}').trim();
    const parsed = parseFirstJson(text);
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    // Normalizza i numeri lato server (difesa: l'AI a volte restituisce stringhe).
    const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
    const clean = rows.map((r, i) => ({
      line: r.line ?? (i + 1),
      link: String(r.link || '').slice(0, 300),
      itemId: String(r.itemId || '').replace(/[^0-9]/g, '').slice(0, 20),
      remarks: String(r.remarks || '').slice(0, 80),
      size: String(r.size || '').slice(0, 60),
      quantity: String(r.quantity || '').slice(0, 20),
      rmb: num(r.rmb),
      freightRmb: num(r.freightRmb),
      totalRmb: num(r.totalRmb),
      gw: num(r.gw),
      unitPriceUsd: num(r.unitPriceUsd) || 0,
      unitFreightUsd: num(r.unitFreightUsd) || 0,
    }));
    const s = parsed.summary || {};
    const summary = {
      goodsUsd: num(s.goodsUsd),
      estFreightUsd: num(s.estFreightUsd),
      discountUsd: s.discountUsd == null ? null : Math.abs(num(s.discountUsd) || 0),
      totalUsd: num(s.totalUsd),
      receivedUsd: num(s.receivedUsd),
      balanceUsd: num(s.balanceUsd),
      totalRmb: num(s.totalRmb),
    };
    return { rows: clean, summary, currency: 'USD' };
  } catch (e) {
    console.error('parseQuotation AI error:', e.message);
    throw new HttpsError('internal', 'Lettura ricevuta fallita: ' + e.message);
  }
}
