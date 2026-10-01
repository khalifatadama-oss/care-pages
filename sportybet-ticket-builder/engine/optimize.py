"""Ticket optimiser on the exact site formula.
Objective: P_indep(payout >= T) with research-adjusted pWin (research can only lower).
Tie-breaks: fewer legs, then correlation-adjusted P. Reports both."""
import json, math, random, sys, time, os, calendar, collections
exec(open('engine.py').read().split("if __name__=='__main__':")[0])
S=500
TARGETS=[('T1',2e6),('T2',5e6),('T3',10e6),('T4',50e6),('T5',200e6)]
ODDS_MIN,ODDS_MAX=1.20,1.75
MIN_START=int(os.environ.get('MIN_START_UTC_MS', calendar.timegm((2026,10,1,15,0,0))*1000))   # default Thu 16:00 WAT
RW=float(os.environ.get('RW','0.03')); RG=float(os.environ.get('RG','0.005'))
BLEND=0.35

cand=json.load(open('candidates.json'))
research=json.load(open('research_merged.json')) if os.path.exists('research_merged.json') else {}
only=set(json.load(open('researched_events.json'))) if os.path.exists('researched_events.json') else None

def adjust(r):
    """Phase-4 rule: research may only LOWER. Veto on avoid/killed/unconfirmed."""
    r=dict(r); r['pSite']=r['p']; r['pUsed']=r['pWin']; r['vetoed']=None; r['researched']=False
    key=f"{r['event']}|{r['mkt']}|{r['spec']}|{r['pick']}"
    rec=research.get(key)
    # event-level vetoes: any record on this event that is killed / avoid / fixture unconfirmed
    for rk,m in research.items():
        if m.get('event')!=r['event']: continue
        if m.get('killed'): r['vetoed']='killed: '+str(m.get('reason',''))[:90]
        elif m.get('verdict')=='avoid': r['vetoed']=r['vetoed'] or 'avoid: '+str(m.get('summary',''))[:90]
        elif 'verdict' in m and not m.get('fixtureConfirmed') and not m.get('fixtureSecondary'): r['vetoed']=r['vetoed'] or 'fixture unconfirmed'
    if rec and 'verdict' in rec and 'killed' in rec:
        r['researched']=True
        pa=rec.get('pAgent')
        if isinstance(pa,(int,float)) and 0<pa<1:
            r['pUsed']=min(r['pWin'], (1-BLEND)*r['pWin']+BLEND*pa)   # research may only LOWER
    return r
pool=[adjust(r) for r in cand if r['factor']>=1.0 and ODDS_MIN<=r['odds']<=ODDS_MAX and r['start']>=MIN_START and not r['voidType'].startswith('whole')]
EXACT=set(json.load(open('setB_legs.json'))[i]['key'] for i in range(len(json.load(open('setB_legs.json')))))|set(l['key'] for l in json.load(open('expansion_legs.json')))
if os.environ.get('EXACT','1')=='1': pool=[r for r in pool if f"{r['event']}|{r['mkt']}|{r['spec']}|{r['pick']}" in EXACT]
elif only and os.environ.get('ALL')!='1': pool=[r for r in pool if r['event'] in only]
if os.environ.get('RESEARCHED_ONLY','0')=='1': pool=[r for r in pool if r['researched']]
pool=[r for r in pool if not r['vetoed']]
for r in pool: r['sportId']=SPORTID.get(r['sport']); r['pWin']=r['pUsed']
byev=collections.defaultdict(list)
for r in pool: byev[r['event']].append(r)
for ev in byev: byev[ev].sort(key=lambda r:-r['value'])
events=sorted(byev, key=lambda ev:-byev[ev][0]['value'])
print(f"pool: {len(pool)} selections / {len(events)} events (researched-only={bool(only)}, research records={len(research)})")

def score(legs,T):
    # fast inner objective: product of research-adjusted pWin, feasibility on exact site payout
    if len(legs)>MAXSEL or site_payout(legs,S)['payout']<T*(1-1e-9): return (0.0,-len(legs))
    return (math.prod(L['pWin'] for L in legs), -len(legs))
