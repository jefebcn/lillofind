# LilloFind — Backend su Cloudflare Workers

Sostituisce le Firebase Cloud Functions (che richiedono il piano Blaze a pagamento)
con un Cloudflare Worker **gratuito** (uso commerciale permesso, 100k richieste/giorno).

Firestore, Firebase Auth e il sito (Hosting) restano su Firebase nel **piano gratuito
Spark** — nessuna migrazione dei dati.

## Cosa fa

| Endpoint | Metodo | Auth | Sostituisce |
|---|---|---|---|
| `/proxyImage?url=` | GET | pubblico | proxyImage |
| `/getAdminProducts` | POST | admin | getAdminProducts |
| `/getAdminOrders` | POST | admin | getAdminOrders |
| `/getAdminStats` | POST | admin | getAdminStats |
| `/saveProduct` | POST | admin | saveProduct |
| `/updateAdminProduct` | POST | admin | updateAdminProduct |
| `/deleteAdminProduct` | POST | admin | deleteAdminProduct |
| `/updateAdminOrder` | POST | admin | updateAdminOrder |
| `/batchSetGender` | POST | admin | batchSetGender |
| `/createPaymentIntent` | POST | utente | createPaymentIntent |
| `/validateOrder` | POST | utente | validateOrder |
| `/yupooAnalyze` | POST | admin | yupooAnalyze |
| `/yupooFetch` | POST | admin | ⚠️ da migrare (ultima fase) |

## Deploy passo-passo

### 1. Crea un account Cloudflare (gratis, senza carta)
https://dash.cloudflare.com/sign-up

### 2. Installa le dipendenze
```bash
cd cloudflare-worker
npm install
```

### 3. Login a Cloudflare
```bash
npx wrangler login
```

### 4. Crea il service account Firebase (per accedere a Firestore)
1. Console Firebase → ⚙ Impostazioni progetto → **Account di servizio**
2. "Genera nuova chiave privata" → scarica il file JSON
3. Caricalo come secret (incolla **tutto** il contenuto JSON quando richiesto):
```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```

### 5. Imposta gli altri secret
```bash
npx wrangler secret put STRIPE_SECRET_KEY     # sk_live_... o sk_test_...
npx wrangler secret put RESEND_API_KEY        # chiave Resend (rigenerata!)
npx wrangler secret put ANTHROPIC_API_KEY     # per l'analisi AI immagini
```

### 6. Deploy
```bash
npx wrangler deploy
```
Al termine Wrangler stampa l'URL del Worker, es:
`https://lillofind-worker.TUO-SUBDOMINIO.workers.dev`

### 7. Collega il frontend
Apri `firebase.js` (nella root del progetto) e imposta `WORKER_BASE` con l'URL del
Worker. Poi pubblica il sito (solo Hosting). Vedi `MIGRAZIONE-CLOUDFLARE.md` nella root.

## Test rapido
```bash
# Health check
curl https://lillofind-worker.TUO-SUBDOMINIO.workers.dev/
# → {"ok":true,"service":"lillofind-worker"}

# proxyImage (sostituisci con un URL immagine Yupoo reale)
curl "https://lillofind-worker.TUO-SUBDOMINIO.workers.dev/proxyImage?url=https://..."
```

## Sviluppo locale
```bash
npx wrangler dev        # avvia in locale su http://localhost:8787
```

## Note tecniche
- **Firestore via REST**: `firebase-admin` non gira su Workers (usa gRPC). Accediamo
  via REST API autenticandoci col service account (vedi `src/lib/firestore.js`).
- **Verifica login**: i token Firebase sono verificati con `jose` contro i certificati
  pubblici di Google (vedi `src/lib/auth.js`).
- **Stripe**: usa il fetch HTTP client compatibile con Workers.
