/* SportyBet ticket builder — paste into the DevTools console on
 * https://www.sportybet.com/ng/ (must be run from Nigeria). */

/* ---- src/00-store.js ---- */
/* SportyBet ticket builder — persistent store.
 * Phase-1 harvests are large and page navigation destroys window state,
 * so everything lands in localStorage under one namespace. */
;(function (root) {
  'use strict';
  var SB = root.SB = root.SB || {};
  var NS = 'sbtb:';

  var store = SB.store = {
    _chunkSize: 400000, // localStorage entries choke well before 5MB in one key

    set: function (key, value) {
      var json = JSON.stringify(value);
      this.del(key);
      var parts = Math.ceil(json.length / this._chunkSize) || 1;
      for (var i = 0; i < parts; i++) {
        localStorage.setItem(NS + key + ':' + i,
          json.slice(i * this._chunkSize, (i + 1) * this._chunkSize));
      }
      localStorage.setItem(NS + key + ':meta', JSON.stringify({ parts: parts, at: Date.now() }));
      return value;
    },

    get: function (key, fallback) {
      var meta = localStorage.getItem(NS + key + ':meta');
      if (!meta) return fallback;
      var parts = JSON.parse(meta).parts, json = '';
      for (var i = 0; i < parts; i++) {
        var part = localStorage.getItem(NS + key + ':' + i);
        if (part === null) return fallback; // torn write — treat as absent
        json += part;
      }
      try { return JSON.parse(json); } catch (e) { return fallback; }
    },

    del: function (key) {
      var meta = localStorage.getItem(NS + key + ':meta');
      if (meta) {
        var parts = JSON.parse(meta).parts;
        for (var i = 0; i < parts; i++) localStorage.removeItem(NS + key + ':' + i);
      }
      localStorage.removeItem(NS + key + ':meta');
    },

    keys: function () {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(NS) === 0 && /:meta$/.test(k)) out.push(k.slice(NS.length, -5));
      }
      return out;
    },

    age: function (key) {
      var meta = localStorage.getItem(NS + key + ':meta');
      return meta ? Date.now() - JSON.parse(meta).at : Infinity;
    },

    /** Download anything as a file — the bridge out to the offline optimiser. */
    download: function (key, filename) {
      var data = typeof key === 'string' ? this.get(key) : key;
      var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || (typeof key === 'string' ? key + '.json' : 'sbtb-export.json');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    }
  };

  SB.log = function () {
    var args = ['%c[sbtb]', 'color:#0a0;font-weight:bold'].concat([].slice.call(arguments));
    console.log.apply(console, args);
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- src/10-harvest.js ---- */
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

/* ---- src/20-rules.js ---- */
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

/* ---- src/30-filters.js ---- */
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

/* ---- src/40-probability.js ---- */
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

/* ---- src/45-ladder.js ---- */
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

/* ---- src/46-voidmodel.js ---- */
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

/* ---- src/50-optimize.js ---- */
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

/* ---- src/60-betslip.js ---- */
/* Phase 7 — write the real betslip, then read back what the SITE says.
 *
 * The localStorage schema for `betslips` / `betslipsSelections` is NOT
 * documented and NOT verified here. Rather than guess it, this module LEARNS
 * it: you add one selection by hand, call capture(), and it records the real
 * shape. write() then replicates that shape for your chosen legs. */
;(function (root) {
  'use strict';
  var SB = root.SB;
  var KEYS = ['betslips', 'betslipsSelections'];

  SB.slip = {
    KEYS: KEYS,

    /** Step 1: add ONE selection to the slip by hand on the site, then run this. */
    capture: function () {
      var snap = {};
      KEYS.forEach(function (k) { snap[k] = localStorage.getItem(k); });
      // also grab anything else that looks slip-shaped, so nothing is missed
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/betslip|selection|cart/i.test(k) && KEYS.indexOf(k) < 0) snap[k] = localStorage.getItem(k);
      }
      SB.store.set('slip:template', snap);
      SB.log('captured slip keys:', Object.keys(snap).join(', '));
      Object.keys(snap).forEach(function (k) {
        SB.log('  ' + k + ' =', (snap[k] || '').slice(0, 400));
      });
      SB.log('If one of these holds your selection, the shape is now known. ' +
             'Then: SB.slip.write(legs)');
      return snap;
    },

    /** Replicate the captured shape for `legs`. Reloads so the app rehydrates. */
    write: function (legs, opts) {
      opts = opts || {};
      var tpl = SB.store.get('slip:template');
      if (!tpl) throw new Error('run SB.slip.capture() with one selection on the slip first');

      var wrote = false;
      Object.keys(tpl).forEach(function (k) {
        var raw = tpl[k]; if (!raw) return;
        var parsed; try { parsed = JSON.parse(raw); } catch (e) { return; }
        var arr = findArray(parsed);
        if (!arr || !arr.length) return;
        var proto = arr[0];
        var rebuilt = legs.map(function (L) { return fill(clone(proto), L); });
        replaceArray(parsed, rebuilt);
        localStorage.setItem(k, JSON.stringify(parsed));
        SB.log('wrote', rebuilt.length, 'selections into', k);
        wrote = true;
      });
      if (!wrote) throw new Error('could not locate the selections array in the template');

      SB.store.set('slip:pending', legs.map(function (L) {
        return { eventId: L.eventId, outcomeId: L.outcomeId, odds: L.odds,
                 match: L.home + ' v ' + L.away, pick: L.pick };
      }));
      if (opts.reload !== false) location.reload();
    },

    /** After reload: read the odds/bonus/payout the SITE displays. Trust this,
     *  not the model. Build to whichever of slip vs booking is LOWER. */
    readDisplayed: function () {
      var txt = document.body.innerText;
      function grab(label) {
        var re = new RegExp(label + '[^\\n]*?([\\d,]+(?:\\.\\d+)?)', 'i');
        var m = txt.match(re); return m ? m[1] : null;
      }
      var out = {
        totalOdds: grab('total odds'), bonus: grab('bonus'),
        potentialWin: grab('potential win') || grab('est\\. payout') || grab('payout'),
        selections: grab('selections?')
      };
      SB.log('site says:', JSON.stringify(out));
      SB.log('CHECK: compare this against the booking confirmation after Book Bet. ' +
             'They can differ — build to the LOWER figure.');
      return out;
    },

    /** Confirm a booking code resolves with the right leg count and no dead legs. */
    verifyCode: function (code) {
      return fetch('/api/ng/orders/share/' + encodeURIComponent(code), {
        credentials: 'include', headers: { accept: 'application/json' }
      }).then(function (r) { return r.json(); }).then(function (raw) {
        var legs = [], unavailable = 0;
        (function rec(n, d) {
          if (!n || typeof n !== 'object' || d > 6) return;
          if (Array.isArray(n)) return n.forEach(function (x) { rec(x, d + 1); });
          if (n.outcomeId || n.odds) {
            legs.push(n);
            if (n.available === false || Number(n.status) === 1) unavailable++;
          }
          for (var k in n) rec(n[k], d + 1);
        })(raw, 0);
        SB.log('code', code, '→', legs.length, 'legs,', unavailable, 'unavailable');
        if (unavailable) SB.log('WARNING: dead legs in this code — rebuild it.');
        return { code: code, legs: legs.length, unavailable: unavailable, raw: raw };
      });
    }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function findArray(node, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 5) return null;
    if (Array.isArray(node)) return node.length && typeof node[0] === 'object' ? node : null;
    for (var k in node) { var r = findArray(node[k], depth + 1); if (r) return r; }
    return null;
  }
  function replaceArray(node, repl, depth) {
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 5) return false;
    for (var k in node) {
      if (Array.isArray(node[k]) && node[k].length && typeof node[k][0] === 'object') {
        node[k] = repl; return true;
      }
      if (replaceArray(node[k], repl, depth + 1)) return true;
    }
    return false;
  }
  /** Fill a captured prototype with one leg's identifiers, by field name. */
  function fill(proto, L) {
    (function rec(n, d) {
      if (!n || typeof n !== 'object' || d > 5) return;
      for (var k in n) {
        var lk = k.toLowerCase();
        if (typeof n[k] === 'object') { rec(n[k], d + 1); continue; }
        if (/^(eventid|matchid)$/.test(lk)) n[k] = L.eventId;
        else if (/^outcomeid$/.test(lk)) n[k] = L.outcomeId;
        else if (/^(marketid)$/.test(lk)) n[k] = L.marketId;
        else if (/^(odds|oddsvalue)$/.test(lk)) n[k] = typeof n[k] === 'string' ? String(L.odds) : L.odds;
        else if (/^specifier$/.test(lk)) n[k] = L.specifier || '';
        else if (/^(hometeamname)$/.test(lk)) n[k] = L.home;
        else if (/^(awayteamname)$/.test(lk)) n[k] = L.away;
        else if (/^(outcomedesc|outcomename)$/.test(lk)) n[k] = L.pick;
      }
    })(proto, 0);
    return proto;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- src/70-report.js ---- */
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

/* ---- src/90-main.js ---- */
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
