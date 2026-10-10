// ════════════════════════════════════════════════════════════════
// Firebase Auth lato server (Identity Toolkit REST) col service account.
// Serve al checkout: al cliente che ha appena creato l'account si manda un
// link per IMPOSTARE la password, invece di una password scelta dal browser.
// ════════════════════════════════════════════════════════════════
import { getAccessToken } from './firestore.js';

const SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';

async function chiama(env, metodo, body) {
  const token = await getAccessToken(env, SCOPE);
  const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/${metodo}`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`identitytoolkit ${metodo}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

// → { email, emailVerified, createdAt (ms), disabled } oppure null
export async function utenteAuth(env, uid) {
  const r = await chiama(env, 'accounts:lookup', { localId: [uid] });
  const u = r && r.users && r.users[0];
  if (!u) return null;
  return { email: u.email || '', emailVerified: !!u.emailVerified, createdAt: Number(u.createdAt) || 0, disabled: !!u.disabled };
}

// Link "imposta la password" (lo stesso dell'email di reset di Firebase),
// da mettere nella nostra email: la password non viaggia mai.
export async function linkImpostaPassword(env, email) {
  const r = await chiama(env, 'accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email, returnOobLink: true });
  return r && r.oobLink;
}
