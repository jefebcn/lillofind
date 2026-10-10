// Imposta (o toglie) il custom claim admin:true su un account Firebase.
//
// E' il modo "pulito" di dire chi e' admin: firestore.rules e il Worker
// accettano il claim admin:true, oppure un'email dell'allowlist ma solo se
// VERIFICATA. Col claim impostato, l'allowlist puo' anche essere svuotata.
//
// Uso (una volta, dal tuo computer, col file del service account):
//   cd scripts && npm i firebase-admin
//   GOOGLE_APPLICATION_CREDENTIALS=/percorso/service-account.json \
//     node set-admin-claim.mjs tua@email.it           # imposta admin
//   ... node set-admin-claim.mjs tua@email.it --togli  # toglie admin
// Poi esci e rientra dal sito: il claim arriva col token nuovo.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const email = process.argv[2];
const togli = process.argv.includes('--togli');
if (!email) { console.error('Uso: node set-admin-claim.mjs <email> [--togli]'); process.exit(1); }

initializeApp({ credential: applicationDefault(), projectId: 'lillofind-c455c' });
const auth = getAuth();
const u = await auth.getUserByEmail(email).catch(() => null);
if (!u) { console.error(`Nessun account con email ${email} su Firebase Auth.`); process.exit(2); }
const claims = { ...(u.customClaims || {}) };
if (togli) delete claims.admin; else claims.admin = true;
await auth.setCustomUserClaims(u.uid, claims);
console.log(`${togli ? 'Tolto' : 'Impostato'} admin per ${email} (uid ${u.uid}). Email verificata: ${u.emailVerified ? 'sì' : 'NO'}.`);
