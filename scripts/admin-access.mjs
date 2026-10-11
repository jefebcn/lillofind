// Dà il permesso admin (custom claim admin:true) agli account indicati e ne
// segna l'email come verificata. Gira da GitHub Actions (admin-access.yml)
// col service account già usato per pubblicare il catalogo.
// Uso: node admin-access.mjs email1 [email2 ...]
// Il permesso arriva col token nuovo: esci e rientra dall'admin.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const emails = process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean);
if (!emails.length) { console.error('Uso: node admin-access.mjs <email> [...]'); process.exit(1); }
initializeApp({ credential: applicationDefault(), projectId: 'lillofind-c455c' });
const auth = getAuth();
let ok = 0;
for (const email of emails) {
  const u = await auth.getUserByEmail(email).catch(() => null);
  if (!u) { console.log(`• ${email}: nessun account su Firebase Auth (niente da fare)`); continue; }
  const providers = (u.providerData || []).map((p) => p.providerId).join(', ') || 'nessuno';
  console.log(`• ${email}: uid ${u.uid} · accesso con: ${providers} · creato ${u.metadata.creationTime} · ultimo accesso ${u.metadata.lastSignInTime} · verificata prima: ${u.emailVerified ? 'sì' : 'NO'} · disattivato: ${u.disabled ? 'SÌ' : 'no'}`);
  await auth.setCustomUserClaims(u.uid, { ...(u.customClaims || {}), admin: true });
  if (!u.emailVerified) await auth.updateUser(u.uid, { emailVerified: true });
  if (u.disabled) await auth.updateUser(u.uid, { disabled: false });
  console.log(`  → admin:true impostato, email verificata${u.disabled ? ', account riattivato' : ''}`);
  ok++;
}
console.log(`Fatto: ${ok} account admin. Esci e rientra da admin.html per ricevere il permesso.`);
