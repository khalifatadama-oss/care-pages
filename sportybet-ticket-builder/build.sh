#!/bin/sh
# Concatenate src into one pasteable console bundle. Order matters.
set -e
cd "$(dirname "$0")"
FILES="src/00-store.js src/10-harvest.js src/20-rules.js src/30-filters.js
src/40-probability.js src/45-ladder.js src/46-voidmodel.js src/50-optimize.js
src/60-betslip.js src/70-report.js src/90-main.js"
{ echo "/* SportyBet ticket builder — paste into the DevTools console on"
  echo " * https://www.sportybet.com/ng/ (must be run from Nigeria). */"
  for f in $FILES; do
    echo ""; echo "/* ---- $f ---- */"; cat "$f"
  done
} > dist/sportybet-builder.js
echo "dist/sportybet-builder.js  $(wc -c < dist/sportybet-builder.js) bytes, $(echo "$FILES" | wc -w) modules"
