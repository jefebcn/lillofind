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

## Ripartenza: sapere a che punto siamo (pochi token)

All'inizio di ogni sessione (o quando Alex scrive «RIPRENDI <progetto>»), prima di qualsiasi altro file:
1. Questo CLAUDE.md è già caricato: non rileggerlo.
2. Leggi `docs/STATO.md` (corto: dove siamo, cosa è aperto, prossimo passo, decisioni recenti di Alex).
3. Controlla cosa è successo dopo la data di STATO.md, che è la fonte più precisa: `git log --oneline -15` e `git status -s` (altre chat, PR unite, automazioni). Se git e STATO non coincidono, vale git, e lo dici in una riga.
4. Se Alex ha già detto il lavoro di oggi, grep della parola chiave in `docs/RICETTE.md`, poi apri solo i documenti di quell'area. Se non l'ha detto, riassumi in 3 righe dove siamo e chiedi soltanto cosa fare oggi e se è cambiato qualcosa fuori dal repo (pannelli, store, social).
5. Non esplorare il repo e non aprire documenti grandi prima di sapere il lavoro.

## Fine lavoro: salvare il punto e imparare senza appesantire

Quando Alex scrive «SESSIONE FINITA» (o un lavoro si chiude), prima della risposta finale:
1. **Riscrivi `docs/STATO.md`** (al massimo ~40 righe, si sostituisce, non si accoda), con le sezioni: data e tema della sessione; Dove siamo (3-6 righe); Aperto / in corso (con file o PR); Prossimo passo consigliato; Decisioni recenti di Alex ancora valide; Attenzione (trappole attive). Le cose chiuse escono dallo STATO: restano in git.
2. Ripensa alla sessione senza rileggere file: cosa è costato più tentativi o letture, cosa ha funzionato al primo colpo, cosa si ripeterà.
3. Salva solo ciò che fa risparmiare la volta dopo, nel posto giusto:
   - regola valida per tutto il progetto (comando, trappola, scelta di Alex) → una riga in questo CLAUDE.md;
   - dettaglio di un'area (come funziona un modulo, un servizio, un deploy) → il documento di quell'area già indicato sopra;
   - lavoro che si ripete (pubblicare, importare, rigenerare, rilasciare) → una riga in `docs/RICETTE.md` (crealo se manca): `COSA | comando o script | trappole | la prossima volta: …`.
4. Limiti di peso, perché questo file si carica in ogni sessione: CLAUDE.md al massimo ~8 KB; righe corte; se una riga nuova sostituisce una vecchia, togli la vecchia; niente diario («fatto il …»), niente elenchi di commit, niente stato del giorno qui (va in STATO.md).
5. Commit di STATO, RICETTE e CLAUDE.md insieme al lavoro (stesso ramo o stessa PR).
6. Nella risposta finale, una riga: cosa hai salvato e dove.
