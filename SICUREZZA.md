# Sicurezza e pagamenti — cosa è cambiato e cosa devi fare tu

Blocco A dell'audit (punti 1-17). Il codice è sistemato e provato. Per alcune
cose serve un tuo passaggio in un pannello, perché richiedono accessi che il
repository non ha (e non deve avere).

## Da fare dopo il merge, in quest'ordine

1. **Chiave imgbb nel Worker** (punto 8). La chiave era scritta nel codice, e il
   repository è pubblico.
   - Rigenerala su imgbb (la vecchia va considerata pubblica).
   - Mettila come secret del Worker:
     Cloudflare → Workers → lillofind → Settings → Variables and Secrets →
     **Add** → tipo *Secret*, nome `IMGBB_KEY`.
   - Se manca, l'upload delle foto risponde «manca il secret IMGBB_KEY», e gli
     import usano l'immagine originale senza ricaricarla su imgbb.

2. **Service account dedicato al Worker** (punto 9). Oggi il Worker usa
   `GOOGLE_CREDENTIALS`, lo stesso service account del deploy Firebase, che può
   fare quasi tutto.
   - Google Cloud Console → progetto `lillofind-c455c` → IAM e amministrazione →
     **Account di servizio** → **Crea account di servizio**, nome `lillofind-worker`.
   - Ruoli:
     - **Cloud Datastore User**: serve per leggere e scrivere Firestore.
     - **Firebase Authentication Admin**: facoltativo. Serve solo per l'email
       «il tuo account è pronto» col link per impostare la password. Senza,
       il sito ripiega sull'email di reset standard di Firebase.
   - Sull'account → **Chiavi** → **Aggiungi chiave** → JSON. Scarica il file.
   - GitHub → lillofind → Settings → Secrets and variables → Actions →
     **New repository secret**: nome `WORKER_SERVICE_ACCOUNT`, valore = tutto il
     contenuto del file JSON. Poi cancella il file dal computer.
   - Al prossimo deploy del Worker si usa quello (il workflow lo preferisce già).

3. **Cloud Functions vecchie** (punto 1). Il sito chiama ancora `proxyImage` sulle
   Cloud Functions, quindi sono ancora deployate. La vecchia `validateOrder` non
   segnava i pagamenti come usati. Nel codice ora è spenta, ma conta quello che
   è online. Cancella da Firebase Console → Functions tutte **tranne**
   `proxyImage`:
   `validateOrder`, `createPaymentIntent`, `saveProduct`, `batchSetGender`,
   `getAdminStats`, `getAdminOrders`, `getAdminProducts`, `deleteAdminProduct`,
   `updateAdminProduct`, `updateAdminOrder`, `yupooFetch`, `yupooAnalyze`,
   `taobaoFetch`.
   Oppure da terminale: `firebase functions:delete validateOrder createPaymentIntent … --region europe-west1`.

4. **Admin** (punto 2). Ora è admin chi ha il claim `admin:true`, oppure un'email
   della lista **verificata**. `yishionvt@gmail.com` con l'accesso Google è già
   verificata: per te non cambia niente.
   - **`admin@lillofind.com`**: io non posso vedere Firebase Auth. Controlla in
     Firebase Console → Authentication se esiste. Se non esiste, dimmelo e la tolgo
     dalla lista. Con la verifica obbligatoria, comunque, nessuno può più
     diventare admin registrandola.
   - Facoltativo, più pulito: `scripts/set-admin-claim.mjs tua@email` imposta il
     claim. Dopo si può svuotare la lista email.

5. **Costi fornitore** (punto 7). La prima volta che apri `admin.html` dopo il
   deploy, i costi (costEUR, supplierPriceCNY, sourceUrl…) passano dai prodotti
   pubblici a `products_private`. Compare un messaggio col numero di prodotti
   spostati. Le pagine admin li mostrano come prima.

## Cosa è cambiato, punto per punto

