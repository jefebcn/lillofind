// ════════════════════════════════════════════════════════════════
// Stream — catalogo video e riproduzione
//
// Modello di accesso MISTO:
//   • catalogo e schede  → pubblici (vetrina e SEO)
//   • URL riproducibili  → solo dietro autenticazione
//
// Il perno è la separazione delle collection: `titles` ed `episodes`
// hanno lettura pubblica (il browser legge Firestore direttamente),
// mentre `title_sources` è chiusa a ogni client dalle regole e
// raggiungibile solo dal service account del Worker. L'unica via
// d'uscita per un URL riproducibile è `play()`, che richiede login.
// ════════════════════════════════════════════════════════════════

import { HttpsError } from '../lib/errors.js';
import {
  makeEpisodeId, slugify, isAllowedSource,
  publicTitle, publicEpisode, groupSeasons, sortEpisodes,
} from '../lib/stream-lib.js';

const TITLES = 'titles';
const EPISODES = 'episodes';
const SOURCES = 'title_sources';
const CONFIG = 'stream_config';

// Quante schede al massimo per pagina/riga
const PAGE = 24;
const ROW = 20;

// Righe di default se stream_config/home non è ancora stato composto
const DEFAULT_ROWS = [
  { label: '🎬 Film', kind: 'query', filter: { type: 'movie' } },
  { label: '📺 Serie TV', kind: 'query', filter: { type: 'series' } },
];

// ── Lettura catalogo (pubblica) ─────────────────────────────────

// Solo i titoli pubblicati finiscono in vetrina: 'unlisted' resta
// raggiungibile per slug diretto ma fuori da home, sfoglia e ricerca.
function isListable(t) { return t && t.visibility !== 'unlisted'; }

// Una query per volta con un solo filtro di uguaglianza, poi si affina
// in JS: così restiamo sugli indici a campo singolo creati da Firestore
// e non serve dichiarare indici compositi per ogni combinazione.
async function queryTitles(db, filter = {}, limit = PAGE) {
  const where = [];
  if (filter.genre) where.push(['genres', 'array-contains', String(filter.genre)]);
  else if (filter.type) where.push(['type', '==', String(filter.type)]);

  const rows = await db.runQuery(TITLES, {
    where,
    orderBy: [['__name__', 'asc']],
    limit: Math.min(limit * 4, 200),
  });

  return rows.filter(t => {
    if (!isListable(t)) return false;
    if (filter.type && t.type !== filter.type) return false;
    if (filter.genre && !(t.genres || []).includes(filter.genre)) return false;
    if (filter.year && String(t.year) !== String(filter.year)) return false;
    return true;
  });
}

// Ricerca per prefisso sul titolo normalizzato. Firestore non fa
// substring: `titleLower` viene scritto da saveTitle apposta, e il
// range >= q … <= q+ è servito dall'indice a campo singolo.
async function searchTitles(db, q) {
  const term = String(q || '').trim().toLowerCase().slice(0, 60);
  if (!term) return [];
  const rows = await db.runQuery(TITLES, {
    where: [['titleLower', '>=', term], ['titleLower', '<=', term + '']],
    orderBy: [['titleLower', 'asc']],
    limit: PAGE,
  });
  return rows.filter(isListable);
}