def build(T, seed, n_start):
    rnd=random.Random(seed)
    order=events[:]
    # mild shuffle among near-equal values so seeds differ
    order=sorted(order, key=lambda ev:-(byev[ev][0]['value']+rnd.uniform(0,0.004)))
    legs=[]; used=set()
    for ev in order:
        if len(legs)>=n_start: break
        legs.append(byev[ev][0]); used.add(ev)
    # grow until feasible
    i=0
    while site_payout(legs,S)['payout']<T and len(legs)<MAXSEL:
        while i<len(order) and order[i] in used: i+=1
        if i>=len(order): break
        legs.append(byev[order[i]][0]); used.add(order[i]); i+=1
    if site_payout(legs,S)['payout']<T: return None
    best=score(legs,T); improved=True; rounds=0
    while improved and rounds<25:
        improved=False; rounds+=1
        # 1) same-event alternative (different line/market) -> trims overshoot
        for k in range(len(legs)):
            for alt in byev[legs[k]['event']]:
                if alt is legs[k]: continue
                trial=legs[:k]+[alt]+legs[k+1:]; sc=score(trial,T)
                if sc>best: legs,best,improved=trial,sc,True; break
            if improved: break
        if improved: continue
        # 2) drop a leg
        for k in range(len(legs)):
            trial=legs[:k]+legs[k+1:]; sc=score(trial,T)
            if sc>best: legs,best,improved=trial,sc,True; used.discard(legs and None); break
        if improved: used={L['event'] for L in legs}; continue
        # 3) swap with an unused event (top 80 by value)
        outside=[ev for ev in order if ev not in used][:40]
        for k in range(len(legs)):
            for ev in outside:
                for alt in byev[ev][:2]:
                    trial=legs[:k]+[alt]+legs[k+1:]; sc=score(trial,T)
                    if sc>best: legs,best,improved=trial,sc,True; break
                if improved: break
            if improved: break
        if improved: used={L['event'] for L in legs}; continue
        # 4) add a leg (lets a later drop/swap trim overshoot)
        for ev in outside[:30]:
            trial=legs+[byev[ev][0]]; sc=score(trial,T)
            if sc>best: legs,best,improved=trial,sc,True; break
        if improved: used={L['event'] for L in legs}
    return legs
def solve(T):
    best=None
    for n0 in (18,24,30,36,42):
        for seed in (1,):
            legs=build(T,seed,n0)
            if not legs: continue
            sc=score(legs,T)
            if best is None or sc>best[0]: best=(sc,legs)
    return best[1] if best else None
def report(tag,T,legs):
    sp=site_payout(legs,S); ind=p_hit(legs,T,S); cor=p_hit(legs,T,S,rg=RG,rw=RW)
    pSite=math.prod(L['pSite'] for L in legs)   # SportyBet-only, no research, no void split
    groups=collections.Counter(group_of(L) for L in legs); clusters=sum(1 for g,c in groups.items() if c>1 and not g.startswith('solo'))
    print(f"\n=== {tag} target N{T:,.0f} ===  legs={len(legs)} nf={sp['nf']} odds={sp['res']:.1f} ratio={sp['ratio']:.2f} clamp={sp['clamp']} targetRtp={sp['target']:.4f}")
    print(f"  site payout N{sp['payout']:,.0f} (raw N{sp['raw']:,.0f})   overshoot {sp['raw']/T-1:+.1%}")
    print(f"  P(>=T) research-veto basis, independent : {ind['p']:.3e}  = 1 in {1/ind['p']:,.0f}   (void branches {ind['pVoidBranches']:.2e})")
    print(f"  P(>=T) SportyBet-only bound             : {pSite*S*0+pSite:.3e}  = 1 in {1/pSite:,.0f}")
    print(f"  P(>=T) correlation-adjusted rw={RW} rg={RG}: {cor['p']:.3e}  = 1 in {1/cor['p']:,.0f}   lift {cor['lift']:.2f}x  ({clusters} clusters)")
    print(f"  researched legs: {sum(1 for L in legs if L['researched'])}/{len(legs)}  | sports {dict(collections.Counter(L['sport'] for L in legs))}")
    for L in sorted(legs,key=lambda L:L['start']):
        print(f"   {L['koWAT']} | {L['sport'][:10]:10} | {L['tour'][:20]:20} | {L['home'][:20]:20} v {L['away'][:20]:20} | {L['mdesc'][:22]:22} {L['spec']:11} {L['pick']:13} @{L['odds']:.2f} p={L['pSite']:.3f} v={L['value']:.3f}{' R' if L['researched'] else ''}{' push='+format(L['pPush'],'.2f') if L['pPush'] else ''}")
    return dict(tag=tag,T=T,legs=[{k:L[k] for k in ('event','gameId','sport','sportId','catId','cat','tourId','tour','home','away','start','koWAT','mkt','mdesc','spec','product','oid','pick','odds','p','pWin','pPush','value')} for L in legs],
                payout=sp['payout'],raw=sp['raw'],ratio=sp['ratio'],pIndep=ind['p'],pSite=pSite,pCorr=cor['p'],lift=cor['lift'])
if __name__=='__main__':
    out={}
    for tag,T in TARGETS:
        t0=time.time(); legs=solve(T)
        if not legs: print(f"{tag}: INFEASIBLE"); continue
        out[tag]=report(tag,T,legs); print(f"  ({time.time()-t0:.0f}s)")
    json.dump(out, open(os.environ.get('OUT','tickets_provisional.json'),'w'))
