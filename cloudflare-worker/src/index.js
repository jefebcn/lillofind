// ════════════════════════════════════════════════════════════════
// LilloFind — Backend su Cloudflare Workers
// Sostituisce le Firebase Cloud Functions mantenendo lo stesso
// "contratto" col frontend (protocollo callable: body {data}, resp {result}).
// Deploy automatico via GitHub Actions (cloudflare-worker-deploy.yml).
// ════════════════════════════════════════════════════════════════

import { Hono } from 'hono';
import { Firestore } from './lib/firestore.js';
import { verifyIdToken, bearerFrom } from './lib/auth.js';
import { HttpsError } from './lib/errors.js';
import * as admin from './handlers/admin.js';
import * as checkout from './handlers/checkout.js';
import * as scrapers from './handlers/scrapers.js';

const app = new Hono();

// ── CORS ────────────────────────────────────────────────────────
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || !origin || allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok && origin ? origin : '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin, c.env) });
  }
  await next();
  const h = corsHeaders(origin, c.env);
  for (const k of Object.keys(h)) c.res.headers.set(k, h[k]);
});

const HTTP_STATUS = {
  'ok': 200, 'invalid-argument': 400, 'unauthenticated': 401,
  'permission-denied': 403, 'not-found': 404, 'already-exists': 409,
  'resource-exhausted': 429, 'internal': 500, 'unavailable': 503,
};

// Wrapper che replica il protocollo Firebase callable.
//   opts.auth: 'required' | 'admin' | 'none'
function callable(handler, opts = {}) {
  return async (c) => {
    const env = c.env;
    try {
      let body = {};
      try { body = await c.req.json(); } catch (_) { body = {}; }
      const data = body && typeof body === 'object' && 'data' in body ? body.data : body;

      const ctx = { env, db: new Firestore(env), auth: null };

      if (opts.auth === 'required' || opts.auth === 'admin' || opts.auth === 'adminEmail') {
        const token = bearerFrom(c.req.raw);
        if (!token) throw new HttpsError('unauthenticated', 'Login richiesto.');
        let decoded;
        try { decoded = await verifyIdToken(token, env.FIREBASE_PROJECT_ID); }
        catch (e) { throw new HttpsError('unauthenticated', 'Token non valido.'); }
        ctx.auth = { uid: decoded.uid, email: decoded.email, token: decoded };

        if (opts.auth === 'admin') {
          const userSnap = await ctx.db.getDoc('users', decoded.uid);
          if (userSnap.data()?.isAdmin !== true) {
            throw new HttpsError('permission-denied', 'Solo admin.');
          }
        }

        // adminEmail: verifica admin tramite allowlist email (non usa Firestore,
        // quindi funziona anche senza FIREBASE_SERVICE_ACCOUNT).
        if (opts.auth === 'adminEmail') {
          const admins = (env.ADMIN_EMAILS || 'yishionvt@gmail.com')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
          if (!admins.includes((decoded.email || '').toLowerCase())) {
            throw new HttpsError('permission-denied', 'Solo admin.');
          }
        }
      }

      const result = await handler(data, ctx);
      return c.json({ result: result ?? null });
    } catch (e) {
      const code = e instanceof HttpsError ? e.code : 'internal';
      const status = HTTP_STATUS[code] || 500;
      if (code === 'internal') console.error('Worker error:', e && e.stack ? e.stack : e);
      return c.json({ error: { status: code, message: e.message || 'Errore interno' } }, status);
    }
  };
}

// ════════════════════════════════════════════════════════════════
// proxyImage — proxy immagini Yupoo (GET pubblico, cacheable)
// ════════════════════════════════════════════════════════════════
app.get('/proxyImage', async (c) => {
  const url = c.req.query('url');
  if (!url) return c.text('Missing url', 400);
  let parsed;
  try { parsed = new URL(url); } catch (e) { return c.text('Invalid URL', 400); }
  const ok = parsed.hostname.endsWith('.yupoo.com') || parsed.hostname.endsWith('.yunjifen.com')
    || parsed.hostname === 'yupoo.com' || parsed.hostname === 'yunjifen.com';
  if (!ok) return c.text('Host not allowed', 403);

  // Cache v2 — versioned key invalidates all previously cached error responses
  const cache = caches.default;
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.set('_cv', '2');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit && hit.ok) return hit;

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `https://${parsed.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      return new Response('Upstream error', {
        status: upstream.status,
        headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const ct = (upstream.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = await upstream.arrayBuffer();
    const resp = new Response(buf, {
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response('Fetch error', {
      status: 502,
      headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
});

// ── Health check ────────────────────────────────────────────────
app.get('/', (c) => c.json({ ok: true, service: 'lillofind-worker' }));

// ── Diagnostica (pubblica, nessun dato sensibile) ───────────────
// Verifica che i secret e l'accesso a Firestore siano configurati bene.
// Utile subito dopo il deploy: GET /diag
app.get('/diag', async (c) => {
  const env = c.env;
  const out = {
    projectId: env.FIREBASE_PROJECT_ID || null,
    secrets: {
      FIREBASE_SERVICE_ACCOUNT: !!env.FIREBASE_SERVICE_ACCOUNT,
      STRIPE_SECRET_KEY: !!env.STRIPE_SECRET_KEY,
      RESEND_API_KEY: !!env.RESEND_API_KEY,
      ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
    },
    firestore: { reachable: false },
  };
  try {
    out.firestore = await new Firestore(env).ping();
  } catch (e) {
    out.firestore = { reachable: false, error: e.message };
  }
  return c.json(out);
});

// ════════════════════════════════════════════════════════════════
// Endpoint callable (POST /<nomeFunzione>)
// ════════════════════════════════════════════════════════════════
// Lettura admin
app.post('/getAdminProducts', callable(admin.getAdminProducts, { auth: 'admin' }));
app.post('/getAdminOrders',   callable(admin.getAdminOrders,   { auth: 'admin' }));
app.post('/getAdminStats',    callable(admin.getAdminStats,    { auth: 'admin' }));
// Scrittura admin
app.post('/saveProduct',        callable(admin.saveProduct,        { auth: 'admin' }));
app.post('/updateAdminProduct', callable(admin.updateAdminProduct, { auth: 'admin' }));
app.post('/deleteAdminProduct', callable(admin.deleteAdminProduct, { auth: 'admin' }));
app.post('/updateAdminOrder',   callable(admin.updateAdminOrder,   { auth: 'admin' }));
app.post('/batchSetGender',     callable(admin.batchSetGender,     { auth: 'admin' }));
// Checkout
app.post('/createPaymentIntent', callable(checkout.createPaymentIntent, { auth: 'required' }));
app.post('/validateOrder',       callable(checkout.validateOrder,       { auth: 'required' }));
// Email tracking al cliente (admin via allowlist email)
app.post('/sendTrackingEmail',   callable(checkout.sendTrackingEmail,   { auth: 'adminEmail' }));
// Scraper (admin)
app.post('/yupooFetch',   callable(scrapers.yupooFetch,   { auth: 'admin' }));
app.post('/yupooAnalyze', callable(scrapers.yupooAnalyze, { auth: 'admin' }));
app.post('/uploadImage',  callable(scrapers.uploadImage,  { auth: 'admin' }));

export default app;
