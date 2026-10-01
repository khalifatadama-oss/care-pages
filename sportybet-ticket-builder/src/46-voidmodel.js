/* P(payout >= target) over the full void distribution.
 *
 * payout = S * (prod of surviving odds) * (1 + bonus). A void removes that
 * leg's odds, so the ticket survives with a smaller payout. The ticket clears
 * the target iff   prod(odds of voided legs) <= S * O_all * (1+bonus) / T.
 * In logs that is a knapsack constraint, so this is a DP over cumulative
 * voided log-odds -- exact for any leg count, unlike 2^k enumeration.
 *
 * A second dimension tracks the NUMBER of voids, because a void may also drop
 * the qualifying-selection count and with it the bonus tier. That interaction
 * is unmeasured on the live site; `voidDropsQualifying` switches it on. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  SB.voidmodel = {
    /** legs: [{pWin, pPush, odds}] (pPush 0 for non-voidable).
     *  bonusOf(qualifyingCount) -> bonus fraction. */
    pAtLeastTarget: function (legs, target, stake, opts) {
      opts = opts || {};
      stake = stake == null ? 500 : stake;
      var table = SB.rules.get();
      var dropsQual = !!opts.voidDropsQualifying;
      var cap = opts.maxPayout == null ? SB.rules.CAPS.maxPayout : opts.maxPayout;

      var eff = SB.rules.effective(legs, table);
      var factor = eff.factor;
      var qualAll = eff.qualifying;
      var bonusOf = opts.bonusOf || function (q) {
        return factor * SB.rules.headline(q, table);
      };

      var logO = 0, voidable = [];
      for (var i = 0; i < legs.length; i++) {
        logO += Math.log(legs[i].odds);
        if (legs[i].pPush > 0) voidable.push(i);
      }
      var k = voidable.length;

      // Largest voided log-odds still clearing the target, per void count.
      // EPS guards the equality boundary: a ticket built to pay exactly the
      // target must not be rejected by floating-point noise.
      var EPS = 1 + 1e-9;
      function slackLog(nVoid) {
        var q = dropsQual ? Math.max(0, qualAll - nVoid) : qualAll;
        var gross = stake * Math.exp(logO) * (1 + bonusOf(q));
        if (Math.min(gross, cap) * EPS < target) return -Infinity;
        return Math.log(stake) + logO + Math.log(1 + bonusOf(q))
               - Math.log(target) + Math.log(EPS);
      }

      // bin width in log space; round costs UP so the result never overstates P
      var h = opts.binWidth || 1e-3;
      var maxSlack = -Infinity;
      for (var nv = 0; nv <= k; nv++) maxSlack = Math.max(maxSlack, slackLog(nv));
      if (!(maxSlack > -Infinity)) return { p: 0, byVoids: [], exact: false };
      var maxBin = Math.ceil(maxSlack / h) + 1;

      // dp[nVoid][bin] = probability mass
      var dp = [];
      for (var a = 0; a <= k; a++) dp.push(new Float64Array(maxBin + 1));
      dp[0][0] = 1;

      for (var li = 0; li < legs.length; li++) {
        var L = legs[li];
        var pw = L.pWin, pp = L.pPush > 0 ? L.pPush : 0;
        var c = pp > 0 ? Math.ceil(Math.log(L.odds) / h) : 0;
        var next = [];
        for (var a2 = 0; a2 <= k; a2++) next.push(new Float64Array(maxBin + 1));
        for (var nv2 = 0; nv2 <= k; nv2++) {
          var row = dp[nv2];
          for (var b = 0; b <= maxBin; b++) {
            var m = row[b];
            if (m === 0) continue;
            next[nv2][b] += m * pw;                       // leg wins
            if (pp > 0 && nv2 + 1 <= k && b + c <= maxBin) {
              next[nv2 + 1][b + c] += m * pp;             // leg voids
            }
            // leg loses -> mass dropped (ticket dead)
          }
        }
        dp = next;
      }

      var total = 0, byVoids = [];
      for (var nv3 = 0; nv3 <= k; nv3++) {
        var s = slackLog(nv3);
        var lim = s > -Infinity ? Math.floor(s / h) : -1;
        var sub = 0;
        for (var b2 = 0; b2 <= Math.min(lim, maxBin); b2++) sub += dp[nv3][b2];
        if (sub > 0) byVoids.push({ voids: nv3, p: sub });
        total += sub;
      }
      return { p: total, byVoids: byVoids, voidableLegs: k, exact: false,
               note: 'binned DP, costs rounded up -> conservative' };
    },

    /** Brute-force reference for validating the DP. Only for small k. */
    bruteForce: function (legs, target, stake, opts) {
      opts = opts || {};
      stake = stake == null ? 500 : stake;
      var table = SB.rules.get();
      var dropsQual = !!opts.voidDropsQualifying;
      var cap = opts.maxPayout == null ? SB.rules.CAPS.maxPayout : opts.maxPayout;
      var eff = SB.rules.effective(legs, table), factor = eff.factor, qualAll = eff.qualifying;
      var bonusOf = opts.bonusOf || function (q) { return factor * SB.rules.headline(q, table); };
      var vi = [];
      legs.forEach(function (L, i) { if (L.pPush > 0) vi.push(i); });
      if (vi.length > 22) throw new Error('too many voidable legs for brute force');
      var total = 0;
      for (var mask = 0; mask < (1 << vi.length); mask++) {
        var O = 1, pr = 1, nv = 0;
        var isVoid = {};
        for (var j = 0; j < vi.length; j++) if (mask & (1 << j)) { isVoid[vi[j]] = 1; nv++; }
        for (var i2 = 0; i2 < legs.length; i2++) {
          if (isVoid[i2]) { pr *= legs[i2].pPush; }
          else { pr *= legs[i2].pWin; O *= legs[i2].odds; }
        }
        var q = dropsQual ? Math.max(0, qualAll - nv) : qualAll;
        var pay = Math.min(stake * O * (1 + bonusOf(q)), cap);
        if (pay * (1 + 1e-9) >= target) total += pr;
      }
      return { p: total, exact: true };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
