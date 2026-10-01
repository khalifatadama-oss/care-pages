# SportyBet maximum-probability tickets — findings

**Date:** 2026-10-01 · **Stake basis:** ₦500/ticket, ₦2,500 total

---

## 0. What I could not do, and why

**I have no booking codes for you.** This container's egress proxy refuses all
connections to `www.sportybet.com` (`connect_rejected`, organisation network
policy). That is not the Nigerian geofence — it is a block on this machine. I
did not try to route around it, and you should not want me to: anything that
reached the site from here would be a non-Nigerian IP, which is exactly the
thing that voids winnings.

So Phase 1 (the feed), Phase 2 (the bonus table), and Phase 7 (the live slip and
`Book Bet`) could not run. Phase 3's per-leg research is downstream of a
candidate list I never got, so it did not run either.

Worth being clear: **Phases 2 and 7 were never doable from here anyway.**
Writing `betslips` into `localStorage` and clicking `Book Bet` needs your own
browser, logged in, in Nigeria. The correct split was always *harvest and book
in your browser, optimise anywhere*. What you lost to the network block is me
doing the harvest for you — not the method. The builder in this directory does
every phase; you run the two that must happen on your machine.

What follows does not depend on the feed, because the governing result is
algebraic.

---

## 1. The identity that governs all five tickets

For legs `i = 1..n` with decimal odds `oᵢ` and SportyBet's fair probability `pᵢ`,
define value `vᵢ = oᵢ·pᵢ` as the brief does. Then

```
P(all win) = ∏pᵢ = ∏(vᵢ/oᵢ) = (∏vᵢ) / O        where O = ∏oᵢ
```

Hitting target `T` from stake `S` requires `S·O·(1+b) = T`, i.e. `O = T/(S(1+b))`.
Any odds beyond that is wasted probability, so at the optimum it binds:

```
          ─────────────────────────────────
            P  =  v̄ⁿ · S(1+b) / T
          ─────────────────────────────────
```

where `v̄` is the geometric mean value of your legs. Four consequences, and they
restructure the whole problem:

**(a) A hard ceiling that no amount of skill touches.** Every `vᵢ < 1` whenever
SportyBet takes any margin at all, so `v̄ⁿ < 1`, so

```
P  <  S(1+b)/T
```

This needs no data. At ₦500 with a 40% bonus, the ₦200M ticket cannot exceed
**1 in 285,714** — not with perfect research, not with perfect selection. That is
the zero-margin limit, and it is unreachable by construction.

**(b) Return on stake is target-independent.**

```
EV/stake = P·T/S = v̄ⁿ (1 + b)
```

`T` has vanished. Whether a ticket is good value has *nothing* to do with which
payout you aim at. It depends only on leg count, margin, and bonus.

**(c) All five tickets have the same objective function.** Maximising `P` at
fixed `T` *is* maximising `v̄ⁿ(1+b)`. The five targets differ only through a
feasibility constraint (`1.20ⁿ ≤ O ≤ 1.70ⁿ`). They are one problem at five
payout levels, not five problems.

**(d) The optimiser collapses to a knapsack.** Since `log P = Σlog vᵢ − log O_req`,
maximising probability at fixed leg count is exactly **maximising total log
value subject to the legs being able to reach `O_req`** — profit `log vᵢ`, weight
`log oᵢ`. That is what `src/50-optimize.js` solves (Lagrangian seed, then
swap/drop local search). It is not a heuristic; it is the exact objective.

---

## 2. The honest numbers

Two independent routes, agreeing. **Route A** is the closed form at `v̄ = 0.97`.
**Route B** is the full optimiser run over a simulated book of 1,476 selections
with margins drawn 3–8% (`node/simulate.mjs`) — real code, real search, simulated
prices.

Bonus table assumed: 5 legs 3%, 10 legs 10%, 20 legs 40%, 30 legs 70%, 40 legs
100%, non-football factor 1.0. **This table is a placeholder — measure it.**

| Ticket | Target | legs | P (independent) | odds against | correlation-adjusted | ROI |
|---|---|---|---|---|---|---|
| 1 | ₦2M | 20–23 | 1.8×10⁻⁴ | **1 in 5,300** | 1 in ~2,800 | 0.73 |
| 2 | ₦5M | 24 | 6.9×10⁻⁵ | **1 in 14,600** | 1 in ~6,600 | 0.69 |
| 3 | ₦10M | 26 | 3.2×10⁻⁵ | **1 in 31,000** | 1 in ~12,300 | 0.65 |
| 4 | ₦50M | 22 | 7.0×10⁻⁶ | **1 in 143,600** | 1 in ~47,500 | 0.70 |
| 5 | ₦200M | 25 | 1.6×10⁻⁶ | **1 in 626,000** | 1 in ~164,000 | 0.64 |

