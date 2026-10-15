// Unisce l'indice degli album Yupoo già importati (KV catalog:albums) con
// quelli letti da `products` (catalog-albums.json), invece di sostituirlo:
// il sourceUrl dei prodotti ora sta in products_private, che la pubblicazione
// del catalogo non legge, e l'indice non deve perdere quegli album.
// Uso: node merge-albums.mjs <indice attuale dal KV> <catalog-albums.json>
import fs from 'node:fs';

const [oldPath, newPath] = process.argv.slice(2);
const read = (p) => { try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(a) ? a : []; } catch (_) { return []; } };
const old = read(oldPath), fresh = read(newPath);
const all = [...new Set([...old, ...fresh].map(String).filter((id) => /^\d+$/.test(id)))];
fs.writeFileSync(newPath, JSON.stringify(all));
console.log(`Indice album: ${all.length} (prima ${old.length}, dal catalogo ${fresh.length})`);
