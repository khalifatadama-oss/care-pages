import json, math, time, collections
exec(open('engine.py').read().split("if __name__=='__main__':")[0])
tk=json.load(open('tickets_provisional.json')); res=json.load(open('research_merged.json')); setA=json.load(open('setA_today.json'))
legsr={}
for f in ('setB_legs.json','expansion_legs.json'):
    for l in json.load(open(f)): legsr[l['key']]=l
def wat(ms): return time.strftime('%a %d %b %H:%M', time.gmtime(ms/1000+3600))
def inv(p): return f"1 in {1/p:,.0f}" if p>0 else "n/a"
def N(x): return f"N{x:,.0f}"
L=[]; A=L.append
A("SPORTYBET TICKETS - STATUS REPORT (PROVISIONAL, NOT RESEARCH-VERIFIED)")
A(f"Generated {wat(time.time()*1000)} WAT. Stake N500 per ticket. Nothing here has been placed or booked.\n")
A("=== 1. WHERE THINGS STAND, PLAINLY ===")
A("* I connected to SportyBet (read-only, no login, from a US data centre; your account was never touched) and pulled the full feed:")
A("  2,146 events, 86,573 priced outcomes, all 16 sports.")
A("* I decoded the site's bonus rules from its own code and checked them against the LIVE slip for your code TGXS9T:")
A("  site shows odds 2,019.36, bonus N1,130,841.09, potential win N2,140,520.64; my formula gives the same to the kobo.")
A("* The research you require (Stage A + Stage B on every leg) COULD NOT be completed. This session has a hard cap of 200 web searches")
A("  and it was used up. 50 of 151 legs got both stages; most of those results say 'could not verify'. Per your rule I am NOT calling")
A("  any ticket below checked. They are the best the MATHS can do, with research only ever lowering a probability.")
A("* I did not create booking codes. My attempt to create one through SportyBet's API was blocked by a safety check, and I did not")
A("  work around it. You (or I, with your explicit go-ahead in a fresh session) can book from your own Nigerian account.\n")
A("=== 2. THE KEY FINDING: A CEILING NOTHING CAN BEAT ===")
A("SportyBet's multiple bonus is not the table maximum. The slip computes it from each leg's odds x SportyBet's own probability, and")
A("chooses it so the ticket's long-run return is about 97.5% of stake (the 'targetRtp' below), as long as it is not at a table limit.")
A("Result: payout is almost exactly  N500 x 0.975 / (product of SportyBet's win probabilities).")
A("So the chance of hitting a target T can never beat about  N500 x 0.975 / T  on SportyBet's numbers:")
for nm,T in [('T1',2e6),('T2',5e6),('T3',10e6),('T4',50e6),('T5',200e6)]:
    A(f"   {nm}  {N(T):>15}  ceiling {inv(500*0.9744/T)}")
