// Test locale delle parti a logica pura (eseguibile con `node test/logic.test.mjs`).
// Non tocca rete/Firestore: valida convertitori e calcolo spedizione.
import { toFsFields, fromFsFields, buildStructuredQuery, docPath } from '../src/lib/firestore.js';
import { getProductWeight, getShippingCost } from '../src/lib/shipping.js';
import {
  episodeCode, makeEpisodeId, parseEpisodeId, slugify, isAllowedSource,
  absolutize, rewriteManifest, publicTitle, publicEpisode, groupSeasons,
} from '../src/lib/stream-lib.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`❌ ${label}\n   atteso: ${e}\n   ottenuto: ${a}`); }
}

// ── Round-trip convertitori Firestore ──────────────────────────
const order = {
  orderId: 'LILLO-ABC123',
  total: 42.10,
  qty: 3,
  isDigital: false,
  items: [
    { name: 'Nike Dunk', price: 20, qty: 1, sizes: ['40', '41'] },
    { name: 'Sub', price: 2.5, isDigital: true },
  ],
  address: { street: 'Via Roma 1', city: 'Milano', zip: '20100' },
  notes: '',
};
const round = fromFsFields(toFsFields(order));
eq(round.orderId, 'LILLO-ABC123', 'string round-trip');
eq(round.total, 42.10, 'double round-trip');
eq(round.qty, 3, 'integer round-trip');
eq(round.isDigital, false, 'boolean round-trip');
eq(round.items.length, 2, 'array length');
eq(round.items[0].sizes, ['40', '41'], 'nested array');
eq(round.items[1].isDigital, true, 'nested boolean');
eq(round.address.city, 'Milano', 'nested map');
eq(round.notes, '', 'empty string');

// integerValue arriva come stringa da Firestore: deve tornare number
eq(typeof round.qty, 'number', 'integer is number');

// undefined deve essere omesso (non serializzato)
const withUndef = toFsFields({ a: 1, b: undefined });
eq(Object.keys(withUndef), ['a'], 'undefined omitted');

// ── Calcolo peso ────────────────────────────────────────────────
eq(getProductWeight({ weightKg: 1.2 }), 1.2, 'peso esplicito');
eq(getProductWeight({ category: 'tshirt' }), 0.35, 'peso categoria tshirt');
eq(getProductWeight({ category: 'scarpe', boxOption: 'con_scatola' }), 2.5, 'scarpe con scatola');
eq(getProductWeight({ category: 'scarpe', boxOption: 'senza_scatola' }), 2.0, 'scarpe senza scatola');
eq(getProductWeight({ category: 'scarpe_box' }), 2.5, 'scarpe_box default');
eq(getProductWeight({ category: 'sconosciuta' }), 0.5, 'categoria sconosciuta → 0.5');

// ── Fasce spedizione ────────────────────────────────────────────
eq(getShippingCost(0.5), 12, 'spedizione <=1kg');
eq(getShippingCost(2), 18, 'spedizione <=3kg');
eq(getShippingCost(5), 25, 'spedizione <=6kg');
eq(getShippingCost(8), 35, 'spedizione <=10kg');
eq(getShippingCost(50), 50, 'spedizione oltre');

// ════════════════════════════════════════════════════════════════
// Catalogo streaming
// ════════════════════════════════════════════════════════════════

// ── structuredQuery ─────────────────────────────────────────────
// Un filtro solo → fieldFilter diretto, senza compositeFilter attorno
eq(
  buildStructuredQuery('titles', { where: [['type', '==', 'movie']] }),
  {
    from: [{ collectionId: 'titles' }],
    where: { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'movie' } } },
  },
  'query: filtro singolo senza composite'
);

// Più filtri → composite in AND
const qMulti = buildStructuredQuery('titles', {
  where: [['visibility', '==', 'public'], ['genres', 'array-contains', 'Azione']],
  orderBy: [['createdAt', 'desc']],
  limit: 24,
});
eq(qMulti.where.compositeFilter.op, 'AND', 'query: composite AND');
eq(qMulti.where.compositeFilter.filters.length, 2, 'query: due filtri');
eq(qMulti.where.compositeFilter.filters[1].fieldFilter.op, 'ARRAY_CONTAINS', 'query: array-contains');
eq(qMulti.orderBy, [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }], 'query: orderBy desc');
eq(qMulti.limit, 24, 'query: limit');
eq(qMulti.startAt, undefined, 'query: nessun cursore se non richiesto');

// Cursore: startAt + before:false è lo startAfter dell'SDK client
const qCur = buildStructuredQuery('titles', {
  orderBy: [['title', 'asc'], ['__name__', 'asc']],
  startAfter: ['Nosferatu', { __ref: docPath('proj', 'titles', 'abc') }],
});
eq(qCur.startAt.before, false, 'cursore: before=false (startAfter)');
eq(qCur.startAt.values[0], { stringValue: 'Nosferatu' }, 'cursore: valore tipizzato');
eq(
  qCur.startAt.values[1],
  { referenceValue: 'projects/proj/databases/(default)/documents/titles/abc' },
  'cursore: __name__ come reference'
);
eq(qCur.orderBy[1].direction, 'ASCENDING', 'query: orderBy asc di default');

// Un operatore sconosciuto deve fallire subito, non produrre query sbagliate in silenzio
let opThrew = false;
try { buildStructuredQuery('titles', { where: [['x', 'LIKE', 'y']] }); } catch (_) { opThrew = true; }
eq(opThrew, true, 'query: operatore non supportato solleva errore');

