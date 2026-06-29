# Migrazione backend → Cloudflare Workers (gratis, niente Blaze)

Questa guida sposta il backend da Firebase Cloud Functions (che richiedono il
piano Blaze a pagamento) a un **Cloudflare Worker gratuito**.

**Restano su Firebase, piano gratuito Spark (nessuna carta):**
- Database Firestore (prodotti, ordini, utenti) — *nessuna migrazione dati*
- Login utenti (Firebase Auth)
- Sito web (Firebase Hosting)

**Si sposta su Cloudflare (gratis, uso commerciale OK):**
- Tutte le funzioni server (checkout, admin, proxy immagini, analisi AI)

---

## Checklist completa (in ordine)

### ☐ 1. Account Cloudflare
Crea un account gratuito (senza carta): https://dash.cloudflare.com/sign-up

### ☐ 2. Deploy del Worker
```bash
cd cloudflare-worker
npm install
npx wrangler login
```
Imposta i secret (vedi sotto come ottenerli):
```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # JSON service account (passo 2a)
npx wrangler secret put STRIPE_SECRET_KEY          # chiave Stripe
npx wrangler secret put RESEND_API_KEY             # chiave Resend (RIGENERATA)
npx wrangler secret put ANTHROPIC_API_KEY          # chiave Anthropic (per analisi AI)
```
Poi:
```bash
npx wrangler deploy
```
Copia l'URL stampato, es: `https://lillofind-worker.tuonome.workers.dev`

#### 2a. Come ottenere il service account Firebase
Console Firebase → ⚙ Impostazioni progetto → **Account di servizio** →
"Genera nuova chiave privata" → scarica il JSON → incollalo tutto quando
`wrangler secret put FIREBASE_SERVICE_ACCOUNT` lo chiede.

### ☐ 3. Test del Worker
```bash
curl https://lillofind-worker.tuonome.workers.dev/
# Atteso: {"ok":true,"service":"lillofind-worker"}
```

### ☐ 4. Collega il frontend
Sostituisci `CHANGEME` con il tuo URL Worker in **DUE file**:
- `firebase.js`  → costante `WORKER_BASE`
- `importer.html` → costante `WORKER_BASE` (nel blocco `<script type="module">` in alto)

### ☐ 5. (Consigliato) Aggiorna le origini CORS del Worker
In `cloudflare-worker/wrangler.toml`, la variabile `ALLOWED_ORIGINS` deve
includere il dominio del tuo sito (già preconfigurato per `*.web.app` e
`*.firebaseapp.com`). Se usi un dominio custom, aggiungilo e ri-deploya il Worker.

### ☐ 6. Pubblica il sito
Fai merge di questo branch su `main`. Il workflow GitHub pubblica
automaticamente l'Hosting (solo Hosting, gratis su Spark).
Oppure manualmente:
```bash
npx firebase-tools deploy --only hosting --project lillofind-c455c
```

### ☐ 7. (Opzionale) Downgrade a Spark per togliere la carta
Una volta che tutto funziona su Cloudflare, in Console Firebase puoi tornare
al piano **Spark** (rimuove qualsiasi rischio di addebito). Firestore, Auth e
Hosting continuano a funzionare gratis.

---

## Cosa è già fatto nel codice
- ✅ Worker completo in `cloudflare-worker/` (build verificata)
- ✅ Shim `lfCallable` nel frontend: le chiamate funzionano identiche a prima
- ✅ `proxyImage` reindirizzato al Worker (con fallback)
- ✅ Workflow di deploy semplificato a solo-Hosting
- ✅ Chiave RESEND rimossa dal codice (ora è un secret)

## Cosa NON è ancora migrato
- ⚠️ **yupooFetch** (scraper import Yupoo/Taobao, 570 righe): chiamarlo dà un
  messaggio chiaro. È admin-only; nel frattempo puoi aggiungere prodotti a mano.
  Sarà la fase finale.

## Rollback
Se qualcosa non va, le Cloud Functions originali sono ancora in
`functions/index.js` (intatte). Basterebbe riattivare Blaze e ripristinare il
vecchio workflow per tornare indietro.
