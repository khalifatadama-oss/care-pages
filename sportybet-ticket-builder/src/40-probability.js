/* Phase 4 / Lever 1 — joint probability under independence and under a
 * one-factor Gaussian copula, plus a moment estimator for the correlation. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  // Abramowitz & Stegun 26.2.23 inverse normal CDF, and Hart's normal CDF.
  function qnorm(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00],
        b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01],
        c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00],
        d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00], pl = 0.02425, q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
             ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
              ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    q = p - 0.5; r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  function pnorm(x) {
    // Numerical Recipes erfc. Phi(x) = erfc(-x/sqrt2)/2, so the argument
    // must be |x|/sqrt2 -- dropping that factor silently breaks the copula.
    var z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + z / 2), y = t * Math.exp(-z*z - 1.26551223 +
      t*(1.00002368 + t*(0.37409196 + t*(0.09678418 + t*(-0.18628806 + t*(0.27886807 +
      t*(-1.13520398 + t*(1.48851587 + t*(-0.82215223 + t*0.17087277))))))))) / 2;
    return x >= 0 ? 1 - y : y;
  }

  // 48-node Gauss–Legendre on [-8,8] in standard-normal space: ample for n<=50.
  var GRID = (function () { var g = [], N = 400, lo = -8, hi = 8, h = (hi - lo) / N;
    for (var i = 0; i <= N; i++) { var m = lo + i * h;
      g.push([m, Math.exp(-m * m / 2) / Math.sqrt(2 * Math.PI) * h *
              (i === 0 || i === N ? 0.5 : 1)]); } return g; })();

  SB.prob = {
    qnorm: qnorm, pnorm: pnorm,

    /** P(all legs win), legs independent. */
    independent: function (ps) {
      return ps.reduce(function (a, p) { return a * p; }, 1);
    },

    /** P(all legs win) under a one-factor Gaussian copula with correlation rho.
     *  Positive rho RAISES this above the independent figure — Lever 1. */
    joint: function (ps, rho) {
      if (!rho) return this.independent(ps);
      var k = ps.map(qnorm), s = Math.sqrt(rho), c = Math.sqrt(1 - rho), total = 0;
      for (var g = 0; g < GRID.length; g++) {
        var m = GRID[g][0], w = GRID[g][1], prod = 1;
        for (var i = 0; i < k.length; i++) {
          prod *= pnorm((k[i] - s * m) / c);
          if (prod < 1e-300) break;
        }
        total += w * prod;
      }
      return total;
    },

    /** Two-level copula: one global factor plus a per-group factor.
     *  Legs in different competitions/days do NOT share a single rho, so the
     *  uniform model above overstates the lift. groups: array of group keys
     *  parallel to ps. rhoGlobal + rhoWithin must stay below 1. */
    jointBlocks: function (ps, groups, rhoGlobal, rhoWithin) {
      rhoGlobal = rhoGlobal || 0; rhoWithin = rhoWithin || 0;
      if (!rhoGlobal && !rhoWithin) return this.independent(ps);
      if (rhoGlobal + rhoWithin >= 0.999) throw new Error('rhoGlobal + rhoWithin must be < 1');
      var k = ps.map(qnorm), byGroup = {};
      for (var i = 0; i < ps.length; i++) {
        var g = groups && groups[i] != null ? groups[i] : i;
        (byGroup[g] = byGroup[g] || []).push(k[i]);
      }
      var keys = Object.keys(byGroup),
          sg = Math.sqrt(rhoGlobal), sw = Math.sqrt(rhoWithin),
          c = Math.sqrt(1 - rhoGlobal - rhoWithin), outer = 0;
      for (var a = 0; a < GRID.length; a++) {
        var G = GRID[a][0], wG = GRID[a][1], prodGroups = 1;
        for (var gi = 0; gi < keys.length && prodGroups > 1e-300; gi++) {
          var ks = byGroup[keys[gi]], inner = 0;
          for (var b = 0; b < GRID.length; b++) {
            var F = GRID[b][0], wF = GRID[b][1], prod = 1;
            for (var j = 0; j < ks.length; j++) {
              prod *= pnorm((ks[j] - sg * G - sw * F) / c);
              if (prod < 1e-300) break;
            }
            inner += wF * prod;
          }
          prodGroups *= inner;
        }
        outer += wG * prodGroups;
      }
      return outer;
    },

    /** P(at least n-1 win) — the Flexi / all-but-one structure. */
    atLeastAllButOne: function (ps, rho) {
      if (!rho) {
        var all = this.independent(ps), sum = all;
        for (var i = 0; i < ps.length; i++) sum += all / ps[i] * (1 - ps[i]);
        return sum;
      }
      var k = ps.map(qnorm), s = Math.sqrt(rho), c = Math.sqrt(1 - rho), total = 0;
      for (var g = 0; g < GRID.length; g++) {
        var m = GRID[g][0], w = GRID[g][1], cond = [], prod = 1;
        for (var j = 0; j < k.length; j++) {
          cond.push(pnorm((k[j] - s * m) / c)); prod *= cond[j];
        }
        var acc = prod;
        for (var j2 = 0; j2 < cond.length; j2++) {
          if (cond[j2] > 1e-300) acc += prod / cond[j2] * (1 - cond[j2]);
        }
        total += w * acc;
      }
      return total;
    },

    /** Lever 2, done properly. A whole-number line (Under 4, -2.0) PUSHES when
     *  the total lands exactly on the number: the leg voids at 1.00, the ticket
     *  survives, the payout drops by that leg's odds. Evaluating this needs the
     *  push branch, not just a headroom constraint.
     *
     *  legs: [{pWin, pPush, odds}]; payoutOf(subsetKept) -> number; target.
     *  Enumerates every push set up to maxPush and keeps the feasible ones. */
    withPushes: function (legs, payoutOf, target, maxPush) {
      maxPush = maxPush == null ? 2 : maxPush;
      var n = legs.length, total = 0, terms = [];
      function logWinAll(skip) {
        var a = 0;
        for (var i = 0; i < n; i++) if (!skip[i]) a += Math.log(legs[i].pWin);
        return a;
      }
      function rec(start, chosen) {
        var skip = {}; chosen.forEach(function (i) { skip[i] = 1; });
        var kept = [];
        for (var i = 0; i < n; i++) if (!skip[i]) kept.push(legs[i]);
        if (payoutOf(kept) >= target) {
          var lp = logWinAll(skip);
          for (var c = 0; c < chosen.length; c++) lp += Math.log(legs[chosen[c]].pPush || 1e-12);
          total += Math.exp(lp);
          terms.push({ pushes: chosen.slice(), p: Math.exp(lp) });
        }
        if (chosen.length >= maxPush) return;
        for (var j = start; j < n; j++) { chosen.push(j); rec(j + 1, chosen); chosen.pop(); }
      }
      rec(0, []);
      return { p: total, terms: terms };
    },

    /** Method-of-moments rho from historical rounds.
     *  rounds: [{hits, n}] — e.g. per league-round, how many matches went Under.
     *  Overdispersion of the hit-share versus binomial implies a common factor. */
    estimateRho: function (rounds) {
      var tot = 0, hits = 0;
      rounds.forEach(function (r) { tot += r.n; hits += r.hits; });
      var pbar = hits / tot, obs = 0, exp = 0, m = 0;
      rounds.forEach(function (r) {
        if (r.n < 2) return;
        var sh = r.hits / r.n;
        obs += (sh - pbar) * (sh - pbar); exp += pbar * (1 - pbar) / r.n; m++;
      });
      if (!m) return { rho: 0, note: 'no usable rounds' };
      obs /= m; exp /= m;
      // excess variance of the share maps to the pairwise outcome correlation
      var rhoOut = Math.max(0, (obs - exp) / (pbar * (1 - pbar)));
      // convert outcome correlation to an approximate latent (copula) rho
      var z = qnorm(pbar), lat = Math.min(0.5, rhoOut * 1.6);
      return {
        rho: lat, rhoOutcome: rhoOut, pbar: pbar, rounds: m,
        note: 'latent rho approximated from outcome correlation; ' +
              'validate by back-testing joint() against realised all-win rates'
      };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
