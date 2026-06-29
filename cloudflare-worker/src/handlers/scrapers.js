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
export async function yupooFetch(data, _ctx) {
  const { url, password } = data || {};
  if (!url || typeof url !== 'string') throw new HttpsError('invalid-argument', 'Parametro url mancante.');

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch (e) { throw new HttpsError('invalid-argument', 'URL non valido.'); }
  const isTaobao = parsedUrl.hostname.endsWith('.taobao.com')
    || parsedUrl.hostname.endsWith('.tmall.com')
    || parsedUrl.hostname.endsWith('.tb.cn')
    || parsedUrl.hostname.endsWith('.aliexpress.com')
    || parsedUrl.hostname === 'taobao.com'
    || parsedUrl.hostname === 'tmall.com'
    || parsedUrl.hostname === 'aliexpress.com';
  if (!parsedUrl.hostname.endsWith('.yupoo.com') && !isTaobao) {
    throw new HttpsError('invalid-argument', 'Solo URL *.yupoo.com, Taobao/Tmall o AliExpress sono permessi.');
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
    const authResult = await yupooPasswordAuth(url, password.trim());
    authCookieStr  = authResult.cookies   || '';
    authDebug      = authResult.debug     || [];
    authHtml       = authResult.html      || null;
    authApiAlbums  = authResult.apiAlbums || null;
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
    }

    const albumCovers = {};
    const albumPrices = {};
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
      const fwdRe = /\/albums\/(\w+)[^<]{0,400}?[¥￥]\s*(\d{1,5})/g;
      let fwd;
      while ((fwd = fwdRe.exec(html)) !== null) { if (!albumPrices[fwd[1]]) albumPrices[fwd[1]] = { value: parseInt(fwd[2], 10), currency: 'CNY' }; }
      const revRe = /[¥￥]\s*(\d{1,5})[^<]{0,400}?\/albums\/(\w+)/g;
      let rev;
      while ((rev = revRe.exec(html)) !== null) { if (!albumPrices[rev[2]]) albumPrices[rev[2]] = { value: parseInt(rev[1], 10), currency: 'CNY' }; }
      const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const stripRe = /\/albums\/(\w+)[^¥￥]{0,200}?[¥￥]\s*(\d{1,5})/g;
      let sp;
      while ((sp = stripRe.exec(stripped)) !== null) { if (!albumPrices[sp[1]]) albumPrices[sp[1]] = { value: parseInt(sp[2], 10), currency: 'CNY' }; }
    }

    let albumInfo = null;
    const isAlbumPage = /\/albums\/\w+/.test(parsedUrl.pathname);
    if (isAlbumPage) {
      const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleM ? titleM[1].replace(/\s*[-|—].*$/, '').trim() : '';
      const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const sizeM = bodyText.match(/(?:size|sizes|尺码|尺寸)[：:\s]+([0-9][0-9\s.\/,]+)/i);
      const sizesRaw = sizeM ? sizeM[1].trim() : '';
      const shoeSizes = sizesRaw ? [...new Set(sizesRaw.split(/[\s,\/]+/).filter(s => /^\d{2}(\.\d)?$/.test(s)))] : [];
      const clothM = bodyText.match(/(?:size|sizes|尺码)[：:\s]+([A-Z]{1,3}(?:\s+[A-Z]{1,3})+)/i);
      const clothSizes = clothM ? clothM[1].split(/\s+/).filter(s => ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'].includes(s)) : [];
      const cnyM = bodyText.match(/[¥￥]\s*(\d{1,5})/) || bodyText.match(/(\d{1,5})\s*(?:元|CNY|cny)/);
      const usdM = bodyText.match(/(\d{1,4})\s*\$/) || bodyText.match(/\$\s*(\d{1,4})/);
      const supplierPriceCNY = cnyM ? parseInt(cnyM[1], 10) : null;
      const supplierPriceUSD = usdM ? parseInt(usdM[1], 10) : null;
      const photos = [];
      const photoRe2 = /(?:data-src|data-original|data-lazy|src)=["']((?:https?:)?\/\/[^"'>\s]+)["']/g;
      let pm2;
      while ((pm2 = photoRe2.exec(html)) !== null && photos.length < 8) {
        const u = norm(pm2[1]);
        if (u && isImg(u) && !photos.includes(u)) photos.push(u);
      }
      albumInfo = { pageTitle, shoeSizes, clothSizes, supplierPriceCNY, supplierPriceUSD, photos };
    }

    return { html, status: resp.status, albumCovers, albumPrices, albumInfo, _debug: { albumIdsInHtml, htmlPreview, htmlLen: html.length, authDebug, authOk: authHtml !== null || authApiAlbums !== null, authApiAlbumsKeys: authApiAlbums ? Object.keys(authApiAlbums) : null, nextDataInfo, apiUrlsInHtml, hrefCount, hasAlbumsPath, hrefSamples, firstAlbumContext } };
  } catch (e) {
    throw new HttpsError('unavailable', 'Fetch fallito: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// yupooAnalyze — fetch immagine + analisi Claude Haiku
// ════════════════════════════════════════════════════════════════
export async function yupooAnalyze(data, { env }) {
  const { imageUrl, brandHint = '', modelHint = '' } = data || {};
  if (!imageUrl || typeof imageUrl !== 'string') throw new HttpsError('invalid-argument', 'imageUrl mancante.');

  const url = imageUrl.startsWith('//') ? 'https:' + imageUrl : imageUrl;

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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Risposta AI non contiene JSON: ' + text.slice(0, 100));
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('yupooAnalyze AI error:', e.message);
    throw new HttpsError('internal', 'Analisi AI fallita: ' + e.message);
  }
}