A("Consequences: (a) my builds are already within 1-5% of that ceiling; leg choice cannot move it much. (b) More legs does NOT compound")
A("the margin the way your prompt assumes; the bonus compensates. (c) The only ways above the ceiling are real edge over SportyBet's")
A("probabilities (needs research or sharp-market comparison) and positive correlation between legs. (d) The handover's 'bonus is")
A("unpredictable' (0.48-0.83 of max) is this effect: it is predictable, and now modelled exactly.\n")
A("=== 3. PROVISIONAL TICKETS (maths-optimal, vetoes applied, unresearched legs marked) ===")
A("'Independent' multiplies the legs. 'SportyBet-only' is the optimistic bound. 'Correlated' assumes within-league-day correlation 0.03")
A("and global 0.005 - THESE TWO NUMBERS ARE MY GUESS, not measured. Sensitivity is in section 4.\n")
for tag in ['T1','T2','T3','T4','T5']:
    t=tk[tag]; legs=t['legs']
    A(f"--- TICKET {tag[1]}  target {N(t['T'])} ---")
    A(f"legs {len(legs)} | site payout {N(t['payout'])} | independent {inv(t['pIndep'])} | SportyBet-only {inv(t['pSite'])} | correlated {inv(t['pCorr'])} (x{t['lift']:.2f})")
    first=min(l['start'] for l in legs)
    nres=0
    for i,l in enumerate(sorted(legs,key=lambda x:x['start']),1):
        key=f"{l['event']}|{l['mkt']}|{l['spec']}|{l['pick']}"; r=res.get(key); done=bool(r and 'verdict' in r and 'killed' in r)
        nres+=done
        A(f"  {i:>2}. {wat(l['start'])} WAT | {l['sport']} | {l['tour'][:26]} | {l['home']} v {l['away']} | {l['mdesc']} {l['spec']} -> {l['pick']} @{l['odds']:.2f} (p={l['p']:.3f}){' [void risk '+format(l['pPush'],'.2f')+']' if l['pPush'] else ''}{'  [research done, unsure]' if done else '  [UNRESEARCHED]'}")
    A(f"  research completed on {nres} of {len(legs)} legs. First kick-off {wat(first)} WAT; last sensible time to place: {wat(first-3600000)} WAT.\n")
A("=== 4. HOW MUCH THE CORRELATION GUESS MATTERS (P(hit target), 1 in N) ===")
A(f"{'ticket':8}{'independent':>14}{'rw=0.01':>12}{'rw=0.03':>12}{'rw=0.05':>12}")
for tag in ['T1','T2','T3','T4','T5']:
    t=tk[tag]; legs=[dict(l,sportId=SPORTID.get(l['sport']),pWin=l['pWin'],pPush=l.get('pPush',0.0)) for l in t['legs']]
    row=[inv(t['pIndep'])]
    for rw in (0.01,0.03,0.05): row.append(inv(p_hit(legs,t['T'],500,rg=0.005,rw=rw)['p']))
    A(f"{tag:8}"+''.join(f"{x:>14}" for x in row))
A("If real within-league correlation is near zero, the 'independent' column is the honest one.\n")
A("=== 5. SET A (PLACED) RE-CHECKED AT TODAY'S PRICES ===")
A("The booking codes carry the selections, not the odds you locked in, so this is indicative only. For your real position I need the")
A("locked payouts from Bet History. Void-corrected (whole-number lines split into win/refund using the line ladders):")
for code,d in setA.items():
    A(f"  {code}  target {N(d['T'])}: site payout today {N(d['payout'])} | naive {inv(d['naive'])} | void-correct P(>=target) {inv(d['p'][0])} | pays anything {inv(d['p'][3])}")
A("")
A("=== 6. RESEARCH FINDINGS SO FAR (partial, mostly 'unverified') ===")
for k,r in res.items():
    l=legsr.get(k); 
    if not l: continue
    if r.get('killed'): A(f"  KILLED  {l['home']} v {l['away']} [{l['pick']}]: {str(r.get('reason'))[:260]}")
    elif r.get('verdict')=='avoid': A(f"  AVOID   {l['home']} v {l['away']} [{l['pick']}]: {str(r.get('summary'))[:260]}")
A("  (Any Set B leg in that list should be treated as suspect; Set B was built from legs that were mostly never individually researched.)\n")
A("=== 7. WHAT I COULD NOT CHECK ===")
A("* Team news, injuries, rotation, form and sharp-market comparison for ~100 of 151 candidate legs (search cap exhausted).")
A("* Correlation between legs (no historical round data pulled; section 4 is a sensitivity, not a measurement).")
A("* Tennis retirement risk (assumed 3% of tennis legs void) and basketball draw-no-bet refund risk (taken from the 1X2 draw price).")
A("* Whether odds move before you book: three of Set B ticket 1's legs already moved in an hour.")
open('SPORTYBET_STATUS_REPORT.txt','w').write('\n'.join(L)); print(len(L),'lines written')
