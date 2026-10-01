"""Exact SportyBet engine: site payout formula (DMBB), void-aware P(payout>=T), block copula."""
import json, math, re, itertools
PLAN=json.load(open('bonus_plans.json'))['data']
P0=PLAN['entityList'][0]
RATIOS={r['qualifyingSelections']:(r['min']/1e4, r['max']/1e4) for r in P0['bonusRatios']}
QLIM=P0['qualifyingOddsLimit']/1e4; DMBB=P0['factor']/1e4; CAP=200e6; MAXSEL=50
SF={x['sportId']:x['bonusFactor']/1e4 for x in PLAN['bonusFactorVOList'] if not x['tournamentId']}
TF={x['tournamentId']:x['bonusFactor']/1e4 for x in PLAN['bonusFactorVOList'] if x['tournamentId']}
SPORTID={'Football':'sr:sport:1','Basketball':'sr:sport:2','Tennis':'sr:sport:5','Ice Hockey':'sr:sport:4','Rugby':'sr:sport:12','Cricket':'sr:sport:21',
 'American Football':'sr:sport:16','Handball':'sr:sport:6','Volleyball':'sr:sport:23','Darts':'sr:sport:22','Badminton':'sr:sport:31','Table Tennis':'sr:sport:20',
 'Baseball':'sr:sport:3','MMA':'sr:sport:117','Boxing':'sr:sport:10','Snooker':'sr:sport:19'}
def factor_of(L): return TF.get(L.get('tourId'), SF.get(L.get('sportId') or SPORTID.get(L['sport'],''), 1.0))

def site_payout(legs, S=500):
    """Replica of betslip DMBB maths (module CvgD u() + y()). Uses SportyBet's own p."""
    res=1.0; sq=1.0; nf=0; rtp=1.0; wsum=0.0; osum=0.0; bf=1.0
    for L in legs:
        o,p=L['odds'],L['p']; res*=o; bf=min(bf,factor_of(L))
        if o>=QLIM: nf+=1; sq*=o; rtp*=o*p; wsum+=o*o*p; osum+=o
    if nf==0 or nf not in RATIOS: return dict(payout=min(S*res,CAP), raw=S*res, ratio=0, nf=nf, res=res, rtp=rtp, target=0, clamp='n/a', bf=bf)
    target=wsum/osum; mn,mx=RATIOS[nf]
    l=round(target*1e4)/1e4*DMBB/rtp-1
    u=math.floor(100*l+1e-9)/100
    A=mx*bf if mx*bf>=mn else mn
    ratio=mn if u<mn else (A if u>A else u)
    clamp='MAX' if u>A else ('MIN' if u<mn else 'no')
    raw=S*res+S*sq*ratio
    return dict(payout=min(raw,CAP), raw=raw, ratio=ratio, nf=nf, res=res, rtp=rtp, target=target, clamp=clamp, bf=bf, needed=l)

# ---- probability ----
def qnorm(p):
    a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00]
    b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01]
    c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00]
    d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00]
    if p<0.02425: q=math.sqrt(-2*math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p>1-0.02425: q=math.sqrt(-2*math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q=p-0.5; r=q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
def pnorm(x): return 0.5*math.erfc(-x/math.sqrt(2))
GRID=[(-8+i*16/400, math.exp(-(-8+i*16/400)**2/2)/math.sqrt(2*math.pi)*(16/400)*(0.5 if i in (0,400) else 1)) for i in range(401)]
def joint_blocks(ps, groups, rg, rw):
    """P(all win) under global+within-group Gaussian copula."""
    if not rg and not rw: return math.prod(ps)
    ks=[qnorm(p) for p in ps]; by={}
    for k,g in zip(ks,groups): by.setdefault(g,[]).append(k)
    sg,sw,c=math.sqrt(rg),math.sqrt(rw),math.sqrt(1-rg-rw); outer=0.0
    for G,wG in GRID:
        prodg=1.0
        for g,kk in by.items():
            inner=0.0
            for F,wF in GRID:
                pr=1.0
                for k in kk:
                    pr*=pnorm((k-sg*G-sw*F)/c)
                    if pr<1e-300: break
                inner+=wF*pr
            prodg*=inner
            if prodg<1e-300: break
        outer+=wG*prodg
    return outer

def group_of(L):
    """Correlation cluster: same sport+tournament+calendar day for totals/handicap legs; else unique."""
    day=L.get('koWAT','')[:10]
    if L['mkt'] in ('18','19','20','225','68','412','16','223','410','66','14','237','238','258'):
        return f"{L['sport']}|{L['tour']}|{day}"
    return f"solo|{L['event']}"

def p_hit(legs, T, S=500, rg=0.0, rw=0.0, use='pWin', max_void=2):
    """P(payout >= T): all-win branch (copula) + void branches (<=max_void voids, independence)."""
    pw=[L[use] if L.get(use) is not None else L['p'] for L in legs]
    pp=[L.get('pPush',0.0) for L in legs]
    base=site_payout(legs,S)['payout']
    if base<T*(1-1e-9): return dict(p=0.0, pAll=0.0, pVoidBranches=0.0, payout=base)
    pall_ind=math.prod(pw)
    pall=joint_blocks(pw,[group_of(L) for L in legs],rg,rw) if (rg or rw) else pall_ind
    lift=pall/pall_ind if pall_ind>0 else 1
    voidable=[i for i,x in enumerate(pp) if x>0]
    extra=0.0
    for k in range(1,max_void+1):
        for sub in itertools.combinations(voidable,k):
            surv=[L for i,L in enumerate(legs) if i not in sub]
            if site_payout(surv,S)['payout']<T*(1-1e-9): continue
            pr=1.0
            for i,L in enumerate(legs): pr*= pp[i] if i in sub else pw[i]
            extra+=pr
    return dict(p=pall+extra*lift, pAll=pall, pAllIndep=pall_ind, pVoidBranches=extra, lift=lift, payout=base)

if __name__=='__main__':
    # sanity: reproduce Set B figures
    rows=json.load(open('legs_all_codes.json'))
    for code,T in [('TGXS9T',2e6),('Z8RKE0',200e6)]:
        legs=[dict(r, mkt=r['mkt'], pWin=r['p'], pPush=0.03 if r['sport']=='Tennis' else 0.0, koWAT='', sportId=None) for r in rows if r['code']==code]
        sp=site_payout(legs); ph=p_hit(legs,T); phc=p_hit(legs,T,rw=0.03,rg=0.005)
        print(f"{code}: payout {sp['payout']:,.0f} ratio {sp['ratio']} clamp {sp['clamp']} | P(>=T) indep {ph['p']:.3e} (1 in {1/ph['p']:,.0f}) | corr(rw=.03,rg=.005) {phc['p']:.3e} (1 in {1/phc['p']:,.0f}) lift {phc['lift']:.2f}x | void branches {ph['pVoidBranches']:.2e}")
