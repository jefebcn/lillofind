#!/usr/bin/env bash
# Prepara dist/: SOLO i file che il sito serve davvero.
#
# Prima Firebase Hosting pubblicava la radice del repository ("public": "."):
# erano online anche .github/, scripts/, tests/, wrangler.jsonc (con le email
# admin), i README, le storie social. Adesso si pubblica dist/, riempita da
# questo elenco: un file nuovo del sito va aggiunto qui, se no non va online.
#
#   bash scripts/build-hosting.sh        → crea/rifà dist/
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist

# pagine, script e stili della radice
for f in *.html firebase.js catalog-qc.js sw.js *.css icons.svg manifest.json robots.txt sitemap.xml; do
  [ -e "$f" ] && cp "$f" dist/
done
# immagini della radice (hero, icone PWA)
for f in hero*.jpg hero*.jpeg hero*.png hero*.webp icon-*.png; do
  [ -e "$f" ] && cp "$f" dist/
done
# cartella assets, senza i file di documentazione
if [ -d assets ]; then
  mkdir -p dist/assets
  find assets -type f ! -name '*.md' -exec cp {} dist/assets/ \;
fi

# niente di questo deve finire online
for vietato in wrangler.jsonc firestore.rules storage.rules firebase.json package.json; do
  if [ -e "dist/$vietato" ]; then echo "ERRORE: $vietato in dist/"; exit 1; fi
done
echo "dist/ pronta: $(find dist -type f | wc -l) file"