| # | Problema | Stato |
|---|---|---|
| 1 | PaymentIntent riutilizzabile per N ordini | **Risolto.** L'ordine e `used_payment_intents/{id}` si scrivono in un solo commit atomico. Il secondo uso viene rifiutato. La vecchia function è spenta nel codice (resta da cancellarla online, vedi sopra). |
| 2 | Admin decisi dall'email senza verifica | **Risolto.** Regole, Worker e admin.html usano lo stesso criterio: claim `admin:true` o email verificata. Il campo `users.isAdmin` non conta più. *Serve una tua verifica su `admin@lillofind.com`.* |
| 3 | Ordini e profili letti tramite email non verificata | **Risolto.** Ogni ramo per email richiede `email_verified`. |
| 4 | XSS nella bacheca Spedizione di Gruppo | **Risolto.** Tutto passa dall'escape, i bottoni usano data-* e un listener, e le regole controllano i tipi (`maxPeople` intero, codice `LF` + 6, visibilità e stato da un elenco). |
| 5 | XSS dai dati del catalogo | **Risolto.** Una funzione `lfEsc()` per ogni campo inserito in HTML. La descrizione si mostra come testo semplice. Gli URL delle immagini passano solo se http(s). I testi si ripuliscono anche al salvataggio (firebase.js e Worker). |
| 6 | onclick con stringhe rompibili | **Risolto.** I valori stanno in `data-*` e c'è un solo listener. Gli altri argomenti in attributi usano `JSON.stringify` + escape. |
| 7 | Costi fornitore leggibili da tutti | **Risolto.** I campi stanno in `products_private`, solo admin. Lo smistamento è automatico in firebase.js e nel Worker; lo spostamento dei dati esistenti avviene al primo accesso admin. |
| 8 | Chiave imgbb nel codice | **Risolto nel codice.** *La rotazione e il secret li fai tu (vedi sopra).* |
| 9 | Worker col service account di deploy | **Istruzioni sopra.** Il workflow usa `WORKER_SERVICE_ACCOUNT` appena c'è. |
| 10 | Spam di ordini ed email | **Risolto.** Tetto agli ordini non pagati: 5/ora per utente, 10/ora per IP. L'email di conferma va al cliente solo se l'indirizzo è verificato o se ha pagato con carta; l'admin la riceve sempre, e il cliente del bonifico ora vede a schermo numero d'ordine, IBAN e causale (anticipato il punto 23). Niente più password dal browser: l'email "account pronto" contiene il link per impostarla, una volta sola per account e con un tetto per IP. |
| 11 | Referral farmabili | **Risolto.** Un invito vale solo se l'invitato ha un account reale e un ordine **pagato**. L'accredito è atomico (`referral_credits/{invitato}` + incremento): niente doppi accrediti in parallelo, e un invitato conta una volta sola. |
| 12 | Collezioni pubbliche senza controlli | **Risolto.** In `sessions` ogni campo ha il suo tipo e c'è un elenco chiuso di chiavi. `product_requests` e `stock_alerts` richiedono un utente: il sito crea un ospite anonimo se serve. |
| 13 | Recensioni falsificabili | **Risolto.** Una recensione per utente e prodotto (id `uid_prodotto`), col nome dell'account. *Il controllo "solo con ordine consegnato" non si può fare nelle regole senza un campo apposito: dimmi se lo vuoi, lo faccio passare dal Worker.* |
| 14 | Gruppi privati leggibili da tutti | **Risolto.** L'elenco mostra solo i gruppi pubblici e i propri. Il gruppo privato si apre conoscendo il codice: i gruppi nuovi hanno id = codice, quelli vecchi li migra l'host la prima volta che apre la pagina. |
| 15 | /streamPlay con token anonimi | **Risolto.** Gli account anonimi vengono rifiutati. |
| 16 | Hosting pubblicava tutto il repository | **Risolto.** Si pubblica `dist/`, preparata da `scripts/build-hosting.sh` con un elenco chiuso di file. |
| 17 | CORS | **Risolto.** In produzione niente origini `localhost` (per lo sviluppo stanno in `.dev.vars`), e niente `*` quando manca l'header Origin. |

In più, dalla tua segnalazione: **tracking "email non esistente"** in admin.
Il cliente si cerca anche negli ordini, non solo fra i profili. Il tracking si
salva anche se il profilo non c'era, e l'email col tracking parte comunque.

## Prove

- `cloudflare-worker`: `npm test`. Ci sono prove nuove per il pagamento usato
  una volta, l'admin con email non verificata, il tetto agli ordini, le email
  e gli inviti (anche in parallelo).
- `tests/rules`: le regole nell'emulatore Firestore (33 controlli, uno per
  regola nuova). Ora girano anche in CI.
- `tests/smoke`: c'è un prodotto «ostile» (virgolette, backslash, `<img onerror>`
  nel nome e `<script>` nella descrizione). Con il codice di prima la prova
  falliva, ora passa. In più si provano i click veri sulle card.
