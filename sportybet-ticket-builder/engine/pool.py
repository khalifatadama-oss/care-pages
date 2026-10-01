"""Candidate pool from the harvest, with void handling done properly.
pWin/pPush per selection:
  - half-number totals/handicaps, Winner, 1X2: pWin = p, pPush = 0
  - whole-number totals/handicaps (void on exact): ladder method
  - Draw No Bet (market 11): voids on a regulation draw -> pPush = P(draw) from market 1
  - tennis Winner: retirement/walkover void haircut (assumption: 3%)
"""
import json, glob, re, time, collections
NOW=time.time()*1000
SPORT_FACTOR={'Football':0.6,'Basketball':1.0,'Tennis':1.0,'Ice Hockey':1.0,'Rugby':1.0,'Cricket':1.0,'Table Tennis':1.0,
 'Baseball':0.75,'MMA':0.75,'Darts':0.75,'Handball':0.75,'Volleyball':0.75,'Badminton':0.75,'Boxing':0.75,'Snooker':0.75,'American Football':0.75}
BANNED=re.compile(r'\b(amateur|youth|u-?1[5-9]|u-?2[0-3]|reserve|simulated|virtual|esport|friendl|academy|b[- ]team)\b', re.I)
TENNIS_VOID=0.03
def wat(ms): return time.strftime('%a %d %b %H:%M', time.gmtime(ms/1000+3600))
rows=[]; events={}
for f in glob.glob('feed/s*_p*.json'):
    try: d=json.load(open(f))['data']
    except Exception: continue
    for t in d.get('tournaments',[]):
        for e in t['events']:
            ev=e['eventId']; sp=e['sport']; tour=sp['category']['tournament']; cat=sp['category']
            events[ev]=dict(event=ev, gameId=e.get('gameId'), sport=sp['name'], sportId=sp['id'], catId=cat['id'], cat=cat['name'],
                            tourId=tour['id'], tour=tour['name'], home=e['homeTeamName'], away=e['awayTeamName'], start=e['estimateStartTime'], status=e.get('status'))
            for m in e.get('markets',[]):
                if m.get('status') not in (0,None): continue
                outs=m.get('outcomes',[])
                for o in outs:
                    try: odds=float(o['odds']); p=float(o['probability'])
                    except Exception: continue
                    if o.get('isActive')!=1 or p<=0: continue
                    rows.append(dict(event=ev, mkt=str(m['id']), mdesc=m.get('desc',''), spec=m.get('specifier','') or '', product=m.get('product'),
                                     oid=str(o['id']), pick=o['desc'], odds=odds, p=p, nOut=len(outs), sumP=sum(float(x['probability']) for x in outs)))
print(f"harvest: {len(events)} events, {len(rows)} outcomes")
# --- ladders for pure two-way line markets ---
def line(spec):
    m=re.search(r'(?:total|hcp)=(-?\d+(?:\.\d+)?)', spec); return float(m.group(1)) if m else None
def side(pick):
    s=pick.lower()
    if s.startswith('under'): return 'under'
    if s.startswith('over'): return 'over'
    if s.startswith('home'): return 'home'
    if s.startswith('away'): return 'away'
    return None
lad=collections.defaultdict(dict)   # (event,mkt,side) -> {line: p}
draw={}                              # event -> P(draw) from market 1
for r in rows:
    if r['mkt']=='1' and r['pick']=='Draw': draw[r['event']]=r['p']
    L=line(r['spec']); sd=side(r['pick'])
    if L is None or sd is None or r['nOut']!=2 or not (0.995<r['sumP']<1.005): continue
    if '&' in r['pick']: continue
    lad[(r['event'],r['mkt'],sd)][L]=r['p']