// GET /stream?kind=home → hero + righe già risolte
export async function home(db) {
  let cfg = null;
  try { const d = await db.getDoc(CONFIG, 'home'); cfg = d.exists ? d.data() : null; } catch (_) { cfg = null; }

  const heroIds = (cfg && Array.isArray(cfg.hero)) ? cfg.hero.slice(0, 8) : [];
  let hero = [];
  if (heroIds.length) {
    const docs = await db.getMany(TITLES, heroIds);
    hero = docs.filter(d => d.exists)
      .map(d => publicTitle({ id: d.id, ...d.data() }))
      .filter(t => t.title);
  }
  // Nessun hero configurato: si usano i titoli marcati featured
  if (!hero.length) {
    const feat = await db.runQuery(TITLES, {
      where: [['featured', '==', true]],
      orderBy: [['__name__', 'asc']],
      limit: 8,
    });
    hero = feat.filter(isListable).map(t => publicTitle(t));
  }

  const rowDefs = (cfg && Array.isArray(cfg.rows) && cfg.rows.length) ? cfg.rows.slice(0, 10) : DEFAULT_ROWS;
  const rows = [];
  for (const def of rowDefs) {
    let items = [];
    if (def.kind === 'manual' && Array.isArray(def.titleIds) && def.titleIds.length) {
      const docs = await db.getMany(TITLES, def.titleIds.slice(0, ROW));
      items = docs.filter(d => d.exists).map(d => publicTitle({ id: d.id, ...d.data() }));
    } else {
      items = (await queryTitles(db, def.filter || {}, ROW)).slice(0, ROW).map(publicTitle);
    }
    if (items.length) rows.push({ label: String(def.label || '').slice(0, 60), items });
  }

  return { hero, rows };
}

// GET /stream?kind=browse → griglia filtrabile
export async function browse(db, params = {}) {
  const q = String(params.q || '').trim();
  const list = q
    ? await searchTitles(db, q)
    : await queryTitles(db, {
        type: params.type || '',
        genre: params.genre || '',
        year: params.year || '',
      }, PAGE);
  return { results: list.slice(0, PAGE).map(publicTitle), query: q };
}

// GET /stream?kind=title&slug= → scheda completa, MAI le sorgenti
export async function titleBySlug(db, slug) {
  const clean = slugify(slug);
  if (!clean) throw new HttpsError('invalid-argument', 'Slug mancante.');

  const rows = await db.runQuery(TITLES, { where: [['slug', '==', clean]], limit: 1 });
  if (!rows.length) throw new HttpsError('not-found', 'Titolo non trovato.');
  const t = rows[0];

  const out = publicTitle(t);
  if (t.type === 'series') {
    const eps = await db.runQuery(EPISODES, {
      where: [['titleId', '==', t.id]],
      orderBy: [['__name__', 'asc']],
      limit: 400,
    });
    out.seasons = groupSeasons(sortEpisodes(eps).map(publicEpisode));
    out.episodeCount = eps.length;
  }
  return out;
}

// ── Riproduzione (autenticata) ──────────────────────────────────

// Ordine di preferenza: HLS prima (qualità adattiva), poi MP4.
function pickSource(list) {
  const usable = (list || []).filter(s => s && s.url && isAllowedSource(s.url));
  if (!usable.length) return null;
  return usable.find(s => s.kind === 'hls') || usable[0];
}

// POST /streamPlay — l'unico punto da cui esce un URL riproducibile.
// Richiede `auth: 'required'`: il router rifiuta con 401 chi non è loggato.
export async function play(data, { env, db }) {
  const titleId = String((data && data.titleId) || '').slice(0, 120);
  const episodeId = data && data.episodeId ? String(data.episodeId).slice(0, 160) : '';
  if (!titleId) throw new HttpsError('invalid-argument', 'titleId mancante.');

  const doc = await db.getDoc(TITLES, titleId);
  if (!doc.exists) throw new HttpsError('not-found', 'Titolo non trovato.');
  const t = doc.data();

  const where = [['titleId', '==', titleId]];
  if (episodeId) where.push(['episodeId', '==', episodeId]);
  const all = await db.runQuery(SOURCES, { where, limit: 30 });

  // Per un film le sorgenti non hanno episodeId: escludiamo quelle di episodio
  const scoped = episodeId ? all : all.filter(s => !s.episodeId);
  const src = pickSource(scoped);
  if (!src) {
    throw new HttpsError('not-found', 'Nessuna sorgente riproducibile per questo titolo.');
  }

  // Gli HLS passano dal proxy del manifest: le origini esterne spesso
  // non espongono header CORS utilizzabili da hls.js.
  const base = String(env.WORKER_PUBLIC_BASE || '').replace(/\/+$/, '');
  const url = src.kind === 'hls'
    ? (base ? base : '') + '/streamManifest?u=' + encodeURIComponent(src.url)
    : src.url;

  return {
    kind: src.kind === 'hls' ? 'hls' : 'mp4',
    url,
    label: src.label || '',
    subtitles: Array.isArray(src.subtitles)
      ? src.subtitles.filter(s => s && s.url && isAllowedSource(s.url)).slice(0, 8)
      : [],
    title: t.title || '',
    episodeId: episodeId || null,
  };
}

