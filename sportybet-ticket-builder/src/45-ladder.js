/* Void-aware selections. THE error that cost the previous build a factor of 2.6.
 *
 * A whole-number total ("Under 4") VOIDS at odds 1.00 when the total lands
 * exactly on the line. The feed's `probability` field is CONDITIONAL on no
 * void: published p = P(win) / (P(win) + P(lose)). Treating it as P(win)
 * overstates every whole-number leg.
 *
 * Recover the true numbers from the ladder of lines on the same market:
 *   pWin(Under L)  = P(Under L-0.5)      <- the half-line below
 *   pPush(Under L) = P(Under L+0.5) - P(Under L-0.5)
 *
 * Note what falls out: "Under L-0.5" has the IDENTICAL win condition as
 * "Under L" at (1/(1-pPush)) times the odds. So the half-line below is
 * normally the better buy outright -- see dominance() and ANALYSIS.md. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  SB.ladder = {
    /** Pure two-way total/handicap markets only. A combined market
     *  ("Under 2.5 & Yes") would pollute the ladder with nonsense. */
    isPureTwoWay: function (rowsForMarket) {
      if (rowsForMarket.length !== 2) return false;
      var s = rowsForMarket[0].p + rowsForMarket[1].p;
      if (!(s > 0.995 && s < 1.005)) return false;
      for (var i = 0; i < 2; i++) {
        if (/&|\band\b|&amp;/i.test(rowsForMarket[i].pick)) return false;
      }
      return true;
    },

    /** Parse the line number out of a selection. Returns null if not a line bet. */
    lineOf: function (row) {
      var src = String(row.specifier || '') + ' ' + String(row.pick || '');
      var m = src.match(/(?:total|hcp|handicap)\s*=\s*(-?\d+(?:\.\d+)?)/i);
      if (m) return parseFloat(m[1]);
      m = String(row.pick || '').match(/(?:over|under)\s*(-?\d+(?:\.\d+)?)/i);
      if (m) return parseFloat(m[1]);
      return null;
    },

    side: function (row) {
      if (/^\s*under\b/i.test(row.pick)) return 'under';
      if (/^\s*over\b/i.test(row.pick)) return 'over';
      return null;
    },

    isWhole: function (line) { return line != null && Math.abs(line - Math.round(line)) < 1e-9; },

    /** Group rows into ladders keyed by event + market root, keeping only pure
     *  two-way markets, then attach pWin / pPush to every selection. */
    annotate: function (rows) {
      // index by event+market+specifier so we can test two-way purity
      var byMarket = {};
      rows.forEach(function (r) {
        var k = r.eventId + '|' + r.marketId + '|' + (r.specifier || '');
        (byMarket[k] = byMarket[k] || []).push(r);
      });
      // ladder: event + marketId + side -> {line: p}
      var ladders = {};
      Object.keys(byMarket).forEach(function (k) {
        var grp = byMarket[k];
        if (!SB.ladder.isPureTwoWay(grp)) return;
        grp.forEach(function (r) {
          var line = SB.ladder.lineOf(r), side = SB.ladder.side(r);
          if (line == null || !side) return;
          var lk = r.eventId + '|' + r.marketId + '|' + side;
          (ladders[lk] = ladders[lk] || {})[line] = r.p;
        });
      });

      var stats = { whole: 0, recovered: 0, unrecoverable: 0, plain: 0 };
      var out = rows.map(function (r) {
        var line = SB.ladder.lineOf(r), side = SB.ladder.side(r);
        var o = Object.assign({}, r);
        if (line == null || !side || !SB.ladder.isWhole(line)) {
          o.pWin = r.p; o.pPush = 0; o.voidable = false; stats.plain++;
          return o;
        }
        stats.whole++;
        var lad = ladders[r.eventId + '|' + r.marketId + '|' + side] || {};
        // For UNDER L: pWin = P(Under L-0.5); for OVER L: pWin = P(Over L+0.5)
        var below = lad[line - 0.5], above = lad[line + 0.5];
        var pWin = side === 'under' ? below : above;
        var pOther = side === 'under' ? above : below;
        if (pWin != null && pOther != null && pOther > pWin) {
          o.pWin = pWin;
          o.pPush = Math.max(0, pOther - pWin);
          o.voidable = true;
          o.pubP = r.p;
          stats.recovered++;
        } else {
          // Cannot recover the split. Refuse to guess: mark it and let the
          // filter drop it. Guessing here is exactly how the factor of 2.6
          // got into the last build.
          o.pWin = null; o.pPush = null; o.voidable = true; o.unrecoverable = true;
          stats.unrecoverable++;
        }
        return o;
      });
      SB.log('ladder: ' + stats.plain + ' non-voidable, ' + stats.whole +
             ' whole-number (' + stats.recovered + ' recovered, ' +
             stats.unrecoverable + ' unrecoverable -> drop)');
      return out;
    },

    /** For each voidable selection, is the half-line below strictly better for
     *  a fixed-target accumulator? Returns the substitution map. */
    dominance: function (annotated) {
      var byKey = {};
      annotated.forEach(function (r) {
        var line = SB.ladder.lineOf(r), side = SB.ladder.side(r);
        if (line == null || !side) return;
        byKey[r.eventId + '|' + r.marketId + '|' + side + '|' + line] = r;
      });
      var subs = [];
      annotated.forEach(function (r) {
        if (!r.voidable || r.unrecoverable) return;
        var line = SB.ladder.lineOf(r), side = SB.ladder.side(r);
        var altLine = side === 'under' ? line - 0.5 : line + 0.5;
        var alt = byKey[r.eventId + '|' + r.marketId + '|' + side + '|' + altLine];
        if (!alt) return;
        // same win condition; compare odds per unit of win probability
        subs.push({
          from: r.pick, to: alt.pick, match: r.home + ' v ' + r.away,
          oddsWhole: r.odds, oddsHalf: alt.odds,
          oddsGain: alt.odds / r.odds,
          pWinSame: Math.abs((alt.pWin || alt.p) - r.pWin) < 0.02,
          replacement: alt
        });
      });
      return subs;
    },

    /** Swap every whole-number line for its half-line equivalent where the
     *  half-line genuinely pays more odds for the same win condition. */
    preferHalfLines: function (annotated) {
      var subs = this.dominance(annotated), map = {};
      var applied = 0;
      subs.forEach(function (s) {
        if (s.oddsGain > 1.01 && s.pWinSame) {
          map[s.replacement.eventId + '|' + s.replacement.outcomeId] = 1;
          applied++;
        }
      });
      SB.log('half-line substitution: ' + applied + ' of ' + subs.length +
             ' whole-number legs have a strictly better half-line alternative');
      return { substitutions: subs, applied: applied };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