Read that honestly: the ₦200M ticket is a **one-in-roughly-600,000** shot, and the
correlation-adjusted figure is the optimistic end of a very uncertain range, not
a promise. `P` tracks `1/T` almost exactly, as the identity says it must — ticket
1 is ~118× likelier than ticket 5.

**ROI 0.64–0.73 means you lose 27–36% of stake in expectation.** That is far
better than the ~50% the raw margin would cost over 20–25 legs — the bonus is
doing real work — but it is not break-even and it is not close.

### A measurement check that matters

At `v̄ = 0.98` the same arithmetic returns **ROI above 1.0** — a sportsbook giving
money away. It won't be. So if your measured table and your measured values
produce ROI > 1, the conclusion is *a measurement is wrong*, not that you found
an edge. The usual culprits: the bonus applies to stake rather than total
returns; it is capped in naira; the "1000%" figure is a maximum under conditions,
not a flat multiplier; or `probability` is not the margin-free field we assume.
`SB.harvest.inspect()` tests that last one directly — it prints `Σp` per market.
If it isn't 1.000, the value ranking is measuring something else and every number
above needs redoing.

---

## 3. The four levers, measured

**Lever 1 — correlation. Real, and the biggest genuine edge. Smaller than you think.**

Confirmed: positive correlation raises `P(all win)` well above the independence
figure, and because the book prices legs marginally, that lift is genuinely
yours. But the size depends entirely on structure, and a uniform ρ across 25
legs in 25 different competitions is not a real thing. With a **two-level model**
(global factor + per-competition factor, `SB.prob.jointBlocks`), at
ρ_within = 0.05 and ρ_global = 0.01:

| legs spread over | lift vs independence |
|---|---|
| 1 competition | 38× |
| 3 competitions | 7.8× |
| 6 competitions | 4.4× |
| 10 competitions | 3.4× |
| 30 competitions | 2.6× |

A realistically diversified 25-leg ticket gets **~2–4×**, not orders of magnitude.
Concentrating legs into few competitions and one weekend buys much more — up to
38× — but the pool of good-value legs inside one competition is small, so you pay
in `v̄`. That trade is exactly what the optimiser's `groupBy` and ρ settings let
you price. **ρ is the most load-bearing and least certain number in the whole
model**; `SB.prob.estimateRho()` fits it from historical round data, and until you
do that, treat every correlation-adjusted figure above as an upper bound.

**Lever 2 — whole-number lines. The brief has this backwards.**

The claim is that given headroom, whole lines "strictly dominate" half lines.
They do not, at a fixed payout target. The push branch is not free: a whole line
has the same win set as the half line below it *plus* a push, so fair pricing
shortens it by exactly `(1 − p_push)`:

```
o_whole / o_half = 1 − p_push
```

Shorter odds at a fixed target force more legs, and every extra leg bleeds
margin. Modelling the push branch exactly (`SB.prob.withPushes`, enumerating all
push sets up to the headroom):

| p_push | half-line ticket | whole-line ticket | result |
|---|---|---|---|
| 0.08 | 22 legs @1.458 → 1.28×10⁻⁴ | 29 legs @1.341 → 8.29×10⁻⁵ | **0.65×** |
| 0.11 | 22 legs @1.458 → 1.28×10⁻⁴ | 32 legs @1.298 → 9.05×10⁻⁵ | **0.71×** |
| 0.15 | 22 legs @1.458 → 1.28×10⁻⁴ | 39 legs @1.239 → 7.10×10⁻⁵ | **0.56×** |

Whole lines cost you **30–45% of your probability**. The "free roll" intuition is
right at a *fixed leg count* and wrong at a *fixed payout*, which is your actual
objective. At ₦2M, 22 half-line legs beat 32 whole-line legs because ten extra
legs of margin outweigh the push protection. Separately, the headroom itself is
expensive: requiring the ticket to survive one void drops P by 42% (1.76×10⁻⁴ →
1.02×10⁻⁴) because you must overshoot to ₦3.3M.

**Use half lines.** One caveat left unmeasured: if a void also drops your
qualifying leg count a bonus tier, whole lines are worse still.

**Lever 3 — mispricing. Sound, but the brief conflates two things.**