# --- annotate ---
stats=collections.Counter()
for r in rows:
    ev=events[r['event']]; r.update(ev)
    L=line(r['spec']); sd=side(r['pick'])
    r['pWin']=r['p']; r['pPush']=0.0; r['voidType']='none'
    if L is not None and sd and float(L).is_integer():
        # whole-number line: voids on exact. 'total' markets: under L wins if <= L-0.5 line; hcp: analogous shift
        isTotal='total=' in r['spec']
        lk=(r['event'],r['mkt'],sd); ld=lad.get(lk,{})
        if isTotal:
            lo=ld.get(L-0.5); hi=ld.get(L+0.5)
            if sd=='under': pw, po = lo, hi      # P(under L-0.5) wins; P(under L+0.5) includes push
            else:           pw, po = hi, lo      # over: P(over L+0.5) wins; P(over L-0.5) includes push
        else:
            # handicap: for the side receiving hcp L, half-lines L-0.5 and L+0.5 exist in the same ladder under the same side label
            lo=ld.get(L-0.5); hi=ld.get(L+0.5)
            pw, po = (lo, hi) if lo is not None and hi is not None and lo<=hi else (hi, lo)
        if pw is not None and po is not None and po>=pw:
            r['pWin']=pw; r['pPush']=max(0.0, po-pw); r['voidType']='whole-line'; stats['whole-recovered']+=1
        else:
            r['pWin']=None; r['voidType']='whole-unrecoverable'; stats['whole-unrecoverable']+=1
    elif r['mkt']=='11':
        pd=draw.get(r['event'])
        if pd is not None:
            r['pPush']=pd; r['pWin']=r['p']*(1-pd); r['voidType']='dnb-draw'; stats['dnb']+=1
        else:
            r['pWin']=None; r['voidType']='dnb-unrecoverable'; stats['dnb-unrecoverable']+=1
    elif r['sport']=='Tennis':
        r['pPush']=TENNIS_VOID; r['pWin']=r['p']*(1-TENNIS_VOID); r['voidType']='tennis-retire'; stats['tennis']+=1
    r['value']=r['odds']*r['p']
    r['factor']=SPORT_FACTOR.get(r['sport'],0.6)
    r['koWAT']=wat(r['start'])
# --- filter ---
cand=[]; drop=collections.Counter()
for r in rows:
    if r['pWin'] is None: drop['unrecoverable']+=1; continue
    if not (1.20<=r['odds']<=1.75): drop['odds']+=1; continue
    if r['start']-NOW < 90*60*1000: drop['soon']+=1; continue
    if BANNED.search(f"{r['tour']} {r['cat']} {r['home']} {r['away']}"): drop['banned']+=1; continue
    if '&' in r['pick'] or r['nOut']>3: drop['combo/multi']+=1; continue
    if r['mkt'] in ('10',): drop['doublechance']+=1; continue
    if r['tourId'] in ('sr:tournament:2112','sr:tournament:1191'): drop['halffactor']+=1; continue
    cand.append(r)
cand.sort(key=lambda r:-r['value'])
json.dump(cand, open('candidates.json','w'))
json.dump(events, open('events.json','w'))
print("void handling:", dict(stats)); print("dropped:", dict(drop)); print(f"candidates: {len(cand)} across {len(set(r['event'] for r in cand))} events")
by=collections.Counter(r['sport'] for r in cand); print("by sport:", dict(by))
ff=[r for r in cand if r['factor']==1.0]; print(f"full-factor candidates: {len(ff)} across {len(set(r['event'] for r in ff))} events")
vals=sorted((r['value'] for r in ff), reverse=True)
print("full-factor value: best %.4f | top10%% %.4f | median %.4f | worst %.4f" % (vals[0], vals[len(vals)//10], vals[len(vals)//2], vals[-1]))
print("\nTOP 40 full-factor by value (one line each):")
seen=set(); n=0
for r in ff:
    if r['event'] in seen: continue
    seen.add(r['event']); n+=1
    print(f"  {r['value']:.4f} {r['koWAT']} | {r['sport'][:10]:10} | {r['tour'][:22]:22} | {r['home'][:20]:20} v {r['away'][:20]:20} | {r['mdesc'][:20]:20} {r['spec']:10} {r['pick']:12} @{r['odds']:.2f} p={r['p']:.3f} pWin={r['pWin']:.3f} push={r['pPush']:.3f} {r['voidType']}")
    if n>=40: break
