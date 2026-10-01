#!/bin/bash
# Full harvest: every sport, every page, match-level markets only.
cd "$(dirname "$0")/feed"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
MK=$(python3 -c "import urllib.parse;print(urllib.parse.quote(','.join(map(str,[1,10,11,14,16,18,19,20,29,60,66,68,186,202,219,223,225,227,228,237,238,251,256,258,260,261,314,340,406,410,412]))))")
one_sport() {
  s=$1; p=1
  while [ $p -le 25 ]; do
    f="s${s}_p${p}.json"
    curl -sS -o "$f" --max-time 60 -A "$UA" -H "Accept: application/json" \
      "https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr%3Asport%3A${s}&marketId=${MK}&pageSize=100&pageNum=${p}&option=1"
    n=$(python3 -c "
import json,sys
try:
  d=json.load(open('$f'))['data']; print(sum(len(t.get('events',[])) for t in d.get('tournaments',[])))
except Exception as e: print(0)")
    echo "sport $s page $p: $n events"
    [ "$n" = "0" ] && { rm -f "$f"; break; }
    p=$((p+1))
  done
}
for s in 1 2 4 5; do one_sport $s & done; wait
for s in 3 6 10 12 16 19 20 21 22 23 31 117; do one_sport $s & done; wait
echo HARVEST_DONE $(date -u +%H:%M:%S)
