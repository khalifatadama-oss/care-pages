/* Phase 6 — the optimiser.
 *
 * The objective collapses. Let v_i = o_i * p_i. Then
 *     P(all win) = prod p_i = prod(v_i / o_i) = (prod v_i) / O
 * and the target forces O >= O_req = T / (S * (1 + b)). Excess odds beyond
 * O_req is pure wasted probability, so at the optimum the constraint binds and
 *     log P = sum(log v_i) - log O_req.
 * So for a FIXED leg count, maximising probability is exactly maximising the
 * sum of log value, subject to the legs being able to reach O_req.
 * That makes this a min-weight-constrained knapsack: profit log v_i,
 * weight log o_i, requirement sum(weight) >= log O_req. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  var opt = SB.optimize = {
    DEFAULT: {
      stake: 500, maxLegs: 50, minLegs: 4,
      voidHeadroom: 0,     // legacy crude headroom; prefer voidAware below
      voidAware: true,     // evaluate P(payout>=T) over the void distribution
      voidDropsQualifying: false,  // UNMEASURED: does a void drop the bonus tier?
      refine: 15,          // seeds to local-search. 15 matches an exhaustive
                           // sweep; 6 loses up to 8% of P, 40 adds nothing.
      rhoGlobal: 0, rhoWithin: 0, groupBy: 'tournament',
      restrict: null       // null | 'nonFootball' | 'fullFactor' | 'football'
    },

    pools: function (rows) {
      var H = SB.harvest.SPORT_FACTOR_HYPOTHESIS, table = SB.rules.get();
      function factor(r) {
        var f = table.sportFactors[r.sport];
        if (f == null) f = H[r.sport];
        return f == null ? 0.6 : f;
      }
      return {
        unrestricted: rows,
        football: rows.filter(function (r) { return r.sport === 'football'; }),
        nonFootball: rows.filter(function (r) { return r.sport !== 'football'; }),
        fullFactor: rows.filter(function (r) { return factor(r) >= 0.999; })
      };
    },

    /** Lagrangian orderings, computed ONCE per pool. score = log v + lam*log o.
     *  lam=0 is pure value; large lam is pure odds. Feasibility lives between. */
    _orders: function (pool, steps) {
      steps = steps || 24;
      var orders = [];
      for (var li = 0; li <= steps; li++) {
        var lam = li / 6;
        orders.push(pool.slice().sort(function (a, b) {
          return (Math.log(b.value) + lam * Math.log(b.odds)) -
                 (Math.log(a.value) + lam * Math.log(a.odds));
        }));
      }
      return orders;
    },

    /** Best prefix-n seed across all Lagrangian orderings. Cheap: no re-sorting. */
    _seed: function (orders, target, n, cfg) {
      var best = null;
      for (var i = 0; i < orders.length; i++) {
        if (orders[i].length < n) continue;
        var cand = this._score(orders[i].slice(0, n), target, cfg);
        if (cand && (!best || cand.logP > best.logP)) best = cand;
      }
      return best;
    },

    /** Full solve for one target: sweep leg counts across all four pools,
     *  then local-search only the most promising seeds. */
    target: function (rows, target, cfg) {
      cfg = Object.assign({}, this.DEFAULT, cfg || {});
      var pools = this.pools(rows), names = cfg.restrict ? [cfg.restrict] :
            ['unrestricted', 'nonFootball', 'fullFactor', 'football'];
      var seeds = [], trace = [];
      for (var pi = 0; pi < names.length; pi++) {
        var pool = pools[names[pi]] || [];
        if (pool.length < cfg.minLegs) continue;
        var orders = this._orders(pool);
        for (var n = cfg.minLegs; n <= Math.min(cfg.maxLegs, pool.length); n++) {
          var s = this._seed(orders, target, n, cfg);
          if (!s) continue;
          s.pool = names[pi]; s._pool = pool;
          trace.push({ pool: names[pi], n: n, pIndep: s.pIndep,
                       payout: s.payout.payout,
                       roi: s.pIndep * s.payout.uncapped / cfg.stake });
          seeds.push(s);
        }
      }
      if (!seeds.length) return null;
      seeds.sort(function (a, b) { return b.logP - a.logP; });

      var best = null, K = Math.min(cfg.refine == null ? 6 : cfg.refine, seeds.length);
      for (var i = 0; i < K; i++) {
        var r = this._localSearch(seeds[i], seeds[i]._pool, target, cfg);
        r.pool = seeds[i].pool;
        if (!best || r.logP > best.logP) best = r;
      }
      best.correlated = this.correlate(best, cfg);
      best.trace = trace;
      best.target = target;
      delete best._pool;
      return best;
    },

    /** Score a leg set, or reject it as infeasible. */
    _score: function (legs, target, cfg) {
      if (legs.length > SB.rules.CAPS.maxSelections) return null;
      var r = SB.rules.payout(legs, cfg.stake);
      if (r.uncapped < target) return null;

      // Lever 2 — void headroom: must still clear the target after the k
      // costliest voids (a whole-number line that lands exactly on the number).
      if (cfg.voidHeadroom > 0) {
        var order = legs.slice().sort(function (a, b) { return b.odds - a.odds; });
        var drop = {};
        for (var k = 0; k < cfg.voidHeadroom && k < order.length; k++) drop[order[k].outcomeId + '@' + order[k].eventId] = 1;
        var surviving = legs.filter(function (L) { return !drop[L.outcomeId + '@' + L.eventId]; });
        if (SB.rules.payout(surviving, cfg.stake).uncapped < target) return null;
      }

      // Void-aware objective. If any leg can VOID (a whole-number line), the
      // product of stated probabilities is the WRONG quantity -- a void keeps
      // the ticket alive at a reduced payout. Evaluate the payout distribution.
      var anyVoidable = false;
      for (var vi = 0; vi < legs.length; vi++) {
        if (legs[vi].pPush > 0) { anyVoidable = true; break; }
      }
      if (anyVoidable && cfg.voidAware !== false) {
        var vlegs = legs.map(function (L) {
          return { pWin: L.pWin == null ? L.p : L.pWin, pPush: L.pPush || 0,
                   odds: L.odds, sport: L.sport, tournament: L.tournament };
        });
        var vr = SB.voidmodel.pAtLeastTarget(vlegs, target, cfg.stake,
          { voidDropsQualifying: !!cfg.voidDropsQualifying });
        if (!(vr.p > 0)) return null;
        return { legs: legs, logP: Math.log(vr.p), pIndep: vr.p, payout: r,
                 n: legs.length, voidModel: vr };
      }

      var logP = 0;
      for (var i = 0; i < legs.length; i++) {
        logP += Math.log(legs[i].pWin == null ? legs[i].p : legs[i].pWin);
      }
      return { legs: legs, logP: logP, pIndep: Math.exp(logP), payout: r, n: legs.length };
    },

    /** Swap / drop local search on the true objective. */
    _localSearch: function (cur, pool, target, cfg) {
      var inSet = {}, improved = true, rounds = 0;
      cur.legs.forEach(function (L) { inSet[L.eventId] = true; });
      var outside = pool.filter(function (L) { return !inSet[L.eventId]; })
        .sort(function (a, b) { return b.value - a.value; }).slice(0, 150);

      while (improved && rounds++ < 25) {
        improved = false;
        for (var i = 0; i < cur.legs.length && !improved; i++) {
          for (var j = 0; j < outside.length; j++) {
            if (inSet[outside[j].eventId]) continue;
            var trial = cur.legs.slice(); trial[i] = outside[j];
            var cand = this._score(trial, target, cfg);
            if (cand && cand.logP > cur.logP + 1e-12) {
              delete inSet[cur.legs[i].eventId]; inSet[outside[j].eventId] = true;
              cur = cand; improved = true; break;
            }
          }
        }
        // Dropping a leg removes one leg's margin bleed; worth it whenever the
        // bonus tier survives. This is why fewer legs often wins.
        if (!improved) {
          for (var d = 0; d < cur.legs.length; d++) {
            var less = cur.legs.filter(function (_, k) { return k !== d; });
            var c2 = this._score(less, target, cfg);
            if (c2 && c2.logP > cur.logP + 1e-12) {
              delete inSet[cur.legs[d].eventId]; cur = c2; improved = true; break;
            }
          }
        }
      }
      return cur;
    },

    /** Lever 1 — correlation-adjusted joint probability. */
    correlate: function (sol, cfg) {
      if (!cfg.rhoWithin && !cfg.rhoGlobal) return null;
      var ps = sol.legs.map(function (L) { return L.p; });
      var groups = sol.legs.map(function (L) { return L[cfg.groupBy] || L.tournament; });
      var p = SB.prob.jointBlocks(ps, groups, cfg.rhoGlobal, cfg.rhoWithin);
      var uniq = {}; groups.forEach(function (g) { uniq[g] = 1; });
      return { p: p, lift: p / sol.pIndep, groups: Object.keys(uniq).length,
               rhoGlobal: cfg.rhoGlobal, rhoWithin: cfg.rhoWithin };
    },

    /** Return-on-stake of a structure: P * payout / stake.
     *  Equals vbar^n * (1+b) and is independent of the target. */
    roi: function (sol, stake) {
      return sol.pIndep * sol.payout.uncapped / (stake || 500);
    },

    /** Flexi (all-but-one) comparison at the same legs. flexiFactor is the
     *  payout multiple Flexi pays relative to the ordinary multiple — MEASURE it. */
    compareFlexi: function (sol, flexiFactor, cfg) {
      var ps = sol.legs.map(function (L) { return L.p; });
      var groups = sol.legs.map(function (L) { return L[(cfg && cfg.groupBy) || 'tournament']; });
      var rg = (cfg && cfg.rhoGlobal) || 0, rw = (cfg && cfg.rhoWithin) || 0;
      var pAll = rw || rg ? SB.prob.jointBlocks(ps, groups, rg, rw) : SB.prob.independent(ps);
      var pFlexi = SB.prob.atLeastAllButOne(ps, rw || rg ? rw + rg : 0);
      return {
        multiple: { p: pAll, payout: sol.payout.payout, ev: pAll * sol.payout.payout },
        flexi: { p: pFlexi, payout: sol.payout.payout * flexiFactor,
                 ev: pFlexi * sol.payout.payout * flexiFactor },
        verdict: pFlexi * flexiFactor > pAll ? 'flexi' : 'multiple',
        note: 'Flexi only beats the Multiple if it still clears the target; a ' +
              'reduced payout that lands under T has probability 0 of hitting T.'
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
