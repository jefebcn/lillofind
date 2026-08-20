// ════════════════════════════════════════════════════════════════
// Stream — logica pura del catalogo video
//
// Qui dentro non si tocca la rete né `env`: solo funzioni
// deterministiche, così sono verificabili da test/logic.test.mjs
// esattamente come lib/shipping.js.
// ════════════════════════════════════════════════════════════════

// ── Id episodio ─────────────────────────────────────────────────

// Numero → 's01e03'
export function episodeCode(season, number) {
  const s = Math.max(0, parseInt(season, 10) || 0);
  const e = Math.max(0, parseInt(number, 10) || 0);
  return 's' + String(s).padStart(2, '0') + 'e' + String(e).padStart(2, '0');
}

// Id documento di un episodio: '<titleId>_s01e03'
export function makeEpisodeId(titleId, season, number) {
  return String(titleId) + '_' + episodeCode(season, number);
}

// '<titleId>_s01e03' → { titleId, season, number }, oppure null se malformato
export function parseEpisodeId(id) {
  const m = /^(.+)_s(\d{1,3})e(\d{1,3})$/i.exec(String(id || ''));
  if (!m) return null;
  return { titleId: m[1], season: parseInt(m[2], 10), number: parseInt(m[3], 10) };
}

// ── Slug ────────────────────────────────────────────────────────

// Titolo → slug usabile in URL. Toglie accenti e punteggiatura.
export function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ── Allowlist degli host sorgente ───────────────────────────────

// Domini da cui accettiamo sorgenti video. Mai un proxy aperto:
// senza questa lista il Worker diventerebbe un relay per chiunque.
export const SOURCE_HOSTS = [
  'archive.org',
  'ia801.us.archive.org',
  'commons.wikimedia.org',
  'upload.wikimedia.org',
  'videos.pexels.com',
  'test-streams.mux.dev',
];

// true se l'URL è https e l'host è nell'allowlist (anche come sottodominio)
export function isAllowedSource(url, hosts = SOURCE_HOSTS) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return hosts.some(allowed => h === allowed || h.endsWith('.' + allowed));
}

// ── Manifest HLS ────────────────────────────────────────────────

// Risolve un riferimento relativo rispetto al manifest che lo contiene
export function absolutize(ref, baseUrl) {
  try { return new URL(String(ref), baseUrl).toString(); } catch (_) { return String(ref); }
}

// Riscrive un manifest .m3u8 rendendo assoluti tutti i riferimenti.
// I segmenti restano puntati all'origine (non passano dal Worker: sono
// migliaia di richieste e brucerebbero la quota); solo le playlist
// annidate vengono reindirizzate al proxy tramite `mapPlaylist`.
export function rewriteManifest(text, baseUrl, mapPlaylist) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  return lines.map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      // Attributi che contengono URI: EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA…
      return line.replace(/URI="([^"]*)"/g, (_m, u) => 'URI="' + absolutize(u, baseUrl) + '"');
    }
    const abs = absolutize(line.trim(), baseUrl);
    const isPlaylist = /\.m3u8(\?|#|$)/i.test(abs);
    return (isPlaylist && typeof mapPlaylist === 'function') ? mapPlaylist(abs) : abs;
  }).join('\n');
}

// ── Proiezioni pubbliche ────────────────────────────────────────
//
// PERNO DI SICUREZZA. In questo progetto il browser legge Firestore
// direttamente, quindi il catalogo ha lettura pubblica. Gli URL
// riproducibili vivono in una collection separata e non devono MAI
// comparire in una risposta pubblica: queste due funzioni sono
// allowlist di campi, non blocklist, così un campo nuovo aggiunto
// domani resta escluso per default.

const PUBLIC_TITLE_FIELDS = [
  'id', 'type', 'slug', 'title', 'originalTitle', 'overview',
  'year', 'runtime', 'genres', 'rating', 'cast', 'country', 'language',
  'posterUrl', 'backdropUrl', 'logoUrl', 'trailerKey', 'trailerUrl',
  'featured', 'featuredOrder', 'network', 'status',
];

const PUBLIC_EPISODE_FIELDS = [
  'id', 'titleId', 'season', 'number', 'title', 'overview', 'stillUrl', 'runtime',
];

function project(row, fields) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

export function publicTitle(row) { return project(row, PUBLIC_TITLE_FIELDS); }
export function publicEpisode(row) { return project(row, PUBLIC_EPISODE_FIELDS); }

// ── Ordinamento episodi ─────────────────────────────────────────

export function sortEpisodes(list) {
  return (list || []).slice().sort((a, b) =>
    (a.season - b.season) || (a.number - b.number));
}

// Raggruppa gli episodi per stagione → [{ season, episodes: [...] }]
export function groupSeasons(list) {
  const bySeason = new Map();
  for (const ep of sortEpisodes(list)) {
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
    bySeason.get(ep.season).push(ep);
  }
  return [...bySeason.keys()].sort((a, b) => a - b)
    .map(season => ({ season, episodes: bySeason.get(season) }));
}