// ── Id episodio ─────────────────────────────────────────────────
eq(episodeCode(1, 3), 's01e03', 'episodio: codice con zero padding');
eq(episodeCode(12, 104), 's12e104', 'episodio: numeri a piu cifre');
eq(makeEpisodeId('abc', 2, 7), 'abc_s02e07', 'episodio: id documento');
eq(parseEpisodeId('abc_s02e07'), { titleId: 'abc', season: 2, number: 7 }, 'episodio: parse');
// Un titleId che contiene underscore non deve rompere il parse
eq(parseEpisodeId('a_b_c_s01e02'), { titleId: 'a_b_c', season: 1, number: 2 }, 'episodio: titleId con underscore');
eq(parseEpisodeId('non-un-episodio'), null, 'episodio: id malformato da null');

// ── Slug ────────────────────────────────────────────────────────
eq(slugify('Citta di Notte'), 'citta-di-notte', 'slug: base');
eq(slugify("L'Alba - 1927!"), 'lalba-1927', 'slug: apostrofi e punteggiatura');
eq(slugify('  ---  '), '', 'slug: input senza lettere');

// ── Allowlist sorgenti ──────────────────────────────────────────
eq(isAllowedSource('https://archive.org/download/x/x.mp4'), true, 'sorgente: host in lista');
eq(isAllowedSource('https://ia801.us.archive.org/x.m3u8'), true, 'sorgente: sottodominio ammesso');
eq(isAllowedSource('http://archive.org/x.mp4'), false, 'sorgente: http rifiutato');
eq(isAllowedSource('https://evil.example/x.mp4'), false, 'sorgente: host fuori lista');
// Il controllo non deve essere un banale endsWith sul nome
eq(isAllowedSource('https://notarchive.org/x.mp4'), false, 'sorgente: suffisso ingannevole rifiutato');
eq(isAllowedSource('non-un-url'), false, 'sorgente: URL non valido');

// ── Manifest HLS ────────────────────────────────────────────────
const BASE = 'https://archive.org/v/film/index.m3u8';
eq(absolutize('seg1.ts', BASE), 'https://archive.org/v/film/seg1.ts', 'manifest: relativo diventa assoluto');
eq(absolutize('https://cdn.x/s.ts', BASE), 'https://cdn.x/s.ts', 'manifest: assoluto invariato');

const media = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
  'seg1.ts',
  'sub/seg2.ts',
  'https://cdn.altro/seg3.ts',
  '',
].join('\n');
eq(
  rewriteManifest(media, BASE).split('\n'),
  [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://archive.org/v/film/key.bin"',
    'https://archive.org/v/film/seg1.ts',
    'https://archive.org/v/film/sub/seg2.ts',
    'https://cdn.altro/seg3.ts',
    '',
  ],
  'manifest: segmenti e URI resi assoluti'
);

// Le playlist annidate devono passare dal proxy (stesso problema CORS),
// i segmenti no: sono migliaia di richieste e restano sull'origine.
const master = ['#EXT-X-STREAM-INF:BANDWIDTH=800000', '720p.m3u8', 'seg.ts'].join('\n');
eq(
  rewriteManifest(master, BASE, u => '/streamManifest?u=' + encodeURIComponent(u)).split('\n'),
  [
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    '/streamManifest?u=' + encodeURIComponent('https://archive.org/v/film/720p.m3u8'),
    'https://archive.org/v/film/seg.ts',
  ],
  'manifest: solo le playlist annidate passano dal proxy'
);
eq(rewriteManifest('', BASE), '', 'manifest: input vuoto');

// ── Proiezioni pubbliche (perno di sicurezza) ───────────────────
// Il catalogo ha lettura pubblica: nessun URL riproducibile puo uscire.
const rawTitle = {
  id: 't1', type: 'movie', title: 'Nosferatu', slug: 'nosferatu', year: 1922,
  posterUrl: 'https://x/p.jpg', genres: ['Horror'],
  url: 'https://archive.org/segreto.mp4',
  sources: [{ url: 'https://archive.org/segreto.mp4' }],
  campoAggiuntoDomani: 'anche-questo-resta-fuori',
};
const pub = publicTitle(rawTitle);
eq(pub.title, 'Nosferatu', 'pubblico: i metadati passano');
eq(pub.url, undefined, 'pubblico: url sorgente escluso');
eq(pub.sources, undefined, 'pubblico: array sources escluso');
eq(pub.campoAggiuntoDomani, undefined, 'pubblico: allowlist, non blocklist');
eq(JSON.stringify(pub).includes('segreto'), false, 'pubblico: nessuna traccia della sorgente');

const pubEp = publicEpisode({ id: 'e1', titleId: 't1', season: 1, number: 2, title: 'Ep', url: 'https://x/s.mp4' });
eq(pubEp.url, undefined, 'pubblico: episodio senza url');
eq(pubEp.season, 1, 'pubblico: episodio conserva la stagione');

// ── Stagioni ────────────────────────────────────────────────────
const eps = [
  { season: 2, number: 1 }, { season: 1, number: 2 },
  { season: 1, number: 1 }, { season: 2, number: 2 },
];
const grouped = groupSeasons(eps);
eq(grouped.length, 2, 'stagioni: due gruppi');
eq(grouped[0].season, 1, 'stagioni: ordinate');
eq(grouped[0].episodes.map(e => e.number), [1, 2], 'stagioni: episodi ordinati');
eq(groupSeasons([]), [], 'stagioni: lista vuota');

// ── Esito ───────────────────────────────────────────────────────
console.log(`\n${pass} passati, ${fail} falliti`);
if (fail > 0) process.exit(1);
console.log('✅ Tutta la logica pura è corretta');
