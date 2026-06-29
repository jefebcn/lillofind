#!/usr/bin/env bash
# Smoke test post-deploy del Worker.
# Uso:  ./smoke-test.sh https://lillofind-worker.TUONOME.workers.dev
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "Uso: ./smoke-test.sh <URL_WORKER>"
  echo "Es:  ./smoke-test.sh https://lillofind-worker.tuonome.workers.dev"
  exit 1
fi
BASE="${BASE%/}"

echo "▶ Health check  ($BASE/ )"
curl -fsS "$BASE/" && echo "" || { echo "❌ health fallito"; exit 1; }

echo ""
echo "▶ Diagnostica   ($BASE/diag )"
DIAG=$(curl -fsS "$BASE/diag")
echo "$DIAG"
echo ""

# Controlli rapidi sul risultato di /diag
echo "$DIAG" | grep -q '"FIREBASE_SERVICE_ACCOUNT":true' && echo "✅ secret service account presente" || echo "⚠️  service account MANCANTE → wrangler secret put FIREBASE_SERVICE_ACCOUNT"
echo "$DIAG" | grep -q '"STRIPE_SECRET_KEY":true'         && echo "✅ secret Stripe presente"           || echo "⚠️  Stripe MANCANTE → wrangler secret put STRIPE_SECRET_KEY"
echo "$DIAG" | grep -q '"reachable":true'                 && echo "✅ Firestore raggiungibile"           || echo "⚠️  Firestore NON raggiungibile (controlla il service account JSON)"

echo ""
echo "Fatto. Se vedi tutti ✅, il backend è pronto."
