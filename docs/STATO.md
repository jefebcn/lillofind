# Stato – LILLOFIND

Aggiornato: 2026-11-19 (prima versione, ricostruita da git: da confermare con Alex alla prossima ripartenza)

## Dove siamo
- Shop online su lillofind.shop: catalogo importato da Yupoo e WooCommerce, ricerca per foto (aggiornata il 5/11), carrello sincronizzato tra computer e telefono, Costi & Margini con WhatsApp per persona.
- Backend su Cloudflare Worker; Firestore sul piano gratuito (la quota giornaliera può finire: i giri pesanti si programmano dopo il reset).
- Contenuti social settimanali generati in automatico (ultimo il 16/11).

## Aperto / in corso
- Passaggi nei pannelli elencati in `SICUREZZA.md` («Da fare dopo il merge», punti 1-6: chiave imgbb, service account del Worker, vecchie Cloud Functions, admin, costi fornitore, webhook Stripe): da verificare con Alex quali sono fatti.

## Prossimo passo consigliato
- Da decidere con Alex.

## Decisioni recenti di Alex ancora valide
- Costo zero: niente piano Blaze di Firebase.

## Attenzione
- Firestore gratuito: le operazioni su tutto il catalogo possono esaurire la quota del giorno.
