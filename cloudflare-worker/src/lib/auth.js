// ════════════════════════════════════════════════════════════════
// Verifica token ID Firebase su Cloudflare Workers
// I token sono JWT RS256 firmati da Google. I certificati pubblici
// (x509 PEM) sono pubblicati e ruotati periodicamente: li cache-iamo.
// ════════════════════════════════════════════════════════════════

import { importX509, jwtVerify, decodeProtectedHeader } from 'jose';

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let _certCache = { certs: null, exp: 0 };

async function getCerts() {
  const now = Date.now();
  if (_certCache.certs && _certCache.exp > now) return _certCache.certs;
  const resp = await fetch(CERT_URL);
  if (!resp.ok) throw new Error('Impossibile scaricare i certificati Firebase');
  const certs = await resp.json();
  // Rispetta il Cache-Control max-age dell'header se presente
  const cc = resp.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) * 1000 : 3600 * 1000;
  _certCache = { certs, exp: now + maxAge };
  return certs;
}

// Verifica il token e ritorna il payload decodificato ({ uid, email, ... }).
// Lancia un errore se il token non è valido.
export async function verifyIdToken(token, projectId) {
  if (!token) throw new Error('Token mancante');
  const header = decodeProtectedHeader(token);
  const certs = await getCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('Certificato non trovato (kid sconosciuto)');

  const key = await importX509(pem, 'RS256');
  const { payload } = await jwtVerify(token, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub) throw new Error('Token senza subject');
  return { uid: payload.sub, email: payload.email || '', ...payload };
}

// Estrae il Bearer token dall'header Authorization
export function bearerFrom(request) {
  const h = request.headers.get('Authorization') || request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}
