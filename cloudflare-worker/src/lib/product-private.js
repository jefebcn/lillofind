// ════════════════════════════════════════════════════════════════
// Campi privati dei prodotti: costi fornitore e link alla fonte.
//
// I documenti di `products` sono leggibili da chiunque (lo shop li legge
// dal browser), quindi costEUR, supplierPriceCNY e sourceUrl erano pubblici:
// bastava una query dalla console per vedere margini e fornitori. Ora stanno
// in `products_private/{stesso id}`, che firestore.rules apre solo all'admin.
// Lo stesso elenco lo usano firebase.js (pagine admin) e la pubblicazione
// del catalogo: e' l'unico posto dove si decide cosa e' privato.
// ════════════════════════════════════════════════════════════════
export const PRIVATE_FIELDS = ['costEUR', 'costFx', 'costFxDate', 'costUpdatedAt', 'supplierPriceCNY', 'sourceUrl'];

// Divide un oggetto prodotto in parte pubblica e parte privata.
export function splitPrivate(obj) {
  const pub = {}, priv = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (PRIVATE_FIELDS.includes(k)) priv[k] = v; else pub[k] = v;
  }
  return { pub, priv };
}

export const hasPrivate = (obj) => PRIVATE_FIELDS.some(f => obj && f in obj);
