# SportyBet ticket builder

Builds maximum-probability accumulators against a payout target. Runs in your
own browser, in Nigeria — no VPN, no server-side requests, nothing to install.

Read `ANALYSIS.md` first. It contains the honest probabilities and three places
where the method in the brief needs correcting.

**This tool never places a bet.** It builds slips and produces booking codes.

---

## Why it runs in your browser

The feed API 403s server-side, so it must be called from inside the page. More
importantly, writing the betslip and clicking `Book Bet` need your logged-in
session on a Nigerian IP. No remote machine can do those steps for you without
tripping the geofence that voids winnings.

## Setup

Open <https://www.sportybet.com/ng/>, open DevTools (F12) → Console, paste the
whole of `dist/sportybet-builder.js`, press Enter. You should see
`[sbtb] loaded.`

> Chrome may require you to type `allow pasting` in the console once first.

Keep **one dedicated tab** for this. Harvest state lives in `localStorage`, so it
survives reloads — but don't run the builder and browse the site in the same tab.

---

## 1. Verify the schema before trusting anything

```js
await SB.run.step1_inspect()        // football; try 2, 5, 20 as well
```

This prints the real field names and runs the check the whole method rests on:

```
market 1 1X2 | sum(p) = 1.0000 | sum(1/odds) = 1.0480 | margin = 4.80%
```

**If `sum(p)` is not ~1.000, stop.** `probability` is then not the margin-free
field, the value ranking means something else, and every number in `ANALYSIS.md`
needs redoing. If field names differ from what `inspect()` expected, patch
`SB.harvest.FIELDS` — each entry is a list of candidate names.

## 2. Harvest

Do it in batches so no single console call times out:

```js
await SB.run.step2_harvest([1])                    // football (the big one)
await SB.run.step2_harvest([2,5,4,20])             // basketball, tennis, hockey, TT
await SB.run.step2_harvest([21,12,6,23,3])         // cricket, rugby, handball, volley, baseball
await SB.run.step2_harvest([10,16,19,22,31,117])   // boxing, NFL, snooker, darts, badminton, MMA
```

Each sport is stored separately, so a failure mid-way costs only that sport.

## 3. Measure the payout rules — do not skip this

```js
await SB.run.step3_rules()
```

The parse is best-effort against an unknown schema. If it finds no tiers, dump
`SB.store.get("rules:plansRaw")`, read the table off it, and enter it by hand:

```js
SB.rules.setBonus(
  [{legs:5,bonus:0.03},{legs:10,bonus:0.10},{legs:20,bonus:0.40},
   {legs:30,bonus:0.70},{legs:40,bonus:1.00}],   // bonus as a FRACTION
  {football:0.6, basketball:1.0, tennis:1.0, baseball:0.75, mma:0.75, darts:0.75},
  {},      // tournament overrides
  1.20     // qualifying odds floor
)
```

Then run these five checks on real slips. Every number in `ANALYSIS.md` depends
on them:

1. **Tier table** — build slips at 5, 10, 20, 30, 40 legs; compare displayed bonus.
2. **Sport factor is a MINIMUM** — 19 non-football legs, read the bonus; add one
   football leg; if the bonus drops to 0.6× of headline, the rule is real. This
   is worth 30%+ on the big tickets.
3. **Qualifying floor** — swap one leg from 1.20 to 1.19. If the tier drops, confirmed.
4. **Slip vs booking** — note the slip's bonus, then `Book Bet` and note the
   confirmation's. **They can differ. Build to the lower.**
5. **Void behaviour** — does a voided leg also drop the qualifying count?

```js
SB.rules.audit()    // prints the checklist with what's currently stored
```

## 4. Candidates

```js
const cand = SB.run.step4_candidates({ minOdds:1.20, maxOdds:1.70, minValue:0.90 })
cand.slice(0,20)    // the value ranking
```

Excludes amateur/youth/U-age/reserve/women's/virtual/esports, odds outside the
band, kick-offs inside 90 minutes, and keeps **one leg per event** (same-match
legs are strongly dependent and mostly rejected in multiples anyway).

Watch for `value > 1.0` — a genuinely +EV leg. Rare and worth taking.

## 5. Research (optional, veto-only)

```js
SB.filters.exportCandidates(cand, 300)   // downloads the worklist
```

Run your Stage A / Stage B agents over it, then feed results back:

```js
SB.filters.importResearch([
  { key:"sr:match:123|456", verdict:"avoid", killed:true },
  { key:"sr:match:789|012", p:0.61, confidence:0.7 }
])
```

Research can only ever **lower** a probability (`p_used = min(p_sportybet, blend)`).
That is deliberate — see `ANALYSIS.md` §4. An agent more optimistic than
SportyBet's pricing model changes nothing.

## 6. Optimise

```js
const sols = SB.run.step5_optimise({
  rhoWithin: 0.05,        // correlation inside a competition — ESTIMATE THIS
  rhoGlobal: 0.01,
  groupBy: 'tournament',
  voidHeadroom: 0,        // leave at 0; see ANALYSIS.md §3 Lever 2
  refine: 15              // seeds to local-search; 15 matches an exhaustive sweep
})
SB.run.step6_report()
```

Solves all four pools (unrestricted / non-football / full-factor / football)
across every leg count, then local-searches the best seeds. The full-factor
non-football pool usually wins — check `sols.T1.pool`.

To estimate ρ from history instead of guessing:

```js
SB.prob.estimateRho([{hits:6,n:10},{hits:3,n:10},{hits:8,n:10}])
// hits = matches in that round that went Under; n = matches in the round
```

## 7. Verify on the live slip, then book

Clear your slip, add **one** selection by hand, then:

```js
SB.slip.capture()          // learns the real betslip schema from that selection
SB.run.step7_slip('T1')    // writes all legs, reloads
SB.slip.readDisplayed()    // read what the SITE says — trust this, not the model
```

If the displayed payout is under target, add or swap a leg and repeat. Then
click `Book Bet` yourself and verify the code:

```js
await SB.slip.verifyCode('ABC123')   // leg count + unavailable outcomes
```

Any `unavailable` legs mean rebuild.

---

## Offline use

Export the harvest and optimise anywhere:

```js
SB.store.download(SB.harvest.merged(), 'feed.json')
```

```sh
node node/simulate.mjs   # optimiser demo on a simulated book
node node/lever2.mjs     # the whole-number-line comparison
node node/e2e.mjs        # full pipeline + sample report
```

## Layout

| file | phase |
|---|---|
| `src/00-store.js` | chunked `localStorage` persistence |
| `src/10-harvest.js` | 1 — feed pull, `value = odds × probability`, `inspect()` |
| `src/20-rules.js` | 2 — bonus table, sport factors, caps, payout |
| `src/30-filters.js` | 3 — exclusions, research veto (downward-only) |
| `src/40-probability.js` | 4 — copula, block correlation, push branch, ρ estimator |
| `src/50-optimize.js` | 6 — the knapsack |
| `src/60-betslip.js` | 7 — schema capture, slip write, code verify |
| `src/70-report.js` | 8 — WAT handover |

`./build.sh` rebuilds `dist/` from `src/`.

## Known gaps

- Bonus table, sport factors, and the `betslips` schema are all unverified —
  steps 1, 3 and 7 are how you verify them.
- ρ defaults to 0; nothing is correlation-adjusted until you set it.
- Flexi/One Cut/2UP comparators exist but have no measured prices.
- The optimiser assumes bonus = `factor × headline(qualifying count)`. If
  measurement contradicts that, fix `SB.rules.effective()`.
