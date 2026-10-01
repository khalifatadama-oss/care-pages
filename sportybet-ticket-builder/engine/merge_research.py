"""Merge investigator + assassin results. Each agent is matched to its EXACT leg by parsing
the LEG line in its own transcript (labels are truncated home names and collide)."""
import json, glob, os, re, collections
WF='/root/.claude/projects/-home-user-care-pages/24a032a6-6238-5e1e-8116-fa4958efefe8/subagents/workflows'
RUNS=['wf_8810e174-f01','wf_297516e3-da5','wf_d2956dcb-eea','wf_4e8e3ce4-3eb','wf_7bf1a6e3-c78','wf_ce053a18-bab','wf_a000d0c9-b72','wf_a27aaec2-0f4','wf_370eec4e-443','wf_a75a1ac6-ea1','wf_2dcea766-518','wf_696e78c5-912']
legs={}
for f in ('setB_legs.json','expansion_legs.json'):
    for l in json.load(open(f)): legs[l['key']]=l
byident={ (l['home'],l['away'],l['pick']): k for k,l in legs.items() }
def _texts(node):
    if isinstance(node,str): yield node
    elif isinstance(node,list):
        for x in node: yield from _texts(x)
    elif isinstance(node,dict):
        for v in node.values(): yield from _texts(v)
LEGRE=re.compile(r'LEG: .*? \u2014 .*? \u2014 (.+?) v (.+?) \u2014 kick-off .*?Pick: "(.+?)" at decimal')
def leg_of_agent(path):
    """Find the LEG: line in the agent's first user message (real text, not JSON-escaped)."""
    try:
        for line in open(path):
            if 'LEG:' not in line: continue
            for t in _texts(json.loads(line)):
                m=LEGRE.search(t)
                if m: return byident.get((m.group(1),m.group(2),m.group(3)))
    except Exception: pass
    return None
# A fixture counts as confirmed if the investigator confirmed it OR cites a listing source by name.
SECONDARY=re.compile(r'flashscore|sofascore|espn|livescore|atptour|wtatennis|eurohockey|euroleague|nhl\.com|basketball-reference|eliteprospects|oddsportal|tennis', re.I)
merged={}; stats=collections.Counter()
for run in RUNS:
    jp=f'{WF}/{run}/journal.jsonl'
    if not os.path.exists(jp): continue
    results={}
    for line in open(jp):
        try: d=json.loads(line)
        except: continue
        if isinstance(d.get('result'),dict) and d.get('agentId'): results[d['agentId']]=d['result']
    for aid,r in results.items():
        key=leg_of_agent(f'{WF}/{run}/agent-{aid}.jsonl')
        if not key: stats['unmatched']+=1; continue
        m=merged.setdefault(key,{'key':key,'event':key.split('|')[0]})
        if 'verdict' in r:
            fc=bool(r.get('fixtureConfirmed')); src=str(r.get('fixtureSource',''))+' '+str(r.get('summary',''))
            m.update(verdict=r.get('verdict'),confidence=r.get('confidence'),pAgent=r.get('pAgent'),fixtureConfirmed=fc,
                     fixtureSecondary=(not fc) and bool(SECONDARY.search(src)) and not re.search(r'not (listed|found)|no listing|could not find (the|this) (match|fixture)', src, re.I),
                     fixtureSource=r.get('fixtureSource'),summary=r.get('summary'),unverified=r.get('unverified'),priceCheck=r.get('priceCheck'),voidRisk=r.get('voidRisk'),baseRate=r.get('baseRate'),teamNews=r.get('teamNews'))
            stats['inv']+=1
        elif 'killed' in r:
            m.update(killed=bool(r.get('killed')),reason=r.get('reason'),source=r.get('source'),assConf=r.get('confidence'),concerns=r.get('concernsNotFatal')); stats['ass']+=1
json.dump(merged,open('research_merged.json','w'),indent=1)
both=[m for m in merged.values() if 'verdict' in m and 'killed' in m]
print(f"merged: {len(merged)} legs touched, {len(both)} complete (both stages) of {len(legs)} | {dict(stats)}")
print(f"killed {sum(1 for m in merged.values() if m.get('killed'))} | avoid {sum(1 for m in merged.values() if m.get('verdict')=='avoid')} | unsure {sum(1 for m in merged.values() if m.get('verdict')=='unsure')} | keep {sum(1 for m in merged.values() if m.get('verdict')=='keep')} | fixture: confirmed {sum(1 for m in merged.values() if m.get('fixtureConfirmed'))}, secondary-only {sum(1 for m in merged.values() if m.get('fixtureSecondary'))}, unconfirmed {sum(1 for m in merged.values() if 'verdict' in m and not m.get('fixtureConfirmed') and not m.get('fixtureSecondary'))}")
for k,m in merged.items():
    l=legs[k]; tag=None
    if m.get('killed'): tag='KILLED  '+str(m.get('reason'))[:170]
    elif m.get('verdict')=='avoid': tag='AVOID   '+str(m.get('summary'))[:170]
    elif 'verdict' in m and not m.get('fixtureConfirmed') and not m.get('fixtureSecondary'): tag='UNCONF  '+str(m.get('fixtureSource') or m.get('unverified'))[:170]
    if tag: print(f"  {l['home'][:22]} v {l['away'][:22]} [{l['pick']}] :: {tag}")
