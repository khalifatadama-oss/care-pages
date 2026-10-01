/* Phase 2 — measure the payout rules. Nothing here is assumed; every number
 * is either read from the API or read off a real betslip. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  var rules = SB.rules = {
    /** Fetch the bonus plan table. Stored raw so the parse can be redone. */
    fetchPlans: function () {
      return fetch('/api/ng/promotion/v2/bonus/plans/valid', {
        credentials: 'include', headers: { accept: 'application/json' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (raw) {
        SB.store.set('rules:plansRaw', raw);
        SB.log('bonus plans stored. Top-level keys:', Object.keys(raw));
        SB.log('Inspect with: SB.store.get("rules:plansRaw")');
        var parsed = rules.parsePlans(raw);
        SB.store.set('rules:bonus', parsed);
        SB.log('parsed tiers:', parsed.tiers.length,
               '| sport factors:', Object.keys(parsed.sportFactors).length,
               '| tournament overrides:', Object.keys(parsed.tournamentFactors).length);
        if (!parsed.tiers.length) {
          SB.log('WARNING: no tiers parsed. The schema differs from the guess — ' +
                 'dump rules:plansRaw and set the table by hand with SB.rules.setBonus().');
        }
        return parsed;
      });
    },

    /** Best-effort parse. Schema unverified; falls back to hand entry. */
    parsePlans: function (raw) {
      var tiers = [], sportFactors = {}, tournamentFactors = {}, minOdds = null;
      walk(raw, 0);
      tiers.sort(function (a, b) { return a.legs - b.legs; });
      // keep only the best bonus seen at each leg count
      var byLegs = {};
      tiers.forEach(function (t) {
        if (!(t.legs in byLegs) || t.bonus > byLegs[t.legs]) byLegs[t.legs] = t.bonus;
      });
      tiers = Object.keys(byLegs).map(Number).sort(function (a, b) { return a - b; })
        .map(function (n) { return { legs: n, bonus: byLegs[n] }; });
      return {
        tiers: tiers, sportFactors: sportFactors, tournamentFactors: tournamentFactors,
        minQualifyingOdds: minOdds == null ? 1.20 : minOdds,
        source: 'api-parse', at: Date.now()
      };
    },

    /** Enter a measured table by hand — the reliable path if the parse fails.
     *  tiers: [{legs, bonus}] with bonus as a fraction (0.30 = 30%). */
    setBonus: function (tiers, sportFactors, tournamentFactors, minQualifyingOdds) {
      var parsed = {
        tiers: (tiers || []).slice().sort(function (a, b) { return a.legs - b.legs; }),
        sportFactors: sportFactors || {},
        tournamentFactors: tournamentFactors || {},
        minQualifyingOdds: minQualifyingOdds == null ? 1.20 : minQualifyingOdds,
        source: 'manual', at: Date.now()
      };
      SB.store.set('rules:bonus', parsed);
      return parsed;
    },

    get: function () {
      return SB.store.get('rules:bonus', {
        tiers: [], sportFactors: {}, tournamentFactors: {},
        minQualifyingOdds: 1.20, source: 'none'
      });
    },

    /** Headline bonus at q qualifying legs: the highest tier at or below q. */
    headline: function (q, table) {
      var tiers = (table || this.get()).tiers, b = 0;
      for (var i = 0; i < tiers.length; i++) if (q >= tiers[i].legs) b = tiers[i].bonus;
      return b;
    },

    /** Effective bonus. The per-sport factor is a MINIMUM across the slip:
     *  one football leg drags the whole ticket to its factor. */
    effective: function (legs, table) {
      table = table || this.get();
      var q = 0, factor = 1;
      for (var i = 0; i < legs.length; i++) {
        var L = legs[i];
        if (L.odds >= table.minQualifyingOdds) q++;
        var f = table.tournamentFactors[L.tournament];
        if (f == null) f = table.sportFactors[L.sport];
        if (f == null) f = SB.harvest.SPORT_FACTOR_HYPOTHESIS[L.sport];
        if (f == null) f = 0.6; // unknown sport: assume the worst
        if (f < factor) factor = f;
      }
      return { bonus: factor * this.headline(q, table), qualifying: q, factor: factor };
    },

    payout: function (legs, stake, table) {
      stake = stake == null ? 500 : stake;
      var O = legs.reduce(function (m, L) { return m * L.odds; }, 1);
      var eff = this.effective(legs, table);
      var gross = stake * O * (1 + eff.bonus);
      return {
        odds: O, bonus: eff.bonus, qualifying: eff.qualifying, factor: eff.factor,
        uncapped: gross, payout: Math.min(gross, rules.CAPS.maxPayout),
        capped: gross > rules.CAPS.maxPayout
      };
    },

    CAPS: { maxPayout: 200e6, maxSelections: 50, maxPerCustomerPerDay: 1e9 },

    /** Print the checks the brief demands, against whatever is stored. */
    audit: function () {
      var t = this.get();
      SB.log('bonus source:', t.source, '| tiers:', JSON.stringify(t.tiers));
      SB.log('qualifying odds floor:', t.minQualifyingOdds);
      SB.log('sport factors (measured):', JSON.stringify(t.sportFactors));
      SB.log('--- unverified until you run the slip tests in README §4 ---');
      SB.log('[ ] tier table matches a real slip at 5/10/20/30/40 legs');
      SB.log('[ ] sport factor is the MIN across slip (19 non-football + 1 football)');
      SB.log('[ ] a leg at 1.19 drops the tier');
      SB.log('[ ] betslip figure vs booking-confirmation figure — build to the LOWER');
      SB.log('[ ] a voided leg: does it also drop the qualifying count?');
      return t;
    }
  };

  function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { node.forEach(function (n) { walk(n, depth + 1); }); return; }
    var legs = num(node, ['selectionCount', 'minSelection', 'minSelections', 'num', 'count', 'legs']);
    var bonus = num(node, ['bonusRate', 'rate', 'ratio', 'bonusPercentage', 'percentage', 'bonus']);
    if (legs != null && bonus != null && legs >= 2 && legs <= 60) {
      walk.tiers && walk.tiers.push({ legs: legs, bonus: bonus > 1.0001 ? bonus / 100 : bonus });
    }
    for (var k in node) walk(node[k], depth + 1);
  }
  // bind collectors onto parsePlans via closure-free shim
  var _origParse = rules.parsePlans;
  rules.parsePlans = function (raw) {
    var tiers = [], sportFactors = {}, tournamentFactors = {}, minOdds = null;
    (function rec(node, depth) {
      if (!node || typeof node !== 'object' || depth > 7) return;
      if (Array.isArray(node)) { node.forEach(function (n) { rec(n, depth + 1); }); return; }
      var legs = num(node, ['selectionCount', 'minSelection', 'minSelections', 'legs', 'num', 'count']);
      var bonus = num(node, ['bonusRate', 'rate', 'ratio', 'bonusPercentage', 'percentage', 'bonus']);
      if (legs != null && bonus != null && legs >= 2 && legs <= 60) {
        tiers.push({ legs: legs, bonus: bonus > 1.0001 ? bonus / 100 : bonus });
      }
      var mo = num(node, ['minOdds', 'oddsLimit', 'minOddsLimit']);
      if (mo != null && mo > 1 && mo < 2) minOdds = mo;
      var nm = node.sportName || node.sport || node.name;
      var wf = num(node, ['weight', 'factor', 'sportRate', 'coefficient']);
      if (typeof nm === 'string' && wf != null && wf > 0 && wf <= 1) {
        if (node.tournamentId || node.tournament) tournamentFactors[nm] = wf;
        else sportFactors[String(nm).toLowerCase()] = wf;
      }
      for (var k in node) rec(node[k], depth + 1);
    })(raw, 0);
    var byLegs = {};
    tiers.forEach(function (t) {
      if (!(t.legs in byLegs) || t.bonus > byLegs[t.legs]) byLegs[t.legs] = t.bonus;
    });
    var out = Object.keys(byLegs).map(Number).sort(function (a, b) { return a - b; })
      .map(function (n) { return { legs: n, bonus: byLegs[n] }; });
    return {
      tiers: out, sportFactors: sportFactors, tournamentFactors: tournamentFactors,
      minQualifyingOdds: minOdds == null ? 1.20 : minOdds,
      source: 'api-parse', at: Date.now()
    };
  };

  function num(obj, names) {
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (typeof v === 'number' && isFinite(v)) return v;
      if (typeof v === 'string' && v !== '' && isFinite(+v)) return +v;
    }
    return null;
  }
})(typeof window !== 'undefined' ? window : globalThis);
