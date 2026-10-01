/* Driver. Run the numbered steps in order from the console on sportybet.com/ng. */
;(function (root) {
  'use strict';
  var SB = root.SB;
  SB.TARGETS = { T1: 2e6, T2: 5e6, T3: 10e6, T4: 50e6, T5: 200e6 };

  SB.run = {
    /** 1. Verify the schema and the margin-free claim before harvesting. */
    step1_inspect: function (sportId) { return SB.harvest.inspect(sportId || 1); },

    /** 2. Harvest. Call in batches so no single eval times out. */
    step2_harvest: function (ids) { return SB.harvest.sports(ids); },

    /** 3. Read the payout rules, then run the manual slip checks in README §4. */
    step3_rules: function () { return SB.rules.fetchPlans().then(function () { return SB.rules.audit(); }); },

    /** 4. Build the candidate list and export the research worklist. */
    step4_candidates: function (opts) {
      var rows = SB.harvest.merged();
      var cand = SB.filters.apply(rows, opts);
      SB.store.set('candidates', cand);
      return cand;
    },

    /** 5. Optimise all five targets. */
    step5_optimise: function (cfg) {
      var cand = SB.filters.applyResearch(SB.store.get('candidates', []));
      if (!cand.length) throw new Error('no candidates — run step4 first');
      var out = {};
      Object.keys(SB.TARGETS).forEach(function (k) {
        out[k] = SB.optimize.target(cand, SB.TARGETS[k], cfg);
        SB.log(k, out[k] ? ('n=' + out[k].n + ' P=' + out[k].pIndep.toExponential(3)
          + ' payout=' + Math.round(out[k].payout.payout)) : 'INFEASIBLE');
      });
      SB.store.set('solutions', out);
      return out;
    },

    /** 6. Print the handover, and save it. */
    step6_report: function (cfg) {
      var sols = SB.store.get('solutions', {});
      var txt = SB.report.full(sols, cfg);
      console.log(txt);
      SB.store.set('report', txt);
      return txt;
    },

    /** 7. Load one ticket onto the real slip and read back what the site says. */
    step7_slip: function (key) {
      var sols = SB.store.get('solutions', {});
      if (!sols[key]) throw new Error('no solution for ' + key);
      SB.slip.write(sols[key].legs);
    }
  };

  SB.log('loaded. Start with: SB.run.step1_inspect()');
  SB.log('store keys:', SB.store.keys().join(', ') || '(empty)');
})(typeof window !== 'undefined' ? window : globalThis);
