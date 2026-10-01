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
