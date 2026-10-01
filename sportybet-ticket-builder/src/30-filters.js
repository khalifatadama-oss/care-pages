/* Phase 3 gatekeeping — exclusions, and the research veto channel. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  var BANNED = [
    /\bamateur\b/i, /\byouth\b/i, /\bu-?(15|16|17|18|19|20|21|22|23)\b/i,
    /\breserve/i, /\bwomen|\bwomens|\bfemale|\bladies\b/i, /\bgirls\b/i,
    /simulated/i, /\bvirtual/i, /\besports?\b/i, /\bfifa\b.*\bcup\b.*\bsim/i,
    /\bfriendl/i, /\btrial\b/i, /\bacademy\b/i, /\bb-?team\b/i, /\bII\b$/
  ];

  SB.filters = {
    BANNED: BANNED,
    DEFAULTS: {
      minOdds: 1.20,      // below this a leg does not qualify for the bonus
      maxOdds: 1.70,
      minLeadMinutes: 90, // must be loadable before kick-off
      minValue: 0.90,
      oneLegPerEvent: true
    },

    apply: function (rows, opts) {
      var o = Object.assign({}, this.DEFAULTS, opts || {});
      var now = Date.now(), vetoes = SB.store.get('research:veto', {});
      var dropped = { odds: 0, banned: 0, soon: 0, value: 0, veto: 0, dup: 0 };

      var kept = rows.filter(function (r) {
        if (!(r.odds >= o.minOdds && r.odds <= o.maxOdds)) { dropped.odds++; return false; }
        if (r.value < o.minValue) { dropped.value++; return false; }
        if (r.start && r.start - now < o.minLeadMinutes * 60000) { dropped.soon++; return false; }
        var text = [r.tournament, r.category, r.home, r.away].join(' ');
        for (var i = 0; i < BANNED.length; i++) {
          if (BANNED[i].test(text)) { dropped.banned++; return false; }
        }
        var v = vetoes[r.eventId + '|' + r.outcomeId] || vetoes[r.eventId];
        if (v && (v.verdict === 'avoid' || v.killed || v.unconfirmed)) { dropped.veto++; return false; }
        return true;
      });

      // One leg per event: legs in the same match are strongly dependent and
      // SportyBet will not accept most same-event combinations in a multiple.
      if (o.oneLegPerEvent) {
        var best = {};
        kept.forEach(function (r) {
          var k = r.eventId;
          if (!best[k] || r.value > best[k].value) best[k] = r;
        });
        var n = kept.length;
        kept = Object.keys(best).map(function (k) { return best[k]; });
        dropped.dup = n - kept.length;
      }

      kept.sort(function (a, b) { return b.value - a.value; });
      SB.log('filtered', rows.length, '→', kept.length, '| dropped:', JSON.stringify(dropped));
      return kept;
    },

    /** Apply the Phase-4 rule: research may only ever LOWER a probability. */
    applyResearch: function (rows, weight) {
      weight = weight == null ? 0.35 : weight;
      var res = SB.store.get('research:prob', {});
      return rows.map(function (r) {
        var rec = res[r.eventId + '|' + r.outcomeId] || res[r.eventId];
        var pUsed = r.p;
        if (rec && typeof rec.p === 'number' && rec.p > 0 && rec.p < 1) {
          var blend = (1 - weight) * r.p + weight * rec.p;
          pUsed = Math.min(r.p, blend);   // veto and penalty only, never optimism
        }
        return Object.assign({}, r, { pSporty: r.p, pUsed: pUsed, p: pUsed });
      });
    },

    /** Export the research worklist for the Stage A / Stage B agents. */
    exportCandidates: function (rows, n) {
      var top = rows.slice(0, n || 300).map(function (r, i) {
        return {
          rank: i + 1, key: r.eventId + '|' + r.outcomeId,
          sport: r.sport, tournament: r.tournament,
          match: r.home + ' v ' + r.away,
          kickoffWAT: SB.report.wat(r.start),
          market: r.marketDesc, pick: r.pick,
          odds: r.odds, pSportybet: +r.p.toFixed(4), value: +r.value.toFixed(4)
        };
      });
      SB.store.set('research:worklist', top);
      SB.store.download(top, 'sbtb-research-worklist.json');
      return top;
    },

    /** Ingest research results. Only `avoid`/`killed`/`unconfirmed` and lower
     *  probabilities can have any effect — see Phase 4. */
    importResearch: function (records) {
      var veto = SB.store.get('research:veto', {}), prob = SB.store.get('research:prob', {});
      records.forEach(function (r) {
        if (r.verdict === 'avoid' || r.killed || r.unconfirmed) veto[r.key] = r;
        if (typeof r.p === 'number') prob[r.key] = { p: r.p, confidence: r.confidence };
      });
      SB.store.set('research:veto', veto); SB.store.set('research:prob', prob);
      SB.log('research: ' + Object.keys(veto).length + ' vetoed, '
             + Object.keys(prob).length + ' with probabilities');
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
