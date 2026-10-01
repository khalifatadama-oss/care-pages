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
