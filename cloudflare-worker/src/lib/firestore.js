// ════════════════════════════════════════════════════════════════
// Firestore REST client per Cloudflare Workers
// firebase-admin non gira su Workers (usa gRPC), quindi accediamo a
// Firestore via REST API autenticandoci con un service account.
//
// Flusso: service account JSON → JWT firmato RS256 (Web Crypto)
//         → scambio per access token OAuth2 → chiamate REST.
// ════════════════════════════════════════════════════════════════

let _tokenCache = { token: null, exp: 0 };

// Sentinel per cancellare un campo in updateDoc (come FieldValue.delete())
export const DELETE_FIELD = Symbol('DELETE_FIELD');

// ── base64url helpers ───────────────────────────────────────────
function b64url(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToBuf(s) { return new TextEncoder().encode(s); }

// Converte la private key PEM (PKCS#8) in CryptoKey per RS256
async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8', der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

// Ottiene (e cache-a) un access token OAuth2 per Firestore
async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp > now + 60) return _tokenCache.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64url(strToBuf(JSON.stringify(header))) + '.' + b64url(strToBuf(JSON.stringify(claim)));
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, strToBuf(unsigned));
  const jwt = unsigned + '.' + b64url(sig);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  if (!resp.ok) throw new Error('OAuth token error: ' + (await resp.text()));
  const data = await resp.json();
  _tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return _tokenCache.token;
}

// ── Conversione valori JS ↔ Firestore typed values ──────────────
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fromFsValue(v) {
  if (v == null) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) {
    const d = new Date(v.timestampValue);
    return { seconds: Math.floor(d.getTime() / 1000), _ts: v.timestampValue };
  }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) return fromFsFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
function toFsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined || obj[k] === DELETE_FIELD) continue;
    fields[k] = toFsValue(obj[k]);
  }
  return fields;
}
function fromFsFields(fields) {
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fromFsValue(fields[k]);
  return out;
}

// Estrae l'id documento dal "name" REST (.../documents/products/ABC → ABC)
function docId(name) { return name ? name.split('/').pop() : ''; }

// ════════════════════════════════════════════════════════════════
// Firestore: classe di accesso
// ════════════════════════════════════════════════════════════════
export class Firestore {
  constructor(env) {
    this.env = env;
    this.projectId = env.FIREBASE_PROJECT_ID;
    this.base = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  async _headers() {
    const token = await getAccessToken(this.env);
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  }

  // GET singolo documento → { exists, id, data() } (interfaccia simil-admin)
  async getDoc(collection, id) {
    const resp = await fetch(`${this.base}/${collection}/${encodeURIComponent(id)}`, {
      headers: await this._headers(),
    });
    if (resp.status === 404) return { exists: false, id, data: () => null };
    if (!resp.ok) throw new Error(`Firestore getDoc ${collection}/${id}: ${resp.status} ${await resp.text()}`);
    const doc = await resp.json();
    const data = fromFsFields(doc.fields || {});
    return { exists: true, id, data: () => data };
  }

  // SET (crea o sovrascrive completamente) un documento con id noto
  async setDoc(collection, id, obj) {
    const resp = await fetch(`${this.base}/${collection}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: await this._headers(),
      body: JSON.stringify({ fields: toFsFields(obj) }),
    });
    if (!resp.ok) throw new Error(`Firestore setDoc: ${resp.status} ${await resp.text()}`);
    return docId((await resp.json()).name);
  }

  // CREATE con id auto-generato → ritorna l'id
  async addDoc(collection, obj) {
    const resp = await fetch(`${this.base}/${collection}`, {
      method: 'POST',
      headers: await this._headers(),
      body: JSON.stringify({ fields: toFsFields(obj) }),
    });
    if (!resp.ok) throw new Error(`Firestore addDoc: ${resp.status} ${await resp.text()}`);
    return docId((await resp.json()).name);
  }

  // UPDATE parziale: aggiorna solo i campi passati (updateMask).
  // Un campo con valore DELETE_FIELD viene rimosso (è nella mask ma non nei fields).
  async updateDoc(collection, id, obj) {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
    const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const resp = await fetch(`${this.base}/${collection}/${encodeURIComponent(id)}?${mask}`, {
      method: 'PATCH',
      headers: await this._headers(),
      body: JSON.stringify({ fields: toFsFields(obj) }),
    });
    if (!resp.ok) throw new Error(`Firestore updateDoc: ${resp.status} ${await resp.text()}`);
    return true;
  }

  async deleteDoc(collection, id) {
    const resp = await fetch(`${this.base}/${collection}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: await this._headers(),
    });
    if (!resp.ok && resp.status !== 404) throw new Error(`Firestore deleteDoc: ${resp.status} ${await resp.text()}`);
    return true;
  }

  // Lista tutti i documenti di una collection (paginazione automatica)
  // → array di { id, ...data }
  async listAll(collection, { orderBy, descending } = {}) {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ pageSize: '300' });
      if (pageToken) params.set('pageToken', pageToken);
      if (orderBy) params.set('orderBy', orderBy + (descending ? ' desc' : ''));
      const resp = await fetch(`${this.base}/${collection}?${params}`, {
        headers: await this._headers(),
      });
      if (!resp.ok) throw new Error(`Firestore listAll: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      for (const doc of (data.documents || [])) {
        out.push({ id: docId(doc.name), ...fromFsFields(doc.fields || {}) });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  // Commit batch di update (max 500 per chiamata, come Firestore).
  // writes = [{ collection, id, fields: {campo: valore} }]
  async commitUpdates(writes) {
    let done = 0;
    for (let i = 0; i < writes.length; i += 500) {
      const chunk = writes.slice(i, i + 500);
      const body = {
        writes: chunk.map(w => ({
          update: {
            name: `projects/${this.projectId}/databases/(default)/documents/${w.collection}/${w.id}`,
            fields: toFsFields(w.fields),
          },
          updateMask: { fieldPaths: Object.keys(w.fields) },
          currentDocument: { exists: true },
        })),
      };
      const resp = await fetch(`https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:commit`, {
        method: 'POST',
        headers: await this._headers(),
        body: JSON.stringify(body),
      });
      if (!resp.ok) throw new Error(`Firestore commit: ${resp.status} ${await resp.text()}`);
      done += chunk.length;
    }
    return done;
  }

  // Batch GET di più documenti per id → array di { exists, id, data() }
  async getMany(collection, ids) {
    const docs = ids.map(id => `projects/${this.projectId}/databases/(default)/documents/${collection}/${id}`);
    const resp = await fetch(`https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents:batchGet`, {
      method: 'POST',
      headers: await this._headers(),
      body: JSON.stringify({ documents: docs }),
    });
    if (!resp.ok) throw new Error(`Firestore getMany: ${resp.status} ${await resp.text()}`);
    const rows = await resp.json();
    // batchGet può restituire in ordine diverso: rimappa per id
    const byId = {};
    for (const r of rows) {
      if (r.found) byId[docId(r.found.name)] = fromFsFields(r.found.fields || {});
    }
    return ids.map(id => byId[id]
      ? { exists: true, id, data: () => byId[id] }
      : { exists: false, id, data: () => null });
  }
}

export { toFsFields, fromFsFields };