// ── Admin ───────────────────────────────────────────────────────
// L'autorizzazione è garantita dal router (auth: 'adminEmail').

const TYPES = ['movie', 'series'];

function cleanSources(list, labelForErr) {
  const out = [];
  for (const s of (Array.isArray(list) ? list.slice(0, 20) : [])) {
    const url = String((s && s.url) || '').trim();
    if (!url) continue;
    if (!isAllowedSource(url)) {
      throw new HttpsError('invalid-argument',
        `Sorgente non ammessa per ${labelForErr}: ${url.slice(0, 80)} — l'host non è nell'allowlist o non è https.`);
    }
    out.push({
      kind: /\.m3u8(\?|$)/i.test(url) || s.kind === 'hls' ? 'hls' : 'mp4',
      url,
      label: String(s.label || '').slice(0, 60),
      quality: String(s.quality || '').slice(0, 20),
      language: String(s.language || 'it').slice(0, 10),
      subtitles: Array.isArray(s.subtitles)
        ? s.subtitles.slice(0, 8).map(t => ({
            lang: String(t.lang || 'it').slice(0, 10),
            label: String(t.label || '').slice(0, 40),
            url: String(t.url || '').slice(0, 600),
          })).filter(t => t.url && isAllowedSource(t.url))
        : [],
    });
  }
  return out;
}

