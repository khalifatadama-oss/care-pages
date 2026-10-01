/* Phase 1 — pull the full upcoming-events feed and expose the hidden
 * `probability` field. Runs inside the page (the API 403s server-side).
 *
 * IMPORTANT: the response schema below is NOT verified against the live API.
 * Run SB.harvest.inspect() first; it prints the real shape and tells you
 * which field names to patch in SB.harvest.FIELDS. */
;(function (root) {
  'use strict';
  var SB = root.SB;

  var SPORTS = {
    1: 'football', 2: 'basketball', 3: 'baseball', 4: 'ice hockey', 5: 'tennis',
    6: 'handball', 10: 'boxing', 12: 'rugby', 16: 'american football',
    19: 'snooker', 20: 'table tennis', 21: 'cricket', 22: 'darts',
    23: 'volleyball', 31: 'badminton', 117: 'mma'
  };

  // Bonus weighting per the task brief. VERIFY with SB.rules.probeSportFactors();
  // these are the starting hypothesis, not measured truth.
  var SPORT_FACTOR_HYPOTHESIS = {
    football: 0.6,
    basketball: 1.0, tennis: 1.0, 'ice hockey': 1.0, rugby: 1.0,
    cricket: 1.0, 'table tennis': 1.0,
    baseball: 0.75, mma: 0.75, darts: 0.75, handball: 0.75,
    volleyball: 0.75, badminton: 0.75, boxing: 0.75, snooker: 0.75,
    'american football': 0.75
  };

  var harvest = SB.harvest = {
    SPORTS: SPORTS,
    SPORT_FACTOR_HYPOTHESIS: SPORT_FACTOR_HYPOTHESIS,

    // Markets to request. 1 = 1X2, 18 = Over/Under, 10 = double chance.
    MARKETS: '1,18,10',

    FIELDS: {
      events:    ['events'],
      eventId:   ['eventId', 'id'],
      startTime: ['estimateStartTime', 'startTime'],
      home:      ['homeTeamName'],
      away:      ['awayTeamName'],
      markets:   ['markets'],
      outcomes:  ['outcomes'],
      odds:      ['odds'],
      prob:      ['probability']
    },

    url: function (sportId, pageNum) {
      return '/api/ng/factsCenter/pcUpcomingEvents'
        + '?sportId=' + encodeURIComponent('sr:sport:' + sportId)
        + '&marketId=' + encodeURIComponent(this.MARKETS)
        + '&pageSize=100&pageNum=' + pageNum + '&option=1';
    },

    fetchPage: function (sportId, pageNum) {
      return fetch(this.url(sportId, pageNum), {
        credentials: 'include',
        headers: { 'accept': 'application/json' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' on sport ' + sportId + ' page ' + pageNum);
        return r.json();
      });
    },

    /** Print the raw shape of one event so field names can be confirmed. */
    inspect: function (sportId) {
      sportId = sportId || 1;
      return this.fetchPage(sportId, 1).then(function (raw) {
        SB.log('top-level keys:', Object.keys(raw));
        var tours = harvest._tournaments(raw);
        SB.log('tournament groups:', tours.length);
        var ev = null;
        for (var i = 0; i < tours.length && !ev; i++) {
          var list = pick(tours[i], harvest.FIELDS.events);
          if (list && list.length) ev = list[0];
        }
        if (!ev) { SB.log('no events found — check FIELDS.events'); return raw; }
        SB.log('event keys:', Object.keys(ev));
        var mk = pick(ev, harvest.FIELDS.markets);
        if (mk && mk.length) {
          SB.log('market keys:', Object.keys(mk[0]));
          var oc = pick(mk[0], harvest.FIELDS.outcomes);
          if (oc && oc.length) {
            SB.log('outcome keys:', Object.keys(oc[0]));
            SB.log('sample outcome:', oc[0]);
          }
          // The claim that matters: do the probabilities sum to 1.0?
          SB.log('--- margin-free check (should sum to ~1.000) ---');
          mk.slice(0, 4).forEach(function (m) {
            var ocs = pick(m, harvest.FIELDS.outcomes) || [];
            var sum = ocs.reduce(function (s, o) {
              return s + (parseFloat(pick(o, harvest.FIELDS.prob)) || 0); }, 0);
            var payout = ocs.reduce(function (s, o) {
              var od = parseFloat(pick(o, harvest.FIELDS.odds));
              return s + (od ? 1 / od : 0); }, 0);
            SB.log('  market', m.id, m.desc || '', '| sum(p) =', sum.toFixed(4),
                   '| sum(1/odds) =', payout.toFixed(4),
                   '| margin =', ((payout - 1) * 100).toFixed(2) + '%');
          });
        }
        return raw;
      });
    },

    _tournaments: function (raw) {
      var d = raw && raw.data;
      if (!d) return [];
      if (Array.isArray(d)) return d;
      if (Array.isArray(d.tournaments)) return d.tournaments;
      for (var k in d) if (Array.isArray(d[k])) return d[k];
      return [];
    },

    /** Flatten a raw page into selection rows carrying value = odds * probability. */
    flatten: function (raw, sportId) {
      var F = this.FIELDS, out = [];
      this._tournaments(raw).forEach(function (tour) {
        var tourName = tour.name || (tour.tournament && tour.tournament.name) || '';
        var catName = (tour.category && tour.category.name) || '';
        (pick(tour, F.events) || []).forEach(function (ev) {
          var sportName = (ev.sport && ev.sport.name) || SPORTS[sportId] || String(sportId);
          var evTour = (ev.sport && ev.sport.category && ev.sport.category.tournament
                        && ev.sport.category.tournament.name) || tourName;
          var evCat = (ev.sport && ev.sport.category && ev.sport.category.name) || catName;
          (pick(ev, F.markets) || []).forEach(function (mk) {
            if (mk.status != null && Number(mk.status) !== 0) return; // not open
            (pick(mk, F.outcomes) || []).forEach(function (oc) {
              var odds = parseFloat(pick(oc, F.odds));
              var prob = parseFloat(pick(oc, F.prob));
              if (!(odds > 1) || !(prob > 0)) return;
              if (oc.isActive != null && Number(oc.isActive) !== 1) return;
              out.push({
                sportId: sportId,
                sport: String(sportName).toLowerCase(),
                category: evCat,
                tournament: evTour,
                eventId: pick(ev, F.eventId),
                start: Number(pick(ev, F.startTime)) || 0,
                home: pick(ev, F.home),
                away: pick(ev, F.away),
                marketId: String(mk.id),
                marketDesc: mk.desc || '',
                specifier: mk.specifier || '',
                product: mk.product,
                outcomeId: String(oc.id),
                pick: oc.desc || '',
                odds: odds,
                p: prob,
                value: odds * prob
              });
            });
          });
        });
      });
      return out;
    },

    /** Harvest one sport, all pages. Kept per-sport so no single call can time out. */
    sport: function (sportId, maxPages) {
      maxPages = maxPages || 30;
      var all = [], page = 1;
      function next() {
        if (page > maxPages) return all;
        return harvest.fetchPage(sportId, page).then(function (raw) {
          var rows = harvest.flatten(raw, sportId);
          var events = harvest._tournaments(raw)
            .reduce(function (n, t) { return n + ((pick(t, harvest.FIELDS.events) || []).length); }, 0);
          SB.log('sport', sportId, SPORTS[sportId] || '', 'page', page,
                 '→', events, 'events,', rows.length, 'selections');
          all = all.concat(rows);
          if (events === 0) return all;  // page returned nothing: done
          page++;
          return next();
        }).catch(function (e) {
          SB.log('sport', sportId, 'page', page, 'failed:', e.message, '— stopping this sport');
          return all;
        });
      }
      return Promise.resolve().then(next).then(function (rows) {
        var key = 'feed:' + sportId;
        SB.store.set(key, rows);
        SB.log('stored', rows.length, 'selections →', key);
        return rows;
      });
    },

    /** Harvest several sports in sequence. Call in batches to stay inside eval limits. */
    sports: function (ids, maxPages) {
      ids = ids || Object.keys(SPORTS).map(Number);
      var i = 0, total = 0;
      function step() {
        if (i >= ids.length) { SB.log('batch done,', total, 'selections'); return total; }
        return harvest.sport(ids[i], maxPages).then(function (rows) {
          total += rows.length; i++; return step();
        });
      }
      return Promise.resolve().then(step);
    },

    /** Merge every stored per-sport feed into one candidate table. */
    merged: function () {
      var rows = [];
      SB.store.keys().forEach(function (k) {
        if (k.indexOf('feed:') === 0) rows = rows.concat(SB.store.get(k, []));
      });
      return rows;
    }
  };

  function pick(obj, names) {
    if (!obj) return undefined;
    for (var i = 0; i < names.length; i++) {
      if (obj[names[i]] !== undefined && obj[names[i]] !== null) return obj[names[i]];
    }
    return undefined;
  }
  harvest._pick = pick;
})(typeof window !== 'undefined' ? window : globalThis);
