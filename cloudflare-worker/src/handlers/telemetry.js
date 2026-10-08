// ── Errori JavaScript dal sito ─────────────────────────────────────
// Il frontend invia window.onerror / unhandledrejection con sendBeacon
// (testo JSON, max 5 per pagina). Qui si ripuliscono e si scrivono nei log
// del Worker: Cloudflare → Workers → lillofind → Logs (o `wrangler tail`).
// Nessun dato personale: solo messaggio, file/riga, stack, pagina, browser.

const MAX_BODY = 16000; // si legge al massimo questo; poi ogni campo viene accorciato

function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

// Ritorna l'oggetto da loggare, oppure null se la richiesta va ignorata.
export function parseClientError(rawBody, { origin = '', allowedOrigins = '', userAgent = '', country = '' } = {}) {
  const allowed = String(allowedOrigins).split(',').map(s => s.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes('*') && !allowed.includes(origin)) return null;
  let e;
  try { e = JSON.parse(String(rawBody || '').slice(0, MAX_BODY)); } catch (_) { return null; }
  if (!e || typeof e !== 'object' || !e.msg) return null;
  return {
    msg: clip(e.msg, 300),
    src: clip(e.src, 200),
    line: Number.isFinite(+e.line) ? +e.line : 0,
    col: Number.isFinite(+e.col) ? +e.col : 0,
    stack: clip(e.stack, 1500),
    page: clip(e.page, 200),
    kind: e.kind === 'promise' ? 'promise' : 'error',
    ua: clip(userAgent, 160),
    country: clip(country, 4),
  };
}

export async function clientError(c) {
  let body = '';
  try { body = await c.req.text(); } catch (_) {}
  const cf = (c.req.raw && c.req.raw.cf) || {};
  const ev = parseClientError(body, {
    origin: c.req.header('Origin') || '',
    allowedOrigins: c.env.ALLOWED_ORIGINS || '',
    userAgent: c.req.header('User-Agent') || '',
    country: cf.country || '',
  });
  if (ev) console.error('[clientError] ' + JSON.stringify(ev));
  return new Response(null, { status: 204 });
}