// POST /streamSaveTitle — crea o aggiorna un titolo con episodi e sorgenti
export async function saveTitle(p, { db }) {
  if (!p || !p.title) throw new HttpsError('invalid-argument', 'Titolo mancante.');
  const type = String(p.type || 'movie').toLowerCase();
  if (!TYPES.includes(type)) throw new HttpsError('invalid-argument', 'type non valido (movie|series).');

  const name = String(p.title).slice(0, 200);
  const slug = slugify(p.slug || name);
  if (!slug) throw new HttpsError('invalid-argument', 'Impossibile generare uno slug da questo titolo.');

  // Lo slug è la chiave pubblica: non può collidere con un altro titolo
  const clash = await db.runQuery(TITLES, { where: [['slug', '==', slug]], limit: 2 });
  const id = p.id ? String(p.id).slice(0, 120) : '';
  if (clash.some(c => c.id !== id)) {
    throw new HttpsError('already-exists', `Lo slug “${slug}” è già usato da un altro titolo.`);
  }

  const doc = {
    type,
    title: name,
    titleLower: name.toLowerCase(),          // serve alla ricerca per prefisso
    originalTitle: String(p.originalTitle || '').slice(0, 200),
    slug,
    overview: String(p.overview || '').slice(0, 4000),
    year: String(p.year || '').slice(0, 8),
    runtime: typeof p.runtime === 'number' ? p.runtime : 0,
    genres: Array.isArray(p.genres) ? p.genres.slice(0, 12).map(g => String(g).slice(0, 40)) : [],
    rating: typeof p.rating === 'number' ? p.rating : null,
    cast: Array.isArray(p.cast) ? p.cast.slice(0, 12) : [],
    country: String(p.country || '').slice(0, 60),
    language: String(p.language || 'it').slice(0, 10),
    posterUrl: String(p.posterUrl || '').slice(0, 600),
    backdropUrl: String(p.backdropUrl || '').slice(0, 600),
    logoUrl: String(p.logoUrl || '').slice(0, 600),
    trailerUrl: String(p.trailerUrl || '').slice(0, 600),
    network: String(p.network || '').slice(0, 60),
    status: String(p.status || '').slice(0, 40),
    visibility: p.visibility === 'unlisted' ? 'unlisted' : 'public',
    featured: !!p.featured,
    featuredOrder: typeof p.featuredOrder === 'number' ? p.featuredOrder : 0,
    sourceOrigin: 'external',                // fase 2: 'r2' quando si ospiterà in proprio
    updatedAt: new Date(),
  };

  // Le sorgenti si validano PRIMA di scrivere il titolo, così un URL
  // rifiutato non lascia a metà un titolo senza contenuto.
  const movieSources = type === 'movie' ? cleanSources(p.sources, name) : [];
  const episodes = [];
  if (type === 'series' && Array.isArray(p.episodes)) {
    for (const ep of p.episodes.slice(0, 400)) {
      const season = parseInt(ep.season, 10) || 0;
      const number = parseInt(ep.number, 10) || 0;
      if (!season || !number) continue;
      episodes.push({
        season, number,
        title: String(ep.title || '').slice(0, 200),
        overview: String(ep.overview || '').slice(0, 2000),
        stillUrl: String(ep.stillUrl || '').slice(0, 600),
        runtime: typeof ep.runtime === 'number' ? ep.runtime : 0,
        sources: cleanSources(ep.sources, `S${season}E${number}`),
      });
    }
  }

  let titleId = id;
  if (titleId) {
    await db.updateDoc(TITLES, titleId, doc);
  } else {
    doc.createdAt = new Date();
    titleId = await db.addDoc(TITLES, doc);
  }

  // Sorgenti: si riscrivono da zero a ogni salvataggio, così una
  // sorgente rimossa dall'admin sparisce davvero.
  const oldSources = await db.runQuery(SOURCES, { where: [['titleId', '==', titleId]], limit: 500 });
  for (const s of oldSources) await db.deleteDoc(SOURCES, s.id);

  for (const s of movieSources) await db.addDoc(SOURCES, { titleId, episodeId: '', ...s });

  for (const ep of episodes) {
    const episodeId = makeEpisodeId(titleId, ep.season, ep.number);
    const { sources, ...meta } = ep;
    await db.setDoc(EPISODES, episodeId, { titleId, ...meta, updatedAt: new Date() });
    for (const s of sources) await db.addDoc(SOURCES, { titleId, episodeId, ...s });
  }

  return { id: titleId, slug, episodes: episodes.length };
}

// POST /streamDeleteTitle — rimuove titolo, episodi e sorgenti collegate
export async function deleteTitle(data, { db }) {
  const id = String((data && data.id) || '').slice(0, 120);
  if (!id) throw new HttpsError('invalid-argument', 'ID mancante.');

  const srcs = await db.runQuery(SOURCES, { where: [['titleId', '==', id]], limit: 500 });
  for (const s of srcs) await db.deleteDoc(SOURCES, s.id);

  const eps = await db.runQuery(EPISODES, { where: [['titleId', '==', id]], limit: 500 });
  for (const e of eps) await db.deleteDoc(EPISODES, e.id);

  await db.deleteDoc(TITLES, id);
  return { ok: true, episodi: eps.length, sorgenti: srcs.length };
}

// POST /streamAdminList — elenco completo per il pannello (anche gli unlisted)
export async function adminList(data, { db }) {
  const rows = await db.runQuery(TITLES, { orderBy: [['__name__', 'asc']], limit: 500 });
  return {
    results: rows.map(t => ({
      id: t.id, type: t.type, title: t.title, slug: t.slug, year: t.year,
      posterUrl: t.posterUrl, visibility: t.visibility, featured: !!t.featured,
    })),
  };
}