`v = o·p` uses *SportyBet's own* `p`. High `v` means **low margin on that
selection**, not edge. A leg can have `v = 0.99` and still be a bad bet if
SportyBet's model is wrong. Edge requires an *external* opinion: `p_sharp >
p_implied`. The two rankings are different and can conflict. Both belong, doing
different jobs:

- Rank by `v` — that is what the identity demands, it minimises margin bleed.
- Use Pinnacle/Betfair closing lines as a **calibration filter**: drop legs where
  the sharp consensus says SportyBet's `p` is too *high*, because those inflate
  your reported `P` without raising the real one. This is the same asymmetry as
  Phase 4 and must stay downward-only.
- A leg where sharp money says SportyBet's `p` is too *low* is genuine edge and
  `v` understates it. Flag those separately; never let them raise a reported `P`.

Also: if any `v > 1` appears, that is a genuinely +EV leg (a boost or a pricing
error) and it breaks the §1(a) ceiling in your favour. The builder flags these.

**Lever 4 — place late. Correct, no caveat.** Team sheets land ~1h before kick-off.
The report prints every kick-off in WAT and the latest sensible placement time.

---

## 4. Your Phase 4 anti-cherry-pick rule is right

`p_used = min(p_sportybet, blend(p_sportybet, p_agent))` is the correct guard, and
it is the single best methodological choice in your brief. Ranking on a symmetric
blend selects precisely the legs where your agents were more optimistic than a
professional pricing model — which is where they are most likely wrong. It is
implemented in `SB.filters.applyResearch()`.

One honest consequence: a one-sided penalty makes the reported figure a
**conservative lower bound, not an estimate**. That is what you asked for, but
don't then read it as "the" probability. The report prints both bases.

---

## 5. The biggest probability leak is the ₦500 × 5 structure itself

`P ∝ S/T` is linear in stake. Five separate ₦500 tickets throw away a factor of
five on whatever target you actually care about:

| Target | ₦500 (as briefed) | all ₦2,500 on one ticket | gain |
|---|---|---|---|
| ₦2M | 1 in 5,254 | **1 in 1,051** | 5.00× |
| ₦5M | 1 in 13,135 | 1 in 2,627 | 5.00× |
| ₦10M | 1 in 26,270 | 1 in 5,254 | 5.00× |
| ₦50M | 1 in 139,603 | 1 in 26,270 | 5.31× |
| ₦200M | 1 in 586,758 | 1 in 108,332 | 5.42× |

**If what you want is the highest probability of a large win, one ₦2,500 ticket
at ₦2M is 1 in ~1,050 against 1 in ~5,250 for the briefed version.** Five tickets
buy you five *lottery lines at five prize levels*; one ticket buys five times the
chance at one. The spread-bet version does give a slightly better chance that
*something* lands (1 in 3,191 for at least one of the five) — but four of those
five outcomes are the small ones, so that number is mostly the ₦2M ticket wearing
a disguise.

Which target is best value: **ticket 1**, on both counts. Highest ROI (0.73 vs
0.64) and highest probability. The identity guarantees this ordering rather than
merely observing it — larger `T` forces more legs *and* pushes you deeper down the
value ranking, so ROI falls monotonically as `T` rises. There is no selection
cleverness that reverses it.

And leg count: ROI peaks at **n ≈ 20**, just above a bonus tier boundary — never
at 50.

| n | 10 | 15 | **20** | 25 | 30 | 40 | 50 |
|---|---|---|---|---|---|---|---|
| ROI | 0.811 | 0.697 | **0.761** | 0.654 | 0.682 | 0.591 | 0.436 |

The sawtooth is the tier structure. **Always sit just above a boundary, never just
below** — and a single leg at 1.19 that drops you a tier is the most expensive
mistake available.

---

## 6. What is not verified

Everything in §2 rests on assumptions, listed so you can knock them down:

- **The bonus table is invented.** Public sources contradict each other (300% at
  30+, 1000% at 40+, "10–100%"); all of them are affiliate marketing. Measure it.
- **The sport-factor rule** (football 0.6, min across slip) is from your brief,
  untested here. The optimiser independently chose the full-factor non-football
  pool for every target, so if the rule is real, it matters a lot.
- **`probability` being margin-free** is unconfirmed. `SB.harvest.inspect()` tests it.
- **The API response schema** is a guess — hence `inspect()` first and patchable
  `FIELDS`.
- **The `betslips` localStorage schema** is not guessed at all: `SB.slip.capture()`
  learns it from a real slip you build by hand.
- **ρ is unestimated.** The most important uncertain number in the model.
- **`v̄ = 0.97`** is my assumption about achievable margin over 20–25 legs. The
  real figure comes from your harvest, and the results move sharply with it.
- **Betslip vs booking-confirmation divergence** — unmeasured. Build to the lower.
- **Void effect on qualifying count** — unmeasured, and it makes Lever 2 worse.
- Flexi, One Cut, and 2UP are implemented as comparisons but have no measured
  prices, so no verdict. The Flexi comparator carries the trap: a reduced payout
  landing under `T` has probability **zero** of hitting `T`, regardless of how
  often the structure "wins".

---

## 7. Addendum — the void error, audited

A brief from a prior session (five tickets already placed: L276WP, LNDRQN,
MTK97W, LLKBMV, ME3JZH) reported a post-placement error: whole-number total
lines VOID rather than lose, and the feed's `probability` field is conditional
on no void. **The diagnosis is correct. The prescribed fix is not.**

I cannot verify anything about the live site — same network block as §0 — so
what follows audits the mathematics only, and takes the brief's reported
measurements as given.

### The diagnosis checks out

Published p for "Under 4" = 0.800; reported P(≤3)=0.671, P(=4)=0.162, P(≥5)=0.167.

```
0.671 / (0.671 + 0.167) = 0.8007   ≈ 0.800   ✓
```

And the sum-to-1.000 property *forces* this reading: unconditional values would
sum to `1 − P(=4) = 0.838`, not 1.0. So any voidable market's published
probabilities must be conditional. Sound.

### The prescription is backwards

"Under 3.5" and "Under 4" have the **identical winning condition** (total ≤ 3).
A fair price sets expected return to 1, and a void returns stake, so:

```
fair_odds(Under 4)   = (1 − pPush) / pWin = 0.838 / 0.671 = 1.249
fair_odds(Under 3.5) =             1 / pWin =     1 / 0.671 = 1.490
ratio = 1.249 / 1.490 = 0.8380 = 1 − pPush        (exact)
```

**The half-line below pays 19.3% more odds for the same probability of
winning.** At a fixed payout target, shorter odds force more legs, and each
extra leg surrenders margin. Tested with the whole-line version steelmanned
(free to sweep headroom, voids optimistically assumed still to count toward the
bonus tier):

| slip | half-lines | whole-lines | |
|---|---|---|---|
| football-heavy (factor 0.6) | 23 legs, **1 in 11,509** | 28 legs, 1 in 14,986 | 1.30× |
| full-factor (factor 1.0) | 22 legs, **1 in 7,620** | 28 legs, 1 in 11,710 | 1.54× |

The decisive evidence is the void-count breakdown on a reconstruction of the
₦2M ticket (31 legs, 10 voidable, built to ₦2.12M):

```
>= N2.0M        1 in 45,936      <- 0-void branch ONLY
>= N1.5M        1 in 13,454
>= N1.0M        1 in  5,946
pays anything   1 in  5,284
void breakdown at N2.0M:  0 voids: 2.177e-5   (1+ voids: nothing)
```

One void divides the payout by 1.249, taking ₦2.12M to ₦1.70M — under target.
**At the target itself the ten voidable legs contribute exactly zero.** They
only help at the lower rungs. So at T they are pure cost. The remedy is to
avoid whole-number lines, not to carry headroom for them.

(Magnitudes differ from the brief's — 1 in 45,936 vs its 1 in 12,022 — because
its actual 31 legs are not public and my plain-leg probabilities differ. The
*shape* reproduces: target far less likely than survival.)

### An inversion that would have caught this before placement

Rearranging §1: `v̄ = (P·T / (S(1+b)))^(1/n)`. For the 31-leg ticket:

| reported | implied v̄ | implied margin/leg |
|---|---|---|
| original, 1 in 4,549 | 0.979–0.985 | **1.5–2.1%** |
| corrected, 1 in 12,022 | 0.949–0.954 | 4.6–5.1% |

The brief states margins are "roughly 2 to 4 percent" per leg. **The original
figure implied a margin below its own stated floor** — detectably wrong on its
own terms, before any void analysis. The corrected figure implies 4.6–5.1%,
normal for football totals. Invert any reported probability to its implied
per-leg margin; if it comes out under ~3%, something is being double-counted.

### What was built

- `src/45-ladder.js` — recovers `pWin`/`pPush` from the line ladder
  (`pWin(Under L) = P(Under L−0.5)`, `pPush = P(Under L+0.5) − P(Under L−0.5)`),
  rejects combined markets ("Under 2.5 & Yes") by requiring a pure two-way market
  whose two probabilities sum to 1, and refuses to guess when the ladder is
  incomplete — those legs are dropped, not estimated. `preferHalfLines()` reports
  every whole-number leg that has a strictly better half-line alternative.
- `src/46-voidmodel.js` — `P(payout ≥ T)` as an exact DP over cumulative voided
  log-odds, rather than 2^k enumeration, so it scales to 50 legs. A second
  dimension tracks void count, because a void may drop the qualifying-selection
  count and with it the bonus tier. Validated against brute force at
  **0.0000% relative error** over six cases including the tier-drop variant.
- The optimiser now maximises `P(payout ≥ T)` whenever any leg can void.

Two caveats on this engine. Whether a void drops the qualifying count is still
**unmeasured**; switching it on costs a further 1.28× at the ₦1M rung. And a
leg priced at 1.199 silently drops the bonus tier — my own first reconstruction
fell into exactly that trap and the engine caught it, which is what it is for.
