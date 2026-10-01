/* Phase 8 — the handover. Everything in West Africa Time, with the honest
 * numbers and an explicit list of what was not verified. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  SB.report = {
    /** WAT is UTC+1, no DST. */
    wat: function (ms) {
      if (!ms) return 'unknown';
      var d = new Date(Number(ms) + 3600000);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
        + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' WAT';
    },

    money: function (n) { return '₦' + Math.round(n).toLocaleString('en-NG'); },

    ticket: function (sol, label, cfg) {
      var L = [], stake = (cfg && cfg.stake) || 500;
      var vetoed = sol.legs.filter(function (l) { return l.pSporty && l.pUsed < l.pSporty; }).length;
      var unconfirmed = sol.legs.filter(function (l) { return !l.researched; });
      var pSportyOnly = Math.exp(sol.legs.reduce(function (a, l) {
        return a + Math.log(l.pSporty || l.p); }, 0));

      L.push('=== ' + label + ' — target ' + this.money(sol.target) + ' ===');
      L.push('pool: ' + sol.pool + ' | legs: ' + sol.n
        + ' | qualifying (odds>=' + SB.rules.get().minQualifyingOdds + '): ' + sol.payout.qualifying);
      L.push('total odds: ' + sol.payout.odds.toFixed(2)
        + ' | sport factor (min across slip): ' + sol.payout.factor
        + ' | bonus: ' + (sol.payout.bonus * 100).toFixed(1) + '%');
      L.push('payout on ' + this.money(stake) + ': ' + this.money(sol.payout.payout)
        + (sol.payout.capped ? '  [CAPPED at ₦200,000,000 — uncapped '
            + this.money(sol.payout.uncapped) + ']' : ''));
      L.push('');
      L.push('P(hits target), independent legs, research-veto basis : '
        + sol.pIndep.toExponential(3) + '   (1 in ' + Math.round(1 / sol.pIndep).toLocaleString() + ')');
      L.push('P(...), SportyBet probabilities only [OPTIMISTIC BOUND]   : '
        + pSportyOnly.toExponential(3) + '   (1 in ' + Math.round(1 / pSportyOnly).toLocaleString() + ')');
      if (sol.correlated) {
        L.push('P(...), correlation-adjusted (rho_within=' + sol.correlated.rhoWithin
          + ', rho_global=' + sol.correlated.rhoGlobal + ', ' + sol.correlated.groups + ' groups): '
          + sol.correlated.p.toExponential(3) + '   (1 in '
          + Math.round(1 / sol.correlated.p).toLocaleString() + ')   lift '
          + sol.correlated.lift.toFixed(1) + 'x');
      }
      L.push('return on stake (EV/stake) = ' + (sol.pIndep * sol.payout.uncapped / stake).toFixed(3)
        + '   (1.000 would be break-even)');
      L.push('');
      L.push('legs (' + vetoed + ' probability-penalised by research, '
        + unconfirmed.length + ' NOT research-confirmed):');
      sol.legs.slice().sort(function (a, b) { return a.start - b.start; })
        .forEach(function (l, i) {
          L.push('  ' + String(i + 1).padStart(2) + '. ' + SB.report.wat(l.start)
            + ' | ' + l.sport + ' | ' + (l.tournament || '?')
            + '\n      ' + l.home + ' v ' + l.away
            + '\n      ' + (l.marketDesc || l.marketId) + ' → ' + l.pick
            + '  @ ' + l.odds.toFixed(2)
            + '  (p=' + (l.p).toFixed(4) + ', value=' + (l.value).toFixed(3) + ')'
            + (l.researched ? '' : '  [UNCONFIRMED]'));
        });
      var soonest = Math.min.apply(null, sol.legs.map(function (l) { return l.start; }));
      L.push('');
      L.push('earliest kick-off: ' + this.wat(soonest)
        + ' — place by ' + this.wat(soonest - 3600000) + ' at the latest.');
      return L.join('\n');
    },

    full: function (solutions, cfg) {
      var out = ['SPORTYBET TICKETS — generated ' + this.wat(Date.now()),
        'stake per ticket: ' + this.money((cfg && cfg.stake) || 500), ''];
      Object.keys(solutions).forEach(function (k) {
        if (solutions[k]) out.push(SB.report.ticket(solutions[k], k, cfg), '');
      });
      out.push('--- NOT VERIFIED ---');
      out.push('bonus table source: ' + SB.rules.get().source);
      out.push('Confirm on a real slip before trusting any payout above.');
      return out.join('\n');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