// POST /streamAdminTitle — un titolo COMPLETO di sorgenti, per l'editor
export async function adminTitle(data, { db }) {
  const id = String((data && data.id) || '').slice(0, 120);
  if (!id) throw new HttpsError('invalid-argument', 'ID mancante.');
  const doc = await db.getDoc(TITLES, id);
  if (!doc.exists) throw new HttpsError('not-found', 'Titolo non trovato.');

  const srcs = await db.runQuery(SOURCES, { where: [['titleId', '==', id]], limit: 500 });
  const eps = sortEpisodes(await db.runQuery(EPISODES, { where: [['titleId', '==', id]], limit: 500 }));

  return {
    id,
    ...doc.data(),
    sources: srcs.filter(s => !s.episodeId),
    episodes: eps.map(e => ({ ...e, sources: srcs.filter(s => s.episodeId === e.id) })),
  };
}

// POST /streamSaveHome — hero e righe della home
export async function saveHome(data, { db }) {
  const hero = Array.isArray(data && data.hero) ? data.hero.slice(0, 8).map(x => String(x).slice(0, 120)) : [];
  const rows = Array.isArray(data && data.rows) ? data.rows.slice(0, 10).map(r => ({
    label: String(r.label || '').slice(0, 60),
    kind: r.kind === 'manual' ? 'manual' : 'query',
    titleIds: Array.isArray(r.titleIds) ? r.titleIds.slice(0, 20).map(x => String(x).slice(0, 120)) : [],
    filter: {
      type: String((r.filter && r.filter.type) || '').slice(0, 20),
      genre: String((r.filter && r.filter.genre) || '').slice(0, 40),
    },
  })) : [];
  await db.setDoc(CONFIG, 'home', { hero, rows, updatedAt: new Date() });
  return { ok: true, hero: hero.length, rows: rows.length };
}

// ── Import metadati (senza API key) ─────────────────────────────
// Stessa filosofia di /watch: TVMaze per le serie, iTunes per i film.
// Nessuna chiave da gestire, nessun limite di quota da sorvegliare.

async function jsonOf(url, headers) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json', ...(headers || {}) },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new HttpsError('unavailable', 'Sorgente metadati non raggiungibile (' + r.status + ').');
  return r.json();
}

const ITUNES_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
};

function stripTags(h) { return String(h || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

// POST /streamImportMeta — cerca metadati da precompilare nell'editor
export async function importMeta(data, { env }) {
  const q = String((data && data.q) || '').trim().slice(0, 80);
  const type = String((data && data.type) || 'movie').toLowerCase();
  if (!q) throw new HttpsError('invalid-argument', 'Termine di ricerca mancante.');

  if (type === 'series') {
    const arr = await jsonOf('https://api.tvmaze.com/search/shows?q=' + encodeURIComponent(q));
    return {
      results: (arr || []).slice(0, 10).map(r => {
        const s = r.show || {};
        return {
          type: 'series',
          title: s.name || '',
          year: (s.premiered || '').slice(0, 4),
          overview: stripTags(s.summary),
          genres: s.genres || [],
          rating: (s.rating && s.rating.average) || null,
          posterUrl: (s.image && (s.image.original || s.image.medium)) || '',
          network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '',
          status: s.status || '',
          language: s.language || '',
          externalId: String(s.id || ''),
        };
      }).filter(x => x.title),
    };
  }

  const f = await jsonOf(
    'https://itunes.apple.com/search?media=movie&country=it&limit=12&term=' + encodeURIComponent(q),
    ITUNES_HEADERS
  );
  return {
    results: ((f && f.results) || []).map(r => ({
      type: 'movie',
      title: r.trackName || '',
      year: String(r.releaseDate || '').slice(0, 4),
      overview: String(r.longDescription || r.shortDescription || '').slice(0, 4000),
      genres: r.primaryGenreName ? [r.primaryGenreName] : [],
      rating: null,
      // L'artwork iTunes arriva a 100px: si chiede la versione grande
      posterUrl: String(r.artworkUrl100 || '').replace(/\/\d+x\d+bb\.(jpg|png)/i, '/600x900bb.$1'),
      runtime: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 60000) : 0,
      country: r.country || '',
      externalId: String(r.trackId || ''),
    })).filter(x => x.title),
  };
}
