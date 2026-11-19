# LILLOFIND

Shop online di streetwear e sneakers (lillofind.shop) di Alex Conti. Scrivi e rispondi sempre in italiano.

## Com'è fatto

- Sito statico su Firebase Hosting (`index.html`, `admin.html`, `importer.html`, `firebase.js`), Firestore e Firebase Auth sul piano gratuito Spark.
- Backend su Cloudflare Worker gratuito: `cloudflare-worker/` (endpoint e deploy nel suo README). `functions/` sono le vecchie Cloud Functions.
- Script di manutenzione del catalogo in `scripts/`; automazioni in `.github/workflows/` (pubblicazione catalogo, deploy, contenuti social).

## Dove guardare

| Lavoro | File |
|---|---|
| Backend, endpoint, secret | `cloudflare-worker/README.md` |
| Sicurezza, pagamenti, cose da fare nei pannelli | `SICUREZZA.md` |
| Perché Cloudflare e non Firebase Functions | `MIGRAZIONE-CLOUDFLARE.md` |
| Regole del database | `firestore.rules` |

## Regole

- Costo zero: niente servizi a pagamento (niente piano Blaze) senza chiederlo ad Alex.
- Il repository è pubblico: nessuna chiave o segreto nel codice, solo secret del Worker o di GitHub.

## Fine lavoro: imparare senza appesantire

Quando Alex scrive «SESSIONE FINITA» (o un lavoro si chiude), prima della risposta finale:
1. Ripensa alla sessione senza rileggere file: cosa è costato più tentativi o letture, cosa ha funzionato al primo colpo, cosa si ripeterà.
2. Salva solo ciò che fa risparmiare la volta dopo, nel posto giusto:
   - regola valida per tutto il progetto (comando, trappola, scelta di Alex) → una riga in questo CLAUDE.md;
   - dettaglio di un'area (come funziona un modulo, un servizio, un deploy) → il documento di quell'area già indicato sopra;
   - lavoro che si ripete (pubblicare, importare, rigenerare, rilasciare) → una riga in `docs/RICETTE.md` (crealo se manca): `COSA | comando o script | trappole | la prossima volta: …`.
3. Limiti di peso, perché questo file si carica in ogni sessione: CLAUDE.md al massimo ~8 KB; righe corte; se una riga nuova sostituisce una vecchia, togli la vecchia; niente diario («fatto il …»), niente elenchi di commit, niente stato temporaneo: quelli stanno in git.
4. Nella risposta finale, una riga: cosa hai salvato e dove.

A inizio lavoro: se il lavoro somiglia a uno già fatto, cerca con grep in `docs/RICETTE.md` prima di ripartire da zero.
