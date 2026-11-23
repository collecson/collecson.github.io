(function () {
  'use strict';

  /* ---------------- state ---------------- */
  var LS = {
    get: function (k) { try { return localStorage.getItem((window.LS_PREFIX || 'fs_') + k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem((window.LS_PREFIX || 'fs_') + k, v); } catch (e) { /* private mode */ } }
  };
  var S = {
    role: LS.get('role'), boot: null, items: [], thumbs: {}, screen: '', params: {}, history: [],
    pinDigits: '', pinBusy: false, pinError: '', pendingRole: '',
    filters: { q: '', range: '', series: '', status: '', cond: '', posted: '', photos: '', sort: 'newest' }, shown: 60, add: null, camTarget: null,
    kid: LS.get('kidMode') === '1', homeWanted: null
  };
  var PRIV = THEME.privateRole;
  var OWN = esc(PRIV || 'the grown-up');   // the owner's name, as shown to a kid
  function dadUnlocked() {
    if (!THEME.needsPin) return true;
    var tok = LS.get('dadToken'), exp = +LS.get('dadTokenExp') || 0;
    return !!(tok && (!exp || exp > Date.now()));
  }
  var isPriv = function () { return S.role === PRIV && dadUnlocked(); };
  function storeDadToken(token, expires) {
    LS.set('dadToken', token || '');
    LS.set('dadTokenExp', expires ? String(expires) : '');
  }
  function clearDadToken() { storeDadToken('', ''); }

  /* ---------------- theme ---------------- */
  (function applyTheme() {
    var c = THEME.colours, r = document.documentElement.style;
    /* ck-theme v1 */
    var vars = { sky: c.sky, skyL: c.skyLight, yel: c.yellow, pink: c.pink, pinkL: c.pinkLight, ink: c.ink, green: c.green, amber: c.amber, red: c.red, white: c.white,
      bar: c.bar, barInk: c.barInk, barLine: c.barLine, main: c.main, mainInk: c.mainInk, navOn: c.navOn, navOnInk: c.navOnInk, guide: c.guide, guideInk: c.guideInk, skyArt: c.skyArt, tint: c.tint };
    Object.keys(vars).forEach(function (k) { if (vars[k]) r.setProperty('--' + k, vars[k]); else r.removeProperty('--' + k); });
    try { var tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.setAttribute('content', c.chrome || c.yellow || c.sky); } catch (eT) { /* ignore */ }
    document.getElementById('logo').innerHTML = THEME.mascotSvg.replace('id="fsBite"', 'id="fsBiteLogo"').replace('url(#fsBite)', 'url(#fsBiteLogo)');
    document.getElementById('appName').textContent = THEME.appName;
    if (THEME.showClouds) document.getElementById('sky').innerHTML = cloudsSvg();
  })();

  function cloudsSvg() {
    var spots = [[20, 30, 0.9], [520, 10, 1.1], [300, 150, 0.7], [640, 230, 0.9], [60, 330, 1.0], [420, 420, 0.8], [700, 520, 1.1], [120, 600, 0.9], [480, 700, 1.0]];
    var g = spots.map(function (s) {
      return '<g transform="translate(' + s[0] + ' ' + s[1] + ') scale(' + s[2] + ')" fill="#FFFFFF" opacity="0.9"><ellipse cx="40" cy="34" rx="40" ry="22"/><ellipse cx="78" cy="22" rx="34" ry="26"/><ellipse cx="116" cy="34" rx="34" ry="20"/><rect x="18" y="32" width="122" height="24" rx="12"/></g>';
    }).join('');
    return '<svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + g + '</svg>';
  }

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function clTitle(t) { return String(t || '').replace(/ - Full set$/i, '').replace(/^Checklist\s*-\s*/i, ''); }
  function W(k, d) { return (THEME.words && THEME.words[k]) || d; }
  function gbp(n) { return n == null ? '-' : (THEME.currency || '\u00A3') + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pct(a, b) { return b ? Math.round(a * 100 / b) : 0; }
  function norm(s) { return String(s || '').toLowerCase().replace(/[\u2019'`]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim(); }

  /* ================= v4: offline layer (IndexedDB copy of the last data + a queue of changes) ================= */
  function noop() {}
  var IDB = (function () {
    var dbp = null;
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('no idb'));
        var r = indexedDB.open((window.LS_PREFIX || 'ck_') + 'app', 2);
        r.onupgradeneeded = function () {
          var d = r.result, have = d.objectStoreNames;
          if (!have.contains('kv')) d.createObjectStore('kv');
          if (!have.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
          if (!have.contains('thumbs')) d.createObjectStore('thumbs');   // v5: one small JPEG per item
        };
        r.onsuccess = function () { var d = r.result; d.onversionchange = function () { d.close(); }; res(d); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(store, mode), req = fn(t.objectStore(store));
          t.oncomplete = function () { res(req ? req.result : undefined); };
          t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
      set: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
      del: function (k) { return tx('kv', 'readwrite', function (s) { return s.delete(k); }); },
      tSet: function (k, v) { return tx('thumbs', 'readwrite', function (s) { return s.put(v, k); }); },
      tDel: function (k) { return tx('thumbs', 'readwrite', function (s) { return s.delete(k); }); },
      tAll: function () {
        return db().then(function (d) {
          return new Promise(function (res, rej) {
            var out = {}, t = d.transaction('thumbs', 'readonly'), cur = t.objectStore('thumbs').openCursor();
            cur.onsuccess = function () { var c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } };
            t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); };
          });
        });
      },
      qAdd: function (v) { return tx('queue', 'readwrite', function (s) { return s.add(v); }); },
      qAll: function () { return tx('queue', 'readonly', function (s) { return s.getAll(); }); },
      qDel: function (id) { return tx('queue', 'readwrite', function (s) { return s.delete(id); }); },
      keys: function () {
        return db().then(function (d) {
          return new Promise(function (res, rej) {
            var out = [], t = d.transaction('kv', 'readonly'), cur = t.objectStore('kv').openCursor();
            cur.onsuccess = function () { var c = cur.result; if (c) { out.push(c.key); c.continue(); } };
            t.oncomplete = function () { res(out); }; t.onerror = function () { rej(t.error); };
          });
        });
      }
    };
  })();
  var NET = {
    offline: navigator.onLine === false, savedAt: 0, queueLen: 0,
    down: function () { if (!this.offline) { this.offline = true; renderNetBar(); } },
    ok: function () { if (this.offline) { this.offline = false; this.savedAt = 0; renderNetBar(); setTimeout(syncQueue, 300); } }
  };
  function rawCall(fn, args) {
    return new Promise(function (resolve, reject) {
      if (window.FS_API) return window.FS_API(fn, args).then(resolve, reject);
      if (!window.google || !google.script) { var e0 = new Error('offline'); e0.network = true; return reject(e0); }
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn].apply(null, args);
    });
  }
  function isNetErr(e) {
    if (navigator.onLine === false) return true;
    return !!(e && (e.network || (e.name === 'TypeError' && /fetch|network|load failed/i.test(e.message || ''))));
  }
  function offlineErr() { return new Error('\uD83D\uDCF4 No signal right now, and this bit wasn\u2019t saved on the phone yet. It\u2019ll work again as soon as you\u2019re back online.'); }
  var READ_FNS = { getBootstrap: 1, getWanted: 1, getChecklists: 1, getChecklist: 1, getItem: 1, getStats: 1, getAllMissing: 1, getPostedBoard: 1, getDuplicates: 1, getPhotoTodo: 1, getNoValue: 1, getValueSummary: 1, getItemPhotos: 1, getHistory: 1, getRewards: 1, getQueuePhoto: 1 };
  var WRITE_FNS = { saveItem: 1, addItem: 1, markGotIt: 1, setPosted: 1, uploadMedia: 1, saveBarcode: 1, setMainPhoto: 1, requestReward: 1, decideReward: 1, saveRewards: 1, savePointRules: 1, saveJobs: 1, completeJob: 1, decidePhoto: 1, saveFunUnits: 1 };
  function tokenNow() { return S.kid ? '' : (LS.get('dadToken') || ''); }   // Kid mode never sends the PIN token
  function cacheKey(fn, args) { return 'c|' + fn + '|' + JSON.stringify(args) + '|' + (tokenNow() && dadUnlocked() ? 'p' : 'n'); }
  function hasPending(args) { return args.some(function (a) { return typeof a === 'string' && a.indexOf('pending:') === 0; }); }
  function call(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    var full = args.concat([tokenNow()]);
    if (WRITE_FNS[fn]) {
      if (NET.offline && navigator.onLine === false) return queueWrite(fn, args);
      if (hasPending(args)) return queueWrite(fn, args);
      return rawCall(fn, full).then(function (r) { NET.ok(); return r; }, function (e) { if (isNetErr(e)) { NET.down(); return queueWrite(fn, args); } throw e; });
    }
    if (READ_FNS[fn]) {
      var ck = cacheKey(fn, args);
      var fromCache = function () {
        return IDB.get(ck).then(function (hit) {
          if (hit) { NET.savedAt = hit.at; renderNetBar(); return hit.r; }
          var f = offlineFallback(fn, args); if (f !== undefined) return f;
          throw offlineErr();
        }, function () { var f2 = offlineFallback(fn, args); if (f2 !== undefined) return f2; throw offlineErr(); });
      };
      if (navigator.onLine === false) { NET.down(); return fromCache(); }
      return rawCall(fn, full).then(function (r) {
        NET.ok();
        if (fn !== 'getItemPhotos' || (r && r.length)) IDB.set(ck, { at: Date.now(), r: r }).catch(noop);
        return r;
      }, function (e) { if (!isNetErr(e)) throw e; NET.down(); return fromCache(); });
    }
    return rawCall(fn, full).then(function (r) { NET.ok(); return r; }, function (e) { if (isNetErr(e)) { NET.down(); throw offlineErr(); } throw e; });
  }
  function offlineFallback(fn, args) {
    if (fn === 'getItem') {
      var it = itemByKey(args[0]); if (!it) return undefined;
      var o = JSON.parse(JSON.stringify(it));
      o.platforms = (THEME.platforms || []).map(function (p) { return { key: p.key, label: p.label, icon: p.icon, yes: (it.pp || []).indexOf(p.key) >= 0 }; });
      o.offlineCopy = true; return o;
    }
    if (fn === 'getItemPhotos') return [];
    if (fn === 'getWanted') return [];
    return undefined;
  }
  function queueWrite(fn, args) {
    var res = { ok: true, queued: true }, pk = '';
    if (fn === 'addItem' || (fn === 'markGotIt' && args[0] === 'wanted')) {
      pk = 'pending:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      res.key = pk; res.id = ''; res.folderId = ''; res.name = fn === 'addItem' ? args[0].name : args[2];
    }
    if (fn === 'markGotIt' && args[0] !== 'wanted') { res.key = args[0] === 'item' ? args[1] : ''; res.name = args[2]; }
    if (fn === 'saveItem') { res.written = Object.keys(args[2] || {}); res.skipped = []; }
    if (fn === 'uploadMedia') res.fileName = 'the photo (kept on the phone until you\u2019re back online)';
    if (fn === 'saveBarcode') res.barcode = args[2];
    var entry = { fn: fn, args: args, at: Date.now(), pk: pk };
    return IDB.qAdd(entry).then(function () {
      NET.queueLen++; applyQueued(entry); renderNetBar(); return res;
    }, function () { throw offlineErr(); });
  }
  /* Show queued (not yet synced) changes straight away, so the phone looks right offline. */
  function applyQueued(en) {
    var a = en.args, it;
    if (!S.items) return;
    if (en.fn === 'addItem') {
      if (!itemByKey(en.pk)) S.items.unshift({ key: en.pk, id: '', name: a[0].name, range: a[0].range || 'Other', status: a[0].status || 'Owned', condition: a[0].condition || 'Unknown', folderId: '', pp: [], pending: true });
    } else if (en.fn === 'markGotIt' && a[0] === 'wanted') {
      if (!itemByKey(en.pk)) S.items.unshift({ key: en.pk, id: '', name: a[2], range: 'Other', status: 'Owned', condition: 'Unknown', folderId: '', pp: [], pending: true });
    } else if (en.fn === 'markGotIt' && a[0] === 'item') {
      it = itemByKey(a[1]); if (it) it.status = 'Owned';
    } else if (en.fn === 'saveItem') {
      it = itemByKey(a[0]); if (it) Object.keys(a[2] || {}).forEach(function (k) { if (['name', 'range', 'condition', 'packaging', 'status', 'series', 'character', 'maker', 'year'].indexOf(k) >= 0) it[k] = a[2][k]; });
    } else if (en.fn === 'saveBarcode') {
      it = itemByKey(a[0]); if (it) it.bc = String(a[2]);
    }
  }
  var syncing = false;
  function syncQueue() {
    if (syncing || navigator.onLine === false) return Promise.resolve();
    syncing = true;
    var doneN = 0, failed = [];
    return IDB.qAll().then(function (list) {
      NET.queueLen = list.length;
      if (!list.length) return;
      renderNetBar('Syncing ' + list.length + ' change' + (list.length === 1 ? '' : 's') + '\u2026');
      return IDB.get('pendingMap').then(function (pm) {
        pm = pm || {};
        return list.reduce(function (p, en) {
          return p.then(function () {
            var a = en.args.map(function (x) { return typeof x === 'string' && pm[x] ? pm[x] : x; });
            if (hasPending(a)) { failed.push({ fn: en.fn, error: 'the item it belonged to didn\u2019t save' }); return IDB.qDel(en.id); }
            return rawCall(en.fn, a.concat([tokenNow()])).then(function (r) {
              if (en.pk && r && r.key) pm[en.pk] = r.key;
              doneN++; NET.queueLen = Math.max(0, NET.queueLen - 1);
              return IDB.qDel(en.id);
            }, function (e) {
              if (isNetErr(e)) throw e;
              failed.push({ fn: en.fn, name: (en.fn === 'addItem' ? a[0].name : a[1]) || '', error: (e && e.message) || 'error' });
              NET.queueLen = Math.max(0, NET.queueLen - 1);
              return IDB.qDel(en.id);
            });
          });
        }, Promise.resolve()).then(function () { return IDB.set('pendingMap', pm); }, function (e) { IDB.set('pendingMap', pm); throw e; });
      });
    }).then(function () {
      syncing = false; renderNetBar();
      if (doneN || failed.length) {
        S.boot = null;
        if (doneN) toast('\u2705 Back online - ' + doneN + ' change' + (doneN === 1 ? '' : 's') + ' synced to the sheet', 'good');
        if (failed.length) sheet('A couple of things didn\u2019t sync', '<ul>' + failed.map(function (f) { return '<li><b>' + esc(f.name || f.fn) + '</b>: ' + esc(f.error) + '</li>'; }).join('') + '</ul><p class="hint">Nothing was deleted. Try those again now you\u2019re online.</p>');
        if (['home', 'collection', 'kid', 'kidStuff', 'kidHunt', 'wanted'].indexOf(S.screen) >= 0) go(S.screen, S.params, true);
      }
    }, function () { syncing = false; renderNetBar(); });
  }
  function fmtWhen(ms) {
    var d = new Date(ms);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function netBarHtml(msg) {
    if (msg) return '<div id="netBar" class="netBar sync">\u23F3 ' + esc(msg) + '</div>';
    if (NET.offline) return '<div id="netBar" class="netBar off">\uD83D\uDCF4 No signal - showing the copy saved on this phone' + (NET.savedAt ? ' (from ' + esc(fmtWhen(NET.savedAt)) + ')' : '') + '.' +
      (NET.queueLen ? ' <b>' + NET.queueLen + ' change' + (NET.queueLen === 1 ? '' : 's') + '</b> will sync when you\u2019re back online.' : ' You can still look, add and edit - it\u2019ll sync later.') + '</div>';
    if (NET.queueLen) return '<div id="netBar" class="netBar sync">\u23F3 ' + NET.queueLen + ' change' + (NET.queueLen === 1 ? '' : 's') + ' waiting to sync <button class="btn small" data-act="syncNow">Sync now</button></div>';
    return '<div id="netBar" hidden></div>';
  }
  function renderNetBar(msg) {
    var el = $('netBar'); if (!el) return;
    var t = document.createElement('div'); t.innerHTML = netBarHtml(msg);
    el.parentNode.replaceChild(t.firstChild, el);
  }
  window.addEventListener('online', function () { NET.ok(); syncQueue(); });
  window.addEventListener('offline', function () { NET.down(); });


  /* ================= v4: never-show list (extra safety on the phone; the server already hides these) ================= */
  function hz(s) { var x = 0x811c9dc5; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; } return x.toString(36); }
  var HIDE_SETS = [];
  function neverShow(name) {
    var s = String(name || '');
    if (/#\s*194[5-9]\b/.test(s)) return true;
    var toks = norm(s.replace(/&/g, ' and ').replace(/#/g, ' ')).split(' '), hs = {};
    toks.forEach(function (t) { if (t) hs[hz(t)] = 1; });
    if (hs.fqi58g && toks.some(function (t) { return /^194[5-9]$/.test(t); })) return true;
    return HIDE_SETS.some(function (set) { return set.every(function (h) { return hs[h]; }); });
  }
  /* Hidden from kid (same list as the server's HIDE_FROM_SON) */
  var SON_HIDE_RE = /\b(nude|naked|nudie|topless|xxx|adults? only|over 18s)\b/i;
  function sonHidden(name) { return SON_HIDE_RE.test(String(name || '')); }
  /* Kid mode also leaves out anything Christmassy or gift-related, to be safe */
  function kidSafe(it) {
    if (!it || neverShow(it.name) || sonHidden(it.name)) return false;
    var t = [it.name, it.range, it.series].join(' ');
    return !/christmas|xmas|x-mas|secret|gift|present|santa/i.test(t);
  }

  /* ================= v4: fuzzy "Do I own it?" ================= */
  var OWNED_ST = ['Owned', 'On order', 'For sale'];
  function isOwned(it) { return OWNED_ST.indexOf(it.status || 'Owned') >= 0; }
  function fz(s) { return norm(String(s || '').replace(/&/g, ' and ').replace(/#/g, ' ')); }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  function fuzzyScore(q, qt, it) {
    if (!it._fz) { it._fzName = fz(it.name); it._fz = fz([it.name, it.character, it.series, it.range, it.id, it.maker, it.year].join(' ')).split(' ').filter(Boolean); }
    if (it._fzName.indexOf(q) >= 0) return 1;
    var sum = 0;
    for (var i = 0; i < qt.length; i++) {
      var w = qt[i], best = 0;
      for (var k = 0; k < it._fz.length && best < 1; k++) {
        var h = it._fz[k], s = 0;
        if (h === w) s = 1;
        else if (w.length >= 2 && h.indexOf(w) === 0) s = 0.9;
        else if (w.length >= 3 && h.indexOf(w) >= 0) s = 0.75;
        else if (w.length >= 4 && !/^\d+$/.test(w)) { var d = lev(w, h); if (d === 1) s = 0.72; else if (d === 2 && w.length >= 7) s = 0.55; }
        if (s > best) best = s;
      }
      sum += best;
    }
    return qt.length ? sum / qt.length : 0;
  }
  function fuzzyFind(query, list, max) {
    var q = fz(query), qt = q.split(' ').filter(Boolean);
    if (!q) return [];
    return list.map(function (it) { return { it: it, s: fuzzyScore(q, qt, it) }; })
      .filter(function (x) { return x.s >= 0.45; })
      .sort(function (a, b) { return b.s - a.s || a.it.name.length - b.it.name.length; }).slice(0, max || 6);
  }
  function ownResultHtml(query) {
    var q = String(query || '').trim();
    if (q.length < 2) return '';
    var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (!S.kid || kidSafe(it)); });
    var owned = fuzzyFind(q, items.filter(isOwned), 5);
    var wantedItems = fuzzyFind(q, items.filter(function (it) { return it.status === 'Wanted'; }), 2);
    var wl = fuzzyFind(q, (S.homeWanted || []).filter(function (w) { return !neverShow(w.name); }).map(function (w) { return { name: w.name, range: w.range, key: '', status: 'Wanted' }; }), 2);
    var sold = fuzzyFind(q, items.filter(function (it) { return it.status === 'Sold'; }), 2);
    var top = owned[0] ? owned[0].s : 0, h;
    if (top >= 0.8) {
      var strong = owned.filter(function (x) { return x.s >= 0.8; });
      h = '<div class="own yes"><div class="ownHead">\u2705 Yes - you\u2019ve got ' + (strong.length > 1 ? strong.length + ' that match' : 'it') + '!</div>';
    } else if (top >= 0.55) {
      h = '<div class="own maybe"><div class="ownHead">\uD83E\uDD14 Not sure - is it one of these?</div>';
    } else {
      h = '<div class="own no"><div class="ownHead">\u274C Not in the collection</div>';
      if (wantedItems.length || wl.length) h += '<p class="hint">\u2B50 But it\u2019s on the Wanted list: <b>' + esc((wantedItems[0] || wl[0]).it.name) + '</b></p>';
      else h += '<p class="hint">Nothing owned matches \u201C' + esc(q) + '\u201D. Try fewer words, or scan the barcode.</p>';
      if (sold.length && sold[0].s >= 0.8) h += '<p class="hint">You did have <b>' + esc(sold[0].it.name) + '</b> (marked Sold).</p>';
    }
    if (top >= 0.55) h += '<div class="list">' + owned.filter(function (x) { return x.s >= 0.55; }).map(function (x) {
      return '<button class="li ownLi" data-act="item" data-key="' + esc(x.it.key) + '">' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) + '<small>' + esc([x.it.range, x.it.status !== 'Owned' ? x.it.status : '', x.it.condition && x.it.condition !== 'Unknown' ? x.it.condition : ''].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>';
    }).join('') + '</div>';
    return h + '</div>';
  }
  function bindOwnSearch(inputId, outId) {
    var inp = $(inputId), out = $(outId), t = null; if (!inp || !out) return;
    var run = function () { out.innerHTML = ownResultHtml(inp.value); watchThumbs(); };
    inp.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { if ((inp.value || '').trim().length >= 2) bumpKid('kidSearches'); run(); }, 120); });
    if (inp.value) run();
  }

  /* ================= v4: barcodes ================= */
  function bcDigits(c) { return String(c == null ? '' : c).replace(/[^0-9]/g, ''); }
  function bcKey(c) { return bcDigits(c).replace(/^0+/, ''); }   // UPC-A and EAN-13 with a leading 0 are the same code
  function localBarcodes() { try { return JSON.parse(LS.get('barcodes') || '{}') || {}; } catch (e) { return {}; } }
  function itemBarcode(it) { return (it && (it.bc || localBarcodes()[it.key])) || ''; }
  function itemsByBarcode(code) {
    var k = bcKey(code); if (!k) return [];
    return (S.items || []).filter(function (it) { var b = itemBarcode(it); return b && bcKey(b) === k && !neverShow(it.name) && (!S.kid || kidSafe(it)); });
  }
  function saveBarcodeTo(key, name, code) {
    code = bcDigits(code);
    var m = localBarcodes(); m[key] = code; LS.set('barcodes', JSON.stringify(m));
    var it = itemByKey(key); if (it) it.bc = code;
    busy('Saving the barcode\u2026');
    return call('saveBarcode', key, name, code, S.role).catch(function (e) {
      if (!/unknown action/i.test((e && e.message) || '')) throw e;
      // Older Apps Script version (before the v4 update): keep it in Notes as "Barcode: 123..." instead.
      return call('getItem', key, S.role).then(function (full) {
        if (new RegExp('barcode\\s*[:#]?\\s*' + code).test(String(full.notes || '').replace(/\s/g, '').replace(/barcode:?/i, 'barcode:'))) return { ok: true, where: 'notes' };
        var notes = String(full.notes || ''); notes = notes ? notes + ' | Barcode: ' + code : 'Barcode: ' + code;
        return call('saveItem', key, name, { notes: notes }, S.role).then(function () { return { ok: true, where: 'notes' }; });
      });
    }).then(function (r) {
      done();
      toast(r && r.queued ? '\uD83C\uDFF7\uFE0F Barcode saved on the phone - it\u2019ll go into the sheet when you\u2019re back online' : '\uD83C\uDFF7\uFE0F Barcode saved - next time it\u2019ll match straight away', 'good');
      return r;
    }).catch(oops);
  }
  var SCAN = { stream: null, timer: null, det: undefined, zx: null, opts: null, last: '', hits: 0 };
  var BC_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
  function loadZXing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'lib/zxing.min.js?v4';
      s.onload = function () { if (window.ZXing) res(window.ZXing); else rej(new Error('zx')); };
      s.onerror = function () { rej(new Error('The barcode reader didn\u2019t load - check your signal and try again.')); };
      document.head.appendChild(s);
    });
  }
  function getDetector() {
    if (SCAN.det !== undefined) return Promise.resolve(SCAN.det);
    if (!('BarcodeDetector' in window)) { SCAN.det = false; return Promise.resolve(false); }
    return Promise.resolve(BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : BC_FORMATS).then(function (f) {
      var use = BC_FORMATS.filter(function (x) { return f.indexOf(x) >= 0; });
      SCAN.det = use.indexOf('ean_13') >= 0 ? new BarcodeDetector({ formats: use }) : false; return SCAN.det;
    }, function () { SCAN.det = false; return false; });
  }
  function zxReader(Z) {
    if (SCAN.zx) return SCAN.zx;
    var hints = new Map(), F = Z.BarcodeFormat;
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    var r = new Z.MultiFormatReader(); r.setHints(hints); SCAN.zx = r; return r;
  }
  function zxCanvas(Z, cv) {
    var r = zxReader(Z);
    try { return r.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(cv)))).getText(); }
    catch (e) { return ''; } finally { try { r.reset(); } catch (e2) { /* ignore */ } }
  }
  /* Find a barcode in an image/canvas/video frame. Uses the phone's built-in reader when it has one, else ZXing. */
  function detectIn(source, w, h) {
    return getDetector().then(function (det) {
      if (det) return det.detect(source).then(function (r) { return r && r[0] ? r[0].rawValue : ''; }, function () { return ''; });
      return loadZXing().then(function (Z) {
        var cv = document.createElement('canvas'), sc = Math.min(1, 1280 / Math.max(w, h));
        cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
        cv.getContext('2d').drawImage(source, 0, 0, cv.width, cv.height);
        return zxCanvas(Z, cv);
      });
    });
  }
  function scanBox() {
    var box = $('scanBox');
    if (!box) {
      box = document.createElement('div'); box.id = 'scanBox'; box.className = 'scanBox'; box.hidden = true;
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Scan a barcode');
      box.innerHTML = '<video id="scanVideo" playsinline muted autoplay></video><div class="scanFrame"><span class="scanLine"></span></div>' +
        '<div class="scanTop"><b id="scanTitle">Point at the barcode</b><small id="scanMsg">Hold the box steady, about a hand\u2019s width away.</small></div>' +
        '<div class="scanBtns"><button class="btn" data-act="scanType">\u2328\uFE0F Type it</button><button class="btn" data-act="scanPhoto">\uD83D\uDDBC\uFE0F From a photo</button><button class="btn main" data-act="scanClose">\u2715 Close</button></div>' +
        '<input id="scanInput" type="file" accept="image/*" hidden>';
      document.body.appendChild(box);
      $('scanInput').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) scanFromFile(f); });
    }
    return box;
  }
  function openScanner(opts) {
    SCAN.opts = opts || {}; SCAN.last = ''; SCAN.hits = 0;
    var box = scanBox(); var wasOpen = !box.hidden; box.hidden = false; layerOpen(wasOpen);
    $('scanTitle').textContent = SCAN.opts.assign ? 'Scan the barcode for ' + SCAN.opts.assign.name : (SCAN.opts.add ? 'Scan the barcode for this new item' : (S.kid ? 'Scan a box!' : 'Point at the barcode'));
    $('scanMsg').textContent = 'Hold the box steady, about a hand\u2019s width away.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { scanNoCamera(); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (stream) {
      if (box.hidden) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      SCAN.stream = stream;
      var v = $('scanVideo'); v.srcObject = stream; var pl = v.play(); if (pl && pl.catch) pl.catch(noop);
      getDetector().then(function (det) { if (!det) return loadZXing(); }).catch(function (e) { $('scanMsg').textContent = e.message; });
      var busyFrame = false;
      SCAN.timer = setInterval(function () {
        if (busyFrame || !v.videoWidth) return;
        busyFrame = true;
        detectIn(v, v.videoWidth, v.videoHeight).then(function (code) {
          busyFrame = false;
          code = bcDigits(code) || String(code || '').trim();
          if (!code) return;
          if (!SCAN.det) { if (code !== SCAN.last) { SCAN.last = code; return; } }   // ZXing: wait for 2 matching reads
          gotCode(code);
        }, function () { busyFrame = false; });
      }, 220);
    }, function () { scanNoCamera(); });
  }
  function scanNoCamera() {
    $('scanTitle').textContent = 'The camera didn\u2019t open';
    $('scanMsg').textContent = 'Allow the camera for this app, or take a photo of the barcode, or type the numbers under it.';
  }
  function stopScanner() {
    clearInterval(SCAN.timer); SCAN.timer = null;
    if (SCAN.stream) { SCAN.stream.getTracks().forEach(function (t) { t.stop(); }); SCAN.stream = null; }
    var v = $('scanVideo'); if (v) v.srcObject = null;
    var box = $('scanBox'); if (box) box.hidden = true;
  }
  function gotCode(code) {
    if (!$('scanBox') || $('scanBox').hidden) return;
    try { if (navigator.vibrate) navigator.vibrate(80); } catch (e) { /* ignore */ }
    NAV.keep = true; stopScanner(); handleCode(code);
  }
  function scanFromFile(file) {
    $('scanMsg').textContent = 'Reading the photo\u2026';
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      detectIn(img, img.naturalWidth, img.naturalHeight).then(function (code) {
        URL.revokeObjectURL(url);
        if (code) gotCode(bcDigits(code) || code);
        else $('scanMsg').textContent = 'Couldn\u2019t spot a barcode in that photo. Get closer so the stripes fill the picture, or type the numbers.';
      }, function (e) { URL.revokeObjectURL(url); $('scanMsg').textContent = (e && e.message) || 'Couldn\u2019t read that photo.'; });
    };
    img.onerror = function () { URL.revokeObjectURL(url); $('scanMsg').textContent = 'Couldn\u2019t open that photo.'; };
    img.src = url;
  }
  function typeCode() {
    var opts = SCAN.opts || {};
    NAV.keep = true;
    stopScanner();
    sheet('\u2328\uFE0F Type the barcode', '<p class="hint">The numbers under the stripes (usually 12 or 13 of them).</p><input type="text" id="bcTyped" inputmode="numeric" autocomplete="off" placeholder="e.g. 5012345678900" style="font-size:22px;letter-spacing:1px">',
      [{ label: 'Check it', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
      var code = bcDigits(($('bcTyped') || {}).value);
      if (v !== 'go') { if (opts.add && S.screen === 'add') go('add', {}, true); return; }
      if (code.length < 6) { toast('That needs to be the numbers under the barcode (8 to 14 of them).', 'oops'); return; }
      SCAN.opts = opts; handleCode(code);
    });
    setTimeout(function () { if ($('bcTyped')) $('bcTyped').focus(); }, 80);
  }
  function handleCode(code) {
    var opts = SCAN.opts || {}, digits = bcDigits(code);
    if (!digits) { layerDrop(); toast('That code isn\u2019t a product barcode (' + String(code).slice(0, 30) + ').', 'oops'); return; }
    if (opts.assign) {
      var a = opts.assign;
      return confirmSheet('Save this barcode?', 'Save <b>' + esc(digits) + '</b> onto <b>' + esc(a.name) + '</b>? Next time you scan this box it\u2019ll match straight away.', 'Yes, save it', 'Cancel').then(function (ok) {
        if (ok) saveBarcodeTo(a.key, a.name, digits).then(function () { if (S.screen === 'item') go('item', S.params, true); });
      });
    }
    if (opts.add) { layerDrop(); applyAddBarcode(digits); return; }
    var hits = itemsByBarcode(digits);
    var listHtml = function (list) {
      return '<div class="list">' + list.map(function (it) {
        return '<button class="li ownLi" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.range, isOwned(it) ? '' : it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>';
      }).join('') + '</div>';
    };
    if (hits.length) {
      var own = hits.filter(isOwned);
      var title = own.length ? (S.kid ? '\u2705 We\u2019ve got this one!' : '\u2705 You\u2019ve got it!') : '\u2B50 Not owned yet - it\u2019s ' + (hits[0].status || 'listed');
      sheet(title, '<p class="hint">Barcode ' + esc(digits) + '</p>' + listHtml(hits) + (own.length > 1 ? '<p class="hint">You\u2019ve got ' + own.length + ' with this barcode.</p>' : ''), [{ label: 'Done', value: true, cls: 'main' }, { label: '\uD83D\uDCF7 Scan another', value: 'again' }]).then(function (v) { if (v === 'again') openScanner({}); });
      setTimeout(watchThumbs, 50);
      return;
    }
    S.lastCode = digits;
    if (S.kid) {
      sheet('\uD83E\uDD37 Not in our collection yet', '<p>Barcode <b>' + esc(digits) + '</b> isn\u2019t saved on anything we\u2019ve got. If you think we have it, show ' + esc(PRIV) + '!</p>', [{ label: '\uD83D\uDCF7 Scan another', value: 'again', cls: 'main' }, { label: 'OK', value: false }]).then(function (v) { if (v === 'again') openScanner({}); });
      return;
    }
    sheet('\uD83E\uDD37 No match for that barcode yet', '<p>Barcode <b>' + esc(digits) + '</b> isn\u2019t saved on any item yet. Most of the collection doesn\u2019t have barcodes saved, so <b>search by name</b> - if you\u2019ve got it, tap it to save the barcode and next time it\u2019ll match straight away.</p>' +
      '<div class="search"><input id="bcName" type="search" placeholder="\uD83D\uDD0D What is it? e.g. Wind-up robot 1960s" autocomplete="off" style="font-size:20px"></div><div id="bcNameOut"></div>' +
      '<div class="stack" style="margin-top:10px"><a class="btn full" href="https://www.google.co.uk/search?q=' + encodeURIComponent(digits) + '" target="_blank" rel="noopener">\uD83D\uDD0E Look the barcode up on Google \u2197</a>' +
      '<button class="btn yel full" data-act="bcAddNew">\u2795 It\u2019s new - add it with this barcode</button></div>',
      [{ label: '\uD83D\uDCF7 Scan another', value: 'again' }, { label: 'Close', value: false, cls: 'main' }]).then(function (v) { if (v === 'again') openScanner({}); });
    var inp = $('bcName'), t = null;
    inp.addEventListener('input', function () {
      clearTimeout(t); t = setTimeout(function () {
        var res = fuzzyFind(inp.value, (S.items || []).filter(function (it) { return !neverShow(it.name); }), 6);
        $('bcNameOut').innerHTML = !inp.value.trim() ? '' : (res.length ? '<p class="hint">Tap the one it is to save the barcode on it:</p><div class="list">' + res.map(function (x) {
          return '<button class="li ownLi" data-act="bcAssign" data-key="' + esc(x.it.key) + '">' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) + '<small>' + esc([x.it.range, x.it.status].filter(Boolean).join(' \u00B7 ')) + '</small></div><span class="pill green">This one</span></button>';
        }).join('') + '</div>' : '<div class="nudge">\u274C Nothing in the collection matches that name.</div>');
        watchThumbs();
      }, 150);
    });
  }

  /* ================= v4: collection value on Home (private) ================= */
  function monthKey(d) { d = d || new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function todayKey() { var d = new Date(); return monthKey(d) + '-' + ('0' + d.getDate()).slice(-2); }
  function localValueSummary() {
    var own = (S.items || []).filter(function (it) { return isOwned(it) && !it.pending; });
    var total = 0, valued = 0, upd = null, m = monthKey();
    own.forEach(function (it) { if (it.v != null) { total += +it.v; valued++; } if (it.vu !== undefined) { upd = upd || 0; if (String(it.vu).slice(0, 7) === m) upd++; } });
    total = Math.round(total * 100) / 100;
    var key = 'valsnap_' + m, snap = null;
    try { snap = JSON.parse(LS.get(key) || 'null'); } catch (e) { snap = null; }
    if (!snap) { snap = { total: total, date: todayKey() }; LS.set(key, JSON.stringify(snap)); }
    return { total: total, valued: valued, items: own.length, notValued: own.length - valued, updatedThisMonth: upd, monthStart: snap, change: Math.round((total - snap.total) * 100) / 100, local: true };
  }
  function shortDate(iso) { var p = String(iso || '').split('-'); if (p.length < 3) return iso || ''; return (+p[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(+p[1] || 1) - 1]; }
  function valueCardHtml(vs) {
    if (!vs) return '';
    var h = '<div class="card yel valueCard"><div class="head">\uD83D\uDD12 Collection value</div><div class="big">' + gbp(vs.total) + '</div>' +
      '<div class="hint"><b>' + vs.items + '</b> items owned \u00B7 ' + vs.valued + ' with a value' + (vs.notValued ? ' (' + vs.notValued + ' still to value)' : '') + '</div>';
    var ms = vs.monthStart;
    if (ms && ms.date && ms.date !== todayKey() && vs.change != null) {
      h += '<div class="vchg ' + (vs.change >= 0 ? 'up' : 'down') + '">' + (vs.change >= 0 ? '\u25B2 +' : '\u25BC ') + gbp(Math.abs(vs.change)).replace(/^/, vs.change < 0 ? '-' : '') + ' this month <small>(since ' + esc(shortDate(ms.date)) + ')</small></div>';
    } else {
      h += '<div class="hint">\uD83D\uDCC8 This month: tracking from ' + esc(shortDate((ms && ms.date) || todayKey())) + ' (the sheet has no older totals)</div>';
    }
    if (vs.updatedThisMonth != null) h += '<div class="hint">' + vs.updatedThisMonth + ' value' + (vs.updatedThisMonth === 1 ? '' : 's') + ' updated this month</div>';
    h += '<button class="btn small" data-act="go" data-to="value">See the value page</button></div>';
    return h;
  }

  /* ================= v4: Wanted deal alerts ================= */
  function dealCount() {
    if (S.homeWanted) return S.homeWanted.filter(function (w) { return w.deal && !neverShow(w.name); }).length;
    return (S.boot && S.boot.tiles && S.boot.tiles.wanted && S.boot.tiles.wanted.deals) || 0;
  }
  function refreshDealBadges() {
    var n = dealCount();
    var tb = document.querySelector('#tabbar [data-tab=wanted]');
    if (tb) { var b = tb.querySelector('.tbBadge'); if (n && !b) { b = document.createElement('span'); b.className = 'tbBadge'; tb.appendChild(b); } if (b) { if (n) b.textContent = n; else b.remove(); } }
    var hb = $('dealLine'); if (hb) hb.innerHTML = n ? '<span class="pill red">\uD83D\uDD25 ' + n + ' deal' + (n === 1 ? '' : 's') + ' under your max price</span>' : '';
  }
  function missingToWanted(rows) {
    return (rows || []).map(function (r) {
      return { kind: 'checklist', ref: r.tab + '|' + r.row, name: r.name, range: r.set || r.tab, series: r.number || '', year: r.year || '', conditionWanted: '', notes: '' };
    });
  }
  function mergeWantedAndMissing(wanted, missing) {
    var out = [], seen = {};
    (wanted || []).forEach(function (w) {
      out.push(w);
      var k = norm(w.name);
      if (k) seen[k] = out.length - 1;
    });
    missingToWanted(missing).forEach(function (w) {
      var k = norm(w.name);
      if (k && seen[k] !== undefined) {
        var cur = out[seen[k]];
        if (cur && !cur.year && w.year) cur.year = w.year;
        if (cur && !cur.series && w.series) cur.series = w.series;
        return;
      }
      if (k) seen[k] = out.length;
      out.push(w);
    });
    return out;
  }
  function loadHomeWanted() {
    var role = S.kid ? KID_ROLE : S.role;
    return Promise.all([
      call('getWanted', role).catch(function () { return []; }),
      call('getAllMissing').catch(function () { return []; })
    ]).then(function (res) {
      var list = mergeWantedAndMissing(res[0] || [], res[1] || []).filter(function (w) { return !neverShow(w.name); });
      S.homeWanted = list;
      refreshDealBadges();
      return list;
    }).catch(function () { return S.homeWanted || []; });
  }

  function busy(text) { $('busyText').textContent = text || 'Just a sec\u2026'; $('busy').hidden = false; }
  function done() { $('busy').hidden = true; }
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'oops' ? 6500 : 3500);
  }
  function oops(e) {
    done();
    var m = (e && e.message ? e.message : String(e || '')).replace(/^(Exception|Error|ScriptError):\s*/i, '');
    if (!m || /TypeError|ReferenceError|Cannot read|undefined is not|null is not|Authori[sz]ation|permission|Service invoked|Exceeded maximum/i.test(m)) {
      m = 'Hmm, that didn\u2019t work. Check you\u2019ve got signal and try again - nothing\u2019s been lost.';
    }
    toast(m, 'oops');
  }

  /* bottom sheet (friendly confirm / warnings) */
  var SHEET_OK = null;
  function finishSheet(value) {
    var sh = $('sheet'); if (sh) sh.hidden = true;
    var fn = SHEET_OK; SHEET_OK = null;
    if (fn) fn(value);
  }
  function sheet(title, bodyHtml, buttons) {
    return new Promise(function (resolve) {
      if (SHEET_OK) { var prev = SHEET_OK; SHEET_OK = null; prev(false); }
      SHEET_OK = resolve;
      var wasOpen = $('sheet') && !$('sheet').hidden;
      $('sheetTitle').textContent = title;
      $('sheetBody').innerHTML = bodyHtml || '';
      var bb = $('sheetButtons'); bb.innerHTML = '';
      (buttons || [{ label: 'OK', value: true, cls: 'main' }]).forEach(function (b) {
        var el = document.createElement('button');
        el.className = 'btn full ' + (b.cls || ''); el.textContent = b.label;
        el.addEventListener('click', function () {
          NAV.sheetValue = b.value;
          if (NAV.pushed > 0) layerBack(); else finishSheet(b.value);
        });
        bb.appendChild(el);
      });
      $('sheet').hidden = false;
      layerOpen(wasOpen);
    });
  }
  function confirmSheet(title, body, yes, no) {
    return sheet(title, '<p>' + body + '</p>', [{ label: yes || 'Yes', value: true, cls: 'main' }, { label: no || 'Not now', value: false }]);
  }

  /* Phone Back (Android): close the top overlay or step; don't leave the app. */
  var NAV = { pushed: 0, keep: false, skip: false, sheetValue: undefined, tourFinished: false };
  function layerPush() {
    try { history.pushState({ fs: 1, t: Date.now() }, ''); NAV.pushed++; } catch (e) { /* ignore */ }
  }
  function layerOpen(wasOpen) {
    if (NAV.keep) { NAV.keep = false; return; }
    if (!wasOpen) layerPush();
  }
  function layerBack() {
    if (NAV.pushed > 0) { try { history.back(); } catch (e) { dismissTop(); } }
    else dismissTop();
  }
  function layerDrop() {
    if (NAV.keep) NAV.keep = false;
    if (NAV.pushed <= 0) return;
    NAV.skip = true; NAV.pushed--;
    try { history.back(); } catch (e) { NAV.skip = false; }
  }
  function overlayOpen(id) { var el = $(id); return !!(el && !el.hidden); }
  function dismissTop() {
    var box = $('scanBox');
    if (box && !box.hidden) { stopScanner(); return true; }
    if (overlayOpen('sheet')) {
      var v = NAV.sheetValue; NAV.sheetValue = undefined;
      finishSheet(v !== undefined ? v : false);
      return true;
    }
    if (overlayOpen('lightbox')) { $('lightbox').hidden = true; return true; }
    if (overlayOpen('dadNote')) { hideDadNote(); return true; }
    if (overlayOpen('dadLetter')) { hideDadLetter(); return true; }
    var tour = $('tour');
    if (tour && !tour.hidden) { var done = !!NAV.tourFinished; NAV.tourFinished = false; closeTour(done); return true; }
    if (S.screen === 'add' && S.add && S.add.step > 1) {
      keepAddName();
      S.add.step = Math.max(1, S.add.step - 1);
      go('add', {}, true);
      return true;
    }
    if (S.history && S.history.length) { back(); return true; }
    if (S.screen === 'add') { go(S.kid ? 'kid' : 'home', {}, true); return true; }
    return false;
  }
  window.addEventListener('popstate', function () {
    if (NAV.skip) { NAV.skip = false; return; }
    if (NAV.pushed > 0) NAV.pushed--;
    dismissTop();
  });

  /* ---------------- navigation ---------------- */
  var TABS = function () {
    if (S.kid) return [['kid', '\uD83C\uDFE0', 'Home'], ['kidStuff', '\uD83E\uDDF8', 'Our stuff'], ['kidHunt', '\u2B50', 'Hunt'], ['kidBadges', '\uD83C\uDFC6', 'Badges'], ['scan', '\uD83D\uDCF7', 'Scan']];
    return [['home', '\uD83C\uDFE0', 'Home'], ['collection', '\uD83D\uDDC2\uFE0F', 'Collection'], ['add', '\u2795', 'Add'], ['wanted', '\u2B50', 'Wanted'], ['more', '\u2630', 'More']];
  };
  function renderTabs() {
    var nav = $('tabbar');
    nav.hidden = !S.role;
    nav.innerHTML = TABS().map(function (t) {
      var cur = S.screen === t[0] || (t[0] === 'collection' && (S.screen === 'item' || S.screen === 'edit')) ||
        (t[0] === 'more' && MORE_SCREENS.indexOf(S.screen) >= 0) || (t[0] === 'wanted' && (S.screen === 'checklists' || S.screen === 'checklist' || S.screen === 'missing'));
      var dn = t[0] === 'wanted' ? dealCount() : 0;
      return '<button data-tab="' + t[0] + '"' + (cur ? ' aria-current="page"' : '') + '><span class="ic">' + t[1] + '</span>' + t[2] + (dn ? '<span class="tbBadge">' + dn + '</span>' : '') + '</button>';
    }).join('');
    $('whoBadge').textContent = S.kid ? 'Kid mode' : (S.role ? 'Hi ' + S.role + (isSolo() ? '' : ' \u00B7 tap to switch') : THEME.tagline);
  }
  var MORE_SCREENS = ['more', 'stats', 'posted', 'spares', 'history', 'export', 'help', 'settings', 'value', 'photos', 'novalue', 'dropZone'];
  function go(screen, params, noHistory) {
    if (!NAV.tourNav) closeTour(); if ($('lightbox')) $('lightbox').hidden = true;
    if (S.kid) { if (screen === 'item') screen = 'kidItem'; else if (KID_SCREENS.indexOf(screen) < 0) { screen = 'kid'; params = {}; } }
    if (!noHistory && S.screen && S.screen !== screen) { S.history.push([S.screen, S.params]); layerPush(); }
    if (S.history.length > 30) S.history.shift();
    S.screen = screen; S.params = params || {};
    renderTabs();
    var fn = SCREENS[screen] || SCREENS.home;
    window.scrollTo(0, 0);
    fn(S.params);
    $('main').focus({ preventScroll: true });
  }
  function back() {
    var prev = S.history.pop();
    if (prev) go(prev[0], prev[1], true); else go(S.kid ? 'kid' : 'home', {}, true);
  }
  function setMain(html) { $('main').innerHTML = netBarHtml() + html + '<p class="foot">' + esc(THEME.footer) + '</p>'; }
  function backBtn() { return '<button class="btn small" data-act="back">\u2190 Back</button>'; }

  /* ---------------- data ---------------- */
  function loadBoot(force) {
    if (S.boot && !force) return Promise.resolve(S.boot);
    busy('Getting the collection\u2026');
    warmThumbs();
    return call('getBootstrap', S.kid ? KID_ROLE : S.role).then(function (b) {
      var privNow = isPriv() && !S.kid;
      b.items = (b.items || []).filter(function (it) { return !neverShow(it.name) && (privNow || !sonHidden(it.name)); });
      S.boot = b; S.items = b.items;
      prefetchThumbs(S.kid ? b.items.filter(function (it) { return isOwned(it) && kidSafe(it); }) : b.items);
      return IDB.qAll().then(function (q) { NET.queueLen = q.length; q.forEach(applyQueued); }, noop).then(function () { done(); renderNetBar(); return b; });
    });
  }
  function itemByKey(key) { for (var i = 0; i < S.items.length; i++) if (S.items[i].key === key) return S.items[i]; return null; }

  /* ================= v5 thumbnails: small, cached on the phone, retried, tap to retry =================
     Drive's thumbnails arrive at ~1280x1600 (~366 KB each as text). Each one is shrunk on the phone to a 320px
     square JPEG (~15-25 KB), kept in its own IndexedDB entry, and (with Apps Script v4.2) handed back to the
     server once so every later load is small. Only cards on screen are fetched, newest-visible first, a few
     at a time, with a time limit and automatic retries; anything that still fails shows "Tap to retry". */
  var TH = { at: {}, done: {}, fail: {}, busy: {}, queue: [], running: 0, small: null, timer: null, kind: {}, pre: {}, bad: {}, autoAt: {}, autoN: {} };
  var TH_MAX_TRIES = 3, TH_PARALLEL = 3, TH_TIMEOUT = 45000, TH_STALE = 3 * 864e5;
  function thumbInner(fid) {
    var t = S.thumbs[fid];
    if (typeof t === 'string') return '<img alt="" decoding="async" src="' + t + '">';
    if (t === null) return noPhotoHtml(TH.kind[fid] === 'video');
    if ((TH.fail[fid] || 0) >= TH_MAX_TRIES) return '<span class="thRetry" data-act="thumbRetry" data-fid2="' + esc(fid) + '" role="button" aria-label="Photo didn\u2019t load. Tap to try again">\u21BB<small>Tap to retry</small></span>';
    return '<span class="thWait" aria-label="Loading photo"></span>';
  }
  /* v7: a card with no picture says why, so it never looks like a photo that failed to load */
  function noPhotoHtml(video) {
    return video ? '<span class="thNone" aria-label="Only a video so far">\uD83C\uDFAC<small>Video only</small></span>'
      : '<span class="thNone" aria-label="No photo yet">\uD83D\uDCF7<small>No photo yet</small></span>';
  }
  /* v7l: local reference pictures for items with no Drive folder. Real photos always win. */
  var STANDIN_IDS = {};
  var WANT_REF_IDS = {};
  function standinUrl(it) {
    var id = it && it.id;
    if (!id || !STANDIN_IDS[id] || it.folderId) return '';
    return 'assets/standins/' + id + '.webp';
  }
  function filmBadgeHtml() {
    return '<span class="filmBadge" title="Still needs a real photo">\uD83C\uDFAC Still to film</span>';
  }
  function standinBlock(it, cls, extraAttr) {
    var src = standinUrl(it);
    if (!src) return '';
    return '<div class="' + cls + ' isStandin"' + (extraAttr || '') + '><img class="standinImg" alt="" src="' + esc(src) + '">' + filmBadgeHtml() + '</div>';
  }
  function thumbHtml(it) {
    if (it.folderId) return '<div class="thumb" data-fid="' + esc(it.folderId) + '">' + thumbInner(it.folderId) + '</div>';
    var s = standinBlock(it, 'thumb');
    if (s) return s;
    return '<div class="thumb" data-nothumb>' + noPhotoHtml(false) + '</div>';
  }
  function paintThumb(fid) {
    document.querySelectorAll('[data-fid="' + fid + '"]').forEach(function (el) { el.innerHTML = thumbInner(fid); });
  }
  function thumbNeeded(fid) {
    if (!fid || TH.busy[fid] || TH.queue.indexOf(fid) >= 0) return false;
    if ((TH.fail[fid] || 0) >= TH_MAX_TRIES) return false;
    var t = S.thumbs[fid];
    if (t === null) return false;
    if (typeof t === 'string') return !TH.done[fid] && Date.now() - (TH.at[fid] || 0) > TH_STALE;   // quiet re-check
    return true;
  }
  function queueThumb(fid) {
    if (!thumbNeeded(fid)) return;
    TH.queue.push(fid);
    clearTimeout(TH.timer); TH.timer = setTimeout(pumpThumbs, 120);
  }
  var observer = null;
  function onScreen(el, pad) { var r = el.getBoundingClientRect(); return r.bottom > -pad && r.top < innerHeight + pad && r.width > 0; }
  function watchThumbs() {
    var els = document.querySelectorAll('[data-fid]');
    if (!('IntersectionObserver' in window)) { els.forEach(function (el) { if (onScreen(el, 600)) queueThumb(el.getAttribute('data-fid')); }); return; }
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) queueThumb(en.target.getAttribute('data-fid')); });
    }, { rootMargin: '400px 0px' });
    els.forEach(function (el) { observer.observe(el); });
    sweepThumbs(); setTimeout(sweepThumbs, 700);    // v7: cards already on screen are asked for even if the observer is late
  }
  /* safety net: after scrolling stops, anything on screen that still needs a photo is asked for */
  var thScrollT = null;
  function sweepThumbs() { document.querySelectorAll('[data-fid]').forEach(function (el) { if (onScreen(el, 400)) queueThumb(el.getAttribute('data-fid')); }); }
  window.addEventListener('scroll', function () { clearTimeout(thScrollT); thScrollT = setTimeout(sweepThumbs, 250); }, { passive: true });
  function pickThumbBatch(n) {
    var vis = [], near = [];
    TH.queue.forEach(function (fid) {
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (!el) { if (TH.pre[fid]) near.push(fid); return; }   // not on the page: only first-screen pre-fetches go ahead
      (onScreen(el, 50) ? vis : near).push(fid);
    });
    var all = vis.concat(near);
    TH.queue = all.slice(n);
    return all.slice(0, n);
  }
  function pumpThumbs() {
    if (navigator.onLine === false) return;
    while (TH.running < TH_PARALLEL && TH.queue.length) {
      var batch = pickThumbBatch(TH.small === false ? 4 : 10);
      if (!batch.length) break;
      runThumbBatch(batch);
    }
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { var e = new Error('timeout'); e.timeout = true; rej(e); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function fetchThumbs(batch) {
    /* straight to the API (not call()), so a slow photo never flips the whole app into "No signal" */
    var old = function () { return rawCall('getThumbs', [batch, tokenNow()]).then(function (m) { return { thumbs: m || {}, big: {}, old: true }; }); };
    if (TH.small === false) return old();
    return rawCall('getThumbsSmall', [batch, tokenNow()]).then(function (r) {
      if (!r || typeof r !== 'object' || !r.thumbs) throw new Error('bad reply');
      TH.small = true; return r;
    }, function (e) {
      if (/unknown action/i.test((e && e.message) || '')) { TH.small = false; return old(); }   // Apps Script not updated yet
      throw e;
    });
  }
  function runThumbBatch(batch) {
    TH.running++;
    batch.forEach(function (f) { TH.busy[f] = 1; });
    withTimeout(fetchThumbs(batch), TH_TIMEOUT).then(function (r) {
      setTimeout(autoRetryThumbs, 0);   // the line works again: give failed photos on screen one more go
      return Promise.all(batch.map(function (fid) {
        if (!Object.prototype.hasOwnProperty.call(r.thumbs, fid)) { delete TH.busy[fid]; TH.queue.push(fid); return null; }  // server ran out of time: ask again
        var v = r.thumbs[fid], kind = r.kinds && r.kinds[fid];
        delete TH.pre[fid];
        if (!v && kind === 'error') { delete TH.busy[fid]; thumbFailed(fid); return null; }   // Drive hiccup: try again
        if (!v) {
          delete TH.busy[fid]; TH.done[fid] = 1; TH.kind[fid] = kind || '';
          if (typeof S.thumbs[fid] !== 'string') { S.thumbs[fid] = null; paintThumb(fid); }
          return null;
        }
        return shrinkThumb(v).then(function (small) {
          delete TH.busy[fid];
          if (!small) { TH.bad[fid] = (TH.bad[fid] || 0) + 1; thumbFailed(fid); return; }
          S.thumbs[fid] = small; TH.at[fid] = Date.now(); TH.done[fid] = 1; delete TH.fail[fid];
          IDB.tSet(fid, { d: small, at: TH.at[fid] }).catch(noop);
          paintThumb(fid);
          if (r.big && r.big[fid] && small !== v && small.length < 88000) rawCall('putThumbSmall', [fid, r.big[fid], small, '']).catch(noop);
        });
      }));
    }, function (e) {
      batch.forEach(function (fid) { delete TH.busy[fid]; thumbFailed(fid, navigator.onLine === false); });
    }).then(function () {
      TH.running--; pumpThumbs();
    }, function () { TH.running--; pumpThumbs(); });
  }
  function thumbFailed(fid, offline) {
    if (typeof S.thumbs[fid] === 'string') { TH.done[fid] = 1; return; }      // keep the saved one
    if (!offline) TH.fail[fid] = (TH.fail[fid] || 0) + 1;
    if (offline || (TH.fail[fid] || 0) >= TH_MAX_TRIES) { if (offline) TH.fail[fid] = TH_MAX_TRIES; paintThumb(fid); return; }
    setTimeout(function () { queueThumb(fid); }, 1500 * TH.fail[fid]);       // try again shortly
  }
  /* v7: never give up on a photo that's on screen - try again every so often (20 s, 40 s, ... up to 3 min) */
  function autoRetryThumbs(now) {
    var t = Date.now();
    Object.keys(TH.fail).forEach(function (fid) {
      if (TH.fail[fid] < TH_MAX_TRIES) return;
      if (!now && t < (TH.autoAt[fid] || 0)) return;
      var el = document.querySelector('[data-fid="' + fid + '"]');
      if (!el || !onScreen(el, 400)) return;
      TH.autoN[fid] = (TH.autoN[fid] || 0) + 1;
      TH.autoAt[fid] = t + Math.min(180000, 20000 * TH.autoN[fid]);
      retryThumb(fid);
    });
  }
  function thumbsWakeUp() {          // back to the app, or signal back: re-check the screen straight away
    if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
    TH.autoAt = {}; autoRetryThumbs(true); sweepThumbs(); pumpThumbs();
  }
  document.addEventListener('visibilitychange', thumbsWakeUp);
  window.addEventListener('pageshow', thumbsWakeUp);
  setInterval(function () { if (document.visibilityState !== 'hidden' && navigator.onLine !== false) { autoRetryThumbs(); sweepThumbs(); } }, 20000);
  /* a saved thumbnail that the phone can't draw (empty or broken) is thrown away and fetched again */
  document.addEventListener('error', function (e) {
    var im = e.target; if (!im || im.tagName !== 'IMG' || !im.closest) return;
    var box = im.closest('[data-fid]'); if (!box) return;
    var fid = box.getAttribute('data-fid');
    if ((TH.bad[fid] = (TH.bad[fid] || 0) + 1) > 2) return;
    forgetThumb(fid); paintThumb(fid); queueThumb(fid);
  }, true);
  /* first screen: fetch the newest items' photos as soon as the list arrives, before they're even drawn */
  function prefetchThumbs(items) {
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    (items || []).slice().sort(function (a, b) { return idn(b) - idn(a) || b.row - a.row; }).filter(function (it) { return it.folderId; }).slice(0, 12)
      .forEach(function (it) { if (thumbNeeded(it.folderId)) { TH.pre[it.folderId] = 1; queueThumb(it.folderId); } });
  }
  var thWarm = false;
  function warmThumbs() {              // wakes Apps Script up while the list is loading, so the first batch isn't the slow one
    if (thWarm || navigator.onLine === false) return; thWarm = true;
    rawCall('getThumbsSmall', [[], '']).catch(function () { thWarm = false; });
  }
  function retryThumb(fid) { delete TH.fail[fid]; delete TH.done[fid]; paintThumb(fid); queueThumb(fid); }
  window.addEventListener('online', function () {
    Object.keys(TH.fail).forEach(function (fid) { if (TH.fail[fid] >= TH_MAX_TRIES && document.querySelector('[data-fid="' + fid + '"]')) retryThumb(fid); });
    thumbsWakeUp();
  });
  /* shrink a big thumbnail to a 320px square JPEG (what the card shows anyway) */
  function shrinkThumb(src) {
    return new Promise(function (res) {
      if (src.length < 60000) return res(src);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h);
          if (!s) return res(null);
          var out = Math.min(320, s), c = document.createElement('canvas'); c.width = c.height = out;
          c.getContext('2d').drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, out, out);
          var d = c.toDataURL('image/jpeg', 0.75);
          res(/^data:image\/jpeg/.test(d) && d.length < src.length ? d : src);
        } catch (e) { res(src); }
      };
      img.onerror = function () { res(null); };
      img.src = src;
    });
  }
  /* kept on the phone (one entry per item), so photos show straight away and with no signal */
  function goodThumb(d) { return typeof d === 'string' && d.length > 300 && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/]{100}/.test(d); }
  function loadSavedThumbs() {
    return IDB.tAll().then(function (m) {
      Object.keys(m || {}).forEach(function (k) {
        var v = m[k];
        if (!v || !goodThumb(v.d)) { IDB.tDel(k).catch(noop); return; }   // v7: empty or broken - fetch it again
        if (typeof S.thumbs[k] !== 'string') { S.thumbs[k] = v.d; TH.at[k] = v.at || 0; paintThumb(k); }
      });
      migrateOldThumbs();
    }).catch(noop);
  }
  /* v4 kept every big thumbnail in one huge entry; shrink them into the new store once, then drop it */
  function migrateOldThumbs() {
    IDB.get('thumbs').then(function (old) {
      if (!old) return;
      var keys = Object.keys(old), i = 0;
      var next = function () {
        if (i >= keys.length) { old = null; return IDB.del('thumbs').catch(noop); }
        var k = keys[i++], v = old[k];
        if (!goodThumb(v) || typeof S.thumbs[k] === 'string') return next();
        return shrinkThumb(v).then(function (small) {
          if (goodThumb(small) && typeof S.thumbs[k] !== 'string') { S.thumbs[k] = small; TH.at[k] = 0; paintThumb(k); return IDB.tSet(k, { d: small, at: 0 }).catch(noop); }
        }).then(function () { return new Promise(function (r) { setTimeout(r, 30); }); }).then(next);
      };
      return next();
    }).catch(noop);
  }
  function forgetThumb(fid) {
    if (!fid) return;
    delete S.thumbs[fid]; delete TH.at[fid]; delete TH.done[fid]; delete TH.fail[fid]; delete TH.kind[fid];
    IDB.tDel(fid).catch(noop);
  }
  /* Refresh: keep showing what we have, but quietly re-check each photo as it comes on screen */
  function thumbsRefresh() {
    TH.done = {}; TH.fail = {}; TH.at = {}; TH.autoAt = {}; TH.autoN = {}; TH.bad = {}; TH.kind = {};
    Object.keys(S.thumbs).forEach(function (k) { if (typeof S.thumbs[k] !== 'string') delete S.thumbs[k]; });
  }

  /* ---------------- camera + uploads ---------------- */
  function readRaw(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { var d = String(fr.result); resolve({ mime: file.type || 'application/octet-stream', b64: d.split(',')[1] || '', preview: (file.type || '').indexOf('image/') === 0 ? d : '' }); };
      fr.onerror = function () { reject(new Error('I couldn\u2019t read that file - try taking it again.')); };
      fr.readAsDataURL(file);
    });
  }
  function prepareFile(file) {
    var mb = file.size / 1048576;
    var isVid = (file.type || '').indexOf('video/') === 0;
    if (isVid && mb > THEME.maxUploadMb) {
      return Promise.reject(new Error('That video is ' + Math.round(mb) + ' MB - a bit big for the app. Pop it in the Drop Zone instead and it\u2019ll get sorted.'));
    }
    if (isVid || (file.type || '').indexOf('image/') !== 0) return readRaw(file);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var max = 2400, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
          var cv = document.createElement('canvas'); cv.width = Math.round(w * s); cv.height = Math.round(h * s);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          var d = cv.toDataURL('image/jpeg', 0.88);
          URL.revokeObjectURL(url);
          resolve({ mime: 'image/jpeg', b64: d.split(',')[1], preview: d });
        } catch (e) { URL.revokeObjectURL(url); readRaw(file).then(resolve); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); readRaw(file).then(resolve); };
      img.src = url;
    });
  }
  // mode: falsy = camera (photo), 'video' = camera (video), anything else = gallery
  function openCamera(target, mode) {
    if (!mode) {   // every "Take photo" asks: camera or gallery
      return sheet('\uD83D\uDCF7 Add a photo', '<p class="hint">Snap it now, or pick one you already took.</p>', [
        { label: '\uD83D\uDCF7 Take photo (camera)', value: 'camera', cls: 'main' },
        { label: '\uD83D\uDDBC\uFE0F Choose from gallery', value: 'gallery' },
        { label: 'Cancel', value: '' }
      ]).then(function (v) { if (v) openInput(target, v === 'camera' ? 'camera' : 'gallery'); });
    }
    openInput(target, mode);
  }
  function openInput(target, mode) {
    S.camTarget = target;
    var inp = mode === 'video' ? $('vidInput') : mode === 'camera' ? $('camInput') : $('pickInput');
    inp.value = '';
    inp.click();
  }
  function onFiles(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    var target = S.camTarget; S.camTarget = null;
    if (!files.length || !target) return;
    if (target.mode === 'add') { addShots(files); return; }
    if (target.mode === 'cfPhoto' || target.mode === 'logPhoto') { cfFiles(files, target); return; }
    var n = 0, names = [], pending = 0;
    busy('Saving to the item\u2019s folder\u2026');
    files.reduce(function (p, f) {
      return p.then(function () { return prepareFile(f); }).then(function (pf) {
        return call('uploadMedia', target.key, target.name, pf.mime, pf.b64, target.makeMain ? 'Main' : 'auto', !!target.makeMain && n === 0);
      }).then(function (r) { n++; names.push(r.fileName); if (r.pending) pending++; if (r.folderId && !r.pending) updateFolder(target.key, r.folderId); });
    }, Promise.resolve()).then(function () {
      done();
      if (S.kid) bumpKid('kidPhotos', n);
      if (pending) toast(n === 1 ? 'Nice one! ' + OWN + ' will have a look, then you get 10 points.' : 'Nice one! ' + OWN + ' will have a look at the photos.', 'good');
      else {
        toast(target.makeMain ? '\u2B50 New main photo saved. The old one is still in the folder.' : '\uD83C\uDF89 Saved ' + (n === 1 ? names[0] : n + ' files') + '. Nice one!', 'good');
        var it = itemByKey(target.key); if (it && it.folderId) forgetThumb(it.folderId);
        if (S.boot && S.boot.tiles && S.boot.tiles.photos.next && S.boot.tiles.photos.next.key === target.key) S.boot = null;
      }
      if (S.screen === 'item' || S.screen === 'kidItem') go(S.screen, S.params, true);
      else if (S.screen === 'photos' || S.screen === 'home' || S.screen === 'kid' || S.screen === 'kidStuff') { S.boot = null; go(S.screen, S.params, true); }
    }).catch(function (e) { oops(e); if (n) toast('Saved ' + n + ', but one didn\u2019t go. Try that one again from the item page.', 'oops'); });
  }
  function updateFolder(key, fid) { var it = itemByKey(key); if (it) it.folderId = fid; }
  function pointsNote(r, msg) {
    var pts = r && r.points, bit = pts > 0 ? ('+' + pts + ' point' + (pts === 1 ? '' : 's') + '!') : '';
    if (msg && bit) toast(msg + ' ' + bit, 'good');
    else if (bit) toast(bit, 'good');
    else if (msg) toast(msg, 'good');
    return pts > 0;
  }

  /* ---------------- v9: your own fields ---------------- */
  var CF_TYPES = [
    ['text', '\uD83D\uDCDD', 'Text', 'Words, like a serial number, colour or registration'],
    ['number', '\uD83D\uDD22', 'Number', 'Mileage, hours, size, how many'],
    ['date', '\uD83D\uDCC5', 'Date', 'Last serviced, MOT due, bought on'],
    ['tick', '\u2611\uFE0F', 'Tick', 'Yes or no, like Boxed, Signed or Insured'],
    ['money', '\uD83D\uDCB7', 'Money', 'Like an insured value. Private: only you see it, never Family or Kid'],
    ['photo', '\uD83D\uDCF7', 'Photo', 'One picture, like a certificate, receipt or the plate'],
    ['log', '\uD83D\uDD27', 'Log', 'Dated entries you add to over time: date, note, cost and photos. E.g. Service log, Repairs']
  ];
  function cfType(t) { for (var i = 0; i < CF_TYPES.length; i++) if (CF_TYPES[i][0] === t) return CF_TYPES[i]; return CF_TYPES[0]; }
  function cfIcon(t) { return t === 'money' ? (THEME.currency === '\u00A3' ? '\uD83D\uDCB7' : '\uD83D\uDCB0') : cfType(t)[1]; }
  function cfMoney(v) { return v === '' || v == null ? '' : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(v)) ? gbp(+v) : String(v)); }
  function cfDate(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return String(s || '');
    try { return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return s; }
  }
  function cfToday() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function cfShow(f) {
    if (f.value === '' || f.value == null) return '';
    if (f.type === 'tick') return f.value === 'Yes' ? '\u2705 Yes' : '\u2716\uFE0F No';
    if (f.type === 'money') return cfMoney(f.value);
    if (f.type === 'date') return cfDate(f.value);
    return String(f.value);
  }
  function cfFileId(u) { var m = String(u || '').match(/\/d\/([\w-]{10,})/) || String(u || '').match(/[?&]id=([\w-]{10,})/); return m ? m[1] : ''; }
  function cfOwnerish() { return !S.kid && S.role === PRIV; }
  function cfHtml(it) {
    if (S.kid) return '';
    var list = it.cf || [];
    var h = '<div class="card cfCard"><h3>\uD83E\uDDE9 Your own fields</h3>';
    if (it.offlineCopy) return h + '<p class="hint">Your own fields load when you\u2019re back online.</p></div>';
    if (!list.length) h += '<p class="hint">Make it fit your collection: add your own details as it grows, like a serial number, mileage, a private insured value, or a dated <b>Service log</b>.</p>';
    list.forEach(function (f, i) {
      if (f.type === 'log') {
        var es = f.entries || [], shown = S.cfAll === f.name ? es : es.slice(0, 4);
        h += '<div class="cfLog"><div class="cfRow"><div class="grow"><div class="cfName">' + cfIcon('log') + ' ' + esc(f.name) + '</div><div class="cfVal hint">' + (es.length ? es.length + ' entr' + (es.length === 1 ? 'y' : 'ies') : 'No entries yet') + '</div></div>' +
          '<button class="btn small green" data-act="logAdd" data-i="' + i + '">\uFF0B Add entry</button></div>' +
          shown.map(function (e, j) {
            return '<button class="logEntry" data-act="logOpen" data-i="' + i + '" data-j="' + es.indexOf(e) + '"><b>' + esc(cfDate(e.date)) + '</b>' +
              (e.note ? '<span>' + esc(e.note) + '</span>' : '') + '<small>' + (e.cost !== undefined && e.cost !== '' ? esc(cfMoney(e.cost)) + ' \u00B7 ' : '') + (e.photos && e.photos.length ? '\uD83D\uDCF7 ' + e.photos.length : '') + '</small></button>';
          }).join('') +
          (es.length > shown.length ? '<button class="btn small" data-act="logAll" data-i="' + i + '">Show all ' + es.length + '</button>' : '') + '</div>';
        return;
      }
      var v = cfShow(f);
      if (f.type === 'photo') {
        h += '<div class="cfRow"><div class="grow"><div class="cfName">' + cfIcon('photo') + ' ' + esc(f.name) + '</div>' +
          (f.value ? '<div class="cfPhoto" id="cfPh' + i + '" data-fid="' + esc(cfFileId(f.value)) + '">\u23F3</div>' : '<div class="cfVal hint">No photo yet</div>') + '</div>' +
          '<button class="btn small" data-act="cfPhoto" data-i="' + i + '">\uD83D\uDCF7 ' + (f.value ? 'Change' : 'Add') + '</button></div>';
        return;
      }
      h += '<div class="cfRow"><div class="grow"><div class="cfName">' + cfIcon(f.type) + ' ' + esc(f.name) + (f.type === 'money' ? ' <span class="hint">(private)</span>' : '') + '</div>' +
        '<div class="cfVal' + (v ? '' : ' hint') + '">' + (v ? esc(v) : 'Not filled in') + '</div></div>' +
        '<button class="btn small" data-act="cfEdit" data-i="' + i + '">' + (v ? '\u270F\uFE0F Edit' : '\uFF0B Add') + '</button></div>';
    });
    if (cfOwnerish()) h += '<div class="row" style="margin-top:10px"><button class="btn yel" style="flex:1" data-act="cfAdd">\uFF0B Add field</button>' +
      (list.length || S.cfHasRemoved ? '<button class="btn" style="flex:1" data-act="cfManage">\u2699\uFE0F Edit fields</button>' : '') + '</div>';
    else if (!list.length) h += '<p class="hint">Only ' + OWN + ' can add fields. Anyone can fill them in.</p>';
    return h + '</div>';
  }
  function cfLoadPhotos() {
    var it = S.current; if (!it || !it.cf) return;
    it.cf.forEach(function (f, i) {
      var el = $('cfPh' + i); if (!el || !el.getAttribute('data-fid')) return;
      call('getPhotoLarge', it.key, el.getAttribute('data-fid')).then(function (r) {
        var e2 = $('cfPh' + i); if (e2 && r && r.src) e2.innerHTML = '<a href="' + esc(r.url || f.value) + '" target="_blank" rel="noopener"><img alt="' + esc(f.name) + '" src="' + r.src + '"></a>';
      }).catch(function () { var e3 = $('cfPh' + i); if (e3) e3.innerHTML = '<a href="' + esc(f.value) + '" target="_blank" rel="noopener">Open photo \u2197</a>'; });
    });
  }
  function cfAgain(msg) { done(); if (msg) toast(msg, 'good'); if (S.current) go('item', { key: S.current.key }, true); }
  function cfOwnerThen(fn) {
    if (isPriv()) return fn();
    if (S.role !== PRIV) { sheet('Ask ' + OWN, '<p>Only ' + OWN + ' can add or change fields. You can still fill them in.</p>'); return; }
    confirmSheet('Unlock first', 'Adding or changing fields needs your PIN. You\u2019ll come straight back to this item.', '\uD83D\uDD13 Unlock', 'Not now').then(function (ok) {
      if (!ok || !S.current) return; S.afterPin = ['item', { key: S.current.key }]; askDadPin(PRIV);
    });
  }
  function cfAdd() {
    cfOwnerThen(function () {
      var body = '<label class="field" for="cfNew">Field name</label><input type="text" id="cfNew" maxlength="40" placeholder="e.g. Serial number, Mileage, Service log">' +
        '<p class="field">What kind?</p><div class="cfTypes">' + CF_TYPES.map(function (t, k) {
          return '<label class="cfType"><input type="radio" name="cfT" value="' + t[0] + '"' + (k === 0 ? ' checked' : '') + '><span><b>' + t[1] + ' ' + t[2] + '</b><small>' + esc(t[3]) + '</small></span></label>';
        }).join('') + '</div><p class="hint">It\u2019s added to every item in this collection, as a new column in your sheet (logs go in a Logs tab). You can rename or remove it later; nothing is ever deleted.</p>';
      sheet('\uFF0B Add a field', body, [{ label: 'Add field', value: 'add', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
        if (v !== 'add') return;
        var name = ($('cfNew') && $('cfNew').value || '').trim(), pick = document.querySelector('input[name=cfT]:checked'), type = pick ? pick.value : 'text';
        if (!name) { toast('Give the field a name first.', 'oops'); return; }
        busy('Adding the field\u2026');
        call('addField', name, type, S.role).then(function (r) { cfAgain((r.restored ? '\u21A9\uFE0F Brought back ' : '\u2705 Added ') + r.name); }).catch(oops);
      });
      setTimeout(function () { if ($('cfNew')) $('cfNew').focus(); }, 60);
    });
  }
  function cfEdit(i) {
    var it = S.current, f = it && it.cf && it.cf[i]; if (!f) return;
    var inp;
    if (f.type === 'tick') {
      return sheet(cfIcon('tick') + ' ' + f.name, '<p>For <b>' + esc(it.name) + '</b></p>', [{ label: '\u2705 Yes', value: 'Yes', cls: 'main' }, { label: '\u2716\uFE0F No', value: 'No' }, { label: 'Clear it', value: 'clear' }, { label: 'Cancel', value: '' }]).then(function (v) {
        if (!v) return; busy('Saving\u2026');
        call('setFieldValue', it.key, it.name, f.name, v === 'clear' ? '' : v, S.role).then(function () { cfAgain('\u2705 Saved'); }).catch(oops);
      });
    }
    if (f.type === 'date') inp = '<input type="date" id="cfVal" value="' + esc(f.value || '') + '">';
    else if (f.type === 'number') inp = '<input type="text" inputmode="decimal" id="cfVal" value="' + esc(f.value) + '">';
    else if (f.type === 'money') inp = '<input type="text" inputmode="decimal" id="cfVal" placeholder="' + esc(THEME.currency || '\u00A3') + '0.00" value="' + esc(f.value) + '">';
    else inp = '<textarea id="cfVal" maxlength="500">' + esc(f.value) + '</textarea>';
    sheet(cfIcon(f.type) + ' ' + f.name, '<p>For <b>' + esc(it.name) + '</b>' + (f.type === 'money' ? ' \u00B7 private, only you see it' : '') + '</p>' + inp, [{ label: '\uD83D\uDCBE Save', value: 'save', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
      if (v !== 'save') return;
      var val = $('cfVal') ? $('cfVal').value : '';
      busy('Saving\u2026');
      call('setFieldValue', it.key, it.name, f.name, val, S.role).then(function () { cfAgain('\u2705 Saved'); }).catch(oops);
    });
    setTimeout(function () { if ($('cfVal')) $('cfVal').focus(); }, 60);
  }
  function cfPhoto(i) {
    var it = S.current, f = it && it.cf && it.cf[i]; if (!f) return;
    openCamera({ mode: 'cfPhoto', key: it.key, name: it.name, field: f.name });
  }
  function cfFiles(files, target) {
    var list = target.mode === 'cfPhoto' ? files.slice(0, 1) : files, n = 0;
    busy('Saving the photo\u2026');
    list.reduce(function (p, file) {
      return p.then(function () { return prepareFile(file); }).then(function (pf) {
        if (pf.mime.indexOf('image/') !== 0) throw new Error('That one needs a photo rather than a video.');
        return target.mode === 'cfPhoto' ? call('uploadFieldPhoto', target.key, target.name, target.field, pf.mime, pf.b64, S.role)
          : call('addLogPhoto', target.entry, target.key, target.name, pf.mime, pf.b64, S.role);
      }).then(function (r) { n++; if (r && r.folderId) updateFolder(target.key, r.folderId); });
    }, Promise.resolve()).then(function () {
      var it = itemByKey(target.key); if (it && it.folderId) forgetThumb(it.folderId);
      cfAgain(n === 1 ? '\uD83D\uDCF7 Photo saved' : '\uD83D\uDCF7 ' + n + ' photos saved');
    }).catch(function (e) { oops(e); if (n) cfAgain(); });
  }
  function logAdd(i) {
    var it = S.current, f = it && it.cf && it.cf[i]; if (!f) return;
    var body = '<p>For <b>' + esc(it.name) + '</b></p><label class="field" for="lgDate">Date</label><input type="date" id="lgDate" value="' + cfToday() + '">' +
      '<label class="field" for="lgNote">What happened?</label><textarea id="lgNote" maxlength="1000" placeholder="e.g. Oil and filter changed, new belt"></textarea>' +
      (isPriv() ? '<label class="field" for="lgCost">Cost ' + esc(THEME.currency || '\u00A3') + ' (optional, private)</label><input type="text" inputmode="decimal" id="lgCost">' : '');
    sheet(cfIcon('log') + ' ' + f.name, body, [{ label: '\uD83D\uDCBE Save entry', value: 'save', cls: 'main' }, { label: '\uD83D\uDCF7 Save and add photos', value: 'photo' }, { label: 'Cancel', value: '' }]).then(function (v) {
      if (!v) return;
      var e = { date: $('lgDate') ? $('lgDate').value : '', note: $('lgNote') ? $('lgNote').value : '', cost: $('lgCost') ? $('lgCost').value : '', photoNext: v === 'photo' };
      busy('Saving\u2026');
      call('addLogEntry', it.key, it.name, f.name, e, S.role).then(function (r) {
        if (v === 'photo') { done(); openCamera({ mode: 'logPhoto', key: it.key, name: it.name, entry: r.id }); return; }
        cfAgain('\u2705 Added to ' + f.name);
      }).catch(oops);
    });
  }
  function logOpen(i, j) {
    var it = S.current, f = it && it.cf && it.cf[i], e = f && f.entries && f.entries[j]; if (!e) return;
    var body = '<p><b>' + esc(cfDate(e.date)) + '</b>' + (e.by ? ' \u00B7 added by ' + esc(e.by) : '') + '</p>' + (e.note ? '<p>' + esc(e.note) + '</p>' : '') +
      (e.cost !== undefined && e.cost !== '' ? '<p>Cost: <b>' + esc(cfMoney(e.cost)) + '</b> <span class="hint">(private)</span></p>' : '') +
      '<div class="cfPhotos">' + (e.photos || []).map(function (p, k) { return '<a class="cfPhoto" id="lgPh' + k + '" href="' + esc(p.url) + '" target="_blank" rel="noopener">\u23F3</a>'; }).join('') + '</div>' +
      '<p class="hint">To change or remove an entry, edit its row in the Logs tab of your sheet.</p>';
    sheet(cfIcon('log') + ' ' + f.name, body, [{ label: '\uD83D\uDCF7 Add a photo', value: 'photo', cls: 'main' }, { label: 'Close', value: '' }]).then(function (v) {
      if (v === 'photo') openCamera({ mode: 'logPhoto', key: it.key, name: it.name, entry: e.id });
    });
    (e.photos || []).forEach(function (p, k) {
      if (!p.id) return;
      call('getPhotoLarge', it.key, p.id).then(function (r) { var el = $('lgPh' + k); if (el && r && r.src) el.innerHTML = '<img alt="" src="' + r.src + '">'; }).catch(function () { var el = $('lgPh' + k); if (el) el.textContent = 'Open \u2197'; });
    });
  }
  function cfManage() {
    cfOwnerThen(function () {
      busy('Loading your fields\u2026');
      call('getFields', S.role).then(function (defs) {
        done();
        var on = defs.filter(function (d) { return !d.removed; }), off = defs.filter(function (d) { return d.removed; });
        S.cfDefs = defs; S.cfHasRemoved = off.length > 0;
        var row = function (d, k, live) {
          return '<div class="cfRow"><div class="grow"><div class="cfName">' + cfIcon(d.type) + ' ' + esc(d.name) + '</div><div class="cfVal hint">' + esc(cfType(d.type)[2]) + '</div></div>' +
            (live ? '<button class="btn small" data-act="cfRename" data-k="' + k + '">\u270F\uFE0F Rename</button><button class="btn small" data-act="cfRemove" data-k="' + k + '">Remove</button>'
              : '<button class="btn small green" data-act="cfRestore" data-k="' + k + '">\u21A9\uFE0F Bring back</button>') + '</div>';
        };
        sheet('\u2699\uFE0F Your fields', (on.length ? on.map(function (d) { return row(d, defs.indexOf(d), true); }).join('') : '<p class="hint">No fields yet.</p>') +
          (off.length ? '<h3 style="margin-top:14px">Removed (still in your sheet)</h3>' + off.map(function (d) { return row(d, defs.indexOf(d), false); }).join('') : '') +
          '<p class="hint">Fields belong to the whole collection. Removing one only hides it here: its column (or Logs rows) stays in your sheet.</p>',
          [{ label: '\uFF0B Add field', value: 'add', cls: 'main' }, { label: 'Done', value: '' }]).then(function (v) { if (v === 'add') cfAdd(); });
      }).catch(oops);
    });
  }
  function cfRename(k) {
    var d = (S.cfDefs || [])[k]; if (!d) return;
    sheet('\u270F\uFE0F Rename \u201C' + d.name + '\u201D', '<input type="text" id="cfRen" maxlength="40" value="' + esc(d.name) + '"><p class="hint">Renames it everywhere, including the sheet column' + (d.type === 'log' ? ' and its Logs rows' : '') + '.</p>',
      [{ label: 'Rename', value: 'ok', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
      if (v !== 'ok') return; var n = ($('cfRen') && $('cfRen').value || '').trim(); if (!n || n === d.name) return;
      busy('Renaming\u2026'); call('renameField', d.name, n, S.role).then(function (r) { cfAgain('\u2705 Renamed to ' + r.name); }).catch(oops);
    });
  }
  function cfRemove(k) {
    var d = (S.cfDefs || [])[k]; if (!d) return;
    confirmSheet('Remove \u201C' + esc(d.name) + '\u201D?', 'It disappears from the app for every item. Nothing is deleted: the ' + (d.type === 'log' ? 'Logs rows stay' : 'column stays') + ' in your sheet, and you can bring it back from \u2699\uFE0F Edit fields.', 'Remove it', 'Keep it').then(function (ok) {
      if (!ok) return; busy('Removing\u2026'); S.cfHasRemoved = true;
      call('removeField', d.name, S.role).then(function () { cfAgain('Removed ' + d.name + ' (still in your sheet)'); }).catch(oops);
    });
  }
  function cfRestore(k) {
    var d = (S.cfDefs || [])[k]; if (!d) return;
    busy('Bringing it back\u2026'); call('addField', d.name, d.type, S.role).then(function (r) { cfAgain('\u21A9\uFE0F ' + r.name + ' is back'); }).catch(oops);
  }

  /* ---------------- help text ---------------- */
  var HELP = {
    home: ['This is your to-do board.', '\u201CDo I own it?\u201D at the top: type any name and it tells you straight away. Or tap \uD83D\uDCF7 Scan and point at a box\u2019s barcode.', 'Each box has one button that sorts that job out. Start with whichever has the biggest number.', 'No signal? The app shows the copy saved on the phone and syncs your changes later.'],
    collection: ['Everything you own, with the newest photo of each.', 'Type in the search box or use the three filters (range, status, condition).', 'Tap any picture to open it.'],
    item: ['This is one item.', 'Tap \u201CAdd photo / video\u201D to use the camera - it saves straight into the item\u2019s own Drive folder.', 'Documents (manuals, receipts, certificates) live under the photos. Receipts and valuations are owner-only.', 'Tap a photo to see it big, or make it the main photo. Videos play here in the app (Open in Drive is still there if you need it).', 'Tap \u201CEdit details\u201D to fix the name, category, condition and so on.', 'Tap a platform under \u201CPosted on\u201D once it\u2019s been posted.', '\uFF0B Add field (under \u201CYour own fields\u201D) adds your own details to every item: text, number, date, tick, private money, a photo, or a dated log like a Service log. Only ' + PRIV + ' can add or rename fields; anyone (not Kid mode) can fill them in. Removing a field only hides it - the sheet keeps the data.'],
    edit: ['Change anything, then tap Save.', 'Year is just the 4 numbers, like 1999. Anything else goes in Year note.', 'Nothing gets deleted from here - the worst that can happen is a typo you can fix.'],
    add: ['Four quick steps: photo, name, range, condition.', 'On the name step you can scan or type the barcode so it\u2019s saved with the new item.', 'If we find a match we\u2019ll fill the name, maker and range for you to check. A catalogue picture is a reference only — it is never saved as our photo.', 'Everything else is optional - you can add it later.', 'If it looks like you already have it, I\u2019ll ask before adding a second one.'],
    wanted: ['Things you\u2019re hunting for.', 'Got one? Tap \u201CGot it\u201D and it moves into the collection (I\u2019ll check first).'],
    checklists: ['How close you are to each full set.', 'Tap a set to see what\u2019s missing.'],
    checklist: ['Green = got it. The rest are still missing.', 'Tap \u201CGot it\u201D to tick one off - I\u2019ll check first.'],
    value: ['Private: only for ' + PRIV + '.', 'Totals, top 10 and paid vs value. These are estimates, mostly from sold prices.'],
    photos: ['Items that still need our own photos.', 'Tap \u201CTake photo\u201D and it goes straight into that item\u2019s folder.', 'Remember: no faces or people in shot.'],
    novalue: ['Items without a value yet.', 'Tap \u201CAdd value\u201D to type your best guess.'],
    settings: [isSolo() ? 'Lock your money view, add family or a kid, take the tour again, or open the sheet and Drive folders.' : 'Switch between ' + THEME.roles.join(', ') + ', take the tour again, or open the sheet and Drive folders.'],
    rewards: ['Kid points and rewards live here.', 'Photos added in Kid mode wait for you to say yes (that\u2019s when the 10 points land). Nothing is deleted if you say no.', 'Approve a reward with your PIN each time. You can add or switch off rewards; money words are not allowed.'],
    kidRewards: ['You earn points for photos (once ' + OWN + ' says yes), ticking things off, and new finds.', 'Ask ' + OWN + ' for a reward when you have enough points. Hidden or secret things never earn points, and there are never prices here.'],
    more: ['Everything else lives here: stats, posted on socials, spares, the missing list, export and help.', 'Tap any big button.'],
    stats: ['Totals and charts for the whole collection.', 'Money only shows for ' + PRIV + '.'],
    posted: ['What\u2019s been posted on socials, and what hasn\u2019t yet.', 'Tap an item, then tap a platform button to tick it.'],
    spares: ['Things you have more than one of.', 'Tap \u201CMark for sale\u201D on the copy you\u2019d sell. Nothing is deleted.'],
    history: ['When each thing joined the collection, newest first.', 'Items with no date are at the bottom.'],
    missing: ['Everything still needed from every full-set checklist.', 'Search, or pick one checklist. Tap \u201CGot it\u201D to tick one off.'],
    export: ['Save a list into Drive as a spreadsheet file (CSV) or a PDF.', 'Filter in Collection first to export just some items.'],
    help: ['All the help topics are on this page.', 'Tap a topic to open it, or take the tour.']
  };
  function showHelp() {
    var _sheet = sheet; sheet = function (t, b, btns) { sheet = _sheet; return _sheet(t, b, (btns || []).filter(Boolean)); };
    var lines = HELP[S.screen] || HELP.home;
    var body = '<ul>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      '<p class="hint">Still stuck? Nothing you do here deletes anything, so it\u2019s safe to try. If something looks wrong, tap Refresh, or ask your bot.</p>';
    sheet('Here\u2019s how this bit works', body, [
      { label: '\u21BB Refresh', value: 'refresh' },
      { label: '\uD83E\uDDED Take the tour', value: 'tour' },
      { label: '\u2753 All help topics', value: 'help' },
      { label: 'Show the first-day guide', value: 'guide' },
      isSolo() ? null : { label: 'Switch user', value: 'who' },
      { label: 'Got it, thanks', value: 'ok', cls: 'main' }
    ]).then(function (v) {
      if (v === 'refresh') { S.boot = null; thumbsRefresh(); go(S.screen || 'home', S.params, true); }
      if (v === 'guide') go('guide', { i: 0 });
      if (v === 'tour') { LS.set('tourPending', '1'); go('home', {}, true); }
      if (v === 'help') go('help');
      if (v === 'who') go('who');
    });
  }

  /* ---------------- screens ---------------- */
  var SCREENS = {};

  /* ================= v4: Kid mode (big tiles, photos, no money, nothing Christmassy) ================= */
  var KID_ROLE = (function () { var k = (THEME.people || []).filter(function (p) { return p.role === 'Kid'; })[0]; return k ? k.name : 'Kid'; })();
  function roleKind(name) { var p = (THEME.people || []).filter(function (x) { return x.name === name; })[0]; return p ? p.role : (name === PRIV ? 'Owner' : 'Family'); }
  function isSolo() { return (THEME.roles || []).length <= 1; }
  function hasKid() { return !!(THEME.hasKid || (THEME.people || []).some(function (p) { return p.role === 'Kid'; })); }
  function kidsAddonOn() { return THEME.kidsAddon !== false; }
  /* Kid surfaces only when a Kid person exists (and the Family add-on flag is on; default on, not payment-locked yet). */
  function showKidFeatures() { return kidsAddonOn() && hasKid(); }
  var KID_SCREENS = ['kid', 'kidStuff', 'kidItem', 'kidHunt', 'kidBadges', 'kidRewards', 'kidNotes', 'pin', 'add'];
  function enterKid() {
    if (!showKidFeatures()) { toast('Add a kid under Settings first, then Kid mode and rewards will show up.'); return; }
    LS.set('kidPrevRole', S.role || '');
    clearDadToken();                    // money needs the PIN again after Kid mode
    S.kid = true; LS.set('kidMode', '1');
    S.role = KID_ROLE; LS.set('role', KID_ROLE);
    S.boot = null; S.items = []; S.homeWanted = null; S.history = []; S.add = null;
    S.kidGreeting = true;
    pickFunUnitRandom();
    pickJokeOnOpen();
    recordBadgeVisit();
    go('kid', {}, true);
  }
  function exitKid() {
    sheet('Back to the full app?', '<p>' + (THEME.needsPin ? 'Grown-ups only: it needs ' + esc(PRIV) + '\u2019s PIN.' : 'Switch back to the full view?') + '</p>',
      [{ label: '\uD83D\uDD13 Yes, full app', value: true, cls: 'main' }, { label: 'Stay in ' + KID_ROLE + '\u2019s mode', value: false }]).then(function (ok) {
      if (!ok) return;
      if (THEME.needsPin) { S.kidExit = true; askDadPin(PRIV); }
      else leaveKid(LS.get('kidPrevRole') || PRIV);
    });
  }
  function leaveKid(role) {
    S.kid = false; S.kidExit = false; LS.set('kidMode', ''); S.boot = null; S.homeWanted = null;
    enterRole(role);
  }
  function kidItems() {
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    return (S.items || []).filter(function (it) { return isOwned(it) && kidSafe(it); }).sort(function (a, b) { return idn(b) - idn(a); });   // newest finds first
  }
  function kidTile(it) {
    return '<button class="ktile" data-act="kidItem" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<span class="kname">' + esc(it.name) + '</span></button>';
  }
  SCREENS.kid = function () {
    loadBoot().then(function () {
      var mine = kidItems();
      var h = '<div class="kidHead"><div class="mascot small">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteK') + '</div><h1>Hiya ' + esc(KID_ROLE === 'Kid' ? 'there' : KID_ROLE) + ' \uD83D\uDC4B</h1></div>' +
        jokeHtml() +
        funWorthHtml() +
        '<div class="kfeatures">' +
        '<button type="button" class="kfeature pinkL" data-act="go" data-to="kidBadges"><span>\uD83C\uDFC6</span><span class="kfeatTxt"><b>My badges</b><small id="kidBadgeN">see what you\u2019ve earned</small></span></button>' +
        '<div id="kidMissions"></div>' +
        '<button type="button" class="kfeature yel" data-act="go" data-to="kidRewards"><span>\u2B50</span><span class="kfeatTxt"><b>My points</b><small id="kidPtsN">earn rewards!</small></span></button>' +
        '<div id="kidJobs"></div>' +
        '<div id="kidEarn"></div>' +
        '</div>' +
        '<div class="ownCard card"><label class="ownLabel" for="kidSearch">\uD83D\uDD0D Have we got it?</label><input id="kidSearch" class="ownInput" type="search" placeholder="Type a name\u2026" autocomplete="off"><div id="kidOwnOut"></div></div>' +
        '<div class="kgrid">' +
        '<button class="kbig yel" data-act="go" data-to="kidStuff"><span>\uD83E\uDDF8</span><b>Our stuff</b><small>' + mine.length + ' things</small></button>' +
        '<button class="kbig pink" data-act="go" data-to="kidHunt"><span>\u2B50</span><b>On the hunt</b><small id="kidHuntN">find these!</small></button>' +
        '<button class="kbig skyL" data-act="scan"><span>\uD83D\uDCF7</span><b>Scan a box</b><small>have we got it?</small></button>' +
        '<button class="kbig green" data-act="kidNew"><span>\u2795</span><b>New find!</b><small>snap it and save it</small></button>' +
        (hasLetter() ? '<button class="kbig paper" data-act="letterOpen"><span>\u2709\uFE0F</span><b>Letter from ' + esc(PRIV) + '</b><small>' + esc(DAD_LETTER.title) + '</small></button>' : '') +
        '<button class="kbig paper" data-act="notesOpen"><span>\uD83D\uDCDD</span><b>Notes for you</b><small>little messages</small></button>' +
        '</div>' +
        '<div class="center" style="margin-top:18px"><button class="btn small" data-act="kidExit">\uD83D\uDD13 Grown-ups: full app</button></div>';
      setMain(h);
      bindOwnSearch('kidSearch', 'kidOwnOut');
      checkNewBadges().then(function (B) { var n = B.filter(function (b) { return b.got; }).length; if ($('kidBadgeN')) $('kidBadgeN').textContent = n + ' badge' + (n === 1 ? '' : 's') + ' so far!'; paintMissions(B); }).catch(noop);
      loadHomeWanted().then(function (w) { var n = w.filter(function (x) { return kidSafe(x); }).length; if ($('kidHuntN')) $('kidHuntN').textContent = n + ' to find!'; });
      loadRewards(true).then(function (r) { if ($('kidPtsN') && r) $('kidPtsN').textContent = r.balance + ' points \u00B7 ' + ((r.level && r.level.name) || ''); try { paintJobs(r); } catch (eJ) {} try { paintEarnPoints(r); } catch (eE) {} }).catch(noop);
      recordBadgeVisit();
      maybeShowLetter();
      bindFunSwipe();
    }).catch(oops);
  };
  SCREENS.kidStuff = function () {
    loadBoot().then(function () {
      var all = kidItems(), q = S.kidQ || '';
      var h = '<h1>\uD83E\uDDF8 Our stuff</h1><div class="search"><input id="kidQ" type="search" class="ownInput" placeholder="\uD83D\uDD0D Find something\u2026" value="' + esc(q) + '" autocomplete="off"></div><div id="kidGrid"></div>';
      setMain(h);
      var draw = function () {
        var list = q ? fuzzyFind(q, all, 60).map(function (x) { return x.it; }) : all.filter(function (it) { return it.folderId; }).concat(all.filter(function (it) { return !it.folderId; }));
        var shown = list.slice(0, S.kidShown || 40);
        $('kidGrid').innerHTML = '<p class="hint">' + list.length + ' thing' + (list.length === 1 ? '' : 's') + (q ? ' found' : ' - tap one to see it or add a photo') + '</p><div class="kstuff">' + shown.map(kidTile).join('') + '</div>' +
          (list.length > shown.length ? '<p class="center"><button class="btn" data-act="kidMore">Show more</button></p>' : '');
        watchThumbs();
      };
      var t = null;
      $('kidQ').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { q = S.kidQ = e.target.value; S.kidShown = 40; draw(); }, 150); });
      S.redrawKid = draw; draw();
    }).catch(oops);
  };
  SCREENS.kidItem = function (p) {
    loadBoot().then(function () {
      var it = itemByKey(p.key);
      if (!it || !kidSafe(it)) { go('kidStuff', {}, true); return; }
      S.current = it;
      var t = it.folderId ? S.thumbs[it.folderId] : null;
      var heroWrap;
      if (it.folderId) {
        var hero = t ? '<img alt="" src="' + t + '">' : thumbInner(it.folderId);
        heroWrap = '<div class="khero" id="kHero" data-act="heroOpen" data-fid="' + esc(it.folderId) + '" role="button">' + hero + '</div>';
      } else if (standinUrl(it)) {
        heroWrap = standinBlock(it, 'khero', ' id="kHero"');
      } else {
        heroWrap = '<div class="khero" id="kHero">' + noPhotoHtml(false) + '</div>';
      }
      var h = backBtn() + '<div class="card center kidItem">' + heroWrap +
        '<h1>' + esc(it.name) + '</h1><div class="chips" style="justify-content:center">' + [it.range, it.character, it.year].filter(function (x) { return x && !/^unknown$/i.test(x); }).map(function (x) { return '<span class="chip on">' + esc(x) + '</span>'; }).join('') + '</div>' +
        '<div id="kGallery" class="gallery kidGal"></div>' +
        '<div class="stack" style="margin-top:14px"><button class="btn main full kbtn" data-act="kidSnap">\uD83D\uDCF7 Add a photo</button>' +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full kbtn" data-act="kidGotItem">\uD83C\uDF89 We got it!</button>' : '<div class="pill green" style="font-size:18px;padding:6px 14px">\u2705 We\u2019ve got this!</div>') +
        '</div></div>';
      setMain(h);
      if (it.folderId) {
        watchThumbs();
        call('getItemPhotos', it.folderId).then(function (ph) {
          S.gallery = ph || [];
          paintKidItemMedia();
          var f = S.gallery.filter(function (x) { return x.thumb; })[0];
          if (f && $('kHero') && typeof S.thumbs[it.folderId] !== 'string') {
            shrinkThumb(f.thumb).then(function (s) { if (s && $('kHero')) { S.thumbs[it.folderId] = s; paintThumb(it.folderId); paintKidItemMedia(); } });
          }
        }).catch(noop);
      }
    }).catch(oops);
  };
  function paintKidItemMedia() {
    var hero = $('kHero'), box = $('kGallery'), list = S.gallery || [];
    if (hero && list.length) {
      hero.setAttribute('data-act', 'heroOpen');
      hero.setAttribute('role', 'button');
      var first = list[0];
      hero.classList.toggle('hasVideo', !!first.video);
      if (first.video && !hero.querySelector('.playIc')) hero.insertAdjacentHTML('beforeend', playBadgeHtml());
      if (!first.video) {
        var ic = hero.querySelector('.playIc'); if (ic && ic.parentNode) ic.parentNode.removeChild(ic);
      }
    }
    if (box) {
      box.innerHTML = list.length ? list.map(function (x, i) { return galleryThumbHtml(x, i); }).join('') : '';
    }
  }
  SCREENS.kidHunt = function () {
    busy('Getting the hunt list\u2026');
    loadHomeWanted().then(function (list) {
      done();
      var kl = list.filter(function (w) { return kidSafe(w); });
      S.kidWanted = kl;
      setMain('<h1>\u2B50 On the hunt</h1><p class="hint">Spotted one? Tap \u201CFound it!\u201D</p>' + renderWantedGroups(kl, true));
    }).catch(oops);
  };
  function kidGot(i) {
    var w = (S.kidWanted || [])[i]; if (!w) return;
    var fromList = w.kind === 'checklist';
    confirmSheet('Found it? \uD83C\uDF89', fromList ? 'Did we get <b>' + esc(w.name) + '</b>? I\u2019ll tick it off the hunt list.' : 'Did we get <b>' + esc(w.name) + '</b>? It\u2019ll go into our collection.', 'Yes, we got it!', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy(fromList ? 'Ticking it off\u2026' : 'Adding it to our stuff\u2026');
      return call('markGotIt', w.kind, w.ref, w.name, KID_ROLE).then(function (r) {
        done(); bumpKid('kidFound'); S.boot = null; S.homeWanted = null;
        pointsNote(r, r.queued ? '\uD83C\uDF89 Got it! It\u2019ll save when there\u2019s signal.' : (fromList || r.suggestAdd ? '\uD83C\uDF89 Brilliant! Ticked off the hunt list.' : '\uD83C\uDF89 Brilliant! It\u2019s in our collection.'));
        return confirmSheet('Take a photo?', 'Snap <b>' + esc(r.name || w.name) + '</b> now? (No faces - hands are fine.)', '\uD83D\uDCF7 Take photo', 'Later').then(function (snap) {
          if (snap && r.key) openCamera({ key: r.key, name: r.name || w.name });
          else go('kidHunt', {}, true);
        });
      });
    }).catch(oops);
  }


  /* ================= v7: letter from owner + points / rewards ================= */
  /* The letter is written by the owner in Settings ("Kid welcome letter"); no letter = no tile and no pop-up. */
  var DAD_LETTER = {
    title: THEME.kidLetterTitle || 'A letter for you',
    paras: String(THEME.kidLetter || '').split(/\n\s*\n|\s*\|\s*/).map(function (s) { return s.trim(); }).filter(Boolean),
    sign: '',
    from: (PRIV || 'Me') + ' x',
    note: ''
  };
  function hasLetter() { return DAD_LETTER.paras.length > 0; }
  function londonDay() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function fillDadLetter() {
    var box = $('letterInner'); if (!box) return;
    box.innerHTML = '<h1 id="letterTitle">' + esc(DAD_LETTER.title) + '</h1>' +
      DAD_LETTER.paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') +
      '<div class="letterSign">' + (DAD_LETTER.sign ? '<p class="love">' + esc(DAD_LETTER.sign) + '</p>' : '') + '<p class="signFrom">' + esc(DAD_LETTER.from) + '</p></div>';
  }
  function showDadLetter(force) {
    fillDadLetter();
    var el = $('dadLetter'); if (!el) return;
    var wasOpen = !el.hidden;
    el.hidden = false;
    dressOverlay(el);
    bumpKid('kidDadReads');
    layerOpen(wasOpen);
    try { var b = el.querySelector('.letterGo'); if (b) b.focus(); } catch (e) { /* ignore */ }
  }
  var LETTER_EVERY_DAYS = 10;
  function londonDayDiff(fromIso, toIso) {
    var a = String(fromIso || '').split('-').map(Number);
    var b = String(toIso || '').split('-').map(Number);
    if (a.length < 3 || b.length < 3 || !a[0] || !b[0]) return null;
    var ms = Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2]);
    return Math.round(ms / 86400000);
  }
  function letterLastShown() {
    return LS.get('kidLetterShown') || LS.get('kidLetterDay') || '';
  }
  function markLetterShown() {
    var d = londonDay();
    LS.set('kidLetterShown', d);
    LS.set('kidLetterDay', d);
  }
  function letterDue() {
    var last = letterLastShown();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return true;
    var n = londonDayDiff(last, londonDay());
    return n == null || n >= LETTER_EVERY_DAYS;
  }
  function hideDadLetter() {
    var el = $('dadLetter'); if (el) { el.hidden = true; el.classList.remove('popIn'); }
    markLetterShown();
  }
  function bumpKidNoteCount() {
    var n = parseInt(LS.get('kidNoteVisits') || '0', 10);
    if (!(n >= 0)) n = 0;
    n += 1;
    if (n >= 5) {
      LS.set('kidNoteVisits', '0');
      return true;
    }
    LS.set('kidNoteVisits', String(n));
    return false;
  }
  function maybeShowLetter() {
    if (!S.kid) return;
    var greeting = !!S.kidGreeting;
    S.kidGreeting = false;
    if (!greeting) return;
    if (hasLetter() && letterDue()) { markLetterShown(); showDadLetter(false); return; }
    if (bumpKidNoteCount()) showDadNote();
  }

  /* Notes the owner wrote in Settings ("Kid notes", one per line), else friendly general ones. */
  var DAD_NOTES = (THEME.kidNotes && THEME.kidNotes.length) ? THEME.kidNotes.slice(0, 60) : [
    'Proud of you. Always.',
    'Every shelf in this house has a bit of you on it.',
    'Gentle hands with the boxes. Some of these are older than you!',
    "You've got a great eye for a bargain.",
    'Got a new photo to take? Go get it, Collector Pro!',
    'The best thing in this collection is you.',
    "Keep being curious. That's what real collectors do.",
    'Thanks for being my best collecting buddy.',
    'Look after them and they will last for ever.',
    'You spotted something I missed last time. Nice one!'
  ];
  function noteHasSign(t) { return /\sx\s*$/.test(String(t || '')); }
  function notesSeen() {
    try {
      var a = JSON.parse(LS.get('kidNotesSeen') || '[]');
      return Array.isArray(a) ? a.map(Number).filter(function (n) { return n >= 0 && n < DAD_NOTES.length; }) : [];
    } catch (e) { return []; }
  }
  function nextNoteIndex() {
    var seen = notesSeen();
    if (seen.length >= DAD_NOTES.length) { LS.set('kidNotesSeen', '[]'); seen = []; }
    for (var i = 0; i < DAD_NOTES.length; i++) if (seen.indexOf(i) < 0) return i;
    return 0;
  }
  function markNoteSeen(i) {
    var a = notesSeen();
    if (a.indexOf(i) < 0) a.push(i);
    LS.set('kidNotesSeen', JSON.stringify(a));
  }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function dressOverlay(el) {
    if (!el) return;
    var sky = el.querySelector('.letterSky');
    if (sky && !sky.innerHTML) sky.innerHTML = cloudsSvg();
    el.classList.remove('popIn');
    try { void el.offsetWidth; } catch (e) {}
    el.classList.add('popIn');
  }
  function noteEmojiFor(t) {
    var s = String(t || '').toLowerCase();
    var rules = [
      [/tractor|farm/, '\uD83D\uDE9C'],
      [/photo|camera|snap/, '\uD83D\uDCF7'],
      [/ebay|bargain/, '\uD83E\uDD1D'],
      [/curious|treasure|hunt|find/, '\uD83D\uDD0D'],
      [/saturday|morning/, '\u2600\uFE0F'],
      [/shelf|house|yours/, '\uD83C\uDFE0']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
    return Math.random() < 0.5 ? '\u2764\uFE0F' : '\u2B50';
  }
  var NOTE_BYE = [
    'Aww thanks!', 'Woohoo!', 'Love you too!', 'Got it, boss!', 'Ha-ha!', 'Nice one!', 'You bet!', 'Too right!', 'Ace!', 'Brilliant!',
    'Cracking!', 'Love a note!', 'Noted!', 'Right you are!', 'On it!', 'Cool beans!', 'Let\u2019s go!', 'Thank you!'
  ];
  var NOTE_CHASE_SAY = ['Too slow!', 'Missed me!', 'Over here!', 'Nearly!', 'Heh heh!', 'Try again!', 'Catch me!'];
  var NOTE_UI = { chase: false, need: 0, got: 0, skipTimer: 0, fromPointer: 0 };
  function clearNoteChase() {
    NOTE_UI.chase = false; NOTE_UI.need = 0; NOTE_UI.got = 0;
    if (NOTE_UI.skipTimer) { clearTimeout(NOTE_UI.skipTimer); NOTE_UI.skipTimer = 0; }
    var btn = $('noteGoBtn') || document.querySelector('#dadNote [data-act="noteGo"]');
    if (btn) {
      btn.style.position = ''; btn.style.left = ''; btn.style.top = '';
      btn.style.right = ''; btn.style.bottom = ''; btn.style.margin = '';
      btn.style.width = ''; btn.style.maxWidth = '';
      btn.classList.remove('noteWobble');
    }
    var skip = $('noteSkip'); if (skip) skip.hidden = true;
    var cap = $('noteChaseSay'); if (cap) cap.hidden = true;
  }
  function setupNoteButton() {
    clearNoteChase();
    var btn = $('noteGoBtn') || document.querySelector('#dadNote [data-act="noteGo"]');
    if (btn) btn.textContent = NOTE_BYE[Math.floor(Math.random() * NOTE_BYE.length)];
    if (btn && !btn.getAttribute('data-note-bound')) {
      btn.setAttribute('data-note-bound', '1');
      btn.addEventListener('pointerdown', function (e) {
        if (e.button != null && e.button !== 0) return;
        NOTE_UI.fromPointer = Date.now();
        if (e.cancelable) e.preventDefault();
        onNoteGo(e);
      });
    }
    NOTE_UI.chase = !reducedMotion() && Math.random() < 1 / 3;
    if (NOTE_UI.chase) {
      NOTE_UI.need = 2 + Math.floor(Math.random() * 3);
      NOTE_UI.got = 0;
      NOTE_UI.skipTimer = setTimeout(function () { var sk = $('noteSkip'); if (sk) sk.hidden = false; }, 5000);
    }
  }
  function jumpNoteButton() {
    var wrap = $('dadNote'), btn = $('noteGoBtn') || (wrap && wrap.querySelector('[data-act="noteGo"]'));
    if (!wrap || !btn) return;
    var vv = window.visualViewport;
    var vx = (vv && vv.offsetLeft) || 0, vy = (vv && vv.offsetTop) || 0;
    var vw = (vv && vv.width) || window.innerWidth, vh = (vv && vv.height) || window.innerHeight;
    var padX = 12, padTop = 16, padBot = 16;
    try {
      var cs = getComputedStyle(wrap);
      padTop = Math.max(16, parseFloat(cs.paddingTop) || 0);
      padBot = Math.max(16, parseFloat(cs.paddingBottom) || 0);
      padX = Math.max(12, parseFloat(cs.paddingLeft) || 0);
    } catch (e) {}
    var bw = btn.offsetWidth, bh = btn.offsetHeight;
    var minL = vx + padX, minT = vy + padTop;
    var maxL = vx + vw - bw - padX, maxT = vy + vh - bh - padBot;
    if (maxL < minL) maxL = minL;
    if (maxT < minT) maxT = minT;
    var left, top, tries = 0, cur = btn.getBoundingClientRect();
    do {
      left = minL + Math.random() * (maxL - minL);
      top = minT + Math.random() * (maxT - minT);
      tries++;
    } while (tries < 10 && Math.hypot(left - cur.left, top - cur.top) < Math.min(90, Math.max(40, (maxL - minL) / 3)));
    btn.style.position = 'fixed';
    btn.style.margin = '0';
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    btn.style.width = bw + 'px';
    btn.style.maxWidth = 'calc(100vw - 24px)';
    btn.classList.remove('noteWobble');
    try { void btn.offsetWidth; } catch (e2) {}
    btn.classList.add('noteWobble');
    var cap = $('noteChaseSay');
    if (cap) {
      cap.textContent = NOTE_CHASE_SAY[Math.floor(Math.random() * NOTE_CHASE_SAY.length)];
      cap.hidden = false;
      var capW = 130;
      cap.style.left = Math.round(Math.min(vx + vw - capW - 8, Math.max(vx + 8, left))) + 'px';
      cap.style.top = Math.round(Math.max(vy + padTop, top - 34)) + 'px';
    }
  }
  function onNoteGo(e) {
    if (NOTE_UI.chase) {
      NOTE_UI.got += 1;
      if (NOTE_UI.got < NOTE_UI.need) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        jumpNoteButton();
        return;
      }
    }
    thanksDadNote();
  }
  function thanksDadNote() {
    clearNoteChase();
    sprinkleConfetti($('dadNote'), function () {
      if (NAV.pushed > 0) layerBack(); else hideDadNote();
    });
  }
  function sprinkleConfetti(root, done) {
    if (!root || reducedMotion()) { if (done) done(); return; }
    var box = root.querySelector('.noteSprinkles');
    if (!box) { box = document.createElement('div'); box.className = 'noteSprinkles'; root.appendChild(box); }
    box.innerHTML = '';
    var colors = ['#F4A0B5', '#FFC971', '#FFFFFF', '#E4572E', '#24304A', '#7BD389'];
    var wr = root.getBoundingClientRect();
    var cx = wr.width / 2, cy = wr.height * 0.62;
    for (var i = 0; i < 28; i++) {
      var d = document.createElement('span');
      d.className = 'noteSprinkle';
      d.style.left = cx + 'px';
      d.style.top = cy + 'px';
      d.style.background = colors[i % colors.length];
      var ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 150;
      d.style.setProperty('--sx', (Math.cos(ang) * dist) + 'px');
      d.style.setProperty('--sy', (Math.sin(ang) * dist) + 'px');
      box.appendChild(d);
    }
    setTimeout(function () { box.innerHTML = ''; if (done) done(); }, 720);
  }

  function showDadNote(idx) {
    var fromList = arguments.length > 0 && idx != null;
    var i = fromList ? +idx : nextNoteIndex();
    if (!(i >= 0 && i < DAD_NOTES.length)) return;
    var el = $('dadNote'); if (!el) return;
    var t = DAD_NOTES[i];
    if ($('noteBody')) $('noteBody').textContent = t;
    var emo = $('noteEmoji'); if (emo) emo.textContent = noteEmojiFor(t);
    var sign = $('noteSign'); if (sign) sign.hidden = noteHasSign(t);
    var wasOpen = !el.hidden;
    el.hidden = false;
    dressOverlay(el);
    setupNoteButton();
    bumpKid('kidDadReads');
    layerOpen(wasOpen);
    if (!fromList) markNoteSeen(i);
    try { var b = el.querySelector('[data-act="noteGo"]'); if (b) b.focus(); } catch (e) { /* ignore */ }
  }
  function hideDadNote() {
    clearNoteChase();
    var el = $('dadNote');
    if (el) { el.hidden = true; el.classList.remove('popIn'); var sp = el.querySelector('.noteSprinkles'); if (sp) sp.innerHTML = ''; }
  }
  SCREENS.kidNotes = function () {
    var h = backBtn() + '<h1>\uD83D\uDCDD Notes for you</h1><p class="hint">Little notes left for you' + (hasLetter() ? '. The big letter is still under Letter from ' + esc(PRIV) : '') + '.</p>' +
      DAD_NOTES.map(function (t, i) {
        return '<button type="button" class="noteLi" data-act="noteOpen" data-i="' + i + '"><p>' + esc(t) + '</p>' +
          (noteHasSign(t) ? '' : '<p class="noteLiSign">' + esc((PRIV || 'Me') + ' x') + '</p>') + '</button>';
      }).join('');
    setMain(h);
  }

  var JOKES = [
    { q: "What do you call a boomerang that won't come back?", a: "A stick." },
    { q: "What's orange and sounds like a parrot?", a: "A carrot." },
    { q: "Why did the bicycle fall over?", a: "It was two-tyred." },
    { q: "What do you call cheese that isn't yours?", a: "Nacho cheese." },
    { q: "Why don't eggs tell jokes?", a: "They'd crack each other up." },
    { q: "What do you call a bear with no teeth?", a: "A gummy bear." },
    { q: "What did the ocean say to the beach?", a: "Nothing, it just waved." },
    { q: "Why was the broom late?", a: "It over-swept." },
    { q: "What do you call a fake noodle?", a: "An impasta." },
    { q: "Why did the cookie go to the doctor?", a: "It felt crumby." },
    { q: "What has hands but can't clap?", a: "A clock." },
    { q: "Why can't your nose be 12 inches long?", a: "Because then it would be a foot." },
    { q: "What do you call a sleeping bull?", a: "A bulldozer." },
    { q: "Why did the golfer bring two pairs of trousers?", a: "In case he got a hole in one." },
    { q: "What do you call a pile of cats?", a: "A meowtain." },
    { q: "Why did the tomato blush?", a: "Because it saw the salad dressing." },
    { q: "What's brown and sticky?", a: "A stick." },
    { q: "Why was six afraid of seven?", a: "Because seven eight nine." },
    { q: "What do you call a fly without wings?", a: "A walk." },
    { q: "Why did the calendar get stressed?", a: "Its days were numbered." },
    { q: "What do you call a song sung in a car?", a: "A cartoon." },
    { q: "What do you call an alligator in a vest?", a: "An investigator." },
    { q: "Why are frogs so happy?", a: "They eat whatever bugs them." },
    { q: "What do you call a pig that does karate?", a: "A pork chop." },
    { q: "Why did the cow become an astronaut?", a: "To visit the moooon." },
    { q: "What do you call a magic dog?", a: "A labracadabrador." },
    { q: "Why do bees have sticky hair?", a: "They use honeycombs." },
    { q: "How do you stop a bull from charging?", a: "Take away its credit card." },
    { q: "What do you call a fish with no eyes?", a: "A fsh." },
    { q: "Why did the banana go to the doctor?", a: "It wasn't peeling well." },
    { q: "Why did the tea bag go to school?", a: "It wanted to be a brew-n medallist." },
    { q: "Why did the milk go to school?", a: "To become a little cultured." },
    { q: "What do you call cheese at a football match?", a: "A little cheer-dar." },
    { q: "Why was the maths book so sad?", a: "It had too many problems." },
    { q: "What is a teacher's favourite tea?", a: "Proper-tea." },
    { q: "Why did the student eat his homework?", a: "The teacher said it was a piece of cake." },
    { q: "What's a maths teacher's favourite season?", a: "Sum-mer." },
    { q: "Why did the teacher wear sunglasses?", a: "Her pupils were so bright." },
    { q: "Why did the boy bring a ladder to school?", a: "He wanted to go to high school." },
    { q: "Why did the goldfish go to school?", a: "To swim to the top of the class." },
    { q: "Why did the teddy go to school?", a: "To become a stuffed-with-knowledge bear." },
    { q: "Why did the crayon go to school?", a: "It wanted to draw attention, very politely." },
    { q: "Why did the school bell blush?", a: "It had just been rung in front of everyone." },
    { q: "Why did the owl make a great teacher?", a: "Because it was a little wise and very patient." },
    { q: "Why did the apple go to school?", a: "It wanted to become a little core-educated." },
    { q: "What did one crayon say to the other?", a: "You're looking very bright today." },
    { q: "Why did the present go to school?", a: "It wanted to be well wrapped up in knowledge." },
    { q: "Why did the stadium get so hot?", a: "All the fans were in it." },
    { q: "Why did the footballer take a pencil to the match?", a: "So he could draw a foul." },
    { q: "Why was the football team so cool?", a: "They had lots of fans." },
    { q: "I used to be a goalkeeper.", a: "But I let myself down." },
    { q: "Why did the player bring string to the game?", a: "To tie the score." },
    { q: "What's a ghost's favourite position?", a: "Ghoul-keeper." },
    { q: "Why did the football go to school?", a: "To get a little more kick out of class." },
    { q: "Why did the referee go to the optician?", a: "He kept missing the offside." },
    { q: "How do footballers stay cool?", a: "They stand next to the fans." },
    { q: "Why did the striker bring a torch?", a: "It was a late kick-off." },
    { q: "Why was the pitch so well behaved?", a: "It knew where the lines were." },
    { q: "What do footballers eat with their pies?", a: "A nice cup of team." },
    { q: "Why was the football wet?", a: "It was a cup tie." },
    { q: "Why was the goalpost so proud?", a: "It had been a great sport all season." },
    { q: "What's a penguin's favourite football position?", a: "Left wing, with a very smart waddle." },
    { q: "Why did the scarecrow get a medal?", a: "He was outstanding in his field." },
    { q: "What has ears but can't hear?", a: "A field of corn." },
    { q: "Why did the tractor turn up early?", a: "It wanted to get ahead of the plough." },
    { q: "Why don't tractors ever get lost?", a: "They always follow the furrows." },
    { q: "What do you call a sheep with a sports car?", a: "A Lamborghini." },
    { q: "Why did the chicken join the farm band?", a: "It had the drumsticks." },
    { q: "What do you get if you cross a tractor with a kangaroo?", a: "A machine that jumps to the next field." },
    { q: "Why was the barn so noisy?", a: "The cows had a moo-sical." },
    { q: "What's a tractor's favourite snack?", a: "Hay-stackers." },
    { q: "What did the horse say after a long trot?", a: "That's enough, I'm hoarse." },
    { q: "Why don't farmers tell secrets in a field of corn?", a: "Too many ears." },
    { q: "What's a scarecrow's favourite fruit?", a: "Straw-berries." },
    { q: "What do you call a cow in a field of daisies?", a: "A happy moo-d." },
    { q: "Why did the tractor take a nap?", a: "It had had a long, tyred day." },
    { q: "What's the fastest vegetable on the farm?", a: "The runner bean." },
    { q: "Why did the tractor honk at the sheep?", a: "It was just saying 'after ewe'." },
    { q: "What's the warmest jumper on the farm?", a: "The woolly one from a very kind sheep." },
    { q: "How do you know if Santa's been in the kitchen?", a: "The mince pies are missing and the carrots have a nibble." },
    { q: "Why did the bauble blush?", a: "It saw the fairy on top of the tree." },
    { q: "What do elves use to keep score?", a: "A wrapping tally." },
    { q: "What did one snowflake say to the other?", a: "Don't flake out on me now." },
    { q: "Why did the ghost go to the Christmas party?", a: "It was there in spirit." },
    { q: "What's the best seat at Christmas dinner?", a: "The one nearest the roast potatoes." },
    { q: "What do you call a sleeping dinosaur?", a: "A dino-snore." },
    { q: "Why did the dinosaur cross the road?", a: "Because chickens hadn't been invented yet." },
    { q: "How do you know there's a dinosaur in the fridge?", a: "The door won't shut." },
    { q: "What's a T-rex's favourite biscuit?", a: "One it can actually hold, which is tricky." },
    { q: "Why can't a T-rex clap?", a: "Because they're extinct, and also those little arms." },
    { q: "What do you call a dinosaur at a tea party?", a: "A dino-scone." },
    { q: "Why was the pterodactyl so good at tennis?", a: "It had a smashing wingspan." },
    { q: "How does a dinosaur cheer at a match?", a: "Dino-score!" },
    { q: "What do you call a dinosaur that writes jokes?", a: "A pun-asaurus." },
    { q: "What do you say to a cold stegosaurus?", a: "Here's a jumper, you look a little dino-sore." },
    { q: "Where do dinosaurs buy their wellies?", a: "At a dino-store." },
    { q: "Why did the triceratops take a pencil to the museum?", a: "To draw its favourite fossils." },
    { q: "What do dinosaurs have that no other animals have?", a: "Baby dinosaurs." },
    { q: "How do you ask a dinosaur to lunch?", a: "Tea-rex?" },
    { q: "What do you call a dinosaur that sits on a biscuit?", a: "A dino-crunch." },
    { q: "Why are dinosaurs brilliant at hide-and-seek in museums?", a: "They're already standing very, very still." },
    { q: "Why did the dinosaur take a bus to the museum?", a: "Its little arms couldn't reach the tickets." },
    { q: "What do you call a dinosaur that loves football?", a: "A goal-asaurus." },
    { q: "What's a dinosaur's favourite crisp flavour?", a: "Roar-ast chicken." },
    { q: "What do you call a dinosaur in wellies?", a: "Ready for a very muddy adventure." },
    { q: "What do you call a quiet classroom of dinosaurs?", a: "A dino-hush, just before lunch." },
    { q: "What do you call a dinosaur that loves school?", a: "A very clever dino-swot, in the nicest way." },
    { q: "What do you call a dinosaur that never gives up?", a: "A try-try-try-ceratops." },
    { q: "Knock knock. Who's there? Boo. Boo who?", a: "Don't cry, it's only a joke!" },
    { q: "Knock knock. Who's there? Lettuce. Lettuce who?", a: "Lettuce in, it's freezing out here!" },
    { q: "Knock knock. Who's there? Atch. Atch who?", a: "Bless you!" },
    { q: "Knock knock. Who's there? Nobel. Nobel who?", a: "No bell, that's why I knocked!" },
    { q: "Knock knock. Who's there? Tank. Tank who?", a: "You're welcome!" },
    { q: "Knock knock. Who's there? Ice cream. Ice cream who?", a: "Ice cream if you don't let me in!" },
    { q: "Knock knock. Who's there? Orange. Orange who?", a: "Orange you going to let me in?" },
    { q: "Knock knock. Who's there? A little old lady. A little old lady who?", a: "I didn't know you could yodel!" },
    { q: "Knock knock. Who's there? Harry. Harry who?", a: "Harry up, it's chilly on the step!" },
    { q: "Knock knock. Who's there? Annie. Annie who?", a: "Annie more jokes you'd like?" },
    { q: "Knock knock. Who's there? Luke. Luke who?", a: "Luke through the keyhole and you'll see!" },
    { q: "Knock knock. Who's there? Cows go. Cows go who?", a: "No, cows go moo!" },
    { q: "Knock knock. Who's there? Hawaii. Hawaii who?", a: "I'm fine, Hawaii you?" },
    { q: "Knock knock. Who's there? Interrupting cow. Interrupting cow who?", a: "MOO! She didn't even wait to be asked." },
    { q: "Knock knock. Who's there? Spell. Spell who?", a: "W-H-O. That was a short spelling test!" },
    { q: "Knock knock. Who's there? Wooden shoe. Wooden shoe who?", a: "Wooden shoe like to hear another joke?" },
    { q: "Knock knock. Who's there? Olive. Olive who?", a: "Olive this joke a lot, do you?" },
    { q: "Knock knock. Who's there? Justin. Justin who?", a: "Justin time for another joke!" },
    { q: "Knock knock. Who's there? Icy. Icy who?", a: "Icy you waving from the window!" },
    { q: "Knock knock. Who's there? Dozen. Dozen who?", a: "Dozen anyone want to let me in?" },
    { q: "Knock knock. Who's there? Alpaca. Alpaca who?", a: "Alpaca the hamper if you pack the crisps!" },
    { q: "Knock knock. Who's there? Radio. Radio who?", a: "Radio not, here comes another joke!" },
    { q: "Knock knock. Who's there? Tractor. Tractor who?", a: "Tractor maybe we can go for a ride in the field!" },
    { q: "What do you call a rabbit that tells jokes?", a: "A funny bunny." },
    { q: "Why did the dog sit in the shade?", a: "It didn't want to be a hot dog." },
    { q: "What do you call a deer with no eyes?", a: "No eye deer." },
    { q: "What do you call a deer with no eyes and no legs?", a: "Still no eye deer." },
    { q: "How do you get an elephant into a fridge?", a: "Open the door, put the elephant in, close the door." },
    { q: "How do you get a giraffe into a fridge?", a: "Open the door, take the elephant out, put the giraffe in." },
    { q: "All the animals come to the lion's party, except one. Who's missing?", a: "The giraffe — it's still in the fridge." },
    { q: "What do Highland cows say in winter?", a: "It's brrr-illiant up here." },
    { q: "Why was the tablet so popular?", a: "It was a sweetie from the start." }
  ];

  function jokesSeen() {
    try {
      var a = JSON.parse(LS.get('kidJokesSeen') || '[]');
      return Array.isArray(a) ? a.map(Number).filter(function (n) { return n >= 0 && n < JOKES.length; }) : [];
    } catch (e) { return []; }
  }
  function markJokeSeen(i) {
    var a = jokesSeen();
    if (a.indexOf(i) < 0) a.push(i);
    LS.set('kidJokesSeen', JSON.stringify(a));
  }
  function nextJokeIndex(except) {
    var seen = jokesSeen();
    if (seen.length >= JOKES.length) { LS.set('kidJokesSeen', '[]'); seen = []; }
    var pool = [];
    for (var i = 0; i < JOKES.length; i++) if (seen.indexOf(i) < 0 && i !== except) pool.push(i);
    if (!pool.length) {
      LS.set('kidJokesSeen', '[]');
      for (var j = 0; j < JOKES.length; j++) if (j !== except) pool.push(j);
      if (!pool.length) pool = [0];
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function pickJokeOnOpen() {
    if (!JOKES.length) return;
    var i = nextJokeIndex();
    LS.set('kidJoke', String(i));
    markJokeSeen(i);
  }
  function jokeHtml() {
    if (!S.kid) return '';
    var i = parseInt(LS.get('kidJoke') || '-1', 10);
    if (!(i >= 0 && i < JOKES.length)) { i = nextJokeIndex(); LS.set('kidJoke', String(i)); markJokeSeen(i); }
    var j = JOKES[i];
    return '<button type="button" class="kidJoke" id="kidJoke" data-act="jokeNext" aria-label="Tap for another joke">' +
      '<p class="jokeQ">' + esc(j.q) + '</p>' +
      '<p class="jokeA">' + esc(j.a) + '</p>' +
      '<p class="jokeHint">Tap for another</p></button>';
  }
  function showNextJoke() {
    var cur = parseInt(LS.get('kidJoke') || '0', 10);
    var i = nextJokeIndex(cur);
    LS.set('kidJoke', String(i));
    markJokeSeen(i);
    bumpKid('kidJokes');
    var el = $('kidJoke'); if (!el) return;
    var j = JOKES[i];
    var q = el.querySelector('.jokeQ'), a = el.querySelector('.jokeA');
    if (q) q.textContent = j.q;
    if (a) a.textContent = j.a;
  }

  var FUN_FALLBACK_ = [
    { id: "icecream", emoji: "\uD83C\uDF66", art: "an", one: "ice cream", many: "ice creams", gbp: 2.5 },
    { id: "pizza", emoji: "\uD83C\uDF55", art: "a", one: "pizza", many: "pizzas", gbp: 12 },
    { id: "cake", emoji: "\uD83C\uDF82", art: "a", one: "cake", many: "cakes", gbp: 15 }
  ];
  function funTotalNum() {
    var tot = S.boot && S.boot.funTotal;
    return tot && typeof tot.total === 'number' && isFinite(tot.total) ? tot.total : null;
  }
  function funUnitsLive() {
    var facts = S.boot && S.boot.funFacts;
    if (Array.isArray(facts) && facts.length) return facts;
    var total = funTotalNum();
    if (total == null) return [];
    return FUN_FALLBACK_.map(function (u) {
      return { id: u.id, emoji: u.emoji, art: u.art, one: u.one, many: u.many, count: u.gbp ? total / u.gbp : 0 };
    });
  }
  function funUnitIndex() {
    var n = funUnitsLive().length, i = parseInt(LS.get('kidFunUnit') || '0', 10);
    if (!(n > 0)) return 0;
    if (!(i >= 0 && i < n)) i = 0;
    return i;
  }
  function pickFunUnitRandom() {
    var n = funUnitsLive().length;
    if (!n) return;
    LS.set('kidFunUnit', String(Math.floor(Math.random() * n)));
  }
  function setFunUnitIndex(i, dir) {
    var n = funUnitsLive().length;
    if (!n) return;
    i = ((i % n) + n) % n;
    LS.set('kidFunUnit', String(i));
    paintFunWorth(dir || 0);
  }
  function funPhrase(n, u) {
    var art = u.art || 'a', one = u.one, many = u.many;
    var about = function (s) { return 'about ' + s; };
    if (n >= 20) return about(Math.round(n).toLocaleString('en-GB') + ' ' + many);
    if (n >= 2) {
      var half = Math.round(n * 2) / 2;
      if (half === Math.round(half)) return about(Math.round(half) + ' ' + many);
      return about(Math.floor(half) + ' and a half ' + many);
    }
    if (n >= 1.25) return about('one and a half ' + many);
    if (n >= 0.75) return about(art + ' ' + one);
    if (n >= 0.4) return about('half ' + art + ' ' + one);
    if (n >= 0.28) return about('a third of ' + art + ' ' + one);
    if (n >= 0.15) return about('a quarter of ' + art + ' ' + one);
    if (n > 0) return 'a little bit of ' + art + ' ' + one;
    return 'a few treasures, and growing';
  }
  function funSlideInner() {
    var list = funUnitsLive();
    if (!list.length) return '';
    var u = list[funUnitIndex()] || list[0];
    var count = (u && typeof u.count === 'number') ? u.count : 0;
    var nShow = count >= 1 ? Math.min(8, Math.max(1, Math.round(Math.min(count, 8)))) : 1;
    var em = '', i;
    for (i = 0; i < nShow; i++) em += (u.emoji || '');
    var line = 'Our collection is worth ' + funPhrase(count, u) + '! ' + (u.emoji || '');
    return '<div class="funEmojis" aria-hidden="true">' + em + '</div><p class="funLine">' + esc(line) + '</p>';
  }
  function funWorthHtml() {
    if (!S.kid) return '';
    if (!funUnitsLive().length) return '';
    return '<div class="funWorth" id="funWorth">' +
      '<p class="funLabel">What\u2019s our collection worth?</p>' +
      '<div class="funViewport"><div class="funSlide">' + funSlideInner() + '</div></div>' +
      '<p class="funHint">Swipe or tap to try another</p></div>';
  }

  var FUN_ANIM = { busy: false, ignoreTap: false };
  function paintFunWorth(dir) {
    var view = document.querySelector('#funWorth .funViewport');
    if (!view) return;
    var next = document.createElement('div');
    next.className = 'funSlide';
    next.innerHTML = funSlideInner();
    var old = view.querySelector('.funSlide');
    if (!old || !dir || FUN_ANIM.busy) {
      view.innerHTML = '';
      view.appendChild(next);
      FUN_ANIM.busy = false;
      return;
    }
    FUN_ANIM.busy = true;
    view.style.minHeight = old.offsetHeight + 'px';
    next.classList.add(dir > 0 ? 'funFromRight' : 'funFromLeft');
    view.appendChild(next);
    old.classList.add(dir > 0 ? 'funToLeft' : 'funToRight');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        next.classList.add('funIn');
        old.classList.add('funOut');
      });
    });
    var done = function () {
      if (old && old.parentNode) old.parentNode.removeChild(old);
      next.classList.remove('funFromRight', 'funFromLeft', 'funIn');
      view.style.minHeight = '';
      FUN_ANIM.busy = false;
    };
    var t = setTimeout(done, 380);
    next.addEventListener('transitionend', function (e) {
      if (e.propertyName && e.propertyName.indexOf('transform') < 0) return;
      clearTimeout(t); done();
    }, { once: true });
  }
  function cycleFunWorth(dir) {
    if (funTotalNum() == null) return;
    dir = dir || 1;
    if (FUN_ANIM.busy) return;
    setFunUnitIndex(funUnitIndex() + dir, dir);
    bumpKid('kidWorthSwipes');
  }
  function bindFunSwipe() {
    var root = document.getElementById('funWorth');
    if (!root || root.getAttribute('data-fun-bound') === '1') return;
    root.setAttribute('data-fun-bound', '1');
    var st = { down: false, x: 0, y: 0, axis: '', dragging: false };
    var view, slide;
    function grab() {
      view = root.querySelector('.funViewport');
      slide = view ? view.querySelector('.funSlide:last-child') : null;
    }
    function start(x, y) {
      if (FUN_ANIM.busy) return;
      st.down = true; st.x = x; st.y = y; st.axis = ''; st.dragging = false;
      grab();
    }
    function move(x, y, ev) {
      if (!st.down || FUN_ANIM.busy) return;
      var dx = x - st.x, dy = y - st.y;
      if (!st.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (st.axis === 'y') { st.down = false; return; }
      }
      if (st.axis !== 'x') return;
      st.dragging = true;
      if (ev && ev.cancelable) ev.preventDefault();
      if (slide) {
        slide.style.transition = 'none';
        slide.style.transform = 'translateX(' + dx + 'px)';
      }
    }
    function end(x) {
      if (!st.down) return;
      st.down = false;
      var dx = x - st.x;
      if (slide) { slide.style.transition = ''; slide.style.transform = ''; }
      if (st.axis === 'x' && Math.abs(dx) >= 40) {
        FUN_ANIM.ignoreTap = true;
        cycleFunWorth(dx < 0 ? 1 : -1);
        setTimeout(function () { FUN_ANIM.ignoreTap = false; }, 400);
      }
    }
    root.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0]; start(t.clientX, t.clientY);
    }, { passive: true });
    root.addEventListener('touchmove', function (e) {
      var t = e.changedTouches[0]; move(t.clientX, t.clientY, e);
    }, { passive: false });
    root.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0]; end(t.clientX);
    }, { passive: true });
    root.addEventListener('touchcancel', function () { st.down = false; if (slide) { slide.style.transition = ''; slide.style.transform = ''; } }, { passive: true });
    root.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.funArrow')) return;
      start(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', function (e) {
      if (!st.down) return;
      move(e.clientX, e.clientY, e);
    });
    window.addEventListener('mouseup', function (e) {
      if (!st.down) return;
      end(e.clientX);
    });
    root.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.funArrow')) return;
      if (FUN_ANIM.ignoreTap || FUN_ANIM.busy || st.dragging) { st.dragging = false; return; }
      cycleFunWorth(1);
    });
  }

  var RW = null;
  function rwIsActive(x) {
    if (!x) return false;
    var v = x.active;
    if (v === false || v == null || v === '') return false;
    if (v === true) return true;
    return !/^(no|false|0|off)$/i.test(String(v).trim());
  }
  function rwArr(x) { return Array.isArray(x) ? x : []; }
  function sortByCost(list) {
    return rwArr(list).slice().sort(function (a, b) {
      return ((a && a.cost) || 0) - ((b && b.cost) || 0) || String((a && a.title) || '').localeCompare(String((b && b.title) || ''));
    });
  }
  /* Same live list kid sees: active rewards only, no local/hardcoded defaults. */
  function activeRewards(r) {
    if (!r) return [];
    var all = rwArr(r.allRewards);
    if (all.length) return sortByCost(all.filter(rwIsActive));
    return sortByCost(r.rewards);
  }
  function forgetRewardsCache(keepKey) {
    return IDB.keys().then(function (keys) {
      return Promise.all((keys || []).filter(function (k) {
        return String(k).indexOf('c|getRewards|') === 0 && k !== keepKey;
      }).map(function (k) { return IDB.del(k); }));
    }, function () { return null; });
  }
  function loadRewards(force) {
    if (RW && !force && navigator.onLine === false) return Promise.resolve(RW);
    RW = force ? null : RW;
    if (RW && !force) return Promise.resolve(RW);
    return call('getRewards', S.kid ? KID_ROLE : S.role).then(function (r) {
      RW = r;
      forgetRewardsCache(cacheKey('getRewards', [S.kid ? KID_ROLE : S.role])).catch(noop);
      return r;
    });
  }
  function niceWhen(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
    catch (e) { return String(iso).slice(0, 16); }
  }
  function rwAction(a) {
    return ({ photo: 'Photo', found: 'Ticked off a find', update: 'Updated something', add: 'New item', streak: '3-day streak bonus', job: 'Job done' })[a] || a;
  }
  function paintRewardsHome(r) {
    var box = $('rwHomeTile'); if (!box || !r) return;
    var bits = [];
    if (r.queue && r.queue.length) bits.push(r.queue.length + ' photo' + (r.queue.length === 1 ? '' : 's') + ' waiting');
    if (r.pendingRequests && r.pendingRequests.length) bits.push(r.pendingRequests.length + ' reward' + (r.pendingRequests.length === 1 ? '' : 's') + ' to decide');
    box.innerHTML = '<div class="head">\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</div>' +
      '<div class="big">' + r.earned + '</div><div class="hint">points earned' + (bits.length ? ' \u00B7 ' + bits.join(' \u00B7 ') : '') + '</div>' +
      '<button class="btn main" data-act="go" data-to="rewards">' + (bits.length ? 'Review' : 'Open') + '</button>';
  }
  function rwLevelCard(r) {
    var lv = r.level || {}, nextAt = lv.nextAt, have = r.earned || 0, min = lv.min || 0;
    var span = nextAt ? (nextAt - min) : 1, done = nextAt ? Math.min(1, (have - min) / span) : 1;
    return '<div class="card yel ptsCard center"><div class="hint">' + esc(lv.name || '') + '</div><div class="big">' + (r.balance || 0) + '</div><div class="hint">points to spend' +
      (r.held ? ' \u00B7 ' + r.held + ' waiting on ' + OWN + '' : '') + '</div>' +
      '<div class="ptsBar" aria-hidden="true"><i style="width:' + Math.round(100 * done) + '%"></i></div>' +
      '<p class="hint">' + (lv.next ? (nextAt - have) + ' more to become ' + esc(lv.next) : 'Top level! Brilliant work.') +
      (r.streak ? '<br>' + (r.helpedToday ? r.streak + ' day' + (r.streak === 1 ? '' : 's') + ' in a row' + (r.streak >= 3 ? ' \u2014 streak bonus unlocked!' : '. Keep going for a bonus at 3.') : 'Help today to keep your ' + r.streak + '-day streak') : '') +
      '</p></div>';
  }
  function rwNeedOk() {
    return '<div class="nudge">This bit needs a quick update on the collection sheet (version 4.4). Until then, photos and the rest of the app still work as usual.</div>';
  }

  SCREENS.kidRewards = function () {
    busy('Counting your points\u2026');
    loadBoot().then(function () { return loadRewards(true); }).then(function (r) {
      done();
      var rewards = activeRewards(r).map(function (x) {
        var pending = rwArr(r.requests).some(function (q) { return q.title === x.title && q.status === 'Pending'; });
        var need = x.cost - (r.balance || 0);
        var btn = pending ? '<span class="pill yel">Asked \u2014 waiting for ' + OWN + '</span>' :
          (need > 0 ? '<span class="hint">' + need + ' more points to go</span>' :
            '<button class="btn main" data-act="rwAsk" data-id="' + esc(x.id) + '">Ask ' + OWN + '</button>');
        return '<div class="rwItem"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">' + x.cost + ' pts</span></div>' + btn + '</div>';
      }).join('');
      var reqs = rwArr(r.requests).length ? '<h2>Your asks</h2><div class="rwList">' + rwArr(r.requests).map(function (q) {
        return '<div class="rwItem"><b>' + esc(q.title) + '</b><small>' + esc(q.status) + (q.when ? ' \u00B7 ' + esc(niceWhen(q.when)) : '') + '</small></div>';
      }).join('') + '</div>' : '';
      var recent = '';
      try {
        recent = rwArr(r.recent).length ? '<h2>Lately</h2><div class="list rwLog">' + rwArr(r.recent).slice(0, 12).map(function (x) {
          return '<div class="li"><div class="grow">' + esc(rwAction(x.action)) + (x.item ? '<small>' + esc(x.item) + '</small>' : '') + '</div><span class="pill">' + (x.points > 0 ? '+' : '') + x.points + '</span></div>';
        }).join('') + '</div>' : '';
      } catch (eRec) { recent = ''; }
      var extra = '';
      try {
        var photo = ptsVal(r, 'photo', 10);
        extra += (r.waiting ? '<div class="nudge">' + OWN + ' is having a look at ' + r.waiting + ' photo' + (r.waiting === 1 ? '' : 's') + '. You get ' + photo + ' point' + (photo === 1 ? '' : 's') + ' for each one that gets a yes.</div>' : '');
      } catch (eWait) { /* keep rewards visible */ }
      try { extra += jobsCardHtml(r) || ''; } catch (eJobs) { /* live API may lack jobs until v4.7 */ }
      try { extra += earnCardHtml(r) || ''; } catch (eEarn) { /* keep rewards visible */ }
      setMain(backBtn() + '<h1>\u2B50 My points</h1>' + rwLevelCard(r) + extra +
        '<h2>Rewards you can ask for</h2><div class="rwList">' +
        (rewards || '<p class="hint">' + OWN + ' hasn\u2019t set any rewards yet.</p>') + '</div>' + reqs + recent);
    }).catch(function (e) { done(); setMain(backBtn() + '<h1>\u2B50 My points</h1>' + rwNeedOk()); });
  };

  SCREENS.rewards = function () {
    if (!isPriv() || !showKidFeatures()) { go('home', {}, true); return; }
    busy('Getting the rewards\u2026');
    loadRewards(true).then(function (r) {
      done();
      var q = (r.queue || []).map(function (p) {
        return '<div class="rwItem" data-qid="' + esc(p.id) + '"><div class="qThumb" id="qth-' + esc(p.id) + '"><span class="thWait"></span></div>' +
          '<b>' + esc(p.item) + '</b><small>' + esc([p.label, niceWhen(p.when)].filter(Boolean).join(' \u00B7 ')) + '</small>' +
          '<label class="field" style="font-weight:700"><input type="checkbox" class="qMain" checked> Make this the main photo</label>' +
          '<div class="row"><button class="btn green" data-act="rwPhotoYes" data-id="' + esc(p.id) + '">Yes, it\u2019s in</button>' +
          '<button class="btn" data-act="rwPhotoNo" data-id="' + esc(p.id) + '">Not this time</button></div></div>';
      }).join('');
      var asks = (r.pendingRequests || []).map(function (x) {
        return '<div class="rwItem"><div class="row"><b>' + esc(x.title) + '</b><span class="pill">' + x.cost + ' pts</span></div><small>' + esc(niceWhen(x.when)) + '</small>' +
          '<div class="row"><button class="btn green" data-act="rwYes" data-id="' + esc(x.id) + '">Yes (PIN)</button>' +
          '<button class="btn" data-act="rwNo" data-id="' + esc(x.id) + '">Not this time (PIN)</button></div></div>';
      }).join('');
      var jobRows = '';
      try {
        jobRows = rwArr(r.allJobs).map(function (x) {
          var doneBtn = x.doneToday ? '<span class="pill yel">Done today</span>' :
            '<button class="btn green" data-act="jobDone" data-id="' + esc(x.id) + '">Done</button>';
          return '<div class="rwItem" data-id="' + esc(x.id) + '"><p class="rwEditHead">Edit this job</p>' +
            '<label class="field">Job name <input type="text" class="jobTitle" data-id="' + esc(x.id) + '" value="' + esc(x.title) + '" maxlength="60" autocomplete="off"></label>' +
            '<label class="field">Points <input type="number" class="jobCost" data-id="' + esc(x.id) + '" value="' + x.cost + '" min="5" step="5"></label>' +
            '<label class="rwOnRow"><input type="checkbox" class="jobOn" data-id="' + esc(x.id) + '"' + (rwIsActive(x) ? ' checked' : '') + '> On the list</label>' +
            '<div class="row" style="margin-top:8px">' + doneBtn + '</div></div>';
        }).join('');
      } catch (eJobs) { jobRows = ''; }
      function rewardEditRow(x, on) {
        return '<div class="rwItem' + (on ? '' : ' rwOff') + '" data-id="' + esc(x.id) + '"><p class="rwEditHead">' + (on ? 'On the list' : 'Off the list') + '</p>' +
          '<label class="field">Reward name <input type="text" class="rwTitle" data-id="' + esc(x.id) + '" value="' + esc(x.title) + '" maxlength="60" autocomplete="off"></label>' +
          '<label class="field">Points cost <input type="number" class="rwCost" data-id="' + esc(x.id) + '" value="' + x.cost + '" min="5" step="5"></label>' +
          '<label class="rwOnRow"><input type="checkbox" class="rwOn" data-id="' + esc(x.id) + '"' + (on ? ' checked' : '') + '> On the list</label></div>';
      }
      var editorSrc = rwArr(r.allRewards);
      if (!editorSrc.length) editorSrc = activeRewards(r).map(function (x) { return { id: x.id, title: x.title, cost: x.cost, active: true }; });
      var onList = sortByCost(editorSrc.filter(rwIsActive));
      var offList = sortByCost(editorSrc.filter(function (x) { return !rwIsActive(x); }));
      var all = onList.map(function (x) { return rewardEditRow(x, true); }).join('');
      var allOff = offList.map(function (x) { return rewardEditRow(x, false); }).join('');
      var pts = (r.points || {});
      var log = (r.log || []).slice(0, 80).map(function (x) {
        return '<div class="li"><div class="grow">' + esc(rwAction(x.action)) + (x.item ? '<small>' + esc(x.item) + (x.detail ? ' \u00B7 ' + esc(x.detail) : '') + '</small>' : (x.detail ? '<small>' + esc(x.detail) + '</small>' : '')) +
          '<small>' + esc(niceWhen(x.when)) + '</small></div><span class="pill">' + (x.points > 0 ? '+' : '') + x.points + '</span></div>';
      }).join('');
      setMain(backBtn() + '<h1>\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</h1>' +
        '<div class="card skyL"><b>' + (r.earned || 0) + '</b> points earned \u00B7 <b>' + (r.balance || 0) + '</b> to spend \u00B7 ' + esc((r.level && r.level.name) || '') +
        (r.streak ? ' \u00B7 ' + r.streak + '-day streak' : '') + '</div>' +
        '<h2>Photos waiting</h2>' + (q ? '<div class="rwList">' + q + '</div>' : '<p class="hint">None waiting \u2014 you\u2019re all caught up.</p>') +
        '<h2>Reward asks</h2>' + (asks ? '<div class="rwList">' + asks + '</div>' : '<p class="hint">No asks waiting.</p>') +
        (Array.isArray(r.allJobs) || Array.isArray(r.jobs) ? '' : '<div class="nudge">Jobs need a quick Code.gs update on the collection sheet (version 4.7). Until then, rewards still work as usual.</div>') +
        (Array.isArray(r.allJobs) || Array.isArray(r.jobs) || jobRows ? ('<h2>Jobs</h2><p class="hint">Give each job a name and points. Tap Done when it\u2019s finished to award the points (once per job per day). Switch one off rather than deleting it. No money in the names, please.</p><div class="rwList" id="jobEdit">' + jobRows + '</div>' +
        '<p><button type="button" class="rwAdd" data-act="jobAdd">+ Add job</button></p>') : '<div class="rwList" id="jobEdit" hidden></div>') +
        '<h2>Rewards they can ask for</h2><p class="hint">This is the same live list Kid mode sees, from the App - Rewards sheet. Each reward has a name and a points cost (for example Ice cream is 100 points, a cake or a bake is 200). Tick \u201COn the list\u201D to show or hide one. Switch one off rather than deleting it. No money in the names, please.</p><div class="rwList" id="rwEdit">' + (all || '<p class="hint">No active rewards yet.</p>') + '</div>' +
        (allOff ? '<h2>Off the list</h2><p class="hint">Hidden from Kid mode until you tick them back on. Nothing is deleted.</p><div class="rwList rwOffList" id="rwEditOff">' + allOff + '</div>' : '') +
        '<p><button type="button" class="rwAdd" data-act="rwAdd">+ Add reward</button></p>' +
        '<h2>Points they earn</h2><p class="hint">Change how many points a photo, a tick, or a new item is worth.</p>' +
        '<div class="card" id="rwRules">' +
          '<label class="field">Points for a photo (when you say yes) <input type="number" id="rwPtsPhoto" min="0" step="1" value="' + (pts.photo != null ? pts.photo : 10) + '"></label>' +
          '<label class="field">Points for a tick / found it <input type="number" id="rwPtsTick" min="0" step="1" value="' + (pts.found != null ? pts.found : 5) + '"></label>' +
          '<label class="field">Points for an update <input type="number" id="rwPtsUpdate" min="0" step="1" value="' + (pts.update != null ? pts.update : 5) + '"></label>' +
          '<label class="field">Points for a brand new item <input type="number" id="rwPtsAdd" min="0" step="1" value="' + (pts.add != null ? pts.add : 20) + '"></label>' +
          '<label class="field">Bonus for helping 3 days in a row <input type="number" id="rwPtsStreak" min="0" step="1" value="' + (pts.streak != null ? pts.streak : 15) + '"></label>' +
        '</div>' +
        (function () {
          var funList = rwArr(r.funUnits);
          if (!funList.length) return '';
          var rows = funList.map(function (x) {
            if (x.builtin) {
              var gbp = Number(x.gbp), gbpText = (gbp === Math.round(gbp)) ? String(Math.round(gbp)) : String(gbp);
              return '<div class="rwItem" data-id="' + esc(x.id) + '" data-src="built-in"><p class="rwEditHead">' + esc((x.emoji ? x.emoji + ' ' : '') + (x.many || x.one || x.id)) + '</p>' +
                '<p class="hint">About \u00A3' + gbpText + ' each. Kid mode only shows the count, never the money.</p>' +
                '<label class="rwOnRow"><input type="checkbox" class="funOn"' + (rwIsActive(x) ? ' checked' : '') + '> On the list</label></div>';
            }
            return '<div class="rwItem" data-id="' + esc(x.id || '') + '" data-src="custom"><p class="rwEditHead">Your fun fact</p>' +
              '<label class="field">Emoji <input type="text" class="funEmoji" value="' + esc(x.emoji || '') + '" maxlength="8" autocomplete="off"></label>' +
              '<label class="field">Name for one <input type="text" class="funOne" value="' + esc(x.one || '') + '" maxlength="40" placeholder="e.g. workshop sign" autocomplete="off"></label>' +
              '<label class="field">Name for many <input type="text" class="funMany" value="' + esc(x.many || '') + '" maxlength="50" placeholder="e.g. workshop signs" autocomplete="off"></label>' +
              '<label class="field">Rough \u00A3 cost of one <input type="number" class="funGbp" value="' + esc(x.gbp || '') + '" min="0.01" step="0.01"></label>' +
              '<label class="rwOnRow"><input type="checkbox" class="funOn"' + (x.active === false ? '' : ' checked') + '> On the list</label></div>';
          }).join('');
          return '<h2>Collection worth fun facts</h2><p class="hint">Kid mode turns the collection\u2019s value into a count of ice creams, cakes, or things from this collection (for example packs of cards). They never see the money. Switch a built-in off, or add your own (name for one, name for many, emoji, and a rough pounds cost for one).</p><div class="rwList" id="funEdit">' + rows + '</div>' +
            '<p><button type="button" class="rwAdd" data-act="funAdd">+ Add a fun fact</button></p>';
        })() +
        '<p class="center"><button class="btn main" data-act="rwSave" id="rwSaveBtn">Save</button></p>' +
        '<h2>Activity log</h2><div class="list rwLog">' + (log || '<p class="hint">Nothing yet.</p>') + '</div>');
      (r.queue || []).forEach(function (p) {
        call('getQueuePhoto', p.id, S.role).then(function (ph) {
          var box = $('qth-' + p.id); if (!box) return;
          if (ph && ph.video && !ph.thumb) { box.innerHTML = '\uD83C\uDFAC'; return; }
          if (ph && ph.thumb) shrinkThumb(ph.thumb).then(function (s) { if ($('qth-' + p.id)) $('qth-' + p.id).innerHTML = s ? '<img alt="" src="' + s + '">' : '\uD83D\uDCF7'; });
          else box.innerHTML = '\uD83D\uDCF7';
        }).catch(function () { var box = $('qth-' + p.id); if (box) box.innerHTML = '\uD83D\uDCF7'; });
      });
    }).catch(function (e) { done(); setMain(backBtn() + '<h1>\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</h1>' + rwNeedOk()); });
  };

  function askReward(id) {
    if (!id) return;
    confirmSheet('Ask ' + OWN + '?', 'It goes on the rewards page, and the points are held until ' + OWN + ' says yes or no.', 'Yes, ask', 'Not now').then(function (ok) {
      if (!ok) return;
      busy('Sending to ' + OWN + '\u2026');
      return call('requestReward', id, KID_ROLE).then(function () {
        done(); RW = null; toast('Asked! ' + OWN + ' will take a look.', 'good'); go('kidRewards', {}, true);
      });
    }).catch(oops);
  }
  function decideRewardUI(id, yes) {
    if (!id) return;
    var wrap = sheet('' + OWN + '\u2019s PIN', '<p class="hint">Needed each time you ' + (yes ? 'approve' : 'say no to') + ' a reward.</p><input id="rwPin" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022">',
      [{ label: yes ? 'Yes, approve' : 'No, not this time', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]);
    setTimeout(function () { var i = $('rwPin'); if (i) i.focus(); }, 50);
    wrap.then(function (v) {
      var pin = ($('rwPin') && $('rwPin').value) || '';
      if (v !== 'go') return;
      if (!/^\d{4}$/.test(pin)) { toast('That needs to be the 4-digit PIN.', 'oops'); return; }
      busy(yes ? 'Approving\u2026' : 'Saving\u2026');
      return call('decideReward', id, !!yes, pin, S.role).then(function (r) {
        done(); RW = null; toast(r.status === 'Approved' ? 'Approved \u2014 points spent.' : 'Okay, not this time. The points go back.', 'good'); go('rewards', {}, true);
      });
    }).catch(oops);
  }
  function decidePhotoUI(id, yes, makeMain) {
    if (!id) return;
    var title = yes ? 'Add this photo to the item?' : 'Say no to this photo?';
    var body = yes ? 'It moves into the item\u2019s folder and they get 10 points. Nothing else is changed.' : 'The file stays in the waiting folder (nothing is deleted) and no points are given.';
    confirmSheet(title, body, yes ? 'Yes, it\u2019s in' : 'Not this time', 'Cancel').then(function (ok) {
      if (!ok) return;
      busy(yes ? 'Adding it to the folder\u2026' : 'Saving\u2026');
      return call('decidePhoto', id, !!yes, !!makeMain, S.role).then(function (r) {
        done(); RW = null;
        if (yes && r.folderId) { updateFolder(r.key, r.folderId); forgetThumb(r.folderId); }
        pointsNote(r, yes ? 'It\u2019s in the folder.' : 'Left in the waiting folder \u2014 nothing deleted.');
        go('rewards', {}, true);
      });
    }).catch(oops);
  }
  function addRewardRow() {
    var box = $('rwEdit'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'rwItem';
    el.innerHTML = '<p class="rwEditHead">New reward</p>' +
      '<label class="field">Reward name <input type="text" class="rwTitle" maxlength="60" placeholder="e.g. Ice cream" autocomplete="off"></label>' +
      '<label class="field">Points cost <input type="number" class="rwCost" min="5" step="5" value="100"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="rwOn" checked> On the list</label>';
    box.appendChild(el);
    var inp = el.querySelector('.rwTitle'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function addJobRow() {
    var box = $('jobEdit'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'rwItem';
    el.innerHTML = '<p class="rwEditHead">New job</p>' +
      '<label class="field">Job name <input type="text" class="jobTitle" maxlength="60" placeholder="e.g. Tidy the shelf" autocomplete="off"></label>' +
      '<label class="field">Points <input type="number" class="jobCost" min="5" step="5" value="50"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="jobOn" checked> On the list</label>';
    box.appendChild(el);
    var inp = el.querySelector('.jobTitle'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function addFunRow() {
    var box = $('funEdit'); if (!box) return;
    var el = document.createElement('div');
    el.className = 'rwItem';
    el.setAttribute('data-src', 'custom');
    el.innerHTML = '<p class="rwEditHead">New fun fact</p>' +
      '<label class="field">Emoji <input type="text" class="funEmoji" maxlength="8" placeholder="\u2B50" autocomplete="off"></label>' +
      '<label class="field">Name for one <input type="text" class="funOne" maxlength="40" placeholder="e.g. workshop sign" autocomplete="off"></label>' +
      '<label class="field">Name for many <input type="text" class="funMany" maxlength="50" placeholder="e.g. workshop signs" autocomplete="off"></label>' +
      '<label class="field">Rough \u00A3 cost of one <input type="number" class="funGbp" min="0.01" step="0.01" value="5"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="funOn" checked> On the list</label>';
    box.appendChild(el);
    var inp = el.querySelector('.funOne'); if (inp) inp.focus();
    var btn = $('rwSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function collectFunForm() {
    var off = [], custom = [], bad = '';
    document.querySelectorAll('#funEdit .rwItem').forEach(function (el) {
      var src = el.getAttribute('data-src') || 'custom';
      var on = !(el.querySelector('.funOn') && !el.querySelector('.funOn').checked);
      var id = el.getAttribute('data-id') || '';
      if (src === 'built-in') {
        if (!on && id) off.push(id);
        return;
      }
      var one = ((el.querySelector('.funOne') && el.querySelector('.funOne').value) || '').replace(/\s+/g, ' ').trim();
      var many = ((el.querySelector('.funMany') && el.querySelector('.funMany').value) || '').replace(/\s+/g, ' ').trim();
      var emoji = ((el.querySelector('.funEmoji') && el.querySelector('.funEmoji').value) || '').replace(/\s+/g, '').slice(0, 8);
      var gbp = parseFloat((el.querySelector('.funGbp') && el.querySelector('.funGbp').value) || '');
      if (!one && !many) return;
      if (!one || !many) { bad = bad || 'Give each fun fact a name for one and a name for many.'; return; }
      if (!(gbp > 0)) { bad = bad || 'Give a rough pounds cost for one, more than zero.'; return; }
      custom.push({ id: id, one: one, many: many, emoji: emoji, gbp: gbp, active: on });
    });
    return { off: off, custom: custom, bad: bad };
  }
  function collectJobsForm() {
    var list = [], bad = '';
    document.querySelectorAll('#jobEdit .rwItem').forEach(function (el) {
      var titleEl = el.querySelector('.jobTitle'), costEl = el.querySelector('.jobCost');
      if (!titleEl || !costEl) return;
      var title = (titleEl.value || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      var cost = parseInt(costEl.value, 10);
      var on = el.querySelector('.jobOn');
      var id = (titleEl.getAttribute('data-id') || el.getAttribute('data-id') || '');
      if (/[\u00a3$\u20ac]|\b\d+\s*p\b|\bpounds?\b|\bquid\b|\bmoney\b|\bcash\b|\bdollars?\b|\beuros?\b|\bpence\b/i.test(title)) bad = 'Keep money out of job names.';
      list.push({ id: id, title: title, cost: cost, active: on ? on.checked : true });
    });
    return { list: list, bad: bad };
  }
  function completeJobUI(id) {
    if (!id) return;
    var row = document.querySelector('#jobEdit .rwItem[data-id="' + id.replace(/"/g, '') + '"]');
    var title = (row && row.querySelector('.jobTitle') && row.querySelector('.jobTitle').value) || 'this job';
    var cost = (row && row.querySelector('.jobCost') && row.querySelector('.jobCost').value) || '';
    confirmSheet('Job done?', 'Award <b>' + esc(String(cost || '')) + '</b> points for <b>' + esc(title) + '</b>? Once a day for each job.', 'Yes, Done', 'Not yet').then(function (ok) {
      if (!ok) return;
      withDadPinThen(function () {
        busy('Adding the points\u2026');
        return call('completeJob', id, S.role).then(function (r) {
          done(); RW = null;
          toast((r && r.points ? ('+' + r.points + ' points') : 'Done') + (r && r.title ? ' \u2014 ' + r.title : '') + '.', 'good');
          go('rewards', {}, true);
        });
      });
    }).catch(oops);
  }
  function collectRewardsForm() {
    var list = [], bad = '';
    document.querySelectorAll('#rwEdit .rwItem, #rwEditOff .rwItem').forEach(function (el) {
      var titleEl = el.querySelector('.rwTitle'), costEl = el.querySelector('.rwCost');
      if (!titleEl || !costEl) return;
      var title = (titleEl.value || '').replace(/\s+/g, ' ').trim();
      if (!title) return;
      var cost = parseInt(costEl.value, 10);
      var on = el.querySelector('.rwOn');
      var id = (titleEl.getAttribute('data-id') || el.getAttribute('data-id') || '');
      if (/[\u00a3$\u20ac]|\b\d+\s*p\b|\bpounds?\b|\bquid\b|\bmoney\b|\bcash\b|\bdollars?\b|\beuros?\b|\bpence\b/i.test(title)) bad = 'Keep money out of reward names.';
      list.push({ id: id, title: title, cost: cost, active: on ? on.checked : true });
    });
    var pts = {
      photo: parseInt(($('rwPtsPhoto') && $('rwPtsPhoto').value) || '10', 10),
      found: parseInt(($('rwPtsTick') && $('rwPtsTick').value) || '5', 10),
      update: parseInt(($('rwPtsUpdate') && $('rwPtsUpdate').value) || '5', 10),
      add: parseInt(($('rwPtsAdd') && $('rwPtsAdd').value) || '20', 10),
      streak: parseInt(($('rwPtsStreak') && $('rwPtsStreak').value) || '15', 10)
    };
    return { list: list, pts: pts, bad: bad };
  }
  function markRewardsSaved() {
    var btn = $('rwSaveBtn');
    if (btn) { btn.textContent = 'Saved \u2713'; btn.classList.add('saved'); }
    toast('Saved \u2713', 'good');
  }
  function withDadPinThen(fn) {
    if (dadUnlocked()) return fn();
    var wrap = sheet('' + OWN + '\u2019s PIN', '<p class="hint">Needed to save the rewards.</p><input id="rwPin" type="password" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022">',
      [{ label: 'Save', value: 'go', cls: 'main' }, { label: 'Cancel', value: '' }]);
    setTimeout(function () { var i = $('rwPin'); if (i) i.focus(); }, 50);
    return wrap.then(function (v) {
      var pin = ($('rwPin') && $('rwPin').value) || '';
      if (v !== 'go') return;
      if (!/^\d{4}$/.test(pin)) { toast('That needs to be the 4-digit PIN.', 'oops'); return; }
      busy('Checking the PIN\u2026');
      return call('verifyDadPin', pin).then(function (r) {
        done();
        if (r && r.ok && r.token) { storeDadToken(r.token, r.expires); return fn(); }
        toast('That PIN didn\u2019t match \u2014 have another go.', 'oops');
      });
    });
  }
  function saveRewardsUI() {
    var form = collectRewardsForm();
    if (form.bad) { toast(form.bad, 'oops'); return; }
    if (!form.list.length) { toast('Add at least one reward with a name.', 'oops'); return; }
    var jobs = collectJobsForm();
    if (jobs.bad) { toast(jobs.bad, 'oops'); return; }
    var funs = collectFunForm();
    if (funs.bad) { toast(funs.bad, 'oops'); return; }
    withDadPinThen(function () {
      busy('Saving\u2026');
      var p1 = call('saveRewards', form.list, S.role);
      var p2 = call('savePointRules', form.pts, S.role).catch(function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw e;
      });
      var p3 = $('jobEdit') ? call('saveJobs', jobs.list, S.role).catch(function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw e;
      }) : Promise.resolve(null);
      var p4 = $('funEdit') ? call('saveFunUnits', { off: funs.off, custom: funs.custom }, S.role).catch(function (e) {
        var msg = String((e && e.message) || e || '');
        if (/unknown action/i.test(msg)) return { skipped: true };
        throw e;
      }) : Promise.resolve(null);
      return Promise.all([p1, p2, p3, p4]).then(function (res) {
        done();
        RW = null;
        if (res[3] && res[3].facts && S.boot) S.boot.funFacts = res[3].facts;
        var saved = res[0] && res[0].rewards;
        if (saved && $('rwEdit')) {
          var titles = $('rwEdit').querySelectorAll('.rwTitle');
          saved.forEach(function (r, i) { if (titles[i]) titles[i].setAttribute('data-id', r.id); });
        }
        var savedJobs = res[2] && res[2].jobs;
        if (savedJobs && $('jobEdit')) {
          var jt = $('jobEdit').querySelectorAll('.jobTitle');
          savedJobs.forEach(function (r, i) { if (jt[i]) { jt[i].setAttribute('data-id', r.id); if (jt[i].closest('.rwItem')) jt[i].closest('.rwItem').setAttribute('data-id', r.id); } });
        }
        markRewardsSaved();
        if (res[1] && res[1].skipped) toast('Rewards saved. Points rules need the server update before they will stick.', 'good');
        else if (res[2] && res[2].skipped) toast('Rewards saved. Jobs need the server update (v4.7) before they will stick.', 'good');
        loadRewards(true);
      }).catch(oops);
    }).catch(oops);
  }
  function keepAddName() {
    var A = addState();
    if (A.step === 2 && $('addName')) A.name = ($('addName').value || '').trim();
  }
  function addBarcodeBox(A) {
    if (A.barcode) {
      return '<div class="addBc" id="addBcBox"><div><b>\uD83C\uDFF7\uFE0F Barcode</b><div class="addBcCode">' + esc(A.barcode) + '</div></div>' +
        addLookHtml(A) +
        '<div class="row"><button class="btn small" data-act="addScan">Scan again</button><button class="btn small" data-act="addTypeBc">Type it</button><button class="btn small" data-act="addClearBc">Clear</button></div></div>';
    }
    return '<div class="row wrap" style="margin-top:12px"><button class="btn" data-act="addScan">\uD83D\uDCF7 Scan barcode</button><button class="btn" data-act="addTypeBc">\u2328\uFE0F Type it</button></div>';
  }

  /* v7b: look up a scanned/typed barcode in a free product database. Never blocks Add.
     UPCitemdb is tried first but its trial API only allows CORS from upcitemdb.com, so in the
     app it usually falls through to Open Products Facts, then Open Food Facts (both allow *).
     Results are cached on the phone. Prices are stripped and never shown. A stock image, if any,
     is a reference only and is never saved as the item photo. */
  var BC_LOOK_MS = 5000;
  function bcVariants(digits) {
    var d = String(digits || '').replace(/\D/g, ''), out = [], seen = {};
    [d, d.replace(/^0+/, '') || d, ('0000000000000' + d).slice(-13), ('000000000000' + d).slice(-12)].forEach(function (x) {
      if (x && x.length >= 8 && !seen[x]) { seen[x] = 1; out.push(x); }
    });
    return out;
  }
  function bcLookGet(code) {
    try {
      var m = JSON.parse(LS.get('bcLookups') || '{}') || {}, h = m[code];
      if (h && (Date.now() - (h.at || 0) < 30 * 864e5)) return h.r;
    } catch (e) { /* ignore */ }
    return undefined;
  }
  function bcLookSet(code, r) {
    try {
      var m = JSON.parse(LS.get('bcLookups') || '{}') || {};
      m[code] = { at: Date.now(), r: r || null };
      var keys = Object.keys(m);
      if (keys.length > 80) {
        keys.sort(function (a, b) { return (m[a].at || 0) - (m[b].at || 0); })
          .slice(0, keys.length - 80).forEach(function (k) { delete m[k]; });
      }
      LS.set('bcLookups', JSON.stringify(m));
    } catch (e) { /* ignore */ }
  }
  function guessRange(name, brand, cats) {
    var lists = (S.boot && S.boot.lists && S.boot.lists.range) || [];
    var blob = [name, brand, cats].join(' ');
    var hints = [
      [/lego/i, 'Lego']
    ];
    var i, j, want;
    for (i = 0; i < hints.length; i++) if (hints[i][0].test(blob)) {
      want = hints[i][1].toLowerCase();
      for (j = 0; j < lists.length; j++) if (lists[j].toLowerCase() === want || lists[j].toLowerCase().indexOf(want) === 0) return lists[j];
      return hints[i][1];
    }
    var b = String(brand || '').split(',')[0].trim().toLowerCase();
    if (b) for (j = 0; j < lists.length; j++) if (lists[j].toLowerCase() === b) return lists[j];
    return '';
  }
  function guessBrand(name, brand) {
    var b = String(brand || '').split(',')[0].replace(/\s+/g, ' ').trim();
    if (b) return b.slice(0, 60);
    if (/\blego\b/i.test(name || '')) return 'LEGO';
    return '';
  }
  function cleanLook(o) {
    if (!o || !o.name) return null;
    var name = String(o.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return null;
    var image = String(o.image || '');
    if (!/^https:\/\//i.test(image)) image = '';
    return { name: name, brand: guessBrand(name, o.brand), range: o.range || guessRange(name, o.brand, o.cats), image: image, source: o.source || '' };
  }
  function fromUpcItem(j) {
    var it = j && j.items && j.items[0];
    if (!it) return null;
    return cleanLook({ name: it.title, brand: it.brand, cats: it.category, image: (it.images && it.images[0]) || '', source: 'upcitemdb' });
  }
  function fromFacts(j, source) {
    if (!j || j.status !== 1 || !j.product) return null;
    var p = j.product;
    return cleanLook({ name: p.product_name || p.product_name_en || '', brand: p.brands, cats: p.categories, image: p.image_front_small_url || p.image_front_url || p.image_url || '', source: source });
  }
  function fetchJson(url, ms) {
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ac) ac.abort(); }, ms || BC_LOOK_MS);
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ac && ac.signal, headers: { 'Accept': 'application/json' } })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('bad'); return r.json(); }, function (e) { clearTimeout(t); throw e; });
  }
  function firstLook(promises) {
    return new Promise(function (resolve) {
      var left = promises.length, done = false;
      if (!left) { resolve(null); return; }
      promises.forEach(function (p) {
        Promise.resolve(p).then(function (r) {
          if (done) return;
          if (r) { done = true; resolve(r); return; }
          if (--left <= 0) resolve(null);
        }, function () { if (!done && --left <= 0) resolve(null); });
      });
    });
  }
  function lookupOne(code) {
    var fields = 'product_name,product_name_en,brands,categories,image_front_small_url,image_front_url,image_url,code';
    var upc = fetchJson('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(code), 2500).then(fromUpcItem, function () { return null; });
    var opf = fetchJson('https://world.openproductsfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + fields, BC_LOOK_MS).then(function (j) { return fromFacts(j, 'openproductsfacts'); }, function () { return null; });
    var off = fetchJson('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(code) + '.json?fields=' + fields, BC_LOOK_MS).then(function (j) { return fromFacts(j, 'openfoodfacts'); }, function () { return null; });
    return firstLook([upc, opf, off]);
  }
  function lookupBarcode(digits) {
    var vars = bcVariants(digits), i, hit;
    for (i = 0; i < vars.length; i++) {
      hit = bcLookGet(vars[i]);
      if (hit !== undefined) return Promise.resolve(hit);
    }
    var start = Date.now();
    var tryVar = function (n) {
      if (n >= vars.length) return Promise.resolve(null);
      if (Date.now() - start > BC_LOOK_MS) return Promise.resolve(null);
      return lookupOne(vars[n]).then(function (r) {
        if (r) { vars.forEach(function (c) { bcLookSet(c, r); }); bcLookSet(digits, r); return r; }
        return tryVar(n + 1);
      }, function () { return tryVar(n + 1); });
    };
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null); }, BC_LOOK_MS);
      tryVar(0).then(function (r) { clearTimeout(t); resolve(r || null); }, function () { clearTimeout(t); resolve(null); });
    });
  }
  function startBarcodeLookup(digits) {
    var A = addState();
    A.bcLook = 'wait';
    A.bcRef = '';
    lookupBarcode(digits).then(function (r) { applyLookupToAdd(digits, r || null); }, function () { applyLookupToAdd(digits, null); });
  }
  function applyLookupToAdd(digits, r) {
    var A = addState();
    if (String(A.barcode || '') !== String(digits || '')) return;
    A.bcLook = r || null;
    A.bcRef = (r && r.image) || '';
    if (r) {
      if (!A.name) A.name = r.name;
      A.more = A.more || {};
      if (!A.more.maker && r.brand) A.more.maker = r.brand;
      if (!A.range && r.range) A.range = r.range;
    }
    if (S.screen !== 'add') return;
    var nameEl = $('addName');
    if (nameEl && r && !String(nameEl.value || '').trim() && A.name) nameEl.value = A.name;
    var makerEl = $('a_maker');
    if (makerEl && r && r.brand && !String(makerEl.value || '').trim()) makerEl.value = r.brand;
    if (A.step === 3 && r && r.range) {
      document.querySelectorAll('#rangeChoices [data-act=addRange]').forEach(function (bt) {
        bt.classList.toggle('sel', bt.getAttribute('data-v') === A.range);
      });
    }
    paintAddLookup(A);
  }
  function addLookHtml(A) {
    if (!A.barcode) return '';
    if (A.bcLook === 'wait') return '<p class="hint" id="addBcLook">Looking it up\u2026</p>';
    if (A.bcLook && A.bcLook.name) {
      return '<div id="addBcLook" class="addBcFound"><p><b>Found: ' + esc(A.bcLook.name) + '</b> (check it)</p>' +
        (A.bcRef ? '<img class="addBcRef" alt="Reference only, not saved as our photo" src="' + esc(A.bcRef) + '" onerror="this.remove()"><p class="hint">Reference only \u2014 this is not saved as our photo. Take your own so it can earn points.</p>' : '') +
        '</div>';
    }
    if (A.bcLook === null) return '<p class="hint" id="addBcLook">Not found, type it in</p>';
    return '<p class="hint" id="addBcLook"></p>';
  }
  function paintAddLookup(A) {
    A = A || addState();
    var box = $('addBcLook'), html = addLookHtml(A), wrap;
    if (box) {
      wrap = document.createElement('div'); wrap.innerHTML = html;
      box.replaceWith(wrap.firstChild || wrap);
    }
  }

  function applyAddBarcode(digits) {
    var A = addState(), hits = itemsByBarcode(digits).filter(function (it) { return isOwned(it) && !neverShow(it.name) && (!S.kid || kidSafe(it)); });
    A.barcode = digits;
    startBarcodeLookup(digits);
    if (!hits.length) { go('add', {}, true); return; }
    var list = '<div class="list">' + hits.map(function (it) {
      return '<button class="li ownLi" data-act="' + (S.kid ? 'kidItem' : 'item') + '" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc(it.range || '') + '</small></div><span>\u203A</span></button>';
    }).join('') + '</div>';
    sheet('Looks like it\u2019s already in the collection', '<p>Barcode <b>' + esc(digits) + '</b> matches something we already have.</p>' + list +
      '<p class="hint">If this is a different copy, you can keep the barcode and carry on adding.</p>',
      [{ label: 'Keep it and carry on', value: 'keep', cls: 'main' }, { label: 'Open the one we have', value: 'open' }, { label: 'Clear the barcode', value: 'clear' }]).then(function (v) {
      if (v === 'clear') A.barcode = '';
      if (v === 'open') { go(S.kid ? 'kidItem' : 'item', { key: hits[0].key }); return; }
      go('add', {}, true);
    });
    setTimeout(watchThumbs, 50);
  }

  SCREENS.guide = function (p) {
    var cards = [
      ['Welcome to ' + THEME.appName + '!', 'Your whole collection lives in your own Google Sheet and Drive. This app is just a friendlier way in.'],
      ['Snap it, save it', 'Tap Add, take a photo, give it a name, pick its category and condition. Done \u2014 it\u2019s in the sheet with its own photo folder.'],
      ['Find anything, later', 'Search and browse with photos. Wanted lists, checklists and your own fields are there when you want them. You can skip this intro any time.']
    ];
    var i = p.i || 0, c = cards[i];
    setMain('<div class="card guide yel"><div class="mascot">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteG') + '</div><h1>' + esc(c[0]) + '</h1><p>' + esc(c[1]) + '</p>' +
      '<div class="dots">' + cards.map(function (x, k) { return '<span class="' + (k === i ? 'on' : '') + '"></span>'; }).join('') + '</div>' +
      '<div class="stack"><button class="btn main full" data-act="guideNext" data-i="' + (i + 1) + '">' + (i < cards.length - 1 ? 'Next \u2192' : 'Let\u2019s go!') + '</button>' +
      (i < cards.length - 1 ? '<button class="btn full" data-act="guideSkip">Skip the intro</button>' : '') + '</div></div>');
    S.guideCount = cards.length;
  };

    function enterRole(role) {
    if (!LS.get('tourDone')) LS.set('tourPending', '1');
    S.role = role;
    LS.set('role', role);
    S.boot = null;
    S.history = [];
    S.pendingRole = '';
    S.pinDigits = '';
    S.pinError = '';
    go('home', {}, true);
  }
  function askDadPin(role) {
    S.pendingRole = role || PRIV;
    S.pinDigits = '';
    S.pinError = '';
    S.pinBusy = false;
    go('pin', {}, true);
  }
  function lockDadView() {
    clearDadToken();
    S.role = '';
    LS.set('role', '');
    S.boot = null;
    S.history = [];
    S.pendingRole = '';
    toast(PRIV + ' view is locked', 'good');
    go('who', {}, true);
  }
  function submitDadPin() {
    if (S.pinBusy || S.pinDigits.length !== 4) return;
    S.pinBusy = true; S.pinError = '';
    go('pin', {}, true);
    call('verifyDadPin', S.pinDigits, LS.get('pinRemember') !== '0').then(function (r) {
      S.pinBusy = false;
      S.pinDigits = '';
      if (r && r.ok && r.token) {
        storeDadToken(r.token, r.expires);
        if (S.kidExit) { leaveKid(PRIV); return; }
        if (S.afterPin) { var ap = S.afterPin; S.afterPin = null; S.role = PRIV; LS.set('role', PRIV); S.pendingRole = ''; S.boot = null; go(ap[0], ap[1], true); return; }
        enterRole(S.pendingRole || PRIV);
      } else {
        S.pinError = 'That PIN didn\u2019t match \u2014 have another go.';
        go('pin', {}, true);
      }
    }).catch(function (e) {
      S.pinBusy = false;
      S.pinDigits = '';
      S.pinError = 'That PIN didn\u2019t match \u2014 have another go.';
      go('pin', {}, true);
    });
  }
  SCREENS.pin = function () {
    var digits = S.pinDigits || '', err = S.pinError || '';
    var dots = '';
    for (var i = 0; i < 4; i++) dots += '<span class="pinDot' + (i < digits.length ? ' on' : '') + (err ? ' bad' : '') + '"></span>';
    var keys = [1,2,3,4,5,6,7,8,9,'',0,'del'];
    var pad = keys.map(function (k) {
      if (k === '') return '<span class="pinKey spacer"></span>';
      if (k === 'del') return '<button type="button" class="pinKey" data-act="pinDel" aria-label="Delete">\u2190</button>';
      return '<button type="button" class="pinKey" data-act="pinDigit" data-d="' + k + '"' + (S.pinBusy ? ' disabled' : '') + '>' + k + '</button>';
    }).join('');
    setMain('<div class="card yel center pinCard' + (err ? ' bad' : '') + '"><h1>\uD83D\uDD12 ' + esc(PRIV) + '\u2019s PIN</h1>' +
      '<p class="hint">Enter the 4-digit PIN to open ' + esc(PRIV) + ' view. Prices stay hidden until then.</p>' +
      '<div class="pinDots" aria-hidden="true">' + dots + '</div>' +
      (S.pinBusy ? '<p class="hint">Checking\u2026</p>' : (err ? '<p class="pinErr">' + esc(err) + '</p>' : '<p class="hint">&nbsp;</p>')) +
      '<div class="pinPad" role="group" aria-label="PIN pad">' + pad + '</div>' +
      '<label class="pinKeep"><input type="checkbox" id="pinKeep"' + (LS.get('pinRemember') !== '0' ? ' checked' : '') + '> Keep me unlocked on this phone for 30 days</label>' +
      '<button class="btn full" data-act="pinCancel" ' + (S.pinBusy ? 'disabled' : '') + '>Not now</button></div>');
    if ($('pinKeep')) $('pinKeep').addEventListener('change', function (e) { LS.set('pinRemember', e.target.checked ? '1' : '0'); });
  };

SCREENS.who = function () {
    if (isSolo() && PRIV) { if (THEME.needsPin && !dadUnlocked()) askDadPin(PRIV); else enterRole(PRIV); return; }
    setMain('<div class="card skyL center"><h1>Who\u2019s using it?</h1><p>Tap your name. You can switch any time from the top.</p><div class="stack">' +
      THEME.roles.map(function (r) { return '<button class="btn ' + (r === PRIV ? 'yel' : 'pink') + ' full" style="min-height:72px;font-size:22px" data-act="pickRole" data-role="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') +
      (showKidFeatures() ? '<button class="btn full" data-act="kidEnter">\uD83E\uDDD2 Kid mode - big buttons, no prices</button>' : '') +
      '</div></div>');
  };

  SCREENS.home = function () {
    loadBoot().then(function (b) {
      var t = b.tiles, h = '';
      h += '<h1>' + (S.role === PRIV ? 'Alright, ' : 'Hiya, ') + esc(S.role) + '! \uD83D\uDC4B</h1>';
      h += '<div class="card ownCard"><label class="ownLabel" for="homeSearch">\uD83E\uDD14 Do I own it?</label>' +
        '<div class="ownRow"><input id="homeSearch" class="ownInput" type="search" placeholder="Type a name\u2026" aria-label="Do I own it? Type a name" enterkeyhint="search" autocomplete="off">' +
        '<button class="btn main scanBtn" data-act="scan" aria-label="Scan a barcode">\uD83D\uDCF7<small>Scan</small></button></div>' +
        '<div id="ownOut"></div></div>';
      var ownedN = S.items.filter(function (it) { return isOwned(it) && !it.pending; }).length;
      if (isPriv()) h += '<div id="valueBox">' + valueCardHtml(localValueSummary()) + '</div>';
      else h += '<div class="card skyL valueCard"><div class="head">\uD83E\uDDF8 Our collection</div><div class="big">' + ownedN + '</div><div class="hint">items owned</div></div>';
      if (b.missing && (b.missing.tabs.length || b.missing.columns.length)) {
        h += '<div class="warn">\uD83D\uDEA7 The sheet is still being tidied up, so a few bits (like ' + esc(b.missing.columns.concat(b.missing.tabs).join(', ')) + ') will appear once that\u2019s finished. Everything else works.</div>';
      }
      if (isPriv() && b.exampleCount) {
        h += '<div class="nudge">The items named \u201CExample -\u2026\u201D are just samples so you can look around. <button class="btn small" data-act="removeExamples">Remove example items</button></div>';
      }
      h += '<div class="tiles">';
      // Photos to take
      h += '<div class="card yel tile"><div class="head">\uD83D\uDCF8 Photos to take</div><div class="big">' + t.photos.count + '</div>';
      if (t.photos.next) {
        h += '<div class="hint">Next up: <b>' + esc(t.photos.next.name) + '</b></div><button class="btn main" data-act="snapFor" data-key="' + esc(t.photos.next.key) + '">\uD83D\uDCF7 Take photo</button>' +
          '<button class="btn small" data-act="go" data-to="photos">See all ' + t.photos.count + '</button>';
      } else h += '<div class="hint">All done - every item has photos. \uD83C\uDF89</div>';
      h += '</div>';
      if (isPriv() && showKidFeatures()) h += '<div class="card pinkL tile" id="rwHomeTile"><div class="head">\u2B50 ' + esc(KID_ROLE) + '\u2019s rewards</div><div class="hint">Points, photo approvals and rewards.</div><button class="btn main" data-act="go" data-to="rewards">Open</button></div>';
      // No value
      h += '<div class="card skyL tile"><div class="head">\uD83D\uDCB7 No value yet</div><div class="big">' + t.noValue.count + '</div>';
      if (isPriv() && t.noValue.next) h += '<div class="hint">Next: <b>' + esc(t.noValue.next.name) + '</b></div><button class="btn main" data-act="valueFor" data-key="' + esc(t.noValue.next.key) + '">Add a value</button>' +
        '<button class="btn small" data-act="go" data-to="novalue">See all</button>';
      else if (!isPriv()) h += '<div class="hint">That\u2019s ' + esc(PRIV) + '\u2019s job \uD83D\uDE09</div>';
      else h += '<div class="hint">Everything has a value. \uD83C\uDF89</div>';
      h += '</div>';
      // Drop Zone
      var dz = t.dropZone || { count: -1 };
      h += '<div class="card pinkL tile"><div class="head">\uD83D\uDCE5 Drop Zone</div><div class="big">' + (dz.count >= 0 ? dz.count : '?') + '</div><div class="hint">files waiting to be sorted into item folders</div>' +
        '<a class="btn main" href="' + esc(dz.url || b.folders.dropZone) + '" target="_blank" rel="noopener">Open Drop Zone \u2197</a>' +
        ((dz.count > 0 && !S.kid) ? '<button class="btn" style="margin-top:8px" data-act="go" data-to="dropZone">Sort documents into an item</button>' : '') + '</div>';
      // Wanted
      h += '<div class="card tile"><div class="head">\u2B50 Wanted</div><div class="big">' + t.wanted.count + '</div><div class="hint">things on the hunt list</div><div id="dealLine"></div><button class="btn main" data-act="go" data-to="wanted">See the wanted list</button></div>';
      // Checklist
      if (t.checklist) {
        var p = pct(t.checklist.owned, t.checklist.total);
        h += '<div class="card skyL tile"><div class="head">\u2705 ' + esc(clTitle(t.checklist.tab)) + ' checklist</div><div class="big">' + t.checklist.owned + ' / ' + t.checklist.total + '</div>' +
          '<div class="bar" role="img" aria-label="' + p + ' percent complete"><div style="width:' + p + '%"></div></div>' +
          '<button class="btn main" data-act="go" data-to="checklist" data-tab="' + esc(t.checklist.tab) + '">See what\u2019s missing</button></div>';
      }
      // Add
      h += '<div class="card pink tile"><div class="head">\u2795 Got something new?</div><div class="hint">Snap it, name it, done. It goes straight into the sheet with its own folder.</div><button class="btn main" data-act="go" data-to="add">Add an item</button></div>';
      h += '</div>';
      if (showKidFeatures()) h += '<button class="btn pink full" style="margin-top:12px" data-act="kidEnter">\uD83E\uDDD2 ' + esc(KID_ROLE) + '\u2019s mode (big buttons, no prices)</button>';
      h += '<div class="row" style="margin-top:6px"><button class="btn small" data-act="refresh">\u21BB Refresh</button><button class="btn small" data-act="go" data-to="stats">\uD83D\uDCCA Stats</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button><button class="btn small" data-act="go" data-to="help">\u2753 Help</button></div>';
      setMain(h);
      if (LS.get('tourPending')) { LS.set('tourPending', ''); setTimeout(function () { startTour(0); }, 350); }
      var hs = $('homeSearch');
      hs.addEventListener('keydown', function (e) { if (e.key === 'Enter') { hs.blur(); } });
      bindOwnSearch('homeSearch', 'ownOut');
      refreshDealBadges();
      loadHomeWanted();
      if (isPriv()) {
        call('getValueSummary', S.role).then(function (vs) {
          if (vs && typeof vs.total === 'number' && $('valueBox') && S.screen === 'home') $('valueBox').innerHTML = valueCardHtml(vs);
        }).catch(noop);
        if (showKidFeatures()) loadRewards(true).then(paintRewardsHome).catch(noop);
      }
    }).catch(oops);
  };

  function filteredItems() {
    var f = S.filters, q = norm(f.q);
    var list = S.items.filter(function (it) {
      if (f.range && it.range !== f.range) return false;
      if (f.series && it.series !== f.series) return false;
      if (f.status && it.status !== f.status) return false;
      if (f.cond && it.condition !== f.cond) return false;
      if (f.posted === 'yes' && !it.posted) return false;
      if (f.posted === 'no' && it.posted) return false;
      if (f.photos === 'yes' && !it.folderId) return false;
      if (f.photos === 'no' && it.folderId) return false;
      if (q) { var hay = norm([it.name, it.range, it.id, it.series, it.character, it.maker, it.year].join(' ')); if (q.split(' ').some(function (w) { return hay.indexOf(w) < 0; })) return false; }
      return true;
    });
    var idn = function (it) { var m = String(it.id || '').match(/(\d+)\s*$/); return m ? +m[1] : 0; };
    var sorts = {
      newest: function (a, b) { return idn(b) - idn(a) || b.row - a.row; },
      oldest: function (a, b) { return idn(a) - idn(b) || a.row - b.row; },
      az: function (a, b) { return a.name.localeCompare(b.name); },
      year: function (a, b) { return (parseInt(a.year, 10) || 9999) - (parseInt(b.year, 10) || 9999); },
      value: function (a, b) { return (b.v || 0) - (a.v || 0); }
    };
    if (f.sort && sorts[f.sort]) list = list.slice().sort(sorts[f.sort]);
    return list;
  }
  function activeFilterCount() { var f = S.filters; return ['range', 'series', 'status', 'cond', 'posted', 'photos'].filter(function (k) { return f[k]; }).length; }
  function opt(list, sel, allLabel) {
    return '<option value="">' + esc(allLabel) + '</option>' + list.map(function (x) { var v = Array.isArray(x) ? x[0] : x, l = Array.isArray(x) ? x[1] : x; return '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  }
  function seriesFor(range) {
    var m = {};
    S.items.forEach(function (it) { if ((!range || it.range === range) && it.series && !/^unknown$/i.test(it.series)) m[it.series] = 1; });
    return Object.keys(m).sort();
  }
  function cardHtml(it) {
    return '<button class="gcard" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) +
      (it.posted ? '<span class="badge" title="Posted on socials">\uD83D\uDCE3</span>' : '') +
      '<div class="gname">' + esc(it.name) + '<span class="gmeta">' + esc([it.range, it.status !== 'Owned' ? it.status : '', it.condition && it.condition !== 'Unknown' ? it.condition : ''].filter(Boolean).join(' \u00B7 ')) + '</span></div></button>';
  }
  SCREENS.collection = function () {
    loadBoot().then(function (b) {
      var L = b.lists, f = S.filters;
      var open = S.filtersOpen || activeFilterCount() > 0;
      var sortOpts = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['az', 'A to Z'], ['year', 'By year']];
      if (isPriv()) sortOpts.push(['value', 'Highest value']);
      var h = '<h1>' + esc(W('collectionTitle', 'Our collection')) + '</h1>' +
        '<div class="search"><input id="colSearch" type="search" placeholder="\uD83D\uDD0D Search name, character, line or ID" aria-label="Search" value="' + esc(f.q) + '" enterkeyhint="search"></div>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn small' + (open ? ' yel' : '') + '" data-act="toggleFilters" id="filterBtn">\u2699\uFE0F Filters' + (activeFilterCount() ? ' (' + activeFilterCount() + ')' : '') + '</button>' +
        '<select id="fSort" aria-label="Sort" class="inline">' + opt(sortOpts, f.sort || 'newest', 'Sort') + '</select>' +
        (activeFilterCount() || f.q ? '<button class="btn small" data-act="clearFilters">\u2715 Clear</button>' : '') + '</div>' +
        '<div class="filters" id="filterBox"' + (open ? '' : ' hidden') + '>' +
        '<label class="field">Category</label><select id="fRange" aria-label="Category">' + opt(L.range, f.range, 'All categories') + '</select>' +
        '<label class="field">Line / series</label><select id="fSeries" aria-label="Line or series">' + opt(seriesFor(f.range), f.series, 'Any line') + '</select>' +
        '<label class="field">Condition</label><select id="fCond" aria-label="Condition">' + opt(L.condition, f.cond, 'Any condition') + '</select>' +
        '<label class="field">Status</label><select id="fStatus" aria-label="Status">' + opt(L.status, f.status, 'Any status') + '</select>' +
        '<label class="field">Posted on socials</label><select id="fPosted" aria-label="Posted">' + opt([['yes', 'Posted'], ['no', 'Not posted yet']], f.posted, 'Posted or not') + '</select>' +
        '<label class="field">Photos</label><select id="fPhotos" aria-label="Photos">' + opt([['yes', 'Has photos'], ['no', 'No photos yet']], f.photos, 'With or without') + '</select>' +
        '</div><div id="colGrid"></div>';
      setMain(h);
      var draw = function () {
        var list = filteredItems();
        S.lastList = list;
        var shown = list.slice(0, S.shown);
        var g = '<p class="hint">' + list.length + ' item' + (list.length === 1 ? '' : 's') + (f.q || activeFilterCount() ? ' match' : '') +
          (list.length ? ' \u00B7 <button class="linkish" data-act="go" data-to="export" data-tab="filtered">Export these</button>' : '') + '</p>';
        if (!list.length) g += '<div class="nudge">Nothing matches that. Try fewer words, or clear the filters. <button class="btn small" data-act="clearFilters">Clear filters</button></div>';
        g += '<div class="grid">' + shown.map(cardHtml).join('') + '</div>';
        if (list.length > shown.length) g += '<p class="center"><button class="btn" data-act="more">Show more (' + (list.length - shown.length) + ' left)</button></p>';
        $('colGrid').innerHTML = g;
        watchThumbs();
      };
      var t = null;
      $('colSearch').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { f.q = e.target.value; S.shown = 60; draw(); }, 200); });
      var bind = function (id, k, rerender) { $(id).addEventListener('change', function (e) { f[k] = e.target.value; if (k === 'range') f.series = ''; S.shown = 60; if (rerender) go('collection', {}, true); else draw(); }); };
      bind('fRange', 'range', true); bind('fSeries', 'series', true); bind('fStatus', 'status', true); bind('fCond', 'cond', true);
      bind('fPosted', 'posted', true); bind('fPhotos', 'photos', true); bind('fSort', 'sort');
      S.redrawGrid = draw;
      draw();
    }).catch(oops);
  };

  SCREENS.item = function (p) {
    busy('Opening\u2026');
    call('getItem', p.key, S.role).then(function (it) {
      done();
      S.current = it;
      var facts = [['Item ID', it.id], ['Category', it.range], ['Status', it.status], ['Condition', it.condition + (it.conditionOld && it.condition === 'Unknown' && !/^unknown$/i.test(it.conditionOld) ? ' (was: ' + it.conditionOld + ')' : '')],
        ['Packaging', it.packaging || (it.packagingOld && it.packagingOld !== 'Unknown' ? 'was: ' + it.packagingOld : '')], ['Line / series', it.series], ['Character', it.character], ['Maker', it.maker],
        ['Year', (it.year || (it.yearOld && it.yearOld !== 'Unknown' ? it.yearOld : '')) + (it.yearNote ? ' (' + it.yearNote + ')' : '')],
        ['Size', it.size], ['Material', it.material], ['Accessories', it.accessories],
        ['Quantity', it.quantity], ['Where it lives', it.location], ['Date got', it.dateGot], ['Barcode', it.barcode || itemBarcode(itemByKey(it.key))]];
      var money = function (v) { return /^\s*-?\d+(\.\d+)?\s*$/.test(String(v || '')) ? gbp(+v) : v; };
      if (isPriv()) facts.push(['Paid', money(it.paid)], ['Where from', it.whereBought], ['Value', money(it.value)], ['Value source', it.valueSource]);
      facts.push(['Description', it.description && it.description !== it.name ? it.description : ''], ['Notes', it.notes]);
      facts = facts.filter(function (f) { return f[1] && !/^unknown$/i.test(String(f[1]).trim()); });
      var plats = (it.platforms || []).map(function (pl) {
        return '<button class="chip' + (pl.yes ? ' on' : '') + '" data-act="togglePosted" data-p="' + esc(pl.key) + '" aria-pressed="' + (pl.yes ? 'true' : 'false') + '">' + esc(pl.icon + ' ' + pl.label) + (pl.yes ? ' \u2713' : '') + '</button>';
      }).join('');
      var standSrc = standinUrl(it);
      var heroInner = it.folderId ? '\u23F3' : (standSrc ? '<img class="standinImg" alt="" src="' + esc(standSrc) + '">' + filmBadgeHtml() : '<span style="font-size:44px">\uD83D\uDCF7</span>');
      var h = backBtn() + '<h1>' + esc(it.name) + '</h1>' +
        '<div id="hero" class="hero' + (standSrc ? ' isStandin' : '') + '" data-act="heroOpen">' + heroInner + '</div>' +
        '<div id="nudge"></div>' +
        '<div class="stack" style="margin:12px 0"><button class="btn main full" data-act="snapCurrent">\uD83D\uDCF7 Take photo</button>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="pickCurrent">\uD83D\uDDBC\uFE0F From gallery</button><button class="btn" style="flex:1" data-act="videoCurrent">\uD83C\uDFA5 Record video</button></div>' +
        '<div class="row"><button class="btn" style="flex:1" data-act="replaceMain">\uD83D\uDD04 New main photo</button><button class="btn" style="flex:1" data-act="scanAssign">\uD83C\uDFF7\uFE0F ' + ((it.barcode || itemBarcode(itemByKey(it.key))) ? 'Change barcode' : 'Save barcode') + '</button></div>' +
        (it.offlineCopy ? '<div class="nudge">\uD83D\uDCF4 Offline copy - the full details and photos load when you\u2019re back online.</div>' : '') +
        '<div class="row"><button class="btn yel" style="flex:1" data-act="edit">\u270F\uFE0F Edit details</button>' +
        (it.folderId ? '<a class="btn" style="flex:1" href="https://drive.google.com/drive/folders/' + esc(it.folderId) + '" target="_blank" rel="noopener">\uD83D\uDCC1 Folder \u2197</a>' : '') + '</div>' +
        (shareable(it) || isPriv() ? '<div class="row">' + (shareable(it) ? '<button class="btn pink" style="flex:1" data-act="shareFind">\uD83D\uDCE4 Share this find</button>' : '') + (isPriv() ? '<button class="btn" style="flex:1" data-act="priceCheck">\uD83D\uDD0E Price check</button>' : '') + '</div><div id="priceSlot"></div>' : '') +
        (it.status === 'Wanted' || it.status === 'On order' ? '<button class="btn green full" data-act="gotItem">\u2705 Got it!</button>' : '') + '</div>' +
        '<h2>Photos</h2><div id="gallery" class="gallery"><div class="hint">' + (it.folderId ? 'Loading photos\u2026' : (standSrc ? 'Reference picture \u2014 still to film.' : 'No photos yet.')) + '</div></div>' +
        '<h2>Documents</h2><div id="docBox" class="card"><div class="hint">Loading documents\u2026</div></div>' +
        (plats ? '<div class="card skyL"><h3>\uD83D\uDCE3 Posted on</h3><div class="chips">' + plats + '</div><p class="hint">Tap one to tick it off when it\u2019s been posted.</p></div>' : '') +
        '<div class="card"><dl class="facts">' + facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl></div>' +
        '<div id="cfBox">' + cfHtml(it) + '</div>' +
        (isPriv() && !it.offlineCopy ? '<div class="card"><button class="btn full" data-act="removeItem">Remove item</button><p class="hint">It comes off your collection and goes to Removed items. You can put it back any time. Photos stay in its folder.</p></div>' : '');
      setMain(h);
      setTimeout(cfLoadPhotos, 30);
      paintDocuments([]);
      if (!it.folderId) {
        $('nudge').innerHTML = standSrc
          ? '<div class="nudge">This is a reference picture, not our photo. Tap \u201CTake photo\u201D when you film it and I\u2019ll make its folder too.</div>'
          : '<div class="nudge">\uD83D\uDCF7 No photos yet - tap \u201CTake photo\u201D and I\u2019ll make its folder too.</div>';
        return;
      }
      call('getItemDocuments', it.key, it.name, S.role).then(paintDocuments).catch(function () { paintDocuments([]); });
      call('getItemPhotos', it.folderId).then(function (ph) {
        if (!$('hero') || !$('gallery')) return;   // moved on to another screen already
        S.gallery = ph;
        if (!ph.length) { $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">No photos yet.</div>'; $('nudge').innerHTML = '<div class="nudge">\uD83D\uDCF7 Missing photo! Snap the front first - no faces in shot.</div>'; return; }
        var first = ph[0];
        $('hero').classList.toggle('hasVideo', !!first.video);
        $('hero').innerHTML = (first.thumb ? '<img alt="' + esc(first.name) + '" src="' + first.thumb + '">' : '<span style="font-size:44px">' + (first.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') +
          (first.video ? playBadgeHtml() + '<span class="zoom">\u25B6 Play video</span>' : '<span class="zoom">\uD83D\uDD0D Tap to zoom</span>');
        $('gallery').innerHTML = ph.map(function (x, i) {
          return galleryThumbHtml(x, i);
        }).join('') + '<p class="hint" style="grid-column:1/-1">' + ph.length + ' photo' + (ph.length === 1 ? '' : 's') + (ph.some(function (x) { return x.video; }) ? ' or video' : '') + ' \u00B7 tap one to see it big, or play a video here</p>';
        if (!ph.some(function (x) { return /- back\b/i.test(x.name); }) && !ph.some(function (x) { return x.video; })) $('nudge').innerHTML = '<div class="nudge">Tip: a photo of the back or box side helps with values later.</div>';
      }).catch(function () { if (!$('hero') || !$('gallery')) return; $('hero').innerHTML = '<span style="font-size:44px">\uD83D\uDCF7</span>'; $('gallery').innerHTML = '<div class="hint">Couldn\u2019t load the photos - tap Refresh in \u201CI\u2019m stuck\u201D.</div>'; });
    }).catch(oops);
  };
  function driveFileId(x) {
    if (!x) return '';
    if (x.id && /^[\w-]{10,}$/.test(String(x.id))) return String(x.id);
    var m = String(x.url || '').match(/\/d\/([\w-]{10,})/) || String(x.url || '').match(/[?&]id=([\w-]{10,})/);
    return m ? m[1] : '';
  }
  function drivePreviewUrl(x) {
    var id = driveFileId(x);
    return id ? 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview' : '';
  }
  function driveOpenUrl(x) {
    if (x && x.url) return x.url;
    var id = driveFileId(x);
    return id ? 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view' : '';
  }
  function playBadgeHtml() {
    return '<span class="playIc" aria-hidden="true"><span class="playTri"></span></span>';
  }
  function galleryThumbHtml(x, i) {
    return '<button class="gthumb' + (x.main ? ' main' : '') + (x.video ? ' hasVideo' : '') + '" data-act="openPhoto" data-i="' + i + '" aria-label="' + esc((x.video ? 'Play video: ' : '') + (x.name || 'Photo')) + '">' +
      (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span>' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') +
      (x.main ? '<b>Main</b>' : '') + (x.video ? playBadgeHtml() : '') + '</button>';
  }
  function openPhoto(i) {
    var x = (S.gallery || [])[i]; if (!x) return;
    var lb = $('lightbox');
    var preview = x.video ? drivePreviewUrl(x) : '';
    var openUrl = driveOpenUrl(x);
    var media;
    if (x.video && preview) {
      media = '<div class="lbImg lbVideoBox"><iframe class="lbVideo" src="' + esc(preview) + '" title="' + esc(x.name || 'Video') + '" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
    } else {
      media = '<div class="lbImg">' + (x.thumb ? '<img alt="" src="' + x.thumb + '">' : '<span style="font-size:60px">' + (x.video ? '\uD83C\uDFAC' : '\uD83D\uDCF7') + '</span>') + (x.video ? playBadgeHtml() : '') + '</div>';
    }
    lb.setAttribute('aria-label', x.video ? 'Video' : 'Photo');
    lb.innerHTML = '<div class="lbInner">' + media +
      '<div class="lbName">' + esc(x.name) + (x.main ? ' \u00B7 <b>main photo</b>' : '') + (x.video ? ' \u00B7 video' : '') + '</div>' +
      (x.video ? '<p class="lbHint">Plays here in the app. If it doesn\u2019t start, use Open in Drive.</p>' : '') +
      '<div class="row lbBtns">' + (i > 0 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i - 1) + '">\u2190</button>' : '') +
      (!x.main && !x.video ? '<button class="btn small yel" data-act="makeMain" data-i="' + i + '">\u2B50 Make main photo</button>' : '') +
      (openUrl ? '<a class="btn small" href="' + esc(openUrl) + '" target="_blank" rel="noopener">Open in Drive \u2197</a>' : '') +
      (i < S.gallery.length - 1 ? '<button class="btn small" data-act="openPhoto" data-i="' + (i + 1) + '">\u2192</button>' : '') +
      '<button class="btn small main" data-act="closePhoto">Close</button></div></div>';
    var wasOpen = !lb.hidden;
    lb.hidden = false;
    layerOpen(wasOpen);
    if (!x.video) call('getPhotoLarge', S.current.key, x.id).then(function (r) {
      if (lb.hidden || !r || !r.src) return;
      var img = lb.querySelector('.lbImg img'); if (img) img.src = r.src; else if (lb.querySelector('.lbImg')) lb.querySelector('.lbImg').innerHTML = '<img alt="" src="' + r.src + '">';
    }).catch(function () { /* keep the small one */ });
  }


  function maxDocMb() { return THEME.maxDocMb || 20; }
  function docLabels() { return (THEME.docLabels && THEME.docLabels.length) ? THEME.docLabels.slice() : ['Manual', 'Receipt', 'Certificate', 'Valuation', 'Other']; }
  function isMoneyDocLabel(label) { return /^(Receipt|Valuation)$/i.test(label || ''); }
  function canAddDocs() {
    if (S.kid) return !!THEME.kidsCanAddDocs;
    return !!S.role;
  }
  function addableDocLabels() {
    var list = docLabels();
    if (isPriv()) return list;
    return list.filter(function (l) { return !isMoneyDocLabel(l); });
  }
  function paintDocuments(docs) {
    var box = $('docBox'); if (!box) return;
    S.docs = docs || [];
    var rows = (docs || []).map(function (d) {
      return '<div class="row" style="align-items:flex-start;margin-top:10px;gap:8px">' +
        '<div style="flex:1;min-width:0"><a href="' + esc(d.url) + '" target="_blank" rel="noopener"><b>' + esc(d.label || 'Document') + '</b> \u2014 ' + esc(d.name) + '</a>' +
        (d.date ? '<div class="hint">' + esc(d.date) + '</div>' : '') + '</div>' +
        (isPriv() ? '<button class="btn small" data-act="removeDoc" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Remove</button>' : '') +
        '</div>';
    }).join('');
    var add = '';
    if (canAddDocs()) {
      add = '<button class="btn full" style="margin-top:12px" data-act="addDoc">Add a document</button>' +
        '<p class="hint">A PDF manual, receipt, certificate or valuation, a Word file, or a photo of the document. Up to ' + maxDocMb() + ' MB. Receipts and valuations stay with ' + esc(PRIV) + '.</p>';
    } else if (S.kid) {
      add = '<p class="hint">Documents here are view only. Receipts and valuations stay with ' + esc(PRIV) + '.</p>';
    }
    box.innerHTML = (rows || '<p class="hint">No documents yet.</p>') + add;
  }
  function addDocumentUI() {
    if (!S.current) return;
    if (!canAddDocs()) { toast('Documents are view only here.'); return; }
    var labels = addableDocLabels();
    sheet('Add a document', '<p>Pick a label, then choose a PDF, a Word file or a photo of the document.</p>' +
      '<label class="field" for="docLabel">Label</label><select id="docLabel">' + labels.map(function (l) { return '<option>' + esc(l) + '</option>'; }).join('') + '</select>',
      [{ label: 'Choose file', value: 'ok', cls: 'main' }, { label: 'Cancel', value: '' }]).then(function (v) {
        if (v !== 'ok') return;
        var sel = $('docLabel');
        S.docLabel = sel ? sel.value : 'Other';
        var inp = $('docInput');
        if (!inp) { toast('This copy of the app needs a quick update to add documents.'); return; }
        inp.value = '';
        inp.click();
      });
  }
  function onDocFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    var it = S.current; if (!it) return;
    var mb = file.size / 1048576, cap = maxDocMb();
    if (mb > cap) { oops(new Error('That file is ' + (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + ' MB. Documents in the app can be up to ' + cap + ' MB. For a bigger one, pop it in the Drop Zone and sort it from Home.')); return; }
    var okType = /pdf|msword|officedocument|opendocument|text\/plain|image\/(jpeg|jpg|png|webp|heic|heif)/i.test(file.type || '') ||
      /\.(pdf|doc|docx|odt|txt|jpe?g|png|webp|heic|heif)$/i.test(file.name || '');
    if (!okType) { oops(new Error('Please pick a PDF, a Word document, or a photo of the document.')); return; }
    busy('Saving the document\u2026');
    readRaw(file).then(function (pf) {
      return call('uploadDocument', it.key, it.name, pf.mime || file.type || 'application/octet-stream', pf.b64, S.docLabel || 'Other', S.role);
    }).then(function () {
      done(); toast('Saved in the item folder.', 'good');
      if (S.screen === 'item') go('item', { key: it.key }, true);
    }).catch(oops);
  }
  function removeDocumentUI(id, name) {
    if (!isPriv() || !S.current || !id) return;
    confirmSheet('Remove this document?', 'It comes off the item and goes to the Removed documents folder (next to the sheet). Nothing is binned. You can move it back from Google Drive if you need it.', 'Remove it', 'Keep it').then(function (ok) {
      if (!ok) return;
      busy('Moving it\u2026');
      return call('removeDocument', S.current.key, S.current.name, id, S.role).then(function () {
        done(); toast((name ? name + ' is' : 'It is') + ' in Removed documents.', 'good');
        if (S.screen === 'item') go('item', { key: S.current.key }, true);
      });
    }).catch(oops);
  }
  SCREENS.dropZone = function () {
    if (S.kid) { go('home'); return; }
    busy('Looking in the Drop Zone\u2026');
    Promise.all([loadBoot().catch(function () { return S.boot; }), call('listDropZoneDocuments', S.role)]).then(function (res) {
      done();
      var docs = res[1] || [];
      var items = ((S.boot && S.boot.items) || S.items || []).filter(function (it) { return it && it.name; });
      var opts = items.map(function (it) { return '<option value="' + esc(it.key || it.id) + '">' + esc(it.name) + '</option>'; }).join('');
      var labels = addableDocLabels();
      var rows = docs.map(function (d) {
        var lab = labels.map(function (l) { return '<option' + (l === d.label ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
        var guessed = d.guessKey ? ' selected' : '';
        var itemOpts = '<option value="">Choose an item</option>' + items.map(function (it) {
          var k = it.key || it.id;
          return '<option value="' + esc(k) + '"' + (k === d.guessKey ? ' selected' : '') + '>' + esc(it.name) + '</option>';
        }).join('');
        return '<div class="card" data-drop="' + esc(d.id) + '"><p><b>' + esc(d.name) + '</b></p>' +
          (d.date ? '<p class="hint">' + esc(d.date) + (d.guessName ? ' \u00B7 looks like ' + esc(d.guessName) : '') + '</p>' : (d.guessName ? '<p class="hint">Looks like ' + esc(d.guessName) + '</p>' : '')) +
          '<label class="field">Item</label><select data-drop-item>' + itemOpts + '</select>' +
          '<label class="field">Label</label><select data-drop-label>' + lab + '</select>' +
          '<button class="btn main full" style="margin-top:10px" data-act="assignDropDoc" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Add to that item</button>' +
          (d.url ? '<a class="btn full" href="' + esc(d.url) + '" target="_blank" rel="noopener">Open in Drive \u2197</a>' : '') +
          '</div>';
      }).join('');
      setMain(backBtn() + '<h1>Drop Zone documents</h1><p class="hint">PDFs and other documents waiting in the Drop Zone. Pick the item and a label to file one. Photos can still be opened in Drive.</p>' +
        (rows || '<div class="card"><p class="hint">No documents waiting. Open the Drop Zone to add a PDF, then come back.</p></div>'));
    }).catch(oops);
  };
  function assignDropDocUI(el) {
    var id = el.getAttribute('data-id');
    var card = el.closest ? el.closest('[data-drop]') : null;
    if (!card && el.parentNode) {
      var n = el.parentNode;
      while (n && !(n.getAttribute && n.getAttribute('data-drop'))) n = n.parentNode;
      card = n;
    }
    if (!id || !card) return;
    var itemSel = card.querySelector('[data-drop-item]');
    var labSel = card.querySelector('[data-drop-label]');
    var key = itemSel && itemSel.value;
    var label = labSel && labSel.value;
    if (!key) { toast('Pick which item it belongs to.'); return; }
    var items = ((S.boot && S.boot.items) || S.items || []);
    var it = items.filter(function (x) { return (x.key || x.id) === key; })[0];
    if (!it) { toast('I couldn\u2019t find that item.'); return; }
    busy('Filing it\u2026');
    call('assignDropZoneDocument', id, it.key || it.id, it.name, label || 'Other', S.role).then(function () {
      done(); toast('Filed with ' + it.name + '.', 'good');
      go('dropZone', {}, true);
    }).catch(oops);
  }

  function selectHtml(id, list, val) {
    var l = list.slice(); if (val && l.indexOf(val) < 0) l.unshift(val);
    return '<select id="' + id + '"><option value=""></option>' + l.map(function (x) { return '<option' + (x === val ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>';
  }
  SCREENS.edit = function () {
    var it = S.current; if (!it) return back();
    var L = S.boot ? S.boot.lists : { range: [], condition: [], packaging: [], status: [] };
    var txt = function (id, label, val, extra) { return '<label class="field" for="e_' + id + '">' + label + '</label><input type="text" id="e_' + id + '" value="' + esc(val) + '" ' + (extra || '') + '>'; };
    var sel = function (id, label, list, val) { return '<label class="field" for="e_' + id + '">' + label + '</label>' + selectHtml('e_' + id, list, val); };
    var h = backBtn() + '<h1>Edit</h1><div class="card">' +
      txt('name', 'Name', it.name) +
      sel('range', 'Range', L.range, it.range) +
      sel('condition', 'Condition', L.condition, it.condition) +
      sel('packaging', 'Packaging', L.packaging, it.packaging) +
      sel('status', 'Status', L.status, it.status) +
      '<details' + (S.params.focus === 'value' ? ' open' : '') + '><summary class="btn small" style="margin-top:12px">More details (optional)</summary>' +
      txt('year', 'Year (just the number)', it.year, 'inputmode="numeric" maxlength="4"') +
      txt('yearNote', 'Year note', it.yearNote) +
      txt('series', 'Line / series and number', it.series) +
      txt('character', 'Character', it.character) +
      txt('maker', 'Maker', it.maker) +
      txt('quantity', 'How many', it.quantity, 'inputmode="numeric"') +
      txt('location', 'Where it lives', it.location) +
      (isPriv() ? txt('paid', 'Price paid ' + (THEME.currency || '\u00A3') + ' (private)', it.paid, 'inputmode="decimal"') + txt('value', 'Value ' + (THEME.currency || '\u00A3') + ' (private)', it.value, 'inputmode="decimal"') : '') +
      '<label class="field" for="e_notes">Notes</label><textarea id="e_notes">' + esc(it.notes) + '</textarea></details>' +
      '<div class="stack" style="margin-top:14px"><button class="btn main full" data-act="saveEdit">\uD83D\uDCBE Save</button><button class="btn full" data-act="back">Cancel</button></div></div>';
    setMain(h);
    if (S.params.focus === 'value' && $('e_value')) $('e_value').focus();
  };
  function saveEdit() {
    var it = S.current, fields = ['name', 'range', 'condition', 'packaging', 'status', 'year', 'yearNote', 'series', 'character', 'maker', 'quantity', 'location', 'notes', 'paid', 'value'];
    var ch = {};
    fields.forEach(function (f) { var el = $('e_' + f); if (el && String(el.value).trim() !== String(it[f] == null ? '' : it[f])) ch[f] = el.value; });
    if (!Object.keys(ch).length) { toast('Nothing changed - all good.'); return back(); }
    if (ch.year && !/^\d{4}$/.test(ch.year.trim())) { sheet('Quick one about the year', '<p>Year works best as just the 4 numbers, like <b>1999</b>. Pop anything else (like \u201Cabout 1990\u201D) in Year note.</p>'); return; }
    var p = Promise.resolve(true);
    if (ch.status === 'Sold') p = confirmSheet('Mark as sold?', 'It stays in the sheet (nothing is deleted), it just won\u2019t count as owned any more.', 'Yes, it\u2019s sold', 'No');
    p.then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('saveItem', it.key, it.name, ch, S.role).then(function (r) {
        done(); S.boot = null;
        pointsNote(r, r.skipped && r.skipped.length ? 'Saved! (The sheet has no column for ' + r.skipped.join(', ') + ' yet, so those were skipped.)' : '\u2705 Saved');
        S.history.pop(); go('item', { key: it.key }, true);
      });
    }).catch(oops);
  }

  /* ---- Add: 4 steps ---- */
  function addState() { if (!S.add) S.add = { step: 1, shots: [], name: '', range: '', condition: '', more: {} }; return S.add; }
  function addShots(files) {
    var A = addState();
    busy('Getting the photo ready\u2026');
    files.reduce(function (p, f) {
      return p.then(function () { return prepareFile(f); }).then(function (pf) {
        var labels = THEME.photoLabels;
        var isVid = pf.mime.indexOf('video/') === 0;
        var used = A.shots.filter(function (s) { return !s.video; }).length;
        pf.video = isVid; pf.label = isVid ? 'Video' : (labels[used] || 'Photo ' + (used + 1));
        A.shots.push(pf);
      });
    }, Promise.resolve()).then(function () { done(); go('add', {}, true); }).catch(function (e) { oops(e); go('add', {}, true); });
  }
  SCREENS.add = function () {
    var A = addState();
    loadBoot().then(function (b) {
      var L = b.lists, h = '<h1>Add an item</h1><div class="steps">' + [1, 2, 3, 4].map(function (n) { return '<span class="' + (n <= A.step ? 'on' : '') + '"></span>'; }).join('') + '</div>';
      if (A.step === 1) {
        h += '<div class="card yel"><h2>1. Snap it \uD83D\uDCF8</h2><p>Front first, then back and sides if you like. No faces in shot.</p>' +
          '<div class="shots">' + A.shots.map(function (s, i) { return '<div class="shot">' + (s.preview ? '<img alt="" src="' + s.preview + '">' : '\uD83C\uDFAC') + '<b>' + esc(s.label) + '</b></div>'; }).join('') + '</div>' +
          '<div class="stack"><button class="btn main full" data-act="addSnap">\uD83D\uDCF7 ' + (A.shots.length ? 'Take another' : 'Take photo') + '</button>' +
          '<button class="btn full" data-act="addPick">\uD83D\uDDBC\uFE0F Choose from gallery</button>' +
          (A.shots.length ? '<button class="btn small" data-act="addClearShots">Start photos again</button>' : '') +
          '<button class="btn green full" data-act="addNext">' + (A.shots.length ? 'Next \u2192' : 'No photo right now \u2192') + '</button></div></div>';
      } else if (A.step === 2) {
        h += '<div class="card skyL"><h2>2. What is it?</h2><p class="hint">Whatever you\u2019d call it, e.g. \u201C' + esc(W('nameExample', 'Blue robot - 1985 boxed')) + '\u201D.</p>' +
          '<input type="text" id="addName" value="' + esc(A.name) + '" placeholder="Name" autocomplete="off" enterkeyhint="next">' +
          addBarcodeBox(A) +
          '<div class="stack" style="margin-top:12px"><button class="btn green full" data-act="addNext">Next \u2192</button><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      } else if (A.step === 3) {
        h += '<div class="card pinkL"><h2>3. Which range?</h2><input type="search" id="rangeFilter" placeholder="\uD83D\uDD0D Find a range" aria-label="Find a range"><div class="choice" id="rangeChoices" style="margin-top:10px">' +
          L.range.map(function (r) { return '<button class="btn small' + (A.range === r ? ' sel' : '') + '" data-act="addRange" data-v="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
          '<div class="stack" style="margin-top:12px"><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      } else {
        h += '<div class="card"><h2>4. What condition?</h2><div class="choice">' +
          L.condition.map(function (c) { return '<button class="btn small' + (A.condition === c ? ' sel' : '') + '" data-act="addCond" data-v="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') + '</div>' +
          '<details style="margin-top:12px"><summary class="btn small">More details (optional)</summary>' +
          '<label class="field" for="a_packaging">Packaging</label>' + selectHtml('a_packaging', L.packaging, A.more.packaging || '') +
          '<label class="field" for="a_status">Status</label>' + selectHtml('a_status', L.status, A.more.status || 'Owned') +
          '<label class="field" for="a_year">Year (just the number)</label><input type="text" id="a_year" inputmode="numeric" maxlength="4" value="' + esc(A.more.year || '') + '">' +
          '<label class="field" for="a_maker">Maker</label><input type="text" id="a_maker" value="' + esc(A.more.maker || '') + '">' +
          (isPriv() ? '<label class="field" for="a_paid">Price paid ' + (THEME.currency || '\u00A3') + ' (private)</label><input type="text" id="a_paid" inputmode="decimal" value="' + esc(A.more.paid || '') + '">' +
            '<label class="field" for="a_where">Where from</label><input type="text" id="a_where" value="' + esc(A.more.whereBought || '') + '">' : '') +
          '<label class="field" for="a_notes">Notes</label><textarea id="a_notes">' + esc(A.more.notes || '') + '</textarea></details>' +
          addBarcodeBox(A) +
          '<div class="warn" style="margin-top:12px"><b>Check:</b> ' + esc(A.name) + ' \u00B7 ' + esc(A.range) + ' \u00B7 ' + (A.condition ? esc(A.condition) : '<i>pick a condition</i>') + ' \u00B7 ' + A.shots.length + ' photo' + (A.shots.length === 1 ? '' : 's') + (A.barcode ? ' \u00B7 barcode ' + esc(A.barcode) : '') + '</div>' +
          '<div class="stack"><button class="btn main full" data-act="addSave"' + (A.condition ? '' : ' disabled') + '>\uD83D\uDCBE Save to the collection</button><button class="btn full" data-act="addBack">\u2190 Back</button></div></div>';
      }
      setMain(h);
      if (A.step === 2) { var n = $('addName'); n.focus(); n.addEventListener('keydown', function (e) { if (e.key === 'Enter') addNext(); }); }
      if (A.step === 3) {
        $('rangeFilter').addEventListener('input', function (e) {
          var q = norm(e.target.value);
          document.querySelectorAll('#rangeChoices button').forEach(function (bt) { bt.hidden = q && norm(bt.textContent).indexOf(q) < 0; });
        });
      }
    }).catch(oops);
  };
  function addNext() {
    var A = addState();
    if (A.step === 2) {
      A.name = ($('addName').value || '').trim();
      if (!A.name) { sheet('It needs a name', '<p>Even a rough one is fine, like \u201C' + esc(W('roughName', 'blue robot thing')) + '\u201D. You can change it later.</p>'); return; }
      busy('Checking you haven\u2019t already got it\u2026');
      call('checkDuplicate', A.name).then(function (hits) {
        done();
        if (!hits.length) { A.step = 3; layerPush(); go('add', {}, true); return; }
        var body = '<p>Looks like you might already have:</p><ul>' + hits.map(function (x) { return '<li><b>' + esc(x.name) + '</b> <span class="muted">(' + esc(x.range) + ')</span></li>'; }).join('') + '</ul><p>Is this a different one, or a second copy?</p>';
        sheet('Already got it?', body, [{ label: 'It\u2019s a different one - carry on', value: 'go', cls: 'main' }, { label: 'Open the one I\u2019ve got', value: 'open' }, { label: 'Change the name', value: 'stay' }])
          .then(function (v) { if (v === 'go') { A.step = 3; layerPush(); go('add', {}, true); } else if (v === 'open') { go(S.kid ? 'kidItem' : 'item', { key: hits[0].key }); } });
      }).catch(function (e) { done(); A.step = 3; go('add', {}, true); });
      return;
    }
    A.step = Math.min(4, A.step + 1); layerPush(); go('add', {}, true);
  }
  function addSave() {
    var A = addState();
    var v = function (id) { var el = $(id); return el ? el.value.trim() : ''; };
    A.more = { packaging: v('a_packaging'), status: v('a_status') || 'Owned', year: v('a_year'), maker: v('a_maker'), paid: v('a_paid'), whereBought: v('a_where'), notes: v('a_notes') };
    if (A.more.year && !/^\d{4}$/.test(A.more.year)) { sheet('Quick one about the year', '<p>Year is just the 4 numbers, like <b>1999</b>. Leave it blank if you\u2019re not sure.</p>'); return; }
    var payload = { name: A.name, range: A.range, condition: A.condition, packaging: A.more.packaging, status: A.more.status, year: A.more.year, maker: A.more.maker, paid: A.more.paid, whereBought: A.more.whereBought, notes: A.more.notes };
    busy('Adding it to the sheet\u2026');
    call('addItem', payload, S.role).then(function (r) {
      var n = 0, failed = 0;
      if (A.barcode) { var bm = localBarcodes(); bm[r.key] = A.barcode; LS.set('barcodes', JSON.stringify(bm)); }
      var bcStep = A.barcode ? call('saveBarcode', r.key, r.name, A.barcode, S.role).catch(function () { /* kept on the phone; can be saved again from the item */ }) : Promise.resolve();
      return bcStep.then(function () { return A.shots.reduce(function (p, s) {
        return p.then(function () {
          busy('Saving photo ' + (n + failed + 1) + ' of ' + A.shots.length + '\u2026');
          return call('uploadMedia', r.key, r.name, s.mime, s.b64, s.label).then(function () { n++; }, function () { failed++; });
        });
      }, Promise.resolve()); }).then(function () {
        done(); S.add = null; S.boot = null;
        var body = (r.queued ? '<p>\uD83D\uDCF4 No signal, so <b>' + esc(r.name) + '</b> and ' + n + ' photo' + (n === 1 ? ' is' : 's are') + ' saved on the phone. They\u2019ll go into the sheet and Drive as soon as you\u2019re back online.</p>' :
          '<p><b>' + esc(r.name) + '</b> is in the collection' + (r.id ? ' as <b>' + esc(r.id) + '</b>' : '') + ', with its own folder and ' + n + ' photo' + (n === 1 ? '' : 's') + '.</p>') +
          (r.points ? '<p><b>+' + r.points + ' points!</b></p>' : '') +
          (failed ? '<div class="nudge">' + failed + ' photo' + (failed === 1 ? '' : 's') + ' didn\u2019t go through - open the item and tap \u201CAdd photo\u201D to try again.</div>' : '');
        return sheet('\uD83C\uDF89 Added!', body, [{ label: 'Open it', value: 'open', cls: 'main' }, { label: 'Add another', value: 'again' }, { label: 'Home', value: 'home' }]).then(function (x) {
          if (x === 'open') go(S.kid ? 'kidItem' : 'item', { key: r.key }); else if (x === 'again') go('add', {}, true); else go(S.kid ? 'kid' : 'home');
        });
      });
    }).catch(oops);
  }


  var WANT_EGGS = ['\uD83D\uDC15', '\uD83C\uDF6A', '\uD83D\uDC1F', '\uD83D\uDC7D', '\uD83C\uDF34', '\uD83D\uDCFA', '\uD83D\uDC7E'];
  var WANT_PEEK_ROT = [];
  function wantArt(cat, series, idx) { return { bg: '', peek: '' }; }
  var WAVE_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
  function waveNum(s) {
    var m = String(s || '').match(/(?:wave|series|season)\s+([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)/i);
    if (!m) return 9999;
    var w = m[1].toLowerCase();
    return WAVE_WORDS[w] || parseInt(w, 10) || 9999;
  }
  function isWantedWave(s) {
    return /(?:^|\b)(?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/i.test(String(s || '').trim());
  }
  function wantedParts(w) {
    var cat = String((w && w.range) || '').trim();
    var series = String((w && w.series) || '').trim();
    if (series && !isWantedWave(series)) series = '';
    var wr = /^(.*?)\s+((?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)(?:\b.*)?)$/i;
    if (!series) {
      var m = cat.match(wr);
      if (m) { cat = m[1].trim(); series = m[2].trim(); }
    }
    if (!series) {
      var m2 = String((w && w.name) || '').match(/\b((?:Wave|Series|Season)\s+(?:[0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen))\b/i);
      if (m2) series = m2[1];
    }
    if (!cat) cat = 'Other';
    return { cat: cat, series: series };
  }
  function wantedGroupId(p) { return (p.cat + '|' + (p.series || '')).toLowerCase(); }
  function wantedGroupTitle(p) { return p.series ? p.cat + ' \u00b7 ' + p.series : p.cat; }
  function wantedGroups(list) {
    var map = {}, order = [];
    (list || []).forEach(function (w, i) {
      var p = wantedParts(w), id = wantedGroupId(p);
      if (!map[id]) { map[id] = { id: id, title: wantedGroupTitle(p), cat: p.cat, series: p.series, items: [] }; order.push(id); }
      map[id].items.push({ w: w, i: i });
    });
    order.sort(function (a, b) {
      var A = map[a], B = map[b];
      var ac = A.cat === 'Other' ? 1 : 0, bc = B.cat === 'Other' ? 1 : 0;
      if (ac !== bc) return ac - bc;
      var c = A.cat.localeCompare(B.cat, 'en-GB', { sensitivity: 'base' });
      if (c) return c;
      var aw = waveNum(A.series), bw = waveNum(B.series);
      if (aw !== bw) return aw - bw;
      return String(A.series || '').localeCompare(String(B.series || ''), 'en-GB', { sensitivity: 'base' });
    });
    return order.map(function (id) {
      map[id].items.sort(function (a, b) { return String(a.w.name || '').localeCompare(String(b.w.name || ''), 'en-GB', { sensitivity: 'base' }); });
      return map[id];
    });
  }
  function wantCollapsedMap() {
    try { var o = JSON.parse(LS.get('wantCollapsed') || '{}'); return o && typeof o === 'object' ? o : {}; }
    catch (e) { return {}; }
  }
  function wantSetCollapsed(id, on) {
    var o = wantCollapsedMap();
    if (on) o[id] = 1; else delete o[id];
    LS.set('wantCollapsed', JSON.stringify(o));
  }
  function wantedDivider(n) { return ''; }
  function wantBannerHtml(g, gi, closed) {
    var art = wantArt(g.cat, g.series, gi);
    return '<button type="button" class="wantHead wantBanner" data-act="wantToggle" data-gid="' + esc(g.id) + '" aria-expanded="' + (closed ? 'false' : 'true') + '">' +
      '<span class="wantBannerBg plain" aria-hidden="true"></span><span class="wantPeek emoji" aria-hidden="true">' + catIcon(g.cat) + '</span>' +
      '<span class="wantBannerText"><span class="wantChev">' + (closed ? '\u25B8' : '\u25BE') + '</span>' +
      '<span class="wantTitle">' + esc(g.title) + '</span>' +
      '<span class="wantN">(' + g.items.length + ')</span></span></button>';
  }
  function wantedSearchHay(w) {
    return norm([w.name, w.range, w.series, w.conditionWanted].filter(Boolean).join(' '));
  }
  function wantedItemHtml(w, i, kid) {
    var hay = esc(wantedSearchHay(w));
    var info = '<button type="button" class="btn small wantInfoBtn" data-act="wantInfo" data-src="' + (kid ? 'kid' : 'own') + '" data-i="' + i + '" aria-label="Info about ' + esc(w.name) + '">\u24D8</button>';
    if (kid) {
      return '<div class="khuntCard" data-wq="' + hay + '"><b>' + esc(w.name) + '</b><small>' + esc([w.range, isWantedWave(w.series) ? w.series : '', (!isWantedWave(w.series) && w.series) ? w.series : (w.number || '')].filter(Boolean).join(' \u00b7 ')) + '</small>' +
        '<div class="row wantActions">' + info + '<button class="btn green kbtn" data-act="kidGot" data-i="' + i + '">\uD83C\uDF89 Found it!</button></div></div>';
    }
    return '<div class="li' + (w.deal ? ' deal' : '') + '" data-wq="' + hay + '"><div class="grow">' + (w.deal ? '<span class="pill red">\uD83D\uDD25 Deal</span> ' : '') + esc(w.name) +
      '<small>' + esc([w.variant, w.range, w.series, w.conditionWanted].filter(Boolean).join(' \u00b7 ')) + '</small>' +
      (w.deal ? '<small>' + esc(['Found' + (w.dealFound ? ' ' + w.dealFound : ''), w.dealCondition ? 'condition: ' + w.dealCondition : ''].filter(Boolean).join(' \u00b7 ')) + '</small>' +
        (w.dealLink ? '<a class="btn small yel" style="margin-top:6px" href="' + esc(w.dealLink) + '" target="_blank" rel="noopener">Open the deal \u2197</a>' : '') : '') +
      '</div><div class="stack" style="gap:6px">' + info +
      '<button class="btn small yel" data-act="findCheapest" data-i="' + i + '">\uD83D\uDED2 Shop</button>' +
      '<button class="btn green small" data-act="gotWanted" data-i="' + i + '">Got it</button></div></div>';
  }
  function renderWantedGroups(list, kid) {
    var groups = wantedGroups(list);
    if (!groups.length) return kid ? '<div class="nudge">Nothing on the hunt list right now.</div>' : '<div class="nudge">Nothing on the wanted list right now.</div>';
    var col = wantCollapsedMap();
    var h = '<div class="wantBar"><button type="button" class="btn small" data-act="wantCollapseAll">Collapse all</button>' +
      '<button type="button" class="btn small" data-act="wantExpandAll">Expand all</button></div>';
    h += '<div id="wantList" class="' + (kid ? 'khunt' : 'list') + ' wantGrouped">';
    groups.forEach(function (g, gi) {
      var closed = !!col[g.id];
      h += '<div class="wantGroup' + (closed ? ' is-collapsed' : '') + '" data-gid="' + esc(g.id) + '">';
      h += wantBannerHtml(g, gi, closed);
      h += '<div class="wantItems">';
      g.items.forEach(function (it) { h += wantedItemHtml(it.w, it.i, kid); });
      h += '</div></div>';
    });
    return h + '</div>';
  }
  function wantToggle(id, force) {
    document.querySelectorAll('.wantGroup').forEach(function (el) {
      var gid = el.getAttribute('data-gid');
      if (id && gid !== id) return;
      var on = force != null ? !!force : !el.classList.contains('is-collapsed');
      el.classList.toggle('is-collapsed', on);
      wantSetCollapsed(gid, on);
      var btn = el.querySelector('.wantHead');
      if (btn) {
        btn.setAttribute('aria-expanded', on ? 'false' : 'true');
        var ch = btn.querySelector('.wantChev');
        if (ch) ch.textContent = on ? '\u25B8' : '\u25BE';
      }
    });
  }
  function wantCollapseAll(on) {
    var o = {};
    document.querySelectorAll('.wantGroup').forEach(function (el) {
      var gid = el.getAttribute('data-gid');
      if (on) o[gid] = 1;
    });
    LS.set('wantCollapsed', JSON.stringify(o));
    wantToggle(null, on);
  }
  function filterWantedList(qRaw, total) {
    var q = norm(qRaw), shown = 0;
    document.querySelectorAll('#wantList .wantGroup').forEach(function (g) {
      var n = 0;
      g.querySelectorAll('[data-wq]').forEach(function (li) {
        var words = q ? q.split(' ') : [], txt = li.getAttribute('data-wq') || '', hit = words.every(function (w) { return txt.indexOf(w) >= 0; });
        li.hidden = !hit; if (hit) { n++; shown++; }
      });
      g.hidden = q ? n === 0 : false;
      if (q && n) g.classList.remove('is-collapsed');
    });
    if ($('wantCount')) $('wantCount').textContent = q ? shown + ' of ' + total + ' match \u201C' + qRaw + '\u201D.' : total + ' on the hunt list. Got one? Tap \u201CGot it\u201D.';
  }
  function wantedSearchQuery(w) {
    return [w && w.name, w && w.range, w && w.series, w && w.year].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  function ebayWantedUrl(w) {
    return 'https://www.ebay.co.uk/sch/i.html?_nkw=' + encodeURIComponent(wantedSearchQuery(w));
  }
  function wantRefSlug(w) {
    var bit = function (s) {
      return norm(s).replace(/#/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
    };
    return bit(w && w.range) + '__' + bit(w && w.series) + '__' + bit(w && w.name);
  }
  function wantRefUrl(w) {
    var id = wantRefSlug(w);
    if (WANT_REF_IDS && WANT_REF_IDS[id]) return './assets/refs/' + id + '.webp';
    return '';
  }
  function findRefPic(w) {
    return Promise.resolve(wantRefUrl(w) || '');
  }
  function wantedInfoSheet(i, list) {
    var w = (list || [])[i]; if (!w) return;
    var url = wantRefUrl(w);
    var kidNow = !!S.kid;
    sheet(w.name, '<div class="wantInfo">' +
      (url ? '<div class="wantRef" id="wantRef"><img alt="" src="' + esc(url) + '"></div><p class="wantRefLab">Reference picture</p>' : '') +
      '<p class="hint">' + esc([w.variant, w.range, w.series, w.conditionWanted ? 'wanted in ' + w.conditionWanted : ''].filter(Boolean).join(' \u00b7 ')) + '</p>' +
      (w.notes ? '<p>' + esc(w.notes) + '</p>' : '') +
      (kidNow ? '<p class="hint">Spotted it? Tap \u201CFound it!\u201D on the list.</p>' : shopLinksHtml(w)) +
      '</div>',
      [{ label: 'Close', value: false }]);
  }

  /* ---- Wanted + checklists ---- */
  SCREENS.wanted = function () {
    busy('Getting the wanted list\u2026');
    loadHomeWanted().then(function (list) {
      done();
      list = (list || []).filter(function (w) { return !neverShow(w.name) && (isPriv() || !sonHidden(w.name)); });
      S.homeWanted = list.slice();
      list = list.filter(function (w) { return w.deal; }).concat(list.filter(function (w) { return !w.deal; }));
      var deals = list.filter(function (w) { return w.deal; }).length;
      refreshDealBadges();
      var h = '<h1>\u2B50 Wanted</h1>' +
        (deals ? '<div class="card dealsCard"><b>\uD83D\uDD25 ' + deals + ' deal' + (deals === 1 ? '' : 's') + ' found under your max price</b><div class="hint">Shown first below. Check the condition and postage - nothing is ever bought or bid on from here.</div></div>' :
          (isPriv() ? '<p class="hint">\uD83D\uDD14 Deal alerts: none right now. They light up when the Wanted sheet has a deal price at or under the max price.</p>' : '')) +
        '<div class="search"><input id="wantSearch" type="search" placeholder="\uD83D\uDD0D Search the wanted list" aria-label="Search wanted" autocomplete="off"></div>' +
        '<p class="hint" id="wantCount">' + list.length + ' on the hunt list. Got one? Tap \u201CGot it\u201D.</p>' +
        '<div class="row" style="margin-bottom:10px"><button class="btn small" data-act="go" data-to="missing">\uD83E\uDDE9 Missing from sets</button><button class="btn small" data-act="go" data-to="checklists">\u2705 Checklists</button></div>' +
        renderWantedGroups(list, false) +
        '<p><button class="btn full" data-act="go" data-to="checklists">\u2705 Full-set checklists</button></p>';
      S.wantedList = list;
      setMain(h);
      $('wantSearch').addEventListener('input', function (e) { filterWantedList(e.target.value, list.length); });
    }).catch(oops);
  };
  /* Price-check links only (opens the shop's own search; nothing is bought or bid on). */
  function shopQuery(w) {
    return [w && w.name, w && w.variant].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  function shopLinks(w) {
    var q = shopQuery(w), e = encodeURIComponent(q), p = e.replace(/%20/g, '+');
    var out = [
      ['\uD83D\uDED2', 'eBay UK - live listings, cheapest first', 'https://www.ebay.co.uk/sch/i.html?_nkw=' + p + '&_sop=15'],
      ['\uD83D\uDCC8', 'eBay UK - what it sold for', 'https://www.ebay.co.uk/sch/i.html?_nkw=' + p + '&LH_Sold=1&LH_Complete=1&_sop=13'],
      ['\uD83D\uDCE6', 'Amazon UK', 'https://www.amazon.co.uk/s?k=' + p + '&s=price-asc-rank'],
      ['\uD83D\uDC55', 'Vinted', 'https://www.vinted.co.uk/catalog?search_text=' + e + '&order=price_low_to_high'],
      ['\uD83C\uDFEA', 'Facebook Marketplace', 'https://www.facebook.com/marketplace/search/?query=' + e],
      ['\uD83D\uDD0E', 'Google Shopping', 'https://www.google.co.uk/search?tbm=shop&q=' + p]
    ];
    if (w && /^https?:\/\//i.test(String(w.link || ''))) out.unshift(['\u2B50', 'Your saved link', String(w.link)]);
    return out;
  }
  function shopLinksHtml(w) {
    return '<div class="shopLinks">' + shopLinks(w).map(function (l) {
      return '<a class="btn full shopLink" href="' + esc(l[2]) + '" target="_blank" rel="noopener noreferrer"><span>' + l[0] + '</span> ' + esc(l[1]) + ' \u2197</a>';
    }).join('') + '</div>';
  }
  /* Search links only: each opens the shop's own search. Nothing is bought or bid on from here. */
  function findCheapest(i) {
    var w = S.wantedList[i]; if (!w) return;
    sheet('\uD83D\uDED2 Find it online', '<p><b>' + esc(w.name) + '</b>' + (w.variant ? ' <span class="hint">(' + esc(w.variant) + ')</span>' : '') + '</p>' +
      '<p class="hint">Searches for \u201C' + esc(shopQuery(w)) + '\u201D. Each opens in a new tab. Check the condition and postage before buying.</p>' + shopLinksHtml(w) +
      '<p class="hint">Tip: add a <b>Variant</b> or <b>Shop link</b> column to the Wanted tab to make these sharper.</p>',
      [{ label: 'Close', value: false }]);
  }
  function gotWanted(i) {
    var w = S.wantedList[i]; if (!w) return;
    var fromList = w.kind === 'checklist';
    confirmSheet('Got it? \uD83C\uDF89', fromList ? 'Mark <b>' + esc(w.name) + '</b> as got on the ' + esc(w.range || 'checklist') + ' list?' : 'Move <b>' + esc(w.name) + '</b> into the collection as Owned? I\u2019ll give it a folder so you can snap it next.', 'Yes, got it!', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy(fromList ? 'Ticking it off\u2026' : 'Moving it into the collection\u2026');
      return call('markGotIt', w.kind, w.ref, w.name, S.role).then(function (r) {
        done(); S.boot = null;
        pointsNote(r, fromList || r.suggestAdd ? '\u2705 Ticked off the list.' : '\u2705 Nice one! It\u2019s in the collection now.');
        if (r.key) {
          return confirmSheet('Snap it now?', 'Take a photo of <b>' + esc(r.name) + '</b> while it\u2019s in your hand?', '\uD83D\uDCF7 Take photo', 'Later').then(function (snap) {
            if (snap) openCamera({ key: r.key, name: r.name }); else go('wanted', {}, true);
          });
        }
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name || w.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: w.name, range: w.range, condition: '', more: {} }; go('add'); }
          else go('wanted', {}, true);
        });
      });
    }).catch(oops);
  }
  SCREENS.checklists = function () {
    busy('Counting\u2026');
    call('getChecklists').then(function (cls) {
      done();
      setMain('<h1>\u2705 Full-set checklists</h1><div class="list">' + cls.map(function (c) {
        var p = pct(c.owned, c.total);
        return '<button class="li" style="width:100%;text-align:left;font-family:inherit;color:inherit" data-act="go" data-to="checklist" data-tab="' + esc(c.tab) + '"><div class="grow">' + esc(clTitle(c.tab)) +
          '<small>' + c.owned + ' of ' + c.total + ' (' + p + '%)</small><div class="bar" style="margin-top:6px"><div style="width:' + p + '%"></div></div></div><span>\u203A</span></button>';
      }).join('') + '</div>');
    }).catch(oops);
  };
  SCREENS.checklist = function (p) {
    busy('Opening the checklist\u2026');
    call('getChecklist', p.tab).then(function (c) {
      done(); S.checklistData = c;
      var showAll = !!p.all, pc = pct(c.owned, c.total);
      var rows = c.rows.filter(function (r) { return showAll || !r.got; });
      setMain(backBtn() + '<h1>' + esc(clTitle(c.tab)) + '</h1><div class="card skyL"><div class="big">' + c.owned + ' / ' + c.total + '</div><div class="bar" role="img" aria-label="' + pc + ' percent"><div style="width:' + pc + '%"></div></div></div>' +
        '<div class="row" style="margin-bottom:10px"><button class="btn small' + (showAll ? '' : ' yel') + '" data-act="clMode" data-all="">Missing (' + (c.total - c.owned) + ')</button><button class="btn small' + (showAll ? ' yel' : '') + '" data-act="clMode" data-all="1">All</button></div>' +
        '<div class="list">' + rows.map(function (r) {
          var badge = r.got ? '<span class="pill green">Got it</span>' : (/loose|\?/i.test(r.owned) ? '<span class="pill amber">' + esc(r.owned) + '</span>' : '<button class="btn green small" data-act="gotCl" data-row="' + r.row + '">Got it</button>');
          return '<div class="li"><div class="grow">' + esc(r.name) + '<small>' + esc([r.number, r.year].filter(Boolean).join(' \u00B7 ')) + '</small></div>' + badge + '</div>';
        }).join('') + '</div>');
    }).catch(oops);
  };
  function gotCl(row) {
    var c = S.checklistData; var r = c.rows.filter(function (x) { return x.row === row; })[0]; if (!r) return;
    confirmSheet('Tick it off?', 'Mark <b>' + esc(r.name) + '</b> as got on the ' + esc(clTitle(c.tab)) + ' checklist?', 'Yes, tick it', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Ticking it off\u2026');
      return call('markGotIt', 'checklist', c.tab + '|' + row, r.name, S.role).then(function () {
        done(); S.boot = null; toast('\u2705 Ticked off!', 'good');
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: r.name, range: clTitle(c.tab), condition: '', more: {} }; go('add'); }
          else go('checklist', S.params, true);
        });
      });
    }).catch(oops);
  }

  /* ---- Value (private) ---- */
  SCREENS.value = function () {
    if (!isPriv()) { setMain('<div class="card center"><h1>\uD83D\uDD12 Just for ' + esc(PRIV) + '</h1><p>The value page is private.</p></div>'); return; }
    busy('Adding it all up\u2026');
    call('getValueReport', S.role).then(function (v) {
      done();
      var h = '<h1>\uD83D\uDCB7 Value (private)</h1><div class="tiles">' +
        '<div class="card yel tile"><div class="head">Estimated value</div><div class="big">' + gbp(v.totalValue) + '</div><div class="hint">' + v.valued + ' of ' + v.items + ' items valued</div></div>' +
        '<div class="card skyL tile"><div class="head">Paid</div><div class="big">' + gbp(v.totalPaid) + '</div><div class="hint">landed cost, where known</div></div>' +
        '<div class="card ' + (v.difference >= 0 ? 'pinkL' : '') + ' tile"><div class="head">Value vs paid</div><div class="big">' + (v.difference >= 0 ? '+' : '') + gbp(v.difference) + '</div></div></div>' +
        (v.notValued ? '<div class="nudge">' + v.notValued + ' items have no value yet. <button class="btn small" data-act="go" data-to="novalue">Add values</button></div>' : '') +
        '<div class="card"><h2>Top 10</h2><table class="tbl"><thead><tr><th>Item</th><th class="num">Paid</th><th class="num">Value</th></tr></thead><tbody>' +
        v.top.map(function (t) { return '<tr data-act="item" data-key="' + esc(t.key) + '"><td>' + esc(t.name) + '</td><td class="num">' + gbp(t.paid) + '</td><td class="num">' + gbp(t.value) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="card"><h2>Paid vs value by range</h2><table class="tbl"><thead><tr><th>Range</th><th class="num">Items</th><th class="num">Paid</th><th class="num">Value</th></tr></thead><tbody>' +
        v.byRange.map(function (r) { return '<tr><td>' + esc(r.range) + '</td><td class="num">' + r.items + '</td><td class="num">' + gbp(r.paid) + '</td><td class="num">' + gbp(r.value) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      setMain(h);
    }).catch(function (e) { if (THEME.needsPin && !dadUnlocked()) askDadPin(S.role || PRIV); else oops(e); });
  };

  SCREENS.photos = function () {
    busy('Finding what needs photos\u2026');
    call('getPhotoTodo', S.role).then(function (list) {
      done();
      setMain(backBtn() + '<h1>\uD83D\uDCF8 Photos to take</h1><p class="hint">' + list.length + ' items. Tap \u201CTake photo\u201D - it saves straight into that item\u2019s folder. No faces in shot.</p><div class="list">' +
        list.map(function (it) { return '<div class="li"><div class="grow" data-act="item" data-key="' + esc(it.key) + '">' + esc(it.name) + '<small>' + esc(it.range) + '</small></div><button class="btn main small" data-act="snapFor" data-key="' + esc(it.key) + '">\uD83D\uDCF7 Take photo</button></div>'; }).join('') + '</div>');
    }).catch(oops);
  };
  SCREENS.novalue = function () {
    busy('Finding items with no value\u2026');
    call('getNoValue', S.role).then(function (list) {
      done();
      setMain(backBtn() + '<h1>\uD83D\uDCB7 No value yet</h1><p class="hint">' + list.length + ' items. Tap \u201CAdd value\u201D and type your best guess.</p><div class="list">' +
        list.map(function (it) { return '<div class="li"><div class="grow">' + esc(it.name) + '<small>' + esc(it.range) + '</small></div><button class="btn yel small" data-act="valueFor" data-key="' + esc(it.key) + '">Add value</button></div>'; }).join('') + '</div>');
    }).catch(oops);
  };
  function removeExamplesUI() {
    var ex = (S.boot && S.boot.examples) || {};
    var names = (ex.items || []).concat((ex.wanted || []).map(function (n) { return 'Wanted: ' + n; }));
    if (ex.checklist) names.push('The tab \u201C' + ex.checklist + '\u201D');
    if (!names.length) { toast('There are no example items to remove', 'good'); return; }
    var body = 'This only removes the example rows' + (ex.checklist ? ' and the example checklist tab' : '') + ':</p><ul>' +
      names.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul><p>Your own items are left alone. This can\u2019t be undone, except by adding them again.';
    confirmSheet('Remove example items?', body, 'Remove them', 'Keep them').then(function (yes) {
      if (!yes) return;
      if (THEME.needsPin && !dadUnlocked()) { S.afterPin = ['settings', {}]; askDadPin(S.role || PRIV); return; }
      busy('Removing examples\u2026');
      call('removeExampleItems').then(function (r) {
        return call('getBootstrap', S.role).then(function (b) {
          S.boot = b; if (b.items) S.items = b.items;
          done();
          var n = (r && r.removed && r.removed.items) ? r.removed.items.length : 0;
          toast('Removed ' + n + ' example item' + (n === 1 ? '' : 's'), 'good');
          go('settings', {}, true);
        });
      }).catch(function (e) { done(); oops(e); });
    });
  }
  function removeItemUI() {
    var it = S.current;
    if (!it) return;
    if (THEME.needsPin && !dadUnlocked()) { S.afterPin = ['item', { key: it.key }]; askDadPin(S.role || PRIV); return; }
    confirmSheet('Remove \u201C' + it.name + '\u201D?', 'It comes off your collection and goes to the Removed items list (More \u2192 Removed items, or Settings). You can put it back any time. Photos stay in its Drive folder.', 'Remove it', 'Keep it').then(function (yes) {
      if (!yes) return;
      busy('Moving it to Removed items\u2026');
      call('removeItem', it.key, it.name, S.role).then(function () {
        return call('getBootstrap', S.role).then(function (b) {
          S.boot = b; if (b.items) S.items = b.items;
          done();
          toast('\u201C' + it.name + '\u201D is in Removed items', 'good');
          go('collection', {}, true);
        });
      }).catch(function (e) { done(); oops(e); });
    });
  }
  function restoreItemUI(key, name) {
    if (THEME.needsPin && !dadUnlocked()) { S.afterPin = ['removed', {}]; askDadPin(S.role || PRIV); return; }
    confirmSheet('Put \u201C' + (name || 'this item') + '\u201D back?', 'It goes back into your collection with the same Item ID. Photos stay in its folder.', 'Put it back', 'Not now').then(function (yes) {
      if (!yes) return;
      busy('Putting it back\u2026');
      call('restoreItem', key, name, S.role).then(function (r) {
        return call('getBootstrap', S.role).then(function (b) {
          S.boot = b; if (b.items) S.items = b.items;
          done();
          toast('\u201C' + (r && r.name || name) + '\u201D is back in your collection', 'good');
          if (r && r.key) go('item', { key: r.key }, true);
          else go('removed', {}, true);
        });
      }).catch(function (e) { done(); oops(e); });
    });
  }
  SCREENS.removed = function () {
    if (!isPriv()) { go('settings'); return; }
    busy('Opening removed items\u2026');
    call('getRemovedItems', S.role).then(function (list) {
      done();
      list = list || [];
      if (S.boot) S.boot.removedCount = list.length;
      var h = backBtn() + '<h1>Removed items</h1><p class="hint">These came off your collection. Photos are still in their folders. Put one back and it returns with the same Item ID.</p>';
      if (!list.length) h += '<div class="nudge">Nothing here. When you tap Remove item on something, it turns up in this list.</div>';
      else h += '<div class="list">' + list.map(function (it) {
        return '<div class="li"><div class="grow">' + esc(it.name) + '<small>' + esc([it.id, it.range, it.removedOn ? ('Removed ' + it.removedOn) : ''].filter(Boolean).join(' \u00B7 ')) + '</small></div>' +
          '<button class="btn main small" data-act="restoreItem" data-key="' + esc(it.key) + '" data-name="' + esc(it.name) + '">Put back</button></div>';
      }).join('') + '</div>';
      setMain(h);
    }).catch(function (e) { done(); oops(e); });
  };
  SCREENS.settings = function () {
    var f = S.boot ? S.boot.folders : null;
    setMain(backBtn() + '<h1>Settings</h1><div class="card stack">' +
      (isSolo() ? '<p>Signed in as <b>' + esc(S.role) + '</b> (just you).</p>' + (THEME.generic && isPriv() ? '<a class="btn green full" href="?settings=1&step=4">\uD83D\uDC6A Add family or a kid (optional)</a>' : '') :
        '<p>Using it as: <b>' + esc(S.role) + '</b></p><button class="btn full" data-act="go" data-to="who">Switch user</button>' + (THEME.generic && isPriv() ? '<a class="btn full" href="?settings=1&step=4">\uD83D\uDC6A People: add or change</a>' : '')) +
      (showKidFeatures() ? '<button class="btn pink full" data-act="kidEnter">\uD83E\uDDD2 Kid mode</button><p class="hint">Big buttons, photos, points and badges for a child. Never any prices. Getting out needs your PIN.</p>' : (isSolo() && THEME.generic && isPriv() ? '<p class="hint">Kid mode, points and rewards stay hidden until you add a kid.</p>' : '')) +
      '<p class="hint">\uD83D\uDCF4 Works offline: the last collection you opened is kept on this phone. Changes made with no signal sync automatically.' + (NET.queueLen ? ' <b>' + NET.queueLen + ' waiting.</b>' : '') + '</p>' +
      (THEME.needsPin && isPriv() ? '<button class="btn full" data-act="lockPriv">\uD83D\uDD12 Lock ' + esc(PRIV) + ' view</button>' : '') +
      (THEME.generic && isPriv() ? '<a class="btn yel full" href="?settings=1">\u2699\uFE0F Change name, type, colours, people</a>' : '') +
      (THEME.generic && isPriv() && S.boot && S.boot.exampleCount ? '<button class="btn full" data-act="removeExamples">Remove example items</button>' : '') +
      (isPriv() ? '<button class="btn full" data-act="go" data-to="removed">Removed items' + (S.boot && S.boot.removedCount ? ' (' + S.boot.removedCount + ')' : '') + '</button>' : '') +
      (THEME.generic ? '<a class="btn full" href="?reset=1">\uD83D\uDD0C Connect a different collection</a>' : '') +
      '<button class="btn full" data-act="startTour">\uD83E\uDDED Walkthrough: every screen (2 min)</button>' +
      '<button class="btn full" data-act="go" data-to="guide">Show the welcome cards</button>' +
      '<button class="btn full" data-act="go" data-to="help">\u2753 Help topics</button>' +
      (f ? '<a class="btn full" href="' + esc(f.sheet) + '" target="_blank" rel="noopener">Open the sheet \u2197</a><a class="btn full" href="' + esc(f.collection) + '" target="_blank" rel="noopener">' + esc(W('collectionFolder', 'Open the photos folder')) + ' \u2197</a><a class="btn full" href="' + esc(f.dropZone) + '" target="_blank" rel="noopener">Open the Drop Zone \u2197</a>' : '') +
      '<p class="hint">Version ' + esc(THEME.version || '') + '</p><p class="hint">Tip: on your phone, use the browser\u2019s Share or \u22EE menu and tap \u201CAdd to Home Screen\u201D to keep this app one tap away.</p></div>');
  };

  /* ---------------- More menu ---------------- */
  SCREENS.more = function () {
    var tiles = [
      ['stats', '\uD83D\uDCCA', 'Stats', 'Counts, categories and charts'],
      ['posted', '\uD83D\uDCE3', 'Posted on socials', 'What\u2019s been posted and what hasn\u2019t'],
      ['spares', '\uD83D\uDD01', 'Spares & duplicates', 'Owned more than once - swap or sell'],
      ['history', '\uD83D\uDDD3\uFE0F', 'Item history', 'When each thing joined, and where from'],
      ['missing', '\uD83E\uDDE9', 'Missing list', 'Everything still needed for the full sets'],
      ['checklists', '\u2705', 'Checklists', 'How close each full set is'],
      ['photos', '\uD83D\uDCF8', 'Photos to take', 'Items still needing our own photos']
    ];
    if (isPriv()) {
      if (showKidFeatures()) {
        tiles.push(['rewards', '\u2B50', KID_ROLE + '\u2019s rewards', 'Points, photo approvals, activity log']);
        tiles.push(['badgeEdit', '\uD83C\uDFC6', KID_ROLE + '\u2019s badges', 'Add badges, change tiers, mark earned']);
      }
      tiles.push(['value', '\uD83D\uDCB7', 'Value', 'Private: totals, top 10, paid vs value']);
    }
    if (isPriv()) tiles.push(['removed', '\uD83D\uDDD1\uFE0F', 'Removed items', 'Things you took out, ready to put back']);
    tiles.push(['export', '\uD83D\uDCE4', 'Export', 'Save a list as a spreadsheet file or PDF'],
      ['help', '\u2753', 'Help', 'How everything works'],
      ['settings', '\u2699\uFE0F', 'Settings', 'Switch user, tour, links']);
    setMain('<h1>More</h1><div class="menu">' + tiles.map(function (t) {
      return '<button class="mtile" data-act="go" data-to="' + t[0] + '"><span class="mic">' + t[1] + '</span><b>' + esc(t[2]) + '</b><small>' + esc(t[3]) + '</small></button>';
    }).join('') + '</div>');
  };

  /* ---------------- Help ---------------- */
  var FAQ = [
    ['\u2795 Adding, editing and removing', ['Tap <b>Add</b> at the bottom to add something new.', 'Take a photo (front first), type a name, pick the category, then the condition. That\u2019s it.', 'Open any item and tap <b>Edit details</b> to change it.', 'Tap <b>Remove item</b> to take it off the collection. It goes to <b>Removed items</b> (under More or Settings) and you can put it back. Photos stay in its folder.', 'Everything else (year, maker, packaging, price) is optional under \u201CMore details\u201D.', 'If it looks like you already have it, I\u2019ll ask before adding a second one.']],
    ['\uD83D\uDCF8 Photos', ['Open any item and tap <b>Add photo / video</b>. It saves straight into that item\u2019s own Drive folder. Videos play in the app when you tap them; Open in Drive is still there as a fallback.', 'Tap <b>New main photo</b> to replace the picture that shows in the lists. The old one stays in the folder - nothing is deleted.', 'Tap any photo to see it big, then <b>Make main photo</b> to pick a different main one.', 'No faces in shot, please. Hands are fine.']],
    ['\uD83D\uDCC4 Documents', ['Each item has a <b>Documents</b> section for manuals, receipts, certificates, valuations or other files (PDF, Word, or a photo of the document), up to 20 MB.', 'They are saved in that item\u2019s Drive folder as <b>Item - Manual.pdf</b> (or Receipt, Certificate, and so on). Tap one to open it in Drive.', 'Receipts and valuations are owner-only and need the PIN. Kid mode can view the others, and can add manuals only if you switch that on in Settings.', 'Remove a document and it goes to the <b>Removed documents</b> folder next to the sheet - nothing is binned. A PDF dropped in the Drop Zone can be sorted onto the right item from Home.']],
    ['\uD83E\uDD14 Do I own it? + barcode scan', ['Type any name in <b>Do I own it?</b> on Home - it tells you yes, maybe or no as you type, even with spelling mistakes.', 'Tap <b>\uD83D\uDCF7 Scan</b> and point the camera at a box\u2019s barcode. If the barcode is saved on an item it matches straight away.', 'First time for a barcode? Search the name and tap the item to save the barcode on it. Or open any item and tap <b>Save barcode</b>.']],
    ['\uD83D\uDCF4 No signal', ['The last collection you opened is kept on the phone, with photos you\u2019ve already seen.', 'Adds, edits, ticks and photos made with no signal are kept on the phone and sync on their own when you\u2019re back online.']],
    ['\uD83E\uDDD2 ' + KID_ROLE + '\u2019s mode', ['Big buttons and photos, no prices. Tick off finds on the hunt list and add photos.', 'If ' + OWN + ' has written a <b>letter</b> in Settings, it pops up every so often and lives on a Home tile.', 'The <b>\u2B50 My points</b> page awards points for photos (once ' + OWN + ' says yes), ticks, new finds and jobs, with levels and real rewards ' + OWN + ' sets. Secret or hidden things never earn points, and there is never any money.', 'The <b>\uD83C\uDFC6 Badges</b> wall unlocks badges from the collection (10 in one category, first rare find, finds this month, photos added\u2026) with confetti for each new one. No money badges, and secret or Christmas things never count.', 'Getting back to the full app needs ' + esc(THEME.privateRole) + '\u2019s PIN.'], 'kidOnly'],
    ['\uD83D\uDD0D Finding things', ['Use the search box on Home or in Collection. It searches names, characters, lines and IDs.', 'Tap <b>Filters</b> to narrow down by category, line, condition, status, posted or photos.', 'Use the sort menu for newest first, A to Z or by year.']],
    ['\u2B50 Wanted and missing', ['<b>Wanted</b> is your hunt list. Tap <b>Got it</b> when one arrives and it moves into the collection.', '<b>Missing list</b> (under More) shows everything still needed from every full-set checklist in one place.', '<b>Checklists</b> shows how close each set is.']],
    ['\uD83D\uDCE3 Posted on socials', ['Each item page has the platforms as buttons. Tap one to tick it once it\u2019s posted.', 'Under More \u2192 <b>Posted on socials</b> you can see what hasn\u2019t been posted yet - handy for planning.']],
    ['\uD83D\uDD01 Spares & duplicates', ['Under More \u2192 <b>Spares & duplicates</b> you\u2019ll see anything you own more than once (same name, or a quantity over 1), plus names that nearly match.', 'Tap <b>Mark for sale</b> on the copy you want to sell or swap. It stays in the sheet, just with the status For sale.', 'Values only show for ' + esc(THEME.privateRole) + '.']],
    ['\uD83D\uDCE4 Share a find', ['Open an item and tap <b>Share this find</b>. It makes a 1080\u00D71350 picture (photo, name and line, plus your handle if you set one) ready for Instagram.', 'Tap <b>Share</b> to send it straight to an app, or <b>Save picture</b>. There are never prices on it, and it isn\u2019t offered for secret or Christmas things.']],
    ['\uD83D\uDD0E Price check', ['On any item (' + esc(THEME.privateRole) + '\u2019s view) tap <b>Price check</b> for eBay UK <b>sold</b> listings - newest, highest or lowest first - or a Google search. It only opens the links; nothing is saved.']],
    ['\uD83D\uDDD3\uFE0F Item history', ['Under More \u2192 <b>Item history</b>: a timeline of when things joined, month by month, with where they came from.', 'It reads Purchase Date, then Date got, then Photo date from the sheet. Anything with no date is listed at the bottom so you can fill it in.', 'Prices only show for ' + esc(THEME.privateRole) + '.']],
    ['\uD83D\uDCCA Stats and value', ['<b>Stats</b> shows totals, categories, conditions, years and what\u2019s been posted.', 'Money (paid and value) only shows for ' + esc(THEME.privateRole) + '.', THEME.needsPin ? esc(THEME.privateRole) + ' view asks for a 4-digit PIN (once per device, for about 12 hours). Lock it again any time from Settings.' : '']],
    ['\uD83D\uDCE4 Export', ['Under More \u2192 <b>Export</b> you can save the whole collection, or what you\u2019ve filtered, as a spreadsheet file (CSV) or a PDF.', 'Files are saved into Drive and the link opens them.']],
    ['\uD83D\uDEE1\uFE0F Is it safe to tap around?', ['The app never deletes your files or photos.', 'On an item, <b>Remove item</b> moves it to the Removed items list (under More or Settings). You can <b>Put back</b> any time. Its Drive folder stays put.', 'If something looks wrong, tap <b>I\u2019m stuck \u2192 Refresh</b>.']],
    ['\uD83D\uDCF1 Put it on your home screen', ['iPhone (Safari): tap Share, then <b>Add to Home Screen</b>.', 'Android (Chrome): tap \u22EE, then <b>Add to Home screen</b>.']]
  ];
  SCREENS.help = function () {
    setMain(backBtn() + '<h1>\u2753 Help</h1><div class="card yel center"><div class="mascot small">' + THEME.mascotSvg.replace(/fsBite/g, 'fsBiteH') + '</div><p><b>New here?</b> Take the 2-minute walkthrough. It visits every screen.</p>' +
      '<div class="stack"><button class="btn main full" data-act="startTour">\uD83E\uDDED Take the tour</button><button class="btn full" data-act="go" data-to="guide">Show the welcome cards</button></div></div>' +
      FAQ.filter(function (f) { return f[2] !== 'kidOnly' || showKidFeatures(); }).map(function (f, i) { return '<details class="card faq"' + (i === 0 ? ' open' : '') + '><summary>' + f[0] + '</summary><ul>' + f[1].filter(Boolean).map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></details>'; }).join('') +
      '<p class="hint center">' + esc(THEME.appName) + ' \u00B7 version ' + esc(THEME.version || '') + '</p>');
  };

  /* ---------------- Guided tour (coach marks) ---------------- */
  function tourItemKey() { var it = (S.items || []).filter(function (x) { return isOwned(x); })[0] || (S.items || [])[0]; return it ? it.key : ''; }
  var TOUR = [
    { screen: 'home', sel: null, t: 'Welcome to the walkthrough \uD83D\uDC4B', b: 'Two minutes, every screen. Tap Next to move on, Back to go back, or Skip any time. You can run it again from Settings or Help.' },
    { screen: 'home', sel: '.ownCard', t: 'Do I own it?', b: 'Type any name and it tells you yes, maybe or no as you type, even with typos. Great at car boots and shops.' },
    { screen: 'home', sel: '[data-act=scan]', t: 'Scan a barcode', b: 'Point the camera at a box\u2019s barcode. If it\u2019s on an item already, you\u2019ll see it straight away.' },
    { screen: 'home', sel: '.tiles .tile', t: 'Your to-do board', b: 'Each box is one job (photos to take, values to add, the Drop Zone) with one button to sort it.' },
    { screen: 'collection', sel: '#colSearch', t: 'Collection', b: 'Everything you own with photos. Search, filter by category, condition, status or posted, and sort newest, A to Z or by year.' },
    { screen: 'collection', sel: '.grid .card, .grid > *', t: 'Open an item', b: 'Tap any picture to see the item, its photos, history and details.' },
    { screen: 'item', params: function () { return { key: tourItemKey() }; }, need: tourItemKey, sel: '[data-act=snapCurrent]', t: 'An item', b: 'Add photos or a video with the camera, pick the main photo, edit details, save a barcode, tick where it\u2019s been posted, share a find card, or price-check it. Documents holds manuals, receipts and certificates as PDFs in the same folder. Remove item moves it to Removed items, where you can put it back; photos and documents stay in its folder.' },
    { screen: 'item', params: function () { return { key: tourItemKey() }; }, need: tourItemKey, sel: '#cfBox .cfCard', t: 'Your own fields', b: 'Tap \uFF0B Add field to add details that suit your collection: text, a number, a date, a tick, a private money value, a photo, or a dated log (date, note, cost, photos) like a Service log or Repairs. Rename or remove them under Edit fields; nothing is ever deleted.' },
    { screen: 'add', sel: '#main .card, #main', t: 'Add something new', b: 'Snap it, name it (or scan its barcode to fill the name in), pick the category and condition. Done: it gets its own photo folder.' },
    { screen: 'wanted', sel: '#wantSearch', t: 'Wanted', b: 'Your hunt list, grouped by category. Search it as you type. Items still missing from your checklists show up here too.' },
    { screen: 'wanted', sel: '[data-act=findCheapest]', t: 'Find it online', b: 'Tap Shop on any wanted item for one-tap searches on eBay (live and sold), Amazon, Vinted, Facebook Marketplace and Google Shopping.' },
    { screen: 'wanted', sel: '[data-act=gotWanted]', t: 'Got it!', b: 'When one arrives, tap Got it and it moves into the collection, ready for a photo.' },
    { screen: 'more', sel: '.menu', t: 'More', b: 'Stats, posted on socials, spares and duplicates, item history, the missing list, checklists, photos to take, removed items (to put something back), export and help.' },
    { screen: 'stats', sel: '#main h1, #main .card', t: 'Stats', b: 'Totals, categories, conditions, decades and newest additions. Money only shows when you\u2019re unlocked.' },
    { screen: 'spares', sel: '#main h1', t: 'Spares and duplicates', b: 'Anything you own more than once, plus near-matches. Mark the spare for sale; nothing is deleted.' },
    { screen: 'history', sel: '#main h1', t: 'Item history', b: 'A month-by-month timeline of when things joined and where from.' },
    { screen: 'export', sel: '#main h1', t: 'Export', b: 'Save the collection (or what you filtered) to Drive as a spreadsheet file or a PDF.' },
    { screen: 'settings', sel: '[data-act=kidEnter]', need: showKidFeatures, t: 'Kid mode', b: 'Hand the phone to a child: big buttons, photos, points, badges and jobs, never any prices. Getting out needs your PIN.' },
    { screen: 'settings', sel: '[data-act=startTour]', t: 'Settings', b: 'Lock your money view, add family or a kid, change the name, type and colours, open Removed items, clear example items, or run this walkthrough again.' },
    { screen: 'home', sel: '#stuckBtn', t: 'I\u2019m stuck', b: 'On every screen. It explains that screen, refreshes, or opens Help.' },
    { screen: 'home', sel: null, t: 'You\u2019re all set! \uD83C\uDF89', b: 'The app never deletes anything, so tap around and explore. Help is under More any time.' }
  ];
  function tourWait(step, i, t0) {
    var bz = $('busy'), ready = !bz || bz.hidden;
    var el = step.sel ? document.querySelector(step.sel) : null;
    if ((ready && (el || !step.sel)) || Date.now() - t0 > 5000) { var ov = $('tour'); if (ov) ov.style.visibility = ''; startTour(i, true); return; }
    setTimeout(function () { tourWait(step, i, t0); }, 150);
  }
  function startTour(i, arrived) {
    i = i || 0;
    var step = TOUR[i]; if (!step) { NAV.tourFinished = true; if (NAV.pushed > 0) layerBack(); else closeTour(true); return; }
    if (step.need && !step.need()) return startTour(i + (i >= (S.tourLast || 0) ? 1 : -1));
    S.tourLast = i;
    if (step.screen && !arrived && (S.screen !== step.screen || step.params)) {
      var ov0 = $('tour'); if (ov0) ov0.style.visibility = 'hidden';
      NAV.tourNav = true; try { go(step.screen, typeof step.params === 'function' ? step.params() : (step.params || {}), true); } finally { NAV.tourNav = false; }
      setTimeout(function () { tourWait(step, i, Date.now()); }, 120); return;
    }
    var ov = $('tour');
    if (!ov) { ov = document.createElement('div'); ov.id = 'tour'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); document.body.appendChild(ov); }
    var el = step.sel ? document.querySelector(step.sel) : null;
    if (step.sel && !el) { var nx = i >= (S.tourLast || 0) ? i + 1 : i - 1; S.tourLast = nx; return startTour(nx); }
    var hole = '', pos = 'center';
    if (el) {
      el.scrollIntoView({ block: 'center' });
      var r = el.getBoundingClientRect(), pad = 6;
      hole = '<div class="tHole" style="top:' + (r.top - pad) + 'px;left:' + (r.left - pad) + 'px;width:' + (r.width + pad * 2) + 'px;height:' + (r.height + pad * 2) + 'px"></div>';
      pos = r.top + r.height / 2 > window.innerHeight / 2 ? 'top' : 'bottom';
    }
    ov.className = el ? 'withHole' : 'dim';
    ov.innerHTML = hole + '<div class="tBubble ' + pos + '"><div class="tStep">' + (i + 1) + ' of ' + TOUR.length + '</div><h2>' + esc(step.t) + '</h2><p>' + esc(step.b) + '</p>' +
      '<div class="row"><button class="btn main" data-act="tourNext" data-i="' + (i + 1) + '">' + (i < TOUR.length - 1 ? 'Next \u2192' : 'Finish') + '</button>' +
      (i > 0 ? '<button class="btn small" data-act="tourNext" data-i="' + (i - 1) + '">\u2190 Back</button>' : '') +
      (i < TOUR.length - 1 ? '<button class="btn small" data-act="tourSkip">Skip tour</button>' : '') + '</div></div>';
    var wasOpen = !ov.hidden;
    ov.hidden = false;
    layerOpen(wasOpen);
  }
  function closeTour(finished) {
    var ov = $('tour'); if (!ov || ov.hidden) return;
    ov.hidden = true; ov.innerHTML = '';
    LS.set('tourDone', '1');
    if (finished) toast('\uD83C\uDF89 Tour done. Help is under More any time.', 'good');
  }

  /* ---------------- Stats ---------------- */
  function bars(rows, valueKey, fmt, max) {
    var top = Math.max.apply(null, rows.map(function (r) { return r[valueKey] || 0; }).concat([1]));
    return '<div class="hbars">' + rows.slice(0, max || 50).map(function (r) {
      var w = Math.max(2, Math.round((r[valueKey] || 0) * 100 / top));
      return '<div class="hb"><span class="hbL">' + esc(r.label) + '</span><span class="hbT"><span class="hbF" style="width:' + w + '%"></span></span><span class="hbV">' + (fmt ? fmt(r[valueKey]) : r[valueKey]) + '</span></div>';
    }).join('') + '</div>';
  }
  function cols(rows, valueKey, fmt) {
    var top = Math.max.apply(null, rows.map(function (r) { return r[valueKey] || 0; }).concat([1]));
    return '<div class="vbars">' + rows.map(function (r) {
      var hgt = Math.max(3, Math.round((r[valueKey] || 0) * 100 / top));
      return '<div class="vb"><span class="vbV">' + (fmt ? fmt(r[valueKey]) : r[valueKey]) + '</span><span class="vbT"><span class="vbF" style="height:' + hgt + '%"></span></span><span class="vbL">' + esc(r.label) + '</span></div>';
    }).join('') + '</div>';
  }
  function ring(part, total, label, colour) {
    var p = total ? part / total : 0, C = 2 * Math.PI * 42;
    return '<div class="ring"><svg viewBox="0 0 100 100" role="img" aria-label="' + esc(label) + ': ' + Math.round(p * 100) + ' percent"><circle cx="50" cy="50" r="42" fill="none" stroke="#FFFFFF" stroke-width="14"/>' +
      '<circle cx="50" cy="50" r="42" fill="none" stroke="' + colour + '" stroke-width="14" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 50 50)" stroke-linecap="round"/>' +
      '<text x="50" y="56" text-anchor="middle" font-size="20" font-weight="900" fill="' + THEME.colours.ink + '">' + Math.round(p * 100) + '%</text></svg><div><b>' + esc(label) + '</b><br><small>' + part + ' of ' + total + '</small></div></div>';
  }
  function monthLabel(k) { var m = k.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(+m[1] || 1) - 1] + ' ' + String(m[0]).slice(2); }
  SCREENS.stats = function () {
    busy('Crunching the numbers\u2026');
    call('getStats', S.role).then(function (st) {
      done();
      var c = THEME.colours;
      var h = backBtn() + '<h1>\uD83D\uDCCA Stats</h1><div class="tiles">' +
        '<div class="card yel tile"><div class="head">Items</div><div class="big">' + st.owned + '</div><div class="hint">in ' + st.categories + ' categories</div></div>' +
        '<div class="card skyL tile"><div class="head">Wanted</div><div class="big">' + st.wanted + '</div><div class="hint">on the hunt list</div></div>';
      if (st.money) {
        h += '<div class="card pinkL tile"><div class="head">\uD83D\uDD12 Spent</div><div class="big">' + gbp(st.money.paid) + '</div><div class="hint">' + st.money.paidCount + ' items with a price</div></div>' +
          '<div class="card tile"><div class="head">\uD83D\uDD12 Worth</div><div class="big">' + gbp(st.money.value) + '</div><div class="hint">' + (st.money.difference >= 0 ? '+' : '') + gbp(st.money.difference) + ' vs paid \u00B7 ' + st.money.valued + ' valued</div></div>';
      }
      h += '</div><div class="card"><h2>Progress</h2><div class="rings">' + ring(st.withPhotos, st.owned, 'Have photos', c.green) + ring(st.postedAny, st.owned, 'Posted on socials', c.pink) + '</div></div>';
      h += '<div class="card"><h2>By category</h2>' + bars(st.byCategory, 'n') + '</div>';
      if (st.money) {
        h += '<div class="card"><h2>\uD83D\uDD12 Value by category</h2>' + bars(st.byCategory.slice().sort(function (a, b) { return b.value - a.value; }).filter(function (r) { return r.value > 0; }), 'value', function (v) { return gbp(v).replace(/\.00$/, ''); }, 15) + '</div>';
        if (st.spendByMonth && st.spendByMonth.length) h += '<div class="card"><h2>\uD83D\uDD12 Spend by month</h2>' + cols(st.spendByMonth.map(function (m) { return { label: monthLabel(m.label), amount: m.amount }; }), 'amount', function (v) { return (THEME.currency || '\u00A3') + Math.round(v); }) + '<p class="hint">From the date got or purchase date, where the sheet has one.</p></div>';
      }
      h += '<div class="card"><h2>Posted on</h2>' + bars(st.platforms.map(function (p) { return { label: p.icon + ' ' + p.label, n: p.n }; }), 'n') + '<button class="btn small" data-act="go" data-to="posted">Open the posted tracker</button></div>';
      h += '<div class="card"><h2>Condition</h2>' + bars(st.byCondition, 'n') + '</div>';
      h += '<div class="card"><h2>Packaging</h2>' + bars(st.byPackaging, 'n') + '</div>';
      if (st.byDecade.length) h += '<div class="card"><h2>By decade</h2>' + cols(st.byDecade, 'n') + '</div>';
      if (st.recent.length) h += '<h2>Newest additions</h2><div class="grid">' + st.recent.map(cardHtml).join('') + '</div>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- Posted tracker ---------------- */
  SCREENS.posted = function () {
    busy('Checking what\u2019s been posted\u2026');
    call('getPostedBoard', S.role).then(function (b) {
      done();
      S.postedBoard = b;
      var mode = S.postedMode || 'not', plat = S.postedPlat || '';
      var list = b.items.filter(function (it) {
        if (plat) return mode === 'not' ? it.pp.indexOf(plat) < 0 : it.pp.indexOf(plat) >= 0;
        return mode === 'not' ? !it.posted : !!it.posted;
      });
      var withPh = list.filter(function (it) { return it.folderId; });
      var ordered = mode === 'not' ? withPh.concat(list.filter(function (it) { return !it.folderId; })) : list;
      var h = backBtn() + '<h1>\uD83D\uDCE3 Posted on socials</h1>' +
        '<div class="card skyL"><div class="big">' + b.postedAny + ' / ' + b.total + '</div><div class="hint">items posted somewhere</div>' +
        '<div class="bar"><div style="width:' + pct(b.postedAny, b.total) + '%"></div></div>' +
        '<div class="chips" style="margin-top:10px">' + THEME.platforms.map(function (p) { return '<span class="chip on">' + esc(p.icon + ' ' + p.label + ' ' + (b.counts[p.key] || 0)) + '</span>'; }).join('') + '</div></div>' +
        '<div class="row" style="margin-bottom:8px"><button class="btn small' + (mode === 'not' ? ' yel' : '') + '" data-act="postedMode" data-v="not">Not posted yet</button><button class="btn small' + (mode === 'yes' ? ' yel' : '') + '" data-act="postedMode" data-v="yes">Posted</button>' +
        '<select id="postedPlat" class="inline" aria-label="Platform">' + opt(THEME.platforms.map(function (p) { return [p.key, p.label]; }), plat, 'Any platform') + '</select></div>' +
        '<p class="hint">' + list.length + ' item' + (list.length === 1 ? '' : 's') + (mode === 'not' ? ' \u00B7 ones with photos first, ready to post' : '') + '. Tap one to tick platforms.</p>' +
        '<div class="grid">' + ordered.slice(0, S.shownPosted || 60).map(cardHtml).join('') + '</div>' +
        (ordered.length > (S.shownPosted || 60) ? '<p class="center"><button class="btn" data-act="morePosted">Show more</button></p>' : '');
      setMain(h);
      $('postedPlat').addEventListener('change', function (e) { S.postedPlat = e.target.value; go('posted', {}, true); });
      watchThumbs();
    }).catch(oops);
  };
  function togglePosted(pkey) {
    var it = S.current; if (!it) return;
    var pl = (it.platforms || []).filter(function (x) { return x.key === pkey; })[0]; if (!pl) return;
    var yes = !pl.yes;
    confirmSheet(yes ? 'Posted on ' + pl.label + '?' : 'Untick ' + pl.label + '?', yes ? 'Tick <b>' + esc(it.name) + '</b> as posted on ' + esc(pl.label) + ' today?' : 'Mark <b>' + esc(it.name) + '</b> as not posted on ' + esc(pl.label) + '?', yes ? 'Yes, it\u2019s posted' : 'Yes, untick it', 'Cancel').then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('setPosted', it.key, it.name, pkey, yes, S.role).then(function () { done(); S.boot = null; toast(yes ? '\u2705 Ticked ' + pl.label : 'Unticked ' + pl.label, 'good'); go('item', S.params, true); });
    }).catch(oops);
  }

  /* ================= v6: share a find, price check, spares & duplicates, badges, item history ================= */
  var XMAS_RE = /christmas|xmas|x-mas|secret|advent|\bsanta\b|\b(gift|present) for\b/i;
  /* Share cards are never offered for secret, Christmassy or kid-hidden items */
  function shareable(it) {
    if (!it || neverShow(it.name) || sonHidden(it.name) || it.hs) return false;
    var slim = itemByKey(it.key); if (slim && (slim.hs || neverShow(slim.name))) return false;
    return !XMAS_RE.test([it.name, it.range, it.series, it.character, it.notes, it.description].join(' '));
  }
  function loadImg(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; }); }
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function fitLines(g, text, maxW, maxLines, size, minSize, weight) {
    for (var s = size; s >= minSize; s -= 2) {
      g.font = weight + ' ' + s + 'px ' + SHARE_FONT;
      var words = String(text).split(/\s+/), lines = [], cur = '';
      words.forEach(function (w) { var t = cur ? cur + ' ' + w : w; if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; } });
      if (cur) lines.push(cur);
      if (lines.length <= maxLines && lines.every(function (l) { return g.measureText(l).width <= maxW; })) return { lines: lines, size: s };
    }
    g.font = weight + ' ' + minSize + 'px ' + SHARE_FONT;
    var all = String(text), out = [];
    while (all && out.length < maxLines) { var n = all.length; while (n > 1 && g.measureText(all.slice(0, n) + (n < all.length ? '\u2026' : '')).width > maxW) n--; out.push(all.slice(0, n) + (n < all.length && out.length === maxLines - 1 ? '\u2026' : '')); all = all.slice(n).trim(); }
    return { lines: out, size: minSize };
  }
  var SHARE_FONT = '"Arial Black", "Helvetica Neue", Roboto, Arial, sans-serif';
  var SHARE_HANDLE = THEME.shareHandle || '';
  /* 1080x1350 portrait card: photo, name, line, branding. Never any price or value. */
  function makeShareCard(it, photoSrc) {
    var W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
    var g = c.getContext('2d'), INK = '#13294B', YEL = '#FFD90F';
    g.fillStyle = '#70C8EA'; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.95)';
    [[120, 120, 70], [200, 100, 90], [300, 130, 60], [800, 90, 70], [890, 70, 90], [990, 110, 60], [60, 760, 50], [1040, 900, 60]].forEach(function (b) { g.beginPath(); g.arc(b[0], b[1], b[2], 0, Math.PI * 2); g.fill(); });
    return Promise.all([photoSrc ? loadImg(photoSrc).catch(function () { return null; }) : null, loadImg('icons/icon-192.png').catch(function () { return null; })]).then(function (imgs) {
      var photo = imgs[0], icon = imgs[1];
      // title
      var tx = icon ? 190 : W / 2;
      if (icon) { g.save(); g.beginPath(); g.arc(110, 95, 62, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 8; g.strokeStyle = INK; g.stroke(); g.clip(); g.drawImage(icon, 48, 33, 124, 124); g.restore(); }
      g.textAlign = icon ? 'left' : 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      var tt = fitLines(g, THEME.appName, icon ? W - tx - 40 : W - 80, 1, 74, 44, '900');
      g.font = '900 ' + tt.size + 'px ' + SHARE_FONT; g.lineWidth = 14; g.strokeStyle = INK; g.strokeText(tt.lines[0], tx, 98); g.fillStyle = YEL; g.fillText(tt.lines[0], tx, 98);
      // photo frame
      var fx = 60, fy = 185, fw = W - 120, fh = 820;
      g.save(); g.shadowColor = 'rgba(19,41,75,.35)'; g.shadowOffsetY = 12; g.shadowBlur = 0; rrect(g, fx, fy, fw, fh, 44); g.fillStyle = '#fff'; g.fill(); g.restore();
      rrect(g, fx, fy, fw, fh, 44); g.lineWidth = 10; g.strokeStyle = INK; g.stroke();
      g.save(); rrect(g, fx + 22, fy + 22, fw - 44, fh - 44, 28); g.clip();
      if (photo) {
        var iw = photo.naturalWidth, ih = photo.naturalHeight, bw = fw - 44, bh = fh - 44, sc = Math.max(bw / iw, bh / ih);
        g.drawImage(photo, fx + 22 + (bw - iw * sc) / 2, fy + 22 + (bh - ih * sc) / 2, iw * sc, ih * sc);
      } else { g.fillStyle = '#E6F4F8'; g.fillRect(fx, fy, fw, fh); g.font = '200px sans-serif'; g.textAlign = 'center'; g.fillText('\uD83D\uDCF7', W / 2, fy + fh / 2); }
      g.restore();
      // name panel
      var py = 1035, ph = 220;
      rrect(g, 50, py, W - 100, ph, 36); g.fillStyle = YEL; g.fill(); g.lineWidth = 10; g.strokeStyle = INK; g.stroke();
      var line = [it.range, it.series && !/^unknown$/i.test(it.series) && it.series !== it.range ? it.series : ''].filter(Boolean).join(' \u00B7 ');
      var nm = fitLines(g, it.name, W - 170, 2, 60, 34, '900');
      g.textAlign = 'center'; g.fillStyle = INK; g.font = '900 ' + nm.size + 'px ' + SHARE_FONT;
      var lh = nm.size * 1.12, total = nm.lines.length * lh + (line ? 50 : 0), y0 = py + ph / 2 - total / 2 + lh / 2;
      nm.lines.forEach(function (l, i) { g.fillText(l, W / 2, y0 + i * lh); });
      if (line) { var ln = fitLines(g, line, W - 170, 1, 36, 24, '700'); g.font = '700 ' + ln.size + 'px ' + SHARE_FONT; g.fillStyle = '#2d4a73'; g.fillText(ln.lines[0], W / 2, y0 + nm.lines.length * lh + 14); }
      // handle
      g.font = '900 46px ' + SHARE_FONT; g.lineWidth = 10; g.strokeStyle = INK; g.strokeText(SHARE_HANDLE, W / 2, 1305); g.fillStyle = '#fff'; g.fillText(SHARE_HANDLE, W / 2, 1305);
      return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.9); });
    });
  }
  function shareFind() {
    var it = S.current; if (!it || !shareable(it)) return;
    busy('Making your share picture\u2026');
    var main = (S.gallery || []).filter(function (x) { return !x.video && x.thumb; })[0];
    var photoP = main ? call('getPhotoLarge', it.key, main.id).then(function (r) { return (r && r.src) || main.thumb; }, function () { return main.thumb; })
      : Promise.resolve(it.folderId ? S.thumbs[it.folderId] || null : null);
    photoP.then(function (src) { return makeShareCard(it, src); }).then(function (blob) {
      done();
      if (!blob) throw new Error('Couldn\u2019t make the picture on this phone.');
      var fname = String(it.name || 'find').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) + '-' + String(THEME.shortName || 'collection').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.jpg';
      var file = null; try { file = new File([blob], fname, { type: 'image/jpeg' }); } catch (e) { file = null; }
      var canFiles = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
      var url = URL.createObjectURL(blob);
      S.shareUrl = url;
      var btns = [];
      if (canFiles) btns.push({ label: '\uD83D\uDCE4 Share', value: 'share', cls: 'main' });
      btns.push({ label: '\u2B07\uFE0F Save picture', value: 'save', cls: canFiles ? '' : 'main' }, { label: 'Close', value: 'close' });
      return sheet('\uD83D\uDCE4 Share this find', '<img class="sharePrev" alt="Share picture preview" src="' + url + '"><p class="hint center">1080\u00D71350 \u00B7 ready for Instagram. No prices on it, ever.</p>', btns).then(function (v) {
        if (v === 'share') return navigator.share({ files: [file], title: it.name, text: it.name + ' \u2013 ' + SHARE_HANDLE }).catch(function (e) { if (e && e.name !== 'AbortError') saveBlob(url, fname); });
        if (v === 'save') saveBlob(url, fname);
      });
    }).catch(oops);
  }
  function saveBlob(url, name) { var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 500); toast('\u2B07\uFE0F Saved to your downloads', 'good'); }

  /* Price check: just links (no scraping) */
  function priceQuery(it) {
    var q = String(it.name || '').replace(/\((?:x?\d+|copy|spare|duplicate|second|2nd)[^)]*\)/ig, '').replace(/[\u2018\u2019]/g, '\'').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ').trim();
    return q;
  }
  function ebaySoldUrl(q, sop) { return 'https://www.ebay.co.uk/sch/i.html?_nkw=' + encodeURIComponent(q).replace(/%20/g, '+') + '&LH_Sold=1&LH_Complete=1' + (sop ? '&_sop=' + sop : ''); }
  function priceBoxHtml(it) {
    var q = priceQuery(it), a = function (href, label, cls) { return '<a class="btn small ' + (cls || '') + '" href="' + esc(href) + '" target="_blank" rel="noopener">' + label + '</a>'; };
    return '<div class="card skyL" id="priceBox"><h3>\uD83D\uDD0E Price check</h3><p class="hint">Opens eBay UK <b>sold</b> listings for \u201C' + esc(q) + '\u201D. Nothing is saved.</p><div class="row wrap">' +
      a(ebaySoldUrl(q, 13), 'eBay sold \u00B7 newest', 'yel') + a(ebaySoldUrl(q, 16), 'eBay sold \u00B7 highest \u00A3') + a(ebaySoldUrl(q, 15), 'eBay sold \u00B7 lowest \u00A3') +
      a('https://www.google.com/search?q=' + encodeURIComponent(q + ' sold price UK'), 'Google') + '</div></div>';
  }

  /* ---------------- Spares & duplicates ---------------- */
  var LOOSE_STOP = /\b(the|and|of|a|an|loose|boxed|carded|sealed|mib|moc|new|vintage|figure|figurine|toy)\b/g;
  function looseKey(name) {
    return String(name || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9#]+/g, ' ').replace(LOOSE_STOP, ' ').replace(/\s+/g, ' ').trim();
  }
  SCREENS.spares = function () {
    busy('Looking for doubles\u2026');
    Promise.all([call('getDuplicates', S.role), loadBoot().catch(function () { return null; })]).then(function (res) {
      done();
      var d = res[0], priv = isPriv();
      var ok = function (it) { return !neverShow(it.name) && (priv || !sonHidden(it.name)); };
      var groups = d.groups.map(function (g) { return { name: g.name, copies: g.copies, items: g.items.filter(ok) }; }).filter(function (g) { return g.items.length && !neverShow(g.name); });
      S.spares = d;
      var inGroup = {}; groups.forEach(function (g) { g.items.forEach(function (it) { inGroup[it.key] = 1; }); });
      var loose = {};
      (S.items || []).filter(function (it) { return isOwned(it) && ok(it) && !inGroup[it.key]; }).forEach(function (it) { var k = looseKey(it.name); if (k.length >= 4) (loose[k] = loose[k] || []).push(it); });
      var maybe = Object.keys(loose).map(function (k) { return loose[k]; }).filter(function (l) { return l.length > 1; });
      var spareCopies = groups.reduce(function (s, g) { return s + g.copies - 1; }, 0);
      var valOf = function (g) { var vs = g.items.map(function (it) { return it.v; }).filter(function (v) { return v != null; }); return vs.length ? Math.max.apply(null, vs) : null; };
      var spareVal = priv ? groups.reduce(function (s, g) { var v = valOf(g); return s + (v != null ? v * (g.copies - 1) : 0); }, 0) : 0;
      var h = backBtn() + '<h1>\uD83D\uDD01 Spares & duplicates</h1><p class="hint">Things we own more than once - handy to swap or sell. Tap <b>Mark for sale</b> on the copy to let go (it stays in the sheet).</p>' +
        '<div class="card yel center"><b style="font-size:22px">' + groups.length + '</b> thing' + (groups.length === 1 ? '' : 's') + ' owned more than once \u00B7 <b>' + spareCopies + '</b> spare cop' + (spareCopies === 1 ? 'y' : 'ies') +
        (priv && spareVal ? '<br>\uD83D\uDD12 Spares worth about <b>' + gbp(spareVal) + '</b>' : '') + '</div>';
      if (!groups.length) h += '<div class="nudge">No doubles found - every name is different. \uD83C\uDF89</div>';
      h += groups.map(function (g) {
        var why = g.items.length === 1 ? 'Quantity ' + g.copies + ' on one row' : g.items.length + ' rows with the same name' + (g.copies > g.items.length ? ' (plus quantity)' : '');
        var v = priv ? valOf(g) : null;
        return '<div class="card"><h3>' + esc(g.name) + ' <span class="pill amber">\u00D7' + g.copies + '</span></h3><p class="hint">' + esc(why) + (v != null ? ' \u00B7 \uD83D\uDD12 about ' + gbp(v) + ' each' : '') + '</p><div class="list">' + g.items.map(function (it) {
          return '<div class="li">' + thumbHtml(it) + '<div class="grow" data-act="item" data-key="' + esc(it.key) + '">' + esc(it.id || 'No ID') + '<small>' + esc([it.condition, it.packaging, it.status].filter(Boolean).join(' \u00B7 ')) + (priv && it.v != null ? ' \u00B7 ' + gbp(it.v) : '') + '</small></div>' +
            (/for sale/i.test(it.status) ? '<span class="pill green">For sale</span>' : '<button class="btn small yel" data-act="markSale" data-key="' + esc(it.key) + '" data-name="' + esc(it.name) + '">Mark for sale</button>') + '</div>';
        }).join('') + '</div></div>';
      }).join('');
      if (maybe.length) h += '<h2>\uD83E\uDD14 Might be doubles</h2><p class="hint">Names that nearly match (ignoring brackets, years and words like loose/boxed). Check them - they may be different versions.</p>' + maybe.slice(0, 40).map(function (l) {
        return '<div class="card"><div class="list">' + l.map(function (it) { return '<button class="li" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.id, it.condition, it.packaging].filter(Boolean).join(' \u00B7 ')) + (priv && it.v != null ? ' \u00B7 ' + gbp(it.v) : '') + '</small></div><span>\u203A</span></button>'; }).join('') + '</div></div>';
      }).join('');
      var fs = d.forSale.filter(ok);
      if (fs.length) h += '<h2>Marked for sale (' + fs.length + ')</h2><div class="grid">' + fs.map(cardHtml).join('') + '</div>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- dates from the sheet's free-text columns ---------------- */
  var MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function parseLoose(s) {
    s = String(s || '').trim();
    if (!s || /^(unknown|n\/?a|none|-|no photos|tbc|\?)/i.test(s)) return null;
    var m, mk = function (y, mo, d, p) { if (y < 100) y += 2000; if (mo < 0 || mo > 11 || y < 1950 || y > 2100) return null; return { t: Date.UTC(y, mo, d || 1), y: y, m: mo, d: d || 0, p: p }; };
    if ((m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/))) return mk(+m[1], +m[2] - 1, +(m[3] || 0), m[3] ? 'd' : 'm');
    if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/)) && MON[m[2].slice(0, 3).toLowerCase()] != null) return mk(+m[3], MON[m[2].slice(0, 3).toLowerCase()], +m[1], 'd');
    if ((m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\b/)) && MON[m[1].slice(0, 3).toLowerCase()] != null) return mk(+m[3], MON[m[1].slice(0, 3).toLowerCase()], +m[2], 'd');
    if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/))) return mk(+m[3], +m[2] - 1, +m[1], 'd');
    if ((m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/)) && MON[m[1].slice(0, 3).toLowerCase()] != null) return mk(+m[2], MON[m[1].slice(0, 3).toLowerCase()], 0, 'm');
    if ((m = s.match(/\b(19[5-9]\d|20\d\d)\b/))) return mk(+m[1], 0, 0, 'y');
    return null;
  }
  var HIST = { data: null, at: 0, role: '' };
  function loadHistory() {
    var who = (S.kid ? 'k' : '') + S.role + (isPriv() ? 'p' : '');
    if (HIST.data && HIST.role === who && Date.now() - HIST.at < 300000) return Promise.resolve(HIST.data);
    return call('getHistory', S.role).then(function (rows) {
      var m = {}; (rows || []).forEach(function (r) { m[r.key] = r; });
      HIST.data = m; HIST.at = Date.now(); HIST.role = who; return m;
    }, function (e) { if (/unknown action/i.test((e && e.message) || '')) return null; throw e; });
  }
  /* bought (owner only) > got > photo date (when it was added) */
  function whenOf(h) {
    if (!h) return null;
    var tries = [[h.pd, 'Bought'], [h.dg, 'Got'], [h.ph, 'Added']];
    for (var i = 0; i < tries.length; i++) { var d = parseLoose(tries[i][0]); if (d) { d.src = tries[i][1]; d.raw = tries[i][0]; return d; } }
    return null;
  }
  function dateLabel(d) {
    if (d.p === 'd') return d.d + ' ' + MON_NAMES[d.m].slice(0, 3);
    if (d.p === 'm') return MON_NAMES[d.m].slice(0, 3);
    return 'Sometime';
  }

  /* ---------------- Item history (timeline) ---------------- */
  SCREENS.history = function () {
    busy('Building the timeline\u2026');
    Promise.all([loadBoot(), loadHistory()]).then(function (r) {
      done();
      var hist = r[1], priv = isPriv();
      if (!hist) { setMain(backBtn() + '<h1>\uD83D\uDDD3\uFE0F Item history</h1><div class="nudge">This needs the latest Apps Script (v4.3). Ask ' + esc(PRIV) + ' to paste it in - then this page fills itself from the sheet.</div>'); return; }
      var items = (S.items || []).filter(function (it) { return !neverShow(it.name) && (priv || !sonHidden(it.name)); });
      var dated = [], undated = [];
      items.forEach(function (it) { var h = hist[it.key], d = whenOf(h); if (d) dated.push({ it: it, h: h, d: d }); else undated.push(it); });
      dated.sort(function (a, b) { return b.d.t - a.d.t || (b.d.p === 'd') - (a.d.p === 'd'); });
      var f = S.histFilter || '';
      var shownList = f ? dated.filter(function (x) { return x.d.src === f; }) : dated;
      var groups = [], cur = null;
      shownList.slice(0, S.histShown || 150).forEach(function (x) {
        var k = x.d.p === 'y' ? x.d.y + '' : x.d.y + '-' + x.d.m;
        if (!cur || cur.k !== k) { cur = { k: k, title: x.d.p === 'y' ? x.d.y + ' (month not known)' : MON_NAMES[x.d.m] + ' ' + x.d.y, rows: [], spent: 0 }; groups.push(cur); }
        cur.rows.push(x); if (priv && x.h && x.h.p != null) cur.spent += x.h.p;
      });
      var chip = function (v, l) { return '<button class="chip' + (f === v ? ' on' : '') + '" data-act="histFilter" data-v="' + v + '">' + l + '</button>'; };
      var h = backBtn() + '<h1>\uD83D\uDDD3\uFE0F Item history</h1><p class="hint">When things joined the collection, newest first. Uses Purchase Date' + (priv ? '' : ' (' + OWN + ' only)') + ', then Date got, then Photo date from the sheet.</p>' +
        '<div class="chips">' + chip('', 'All (' + dated.length + ')') + (priv ? chip('Bought', 'Bought') : '') + chip('Got', 'Got') + chip('Added', 'Added (photo date)') + '</div>' +
        '<div class="timeline">' + groups.map(function (g) {
          return '<div class="tlMonth"><h2>' + esc(g.title) + ' <span class="pill">' + g.rows.length + '</span>' + (priv && g.spent ? ' <span class="pill amber">\uD83D\uDD12 ' + gbp(g.spent) + '</span>' : '') + '</h2>' + g.rows.map(function (x) {
            var meta = [dateLabel(x.d) + ' \u00B7 ' + x.d.src, x.h && x.h.w ? x.h.w : ''].filter(Boolean).join(' \u00B7 ');
            return '<button class="li tlRow" data-act="item" data-key="' + esc(x.it.key) + '"><span class="tlDot"></span>' + thumbHtml(x.it) + '<div class="grow">' + esc(x.it.name) +
              '<small>' + esc([x.it.range].filter(Boolean).join('')) + '</small><small class="tlMeta">' + esc(meta) + (priv && x.h && x.h.p != null ? ' \u00B7 <b>' + gbp(x.h.p) + '</b>' : '') + '</small></div></button>';
          }).join('') + '</div>';
        }).join('') + '</div>' +
        (shownList.length > (S.histShown || 150) ? '<p class="center"><button class="btn" data-act="histMore">Show more (' + (shownList.length - (S.histShown || 150)) + ' left)</button></p>' : '') +
        '<details class="card"' + (undated.length && !dated.length ? ' open' : '') + '><summary>\u2753 No date yet: <b>' + undated.length + '</b> item' + (undated.length === 1 ? '' : 's') + '</summary><p class="hint">These have no usable Purchase Date, Date got or Photo date. Add one in the sheet (e.g. \u201C12 Oct 2026\u201D or \u201COct 2026\u201D) and they\u2019ll slot in.</p><div class="list">' +
        undated.slice(0, 300).map(function (it) { return '<button class="li" data-act="item" data-key="' + esc(it.key) + '">' + thumbHtml(it) + '<div class="grow">' + esc(it.name) + '<small>' + esc([it.id, it.range].filter(Boolean).join(' \u00B7 ')) + '</small></div><span>\u203A</span></button>'; }).join('') + '</div></details>';
      setMain(h);
      watchThumbs();
    }).catch(oops);
  };

  /* ---------------- Badges for Kid mode (from the collection; no money; secret/Christmas never count) ---------------- */
  var RARE_RE = /limited|exclusive|\bchase\b|\brare\b|signed|autograph|convention|sdcc|\bglow\b|glow in the dark|metallic|flocked|numbered|\b1 of\b|prototype|special edition/i;
  var CAT_ICONS = [[/vinyl|pop/i, '\uD83E\uDDF8'], [/pez/i, '\uD83C\uDF6C'], [/badge|pin/i, '\uD83D\uDCCC'], [/plush|soft/i, '\uD83E\uDDF8'], [/lego|mega|build/i, '\uD83E\uDDF1'], [/china|figurine|ornament/i, '\uD83C\uDFFA'], [/action|figure/i, '\uD83E\uDDB8'], [/game|puzzle/i, '\uD83C\uDFB2'], [/book|comic/i, '\uD83D\uDCDA'], [/sign|wall|poster/i, '\uD83D\uDDBC\uFE0F'], [/talk|electronic/i, '\uD83D\uDD0A'], [/key/i, '\uD83D\uDD11'], [/tin|mug|cup/i, '\u2615'], [/fast food|burger|kfc|meal/i, '\uD83C\uDF54']];
  var CAT_TIERS = [[5, 'Starter'], [10, 'Fan'], [25, 'Super Fan'], [50, 'Mega Fan'], [100, 'Legend']];
  var CHARS = [];
  function catIcon(r) { for (var i = 0; i < CAT_ICONS.length; i++) if (CAT_ICONS[i][0].test(r)) return CAT_ICONS[i][1]; return '\u2B50'; }
  function kidCount(k) { return +LS.get(k) || 0; }
  function bumpKid(k, n) { LS.set(k, String(kidCount(k) + (n || 1))); }
  var BADGE_TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'elite', 'champion', 'unreal'];
  var BADGE_TIER_NAME = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', elite: 'Elite', champion: 'Champion', unreal: 'Unreal' };
  var BADGE_CATALOG = [
    { id: 'drop-in', tier: 'bronze', emoji: '\uD83C\uDF91', name: 'First Drop-In', goal: 'Open Kid mode for the first time.', rule: { type: 'starter' } },
    { id: 'wee-welcome', tier: 'bronze', emoji: '\uD83D\uDC4B', name: 'Big Welcome', goal: 'Say hi on the home screen.', rule: { type: 'starter' } },
    { id: 'snap-happy', tier: 'bronze', emoji: '\uD83D\uDCF8', name: 'Snap Happy', goal: 'Add 1 photo in Kid mode.', rule: { type: 'photos', n: 1 } },
    { id: 'first-find', tier: 'bronze', emoji: '\uD83D\uDD0D', name: 'First Find!', goal: 'Tick 1 item off the hunt list.', rule: { type: 'found', n: 1 } },
    { id: 'ten-pointer', tier: 'bronze', emoji: '\u2B50', name: 'Ten Pointer', goal: 'Earn 10 points.', rule: { type: 'points', n: 10 } },
    { id: 'back-again', tier: 'bronze', emoji: '\uD83D\uDC5F', name: 'Back Again', goal: 'Visit on 2 different days.', rule: { type: 'visits', n: 2 } },
    { id: 'new-shelf', tier: 'bronze', emoji: '\uD83D\uDCE6', name: 'New On The Shelf', goal: 'Add 1 new item to the collection.', rule: { type: 'items', n: 1 } },
    { id: 'joke-machine', tier: 'bronze', emoji: '\uD83D\uDE02', name: 'Joke Machine', goal: 'Tap the joke card 3 times.', rule: { type: 'jokes', n: 3 } },
    { id: 'worth-swipe', tier: 'bronze', emoji: '\uD83C\uDF69', name: 'Worth a Swipe', goal: 'Swipe or tap the worth card.', rule: { type: 'swipes', n: 1 } },
    { id: 'note-read', tier: 'bronze', emoji: '\uD83D\uDCDD', name: 'Got a Note', goal: 'Open one of your notes.', rule: { type: 'reads', n: 1 } },
    { id: 'got-it-search', tier: 'bronze', emoji: '\uD83D\uDD0E', name: 'Have We Got It?', goal: 'Search for something on the home screen.', rule: { type: 'searches', n: 1 } },
    { id: 'box-scanner', tier: 'bronze', emoji: '\uD83D\uDCF7', name: 'Box Scanner', goal: 'Scan a box.', rule: { type: 'scans', n: 1 } },
    { id: 'camera-kid', tier: 'silver', emoji: '\uD83D\uDCF7', name: 'Camera Kid', goal: 'Add 5 photos in Kid mode.', rule: { type: 'photos', n: 5 } },
    { id: 'super-sleuth', tier: 'silver', emoji: '\uD83D\uDD75\uFE0F', name: 'Super Sleuth', goal: 'Tick 5 items off the hunt list.', rule: { type: 'found', n: 5 } },
    { id: 'fifty-pointer', tier: 'silver', emoji: '\uD83C\uDF1F', name: 'Fifty Pointer', goal: 'Earn 50 points.', rule: { type: 'points', n: 50 } },
    { id: 'week-visitor', tier: 'silver', emoji: '\uD83D\uDCC5', name: 'Week Visitor', goal: 'Visit on 5 different days.', rule: { type: 'visits', n: 5 } },
    { id: 'five-finds', tier: 'silver', emoji: '\uD83C\uDF81', name: 'Five New Finds', goal: 'Add 5 new items to the collection.', rule: { type: 'items', n: 5 } },
    { id: 'hunt-pair', tier: 'silver', emoji: '\uD83D\uDD2D', name: 'Hunt Pair', goal: 'Tick 2 items off the hunt list.', rule: { type: 'found', n: 2 } },
    { id: 'point-stash', tier: 'silver', emoji: '\uD83C\uDFC5', name: 'Point Stash', goal: 'Earn 25 points.', rule: { type: 'points', n: 25 } },
    { id: 'picture-day', tier: 'silver', emoji: '\uD83D\uDDBC\uFE0F', name: 'Picture Day', goal: 'Add 3 photos in Kid mode.', rule: { type: 'photos', n: 3 } },
    { id: 'joke-book', tier: 'silver', emoji: '\uD83D\uDCD6', name: 'Joke Book', goal: 'Tap the joke card 10 times.', rule: { type: 'jokes', n: 10 } },
    { id: 'fresh-cats', tier: 'silver', emoji: '\uD83D\uDDC2\uFE0F', name: 'Fresh Categories', goal: 'Add items in 2 new categories.', rule: { type: 'cats', n: 2 } },
    { id: 'camera-ace', tier: 'gold', emoji: '\uD83C\uDFAF', name: 'Camera Ace', goal: 'Add 10 photos in Kid mode.', rule: { type: 'photos', n: 10 } },
    { id: 'master-hunter', tier: 'gold', emoji: '\uD83C\uDFAF', name: 'Master Hunter', goal: 'Tick 10 items off the hunt list.', rule: { type: 'found', n: 10 } },
    { id: 'century-club', tier: 'gold', emoji: '\uD83C\uDFC6', name: 'Century Club', goal: 'Earn 100 points.', rule: { type: 'points', n: 100 } },
    { id: 'fortnight-fun', tier: 'gold', emoji: '\uD83C\uDFC3', name: 'Fortnight of Fun', goal: 'Visit on 10 different days.', rule: { type: 'visits', n: 10 } },
    { id: 'ten-treasures', tier: 'gold', emoji: '\uD83D\uDC8E', name: 'Ten Treasures', goal: 'Add 10 new items to the collection.', rule: { type: 'items', n: 10 } },
    { id: 'category-captain', tier: 'gold', emoji: '\uD83E\uDDED', name: 'Category Captain', goal: 'Add items in 3 new categories.', rule: { type: 'cats', n: 3 } },
    { id: 'seven-day', tier: 'gold', emoji: '\u2B50', name: 'Seven Day Hero', goal: 'Visit on 7 different days.', rule: { type: 'visits', n: 7 } },
    { id: 'shelf-star', tier: 'gold', emoji: '\uD83C\uDF1F', name: 'Shelf Star', goal: 'Add 15 new items to the collection.', rule: { type: 'items', n: 15 } },
    { id: 'photo-pro', tier: 'platinum', emoji: '\uD83D\uDCF8', name: 'Photo Pro', goal: 'Add 20 photos in Kid mode.', rule: { type: 'photos', n: 20 } },
    { id: 'hunt-legend', tier: 'platinum', emoji: '\uD83C\uDFC6', name: 'Hunt Legend', goal: 'Tick 20 items off the hunt list.', rule: { type: 'found', n: 20 } },
    { id: 'club-250', tier: 'platinum', emoji: '\uD83D\uDC8E', name: '250 Club', goal: 'Earn 250 points.', rule: { type: 'points', n: 250 } },
    { id: 'monthly-regular', tier: 'platinum', emoji: '\uD83D\uDCC5', name: 'Monthly Regular', goal: 'Visit on 20 different days.', rule: { type: 'visits', n: 20 } },
    { id: 'haul-hero', tier: 'platinum', emoji: '\uD83D\uDCE6', name: 'Haul Hero', goal: 'Add 25 new items to the collection.', rule: { type: 'items', n: 25 } },
    { id: 'range-master', tier: 'platinum', emoji: '\uD83C\uDFAF', name: 'Range Master', goal: 'Add items in 5 new categories.', rule: { type: 'cats', n: 5 } },
    { id: 'diamond-lens', tier: 'diamond', emoji: '\uD83D\uDC8E', name: 'Diamond Lens', goal: 'Add 40 photos in Kid mode.', rule: { type: 'photos', n: 40 } },
    { id: 'diamond-hunter', tier: 'diamond', emoji: '\uD83D\uDD0D', name: 'Diamond Hunter', goal: 'Tick 35 items off the hunt list.', rule: { type: 'found', n: 35 } },
    { id: 'diamond-points', tier: 'diamond', emoji: '\u2B50', name: 'Diamond Points', goal: 'Earn 500 points.', rule: { type: 'points', n: 500 } },
    { id: 'everyday-explorer', tier: 'diamond', emoji: '\uD83E\uDDED', name: 'Everyday Explorer', goal: 'Visit on 30 different days.', rule: { type: 'visits', n: 30 } },
    { id: 'mega-haul', tier: 'diamond', emoji: '\uD83C\uDFDB\uFE0F', name: 'Mega Haul', goal: 'Add 50 new items to the collection.', rule: { type: 'items', n: 50 } },
    { id: 'elite-camera', tier: 'elite', emoji: '\uD83D\uDCF7', name: 'Elite Camera', goal: 'Add 75 photos in Kid mode.', rule: { type: 'photos', n: 75 } },
    { id: 'elite-hunter', tier: 'elite', emoji: '\uD83C\uDFAF', name: 'Elite Hunter', goal: 'Tick 50 items off the hunt list.', rule: { type: 'found', n: 50 } },
    { id: 'elite-points', tier: 'elite', emoji: '\uD83C\uDF1F', name: 'Elite Points', goal: 'Earn 800 points.', rule: { type: 'points', n: 800 } },
    { id: 'elite-shelf', tier: 'elite', emoji: '\uD83D\uDCDC', name: 'Elite Shelf', goal: 'Add 75 new items to the collection.', rule: { type: 'items', n: 75 } },
    { id: 'champ-shelf', tier: 'champion', emoji: '\uD83C\uDFC6', name: 'Champion of the Shelf', goal: 'Add 100 new items to the collection.', rule: { type: 'items', n: 100 } },
    { id: 'champ-hunter', tier: 'champion', emoji: '\uD83D\uDD25', name: 'Champion Hunter', goal: 'Tick 80 items off the hunt list.', rule: { type: 'found', n: 80 } },
    { id: 'champ-points', tier: 'champion', emoji: '\uD83D\uDC51', name: 'Champion Points', goal: 'Earn 1,200 points.', rule: { type: 'points', n: 1200 } },
    { id: 'unreal-collector', tier: 'unreal', emoji: '\uD83D\uDE80', name: 'Unreal Collector', goal: 'Add 200 new items to the collection.', rule: { type: 'items', n: 200 } },
    { id: 'unreal-legend', tier: 'unreal', emoji: '\u2728', name: 'Unreal Legend', goal: 'Earn 2,000 points.', rule: { type: 'points', n: 2000 } }
  ];
  var BADGE_STARTERS = ['drop-in', 'wee-welcome'];

  function badgeBook() {
    try {
      var o = JSON.parse(LS.get('badgeBook') || 'null');
      if (o && o.v === 1) return o;
    } catch (e) {}
    return { v: 1, resetAt: '', baseline: null, earned: {}, override: {}, custom: [], visits: [] };
  }
  function saveBadgeBook(b) { LS.set('badgeBook', JSON.stringify(b)); }
  function badgeCatCount() {
    var o = {};
    kidItems().forEach(function (it) {
      var r = String(it.range || '').trim();
      if (r && !/^(unknown|other)$/i.test(r)) o[r] = 1;
    });
    return Object.keys(o).length;
  }
  function currentBadgeStats(rewards) {
    return {
      items: kidItems().length,
      photos: kidCount('kidPhotos'),
      found: kidCount('kidFound'),
      points: rewards && rewards.balance != null ? +rewards.balance : 0,
      jokes: kidCount('kidJokes'),
      swipes: kidCount('kidWorthSwipes'),
      scans: kidCount('kidScans'),
      searches: kidCount('kidSearches'),
      reads: kidCount('kidDadReads'),
      cats: badgeCatCount()
    };
  }
  function ensureBadgeBaseline(stats) {
    var b = badgeBook();
    if (!b.baseline) {
      b.resetAt = londonDay();
      b.baseline = stats;
      b.earned = b.earned || {};
      BADGE_STARTERS.forEach(function (id) { b.earned[id] = 1; });
      b.visits = b.visits || [];
      var d = londonDay();
      if (b.visits.indexOf(d) < 0) b.visits.push(d);
      saveBadgeBook(b);
      var seen = badgesSeen() || [];
      BADGE_STARTERS.forEach(function (id) { if (seen.indexOf(id) < 0) seen.push(id); });
      LS.set('kidBadgesSeen', JSON.stringify(seen));
    }
    return b;
  }
  function recordBadgeVisit() {
    var b = badgeBook();
    b.visits = b.visits || [];
    var d = londonDay();
    if (b.visits.indexOf(d) < 0) { b.visits.push(d); saveBadgeBook(b); }
  }
  function allBadgeDefs() {
    return BADGE_CATALOG.concat(badgeBook().custom || []);
  }
  function computeBadges(hist, rewards) {
    var stats = currentBadgeStats(rewards);
    var book = ensureBadgeBaseline(stats);
    var base = book.baseline || {};
    return allBadgeDefs().map(function (def) {
      var typ = (def.rule && def.rule.type) || 'manual';
      var need = typ === 'starter' ? 1 : Math.max(1, (def.rule && def.rule.n) || 1);
      var have = 0;
      if (typ === 'starter') have = 1;
      else if (typ === 'visits') have = (book.visits || []).length;
      else if (typ === 'manual') have = (book.earned && book.earned[def.id]) ? need : 0;
      else have = Math.max(0, (stats[typ] || 0) - (base[typ] || 0));
      have = Math.min(have, need);
      var got = have >= need;
      if (book.override && book.override[def.id] === 0) got = false;
      else if (book.override && book.override[def.id] === 1) got = true;
      if (got) have = need;
      return { id: def.id, icon: def.emoji, name: def.name, desc: def.goal, tier: def.tier || 'bronze', have: have, need: need, got: got, custom: !!def.custom, rule: typ };
    });
  }
  function badgesSeen() { try { return JSON.parse(LS.get('kidBadgesSeen') || 'null'); } catch (e) { return null; } }
  function ptsVal(r, key, fallback) {
    var n = parseInt(((r && r.points) || {})[key], 10);
    return (n >= 0 && n <= 100000) ? n : fallback;
  }
  function ptsLabel(n) { return n === 1 ? '1 pt' : n + ' pts'; }
  function earnJobs(r) {
    return [
      { kind: 'photo', icon: '\uD83D\uDCF8', title: 'Add a photo', pts: ptsVal(r, 'photo', 10), desc: 'Snap one of our things. You get the points when ' + OWN + ' says yes.' },
      { kind: 'add', icon: '\uD83D\uDCE6', title: 'Add a new find', pts: ptsVal(r, 'add', 20), desc: 'Save something new to our collection.' },
      { kind: 'found', icon: '\u2B50', title: 'Tick one off the Hunt', pts: ptsVal(r, 'found', 5), desc: 'Found it on Hunt or Wanted? Mark it ours.' },
      { kind: 'update', icon: '\u270F\uFE0F', title: 'Update a thing', pts: ptsVal(r, 'update', 5), desc: 'Help fill in details on something we already have.' },
      { kind: 'streak', icon: '\uD83D\uDD25', title: '3-day helper bonus', pts: ptsVal(r, 'streak', 15), desc: 'Help on 3 days in a row and get a bonus on top.' }
    ];
  }
  function earnCardHtml(r) {
    var h = '<div class="earnCard"><h2>How to earn points</h2><p class="earnSub">Your point jobs \u2014 tap one to have a go</p><div class="earnJobs">';
    earnJobs(r).forEach(function (j) {
      h += '<button type="button" class="earnJob" data-act="earnGo" data-kind="' + esc(j.kind) + '">' +
        '<span class="eIc">' + j.icon + '</span>' +
        '<span class="eTxt"><b>' + esc(j.title) + '</b><small>' + esc(j.desc) + '</small></span>' +
        '<span class="ePts">' + ptsLabel(j.pts) + '</span></button>';
    });
    return h + '</div></div>';
  }
  function paintEarnPoints(r) {
    var el = $('kidEarn'); if (!el) return;
    el.innerHTML = earnCardHtml(r || RW || {});
  }
  function jobEmoji(t) {
    var s = String(t || '').toLowerCase();
    if (/dish/.test(s)) return '\uD83C\uDF74';
    if (/room|bed/.test(s)) return '\uD83D\uDECF\uFE0F';
    if (/rubbish|trash|bin/.test(s)) return '\uD83D\uDDD1\uFE0F';
    if (/garden|lawn|grass/.test(s)) return '\uD83C\uDF3F';
    return '\uD83E\uDDF9';
  }
  function jobsCardHtml(r) {
    var jobs = rwArr(r && r.jobs).slice();
    if (!jobs.length) return '';
    jobs.sort(function (a, b) { return (a.cost - b.cost) || String(a.title || '').localeCompare(String(b.title || '')); });
    var h = '<div class="jobCard"><h2>Jobs</h2><p class="jobSub">Jobs from ' + OWN + ' \u2014 when they tap Done, you get the points</p><div class="jobRows">';
    jobs.forEach(function (j) {
      h += '<div class="jobRow">' +
        '<span class="eIc">' + jobEmoji(j.title) + '</span>' +
        '<span class="eTxt"><b>' + esc(j.title) + '</b><small>' + (j.doneToday ? 'Done today \u2014 well done!' : '' + OWN + ' taps Done when it\u2019s finished') + '</small></span>' +
        '<span class="ePts">+' + j.cost + '</span></div>';
    });
    return h + '</div></div>';
  }
  function paintJobs(r) {
    var el = $('kidJobs'); if (!el) return;
    el.innerHTML = jobsCardHtml(r || RW || {});
  }
  function runEarnJob(kind) {
    if (kind === 'photo' || kind === 'update') go('kidStuff');
    else if (kind === 'add') { S.add = null; go('add'); }
    else if (kind === 'found') go('kidHunt');
    else if (kind === 'streak') toast('Help today with a photo, a find or a new item to keep your streak going!', 'good');
    else go('kidRewards');
  }
  function missionAction(b) {
    var left = Math.max(1, (b.need || 1) - (b.have || 0));
    var typ = b.rule || '';
    if (typ === 'photos') return left === 1 ? 'Add 1 more photo' : 'Add ' + left + ' more photos';
    if (typ === 'found') return left === 1 ? 'Find 1 item from Hunt' : 'Find ' + left + ' items from Hunt';
    if (typ === 'points') return left === 1 ? 'Earn 1 more point' : 'Earn ' + left + ' more points';
    if (typ === 'visits') return left === 1 ? 'Come back tomorrow' : 'Visit on ' + left + ' more days';
    if (typ === 'items') return left === 1 ? 'Add 1 new item' : 'Add ' + left + ' new items';
    if (typ === 'cats') return left === 1 ? 'Add an item in 1 more category' : 'Add items in ' + left + ' more categories';
    if (typ === 'jokes') return left === 1 ? 'Tap the joke 1 more time' : 'Tap the joke ' + left + ' more times';
    if (typ === 'swipes') return 'Swipe or tap the worth card';
    if (typ === 'reads') return 'Open one of your notes';
    if (typ === 'searches') return 'Search for something on the home screen';
    if (typ === 'scans') return 'Scan a box';
    return b.desc || 'Have a go at this badge';
  }
  function nearestMissions(B, n) {
    n = n || 4;
    var open = (B || []).filter(function (b) { return !b.got && b.rule && b.rule !== 'starter' && b.rule !== 'manual'; });
    open.sort(function (a, b) {
      var pa = a.need ? a.have / a.need : 0, pb = b.need ? b.have / b.need : 0;
      if (pb !== pa) return pb - pa;
      var ra = a.need - a.have, rb = b.need - b.have;
      if (ra !== rb) return ra - rb;
      var ta = BADGE_TIER_ORDER.indexOf(a.tier), tb = BADGE_TIER_ORDER.indexOf(b.tier);
      if (ta !== tb) return ta - tb;
      return 0;
    });
    return open.slice(0, n);
  }
  function missionCardHtml(B) {
    var rows = nearestMissions(B, 4);
    if (!rows.length) {
      return '<div class="missionCard"><h2>My missions</h2><p class="missionSub">You\u2019ve smashed every quest for now \u2014 check your badge wall!</p>' +
        '<button type="button" class="missionRow tier-gold" data-act="go" data-to="kidBadges"><span class="mIc">\uD83C\uDFC6</span><span class="mTxt"><b>See my badges</b><small>All current missions complete</small></span></button></div>';
    }
    var h = '<div class="missionCard"><h2>My missions</h2><p class="missionSub">Your next badge quests \u2014 tap one to get started</p>';
    rows.forEach(function (b) {
      var pct = b.need ? Math.round(100 * b.have / b.need) : 0;
      h += '<button type="button" class="missionRow tier-' + esc(b.tier || 'bronze') + '" data-act="mission" data-kind="' + esc(b.rule || '') + '">' +
        '<span class="mIc">' + (b.icon || '\uD83C\uDFC6') + '</span>' +
        '<span class="mTxt"><b>' + esc(b.name) + '</b><small>' + esc(missionAction(b)) + '</small>' +
        '<span class="mBar"><i style="width:' + pct + '%"></i></span></span>' +
        '<span class="mCount"><span class="tPip ' + esc(b.tier || 'bronze') + '"></span> ' + b.have + ' / ' + b.need + '</span>' +
        '</button>';
    });
    return h + '</div>';
  }
  function paintMissions(B) {
    var el = $('kidMissions'); if (!el) return;
    el.innerHTML = missionCardHtml(B || S.badges || []);
  }
  function runMission(kind) {
    if (kind === 'photos') go('kidStuff');
    else if (kind === 'found') go('kidHunt');
    else if (kind === 'points') go('kidRewards');
    else if (kind === 'items' || kind === 'cats') { S.add = null; go('add'); }
    else if (kind === 'scans') openScanner({});
    else if (kind === 'reads') showDadLetter(true);
    else if (kind === 'visits') toast('Come back tomorrow and this one will tick along!', 'good');
    else if (kind === 'jokes') {
      var j = $('kidJoke');
      if (j) { try { j.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} j.classList.add('missionPulse'); setTimeout(function () { j.classList.remove('missionPulse'); }, 1600); }
    } else if (kind === 'swipes') {
      var w = $('funWorth');
      if (w) { try { w.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} w.classList.add('missionPulse'); setTimeout(function () { w.classList.remove('missionPulse'); }, 1600); }
    } else if (kind === 'searches') {
      var s = $('kidSearch');
      if (s) { try { s.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} s.focus(); s.classList.add('missionPulse'); setTimeout(function () { s.classList.remove('missionPulse'); }, 1600); }
    } else go('kidBadges');
  }
  function checkNewBadges() {
    return Promise.all([
      loadHistory().catch(function () { return null; }),
      loadRewards().catch(function () { return null; })
    ]).then(function (res) {
      var B = computeBadges(res[0], res[1]), got = B.filter(function (b) { return b.got; }), seen = badgesSeen(), first = !seen;
      seen = seen || [];
      var fresh = got.filter(function (b) { return seen.indexOf(b.id) < 0; });
      S.badges = B;
      if (!fresh.length || S.screen.indexOf('kid') !== 0) return B;
      LS.set('kidBadgesSeen', JSON.stringify(seen.concat(fresh.map(function (b) { return b.id; }))));
      var top = fresh[fresh.length - 1];
      confetti();
      sheet(first ? '\uD83C\uDF89 You\u2019ve got badges!' : '\uD83C\uDF89 New badge!', '<div class="badgeBig">' + top.icon + '</div><p class="center"><b style="font-size:22px">' + esc(first ? got.length + ' badges already!' : top.name) + '</b><br>' + esc(first ? 'Look at all the stuff you\u2019ve collected!' : top.desc) +
        (!first && fresh.length > 1 ? '<br><small>\u2026and ' + (fresh.length - 1) + ' more!</small>' : '') + '</p>', [{ label: '\uD83C\uDFC6 See my badges', value: 'wall', cls: 'main' }, { label: 'Yay!', value: 'ok' }]).then(function (v) { if (v === 'wall') go('kidBadges'); });
      return B;
    });
  }
  function badgeTile(b) {
    return '<div class="badge tier-' + esc(b.tier || 'bronze') + (b.got ? ' got' : '') + '"><span class="bTier">' + esc(BADGE_TIER_NAME[b.tier] || b.tier) + '</span><span class="bIc">' + b.icon + '</span><b>' + esc(b.name) + '</b><small>' + esc(b.desc) + '</small>' +
      (b.got ? '<em>\u2705 Got it!</em>' : '<span class="bBar"><i style="width:' + Math.round(100 * b.have / b.need) + '%"></i></span><em>' + b.have + ' / ' + b.need + '</em>') + '</div>';
  }
  SCREENS.kidBadges = function () {
    busy('Polishing your badges\u2026');
    recordBadgeVisit();
    loadBoot().then(checkNewBadges).then(function (B) {
      done();
      var gotN = B.filter(function (b) { return b.got; }).length;
      var h = '<h1>\uD83C\uDFC6 My badges</h1><div class="card yel center badgeSum"><b style="font-size:26px">' + gotN + ' / ' + B.length + '</b> badges<br><small>' + (B.length - gotN) + ' still to get \u2014 keep collecting, snapping and hunting!</small></div>';
      BADGE_TIER_ORDER.forEach(function (tier) {
        var rows = B.filter(function (b) { return b.tier === tier; });
        if (!rows.length) return;
        var g = rows.filter(function (b) { return b.got; }).length;
        h += '<h2 class="badgeTier"><span class="tPip ' + tier + '"></span>' + esc(BADGE_TIER_NAME[tier]) + ' <span class="wantN">(' + g + '/' + rows.length + ')</span></h2>';
        h += '<div class="badgeWall">' + rows.map(badgeTile).join('') + '</div>';
      });
      setMain(h);
    }).catch(oops);
  };
  function badgeTierOptions(cur) {
    return BADGE_TIER_ORDER.map(function (t) {
      return '<option value="' + t + '"' + (t === cur ? ' selected' : '') + '>' + BADGE_TIER_NAME[t] + '</option>';
    }).join('');
  }
  function badgeEditorRow(def, earned) {
    var custom = !!def.custom;
    return '<div class="rwItem bdgRow" data-id="' + esc(def.id) + '" data-custom="' + (custom ? '1' : '0') + '">' +
      (custom ? '<p class="rwEditHead">Custom badge</p>' : '<p class="rwEditHead">' + esc(BADGE_TIER_NAME[def.tier] || def.tier) + '</p>') +
      '<label class="field">Emoji <input type="text" class="bdgEmoji" maxlength="8" value="' + esc(def.emoji || '') + '"></label>' +
      '<label class="field">Name <input type="text" class="bdgName" maxlength="40" value="' + esc(def.name || '') + '"></label>' +
      '<label class="field">Tier <select class="bdgTier">' + badgeTierOptions(def.tier || 'bronze') + '</select></label>' +
      '<label class="field">Goal <input type="text" class="bdgGoal" maxlength="120" value="' + esc(def.goal || '') + '"></label>' +
      '<label class="rwOnRow"><input type="checkbox" class="bdgOn"' + (earned ? ' checked' : '') + '> Earned</label>' +
      (custom ? '<p><button type="button" class="btn small" data-act="bdgRemove" data-id="' + esc(def.id) + '">Remove</button></p>' : '') +
      '</div>';
  }
  SCREENS.badgeEdit = function () {
    if (!isPriv() || !showKidFeatures()) { go('home', {}, true); return; }
    busy('Loading badges\u2026');
    Promise.all([loadBoot().catch(function () { return null; }), loadRewards().catch(function () { return null; })]).then(function (res) {
      done();
      var B = computeBadges(res[0], res[1]);
      var got = {};
      B.forEach(function (b) { got[b.id] = b.got; });
      var rows = allBadgeDefs().map(function (d) { return badgeEditorRow(d, !!got[d.id]); }).join('');
      setMain(backBtn() + '<h1>\uD83C\uDFC6 ' + esc(KID_ROLE) + '\u2019s badges</h1>' +
        '<p class="hint">There are 50 ready-made badges, with two easy Bronze ones already earned. Add more any time. Changes save on this phone.</p>' +
        '<div class="rwList bdgEdit" id="bdgEdit">' + rows + '</div>' +
        '<p><button type="button" class="rwAdd" data-act="bdgAdd">+ Add badge</button></p>' +
        '<p class="center"><button class="btn main" data-act="bdgSave" id="bdgSaveBtn">Save</button></p>');
    }).catch(oops);
  };
  function addBadgeRow() {
    var box = $('bdgEdit'); if (!box) return;
    var id = 'custom-' + Date.now();
    var el = document.createElement('div');
    el.innerHTML = badgeEditorRow({ id: id, custom: true, emoji: '\uD83C\uDFC6', name: '', tier: 'bronze', goal: '', rule: { type: 'manual' } }, false);
    box.appendChild(el.firstChild);
    var btn = $('bdgSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); }
  }
  function saveBadgesUI() {
    var book = badgeBook();
    if (!book.baseline) book = ensureBadgeBaseline(currentBadgeStats(null));
    book.override = book.override || {};
    book.earned = book.earned || {};
    var custom = [], bad = '';
    document.querySelectorAll('#bdgEdit .bdgRow').forEach(function (el) {
      var id = el.getAttribute('data-id') || '';
      var name = ((el.querySelector('.bdgName') || {}).value || '').replace(/\s+/g, ' ').trim();
      var emoji = ((el.querySelector('.bdgEmoji') || {}).value || '').trim() || '\uD83C\uDFC6';
      var tier = ((el.querySelector('.bdgTier') || {}).value || 'bronze');
      if (BADGE_TIER_ORDER.indexOf(tier) < 0) tier = 'bronze';
      var goal = ((el.querySelector('.bdgGoal') || {}).value || '').replace(/\s+/g, ' ').trim();
      var on = !!(el.querySelector('.bdgOn') && el.querySelector('.bdgOn').checked);
      var isCustom = el.getAttribute('data-custom') === '1';
      if (isCustom && !name) { bad = 'Give each new badge a name.'; return; }
      if (isCustom) custom.push({ id: id, custom: true, emoji: emoji, name: name, tier: tier, goal: goal || '' + OWN + ' added this one.', rule: { type: 'manual' } });
      else {
        var def = null;
        BADGE_CATALOG.forEach(function (d) { if (d.id === id) def = d; });
        if (def) { def._tmp = 1; }
        book.override[id] = on ? 1 : 0;
        if (on) book.earned[id] = 1; else delete book.earned[id];
      }
      if (isCustom) {
        book.override[id] = on ? 1 : 0;
        if (on) book.earned[id] = 1; else delete book.earned[id];
      }
    });
    if (bad) { toast(bad, 'oops'); return; }
    book.custom = custom;
    saveBadgeBook(book);
    var seen = badgesSeen() || [];
    Object.keys(book.earned).forEach(function (id) { if (book.earned[id] && seen.indexOf(id) < 0) seen.push(id); });
    LS.set('kidBadgesSeen', JSON.stringify(seen));
    var btn = $('bdgSaveBtn');
    if (btn) { btn.textContent = 'Saved \u2713'; btn.classList.add('saved'); }
    toast('Saved \u2713', 'good');
  }

  function confetti() {
    try { if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch (e) { /* ignore */ }
    var c = document.createElement('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
    c.className = 'confetti'; c.width = W * dpr; c.height = H * dpr; document.body.appendChild(c);
    var g = c.getContext('2d'); g.scale(dpr, dpr);
    var cols = ['#FFD90F', '#F4A0B5', '#7BD389', '#70C8EA', '#FFB347', '#E4572E', '#ffffff'], P = [];
    for (var i = 0; i < 170; i++) P.push({ x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 4, r: Math.random() * 6 + 4, a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length] });
    var t0 = performance.now();
    (function frame(t) {
      var el = t - t0; g.clearRect(0, 0, W, H);
      P.forEach(function (p) { p.vy += 0.45; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va; g.save(); g.translate(p.x, p.y); g.rotate(p.a); g.fillStyle = p.c; g.globalAlpha = Math.max(0, 1 - el / 3200); g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore(); });
      if (el < 3200) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }

  function markSale(key, name) {
    confirmSheet('Mark for sale?', '<b>' + esc(name) + '</b> stays in the sheet (nothing is deleted). Its status just changes to For sale.', 'Yes, for sale', 'Not now').then(function (ok) {
      if (!ok) return;
      busy('Saving\u2026');
      return call('saveItem', key, name, { status: 'For sale' }, S.role).then(function () { done(); S.boot = null; toast('\u2705 Marked for sale', 'good'); go('spares', {}, true); });
    }).catch(oops);
  }

  /* ---------------- Missing (all checklists) ---------------- */
  SCREENS.missing = function () {
    busy('Gathering everything still missing\u2026');
    call('getAllMissing').then(function (rows) {
      done();
      S.missingRows = rows;
      var sets = {}; rows.forEach(function (r) { sets[r.set] = (sets[r.set] || 0) + 1; });
      var h = backBtn() + '<h1>\uD83E\uDDE9 Missing list</h1><p class="hint">' + rows.length + ' still needed across ' + Object.keys(sets).length + ' checklists.</p>' +
        '<div class="search"><input id="misSearch" type="search" placeholder="\uD83D\uDD0D Search the missing list" aria-label="Search missing" value="' + esc(S.misQ || '') + '"></div>' +
        '<select id="misSet" aria-label="Checklist">' + opt(Object.keys(sets).sort().map(function (k) { return [k, k + ' (' + sets[k] + ')']; }), S.misSet || '', 'All checklists') + '</select>' +
        '<div id="misList" class="list" style="margin-top:10px"></div>';
      setMain(h);
      var draw = function () {
        var q = norm(S.misQ || ''), st = S.misSet || '';
        var list = rows.filter(function (r) { return (!st || r.set === st) && (!q || norm(r.name + ' ' + r.number + ' ' + r.set).indexOf(q) >= 0); });
        $('misList').innerHTML = list.length ? list.slice(0, 300).map(function (r, i) {
          return '<div class="li"><div class="grow">' + esc(r.name) + '<small>' + esc([r.set, r.number, r.year].filter(Boolean).join(' \u00B7 ')) + '</small></div>' +
            (/loose|\?/i.test(r.owned) ? '<span class="pill amber">' + esc(r.owned) + '</span>' : '<button class="btn green small" data-act="gotMissing" data-i="' + rows.indexOf(r) + '">Got it</button>') + '</div>';
        }).join('') : '<div class="nudge">Nothing missing there. \uD83C\uDF89</div>';
      };
      var t = null;
      $('misSearch').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { S.misQ = e.target.value; draw(); }, 200); });
      $('misSet').addEventListener('change', function (e) { S.misSet = e.target.value; draw(); });
      draw();
    }).catch(oops);
  };
  function gotMissing(i) {
    var r = (S.missingRows || [])[i]; if (!r) return;
    confirmSheet('Tick it off?', 'Mark <b>' + esc(r.name) + '</b> as got on the ' + esc(r.set) + ' checklist?', 'Yes, tick it', 'Not yet').then(function (ok) {
      if (!ok) return;
      busy('Ticking it off\u2026');
      return call('markGotIt', 'checklist', r.tab + '|' + r.row, r.name, S.role).then(function () {
        done(); S.boot = null; toast('\u2705 Ticked off!', 'good');
        return confirmSheet('Add it to the collection?', 'Want to add <b>' + esc(r.name) + '</b> to the collection now with a photo?', 'Yes, add it', 'Later').then(function (add) {
          if (add) { S.add = { step: 1, shots: [], name: r.name, range: r.set, condition: '', more: {} }; go('add'); }
          else go('missing', {}, true);
        });
      });
    }).catch(oops);
  }

  /* ---------------- Export ---------------- */
  SCREENS.export = function (p) {
    loadBoot().then(function () {
      var filtered = p && p.tab === 'filtered' && S.lastList ? S.lastList : null;
      S.exportKeys = filtered ? filtered.map(function (it) { return it.key; }) : null;
      var n = filtered ? filtered.length : S.items.length;
      var h = backBtn() + '<h1>\uD83D\uDCE4 Export</h1><div class="card skyL"><p>Exporting <b>' + n + ' item' + (n === 1 ? '' : 's') + '</b>' + (filtered ? ' (what you filtered in Collection)' : ' (the whole collection)') + '.</p>' +
        (filtered ? '<button class="btn small" data-act="go" data-to="export">Use the whole collection instead</button>' : '<p class="hint">Tip: filter in Collection first, then tap \u201CExport these\u201D to export just those.</p>') +
        (isPriv() ? '<p class="hint">\uD83D\uDD12 Includes paid and value because you\u2019re ' + esc(PRIV) + '.</p>' : '<p class="hint">Prices are left out.</p>') + '</div>' +
        '<div class="stack"><button class="btn main full" data-act="doExport" data-k="csv">\uD83D\uDCC4 Spreadsheet file (CSV)</button>' +
        '<button class="btn full" data-act="doExport" data-k="pdf">\uD83D\uDDA8\uFE0F PDF list</button>' +
        '<button class="btn full" data-act="doExport" data-k="pdfPhotos"' + (n > 120 ? ' disabled' : '') + '>\uD83D\uDDBC\uFE0F PDF with photos' + (n > 120 ? ' (filter to 120 or fewer)' : '') + '</button></div>' +
        '<div id="exportResult"></div>';
      setMain(h);
    }).catch(oops);
  };
  function doExport(kind) {
    var title = THEME.shortName + (S.exportKeys ? ' (filtered)' : ' collection');
    busy(kind === 'pdfPhotos' ? 'Making the PDF with photos - this can take a minute\u2026' : 'Making your file\u2026');
    var pr = kind === 'csv' ? call('exportCsv', S.role, S.exportKeys, title) : call('exportPdf', S.role, S.exportKeys, title, kind === 'pdfPhotos');
    pr.then(function (r) {
      done();
      $('exportResult').innerHTML = '<div class="card yel"><h3>\u2705 Saved to Drive</h3><p>' + esc(r.name) + ' (' + r.count + ' items)</p><a class="btn main full" href="' + esc(r.url) + '" target="_blank" rel="noopener">Open it \u2197</a></div>';
    }).catch(oops);
  }

  /* ---------------- events ---------------- */
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('[data-tab]');
    if (tab) { if (tab.getAttribute('data-tab') === 'scan') { openScanner({}); return; } S.history = []; var to = tab.getAttribute('data-tab'); if (to === 'add') layerPush(); go(to, {}, true); return; }
    var el = e.target.closest('[data-act]'); if (!el) return;
    var a = el.getAttribute('data-act'), key = el.getAttribute('data-key');
    switch (a) {
      case 'back': layerBack(); break;
      case 'go': if (el.getAttribute('data-to') === 'guide') { go('guide', { i: 0 }); break; } go(el.getAttribute('data-to'), { tab: el.getAttribute('data-tab') }); break;
      case 'refresh': S.boot = null; thumbsRefresh(); go(S.screen, S.params, true); break;
      case 'thumbRetry': retryThumb(el.getAttribute('data-fid2')); break;
      case 'shareFind': shareFind(); break;
      case 'priceCheck': if ($('priceSlot') && S.current) $('priceSlot').innerHTML = $('priceSlot').innerHTML ? '' : priceBoxHtml(S.current); break;
      case 'histFilter': S.histFilter = el.getAttribute('data-v'); S.histShown = 150; go('history', {}, true); break;
      case 'histMore': S.histShown = (S.histShown || 150) + 150; go('history', {}, true); break;
      case 'guideNext': var i = +el.getAttribute('data-i'); if (i >= (S.guideCount || 5)) { LS.set('seenGuide', '1'); if (!LS.get('tourDone')) LS.set('tourPending', '1'); go(S.role ? 'home' : 'who', {}, true); } else go('guide', { i: i }, true); break;
      case 'guideSkip': LS.set('seenGuide', '1'); if (!LS.get('tourDone')) LS.set('tourPending', '1'); go(S.role ? 'home' : 'who', {}, true); break;
      case 'pickRole':
        var role = el.getAttribute('data-role');
        if (roleKind(role) === 'Kid') { enterKid(); break; }
        if (role === PRIV && THEME.needsPin && !dadUnlocked()) askDadPin(role);
        else enterRole(role);
        break;
      case 'pinDigit':
        if (S.pinBusy || (S.pinDigits || '').length >= 4) break;
        S.pinError = '';
        S.pinDigits = (S.pinDigits || '') + el.getAttribute('data-d');
        go('pin', {}, true);
        if (S.pinDigits.length === 4) setTimeout(submitDadPin, 80);
        break;
      case 'pinDel':
        if (S.pinBusy) break;
        S.pinError = '';
        S.pinDigits = (S.pinDigits || '').slice(0, -1);
        go('pin', {}, true);
        break;
      case 'pinCancel': S.pendingRole = ''; S.pinDigits = ''; S.pinError = ''; if (S.afterPin) { var ap2 = S.afterPin; S.afterPin = null; go(ap2[0], ap2[1], true); break; } if (S.kidExit) { S.kidExit = false; go('kid', {}, true); break; } go('who', {}, true); break;
      case 'lockPriv': lockDadView(); break;
      case 'item': $('sheet').hidden = true; if (key && key.indexOf('pending:') === 0) { toast('That one is waiting to sync - it\u2019ll open once you\u2019re back online.'); break; } go('item', { key: key }); break;
      case 'more': S.shown += 60; if (S.redrawGrid) S.redrawGrid(); break;
      case 'clearFilters': S.filters = { q: '', range: '', series: '', status: '', cond: '', posted: '', photos: '', sort: 'newest' }; go('collection', {}, true); break;
      case 'snapFor': var it = itemByKey(key) || { key: key, name: '' }; openCamera({ key: key, name: it.name }); break;
      case 'valueFor': S.current = null; busy('Opening\u2026'); call('getItem', key, S.role).then(function (x) { done(); S.current = x; go('edit', { focus: 'value' }); }).catch(oops); break;
      case 'snapCurrent': openCamera({ key: S.current.key, name: S.current.name }); break;
      case 'pickCurrent': openCamera({ key: S.current.key, name: S.current.name }, 'gallery'); break;
      case 'videoCurrent': openCamera({ key: S.current.key, name: S.current.name }, 'video'); break;
      case 'findCheapest': findCheapest(+el.getAttribute('data-i')); break;
      case 'edit': go('edit', {}); break;
      case 'removeItem': removeItemUI(); break;
      case 'addDoc': addDocumentUI(); break;
      case 'removeDoc': removeDocumentUI(el.getAttribute('data-id'), el.getAttribute('data-name')); break;
      case 'assignDropDoc': assignDropDocUI(el); break;
      case 'restoreItem': restoreItemUI(el.getAttribute('data-key'), el.getAttribute('data-name')); break;
      case 'cfAdd': cfAdd(); break;
      case 'cfEdit': cfEdit(+el.getAttribute('data-i')); break;
      case 'cfPhoto': cfPhoto(+el.getAttribute('data-i')); break;
      case 'cfManage': cfManage(); break;
      case 'cfRename': cfRename(+el.getAttribute('data-k')); break;
      case 'cfRemove': cfRemove(+el.getAttribute('data-k')); break;
      case 'cfRestore': cfRestore(+el.getAttribute('data-k')); break;
      case 'logAdd': logAdd(+el.getAttribute('data-i')); break;
      case 'logOpen': logOpen(+el.getAttribute('data-i'), +el.getAttribute('data-j')); break;
      case 'logAll': S.cfAll = ((S.current || {}).cf || [])[+el.getAttribute('data-i')] ? S.current.cf[+el.getAttribute('data-i')].name : ''; go('item', { key: S.current.key }, true); break;
      case 'saveEdit': saveEdit(); break;
      case 'gotItem':
        confirmSheet('Got it? \uD83C\uDF89', 'Mark <b>' + esc(S.current.name) + '</b> as Owned?', 'Yes, got it!', 'Not yet').then(function (ok) {
          if (!ok) return; busy('Saving\u2026');
          return call('markGotIt', 'item', S.current.key, S.current.name, S.role).then(function (r) { done(); S.boot = null; pointsNote(r, '\u2705 It\u2019s officially ours!'); go('item', S.params, true); });
        }).catch(oops); break;
      case 'addSnap': openCamera({ mode: 'add' }); break;
      case 'addPick': openCamera({ mode: 'add' }, true); break;
      case 'addClearShots': addState().shots = []; go('add', {}, true); break;
      case 'addNext': addNext(); break;
      case 'addBack': layerBack(); break;
      case 'addRange': addState().range = el.getAttribute('data-v'); addState().step = 4; layerPush(); go('add', {}, true); break;
      case 'addCond': addState().condition = el.getAttribute('data-v'); document.querySelectorAll('[data-act=addCond]').forEach(function (b) { b.classList.toggle('sel', b === el); });
        var sv = document.querySelector('[data-act=addSave]'); if (sv) sv.disabled = false;
        var chk = document.querySelector('.warn i'); if (chk) chk.outerHTML = esc(addState().condition); break;
      case 'addSave': addSave(); break;
      case 'gotWanted': gotWanted(+el.getAttribute('data-i')); break;
      case 'gotCl': gotCl(+el.getAttribute('data-row')); break;
      case 'clMode': go('checklist', { tab: S.params.tab, all: el.getAttribute('data-all') }, true); break;
      case 'toggleFilters': S.filtersOpen = !($('filterBox') && !$('filterBox').hidden); go('collection', {}, true); break;
      case 'openPhoto': openPhoto(+el.getAttribute('data-i')); break;
      case 'closePhoto': layerBack(); break;
      case 'heroOpen': if (S.gallery && S.gallery.length) openPhoto(0); break;
      case 'makeMain':
        var ph = S.gallery[+el.getAttribute('data-i')]; busy('Making it the main photo\u2026');
        call('setMainPhoto', S.current.key, S.current.name, ph.id).then(function () { done(); $('lightbox').hidden = true; layerDrop(); if (S.current.folderId) forgetThumb(S.current.folderId); toast('\u2B50 That\u2019s the main photo now', 'good'); go('item', S.params, true); }).catch(oops); break;
      case 'replaceMain': openCamera({ key: S.current.key, name: S.current.name, makeMain: true }); break;
      case 'togglePosted': togglePosted(el.getAttribute('data-p')); break;
      case 'postedMode': S.postedMode = el.getAttribute('data-v'); S.shownPosted = 60; go('posted', {}, true); break;
      case 'morePosted': S.shownPosted = (S.shownPosted || 60) + 60; go('posted', {}, true); break;
      case 'markSale': markSale(key, el.getAttribute('data-name')); break;
      case 'gotMissing': gotMissing(+el.getAttribute('data-i')); break;
      case 'doExport': doExport(el.getAttribute('data-k')); break;
      case 'startTour': LS.set('tourPending', '1'); go('home', {}, true); break;
      case 'tourNext': startTour(+el.getAttribute('data-i')); break;
      case 'tourSkip': if (NAV.pushed > 0) layerBack(); else closeTour(); toast('No problem - the tour is under More \u2192 Help.'); break;
      case 'scan': bumpKid('kidScans'); openScanner({}); break;
      case 'scanAssign': openScanner({ assign: { key: S.current.key, name: S.current.name } }); break;
      case 'scanClose': if (NAV.pushed > 0) layerBack(); else stopScanner(); break;
      case 'scanType': typeCode(); break;
      case 'scanPhoto': $('scanInput').value = ''; $('scanInput').click(); break;
      case 'bcAssign':
        var bi = itemByKey(key); if (!bi) break; $('sheet').hidden = true;
        saveBarcodeTo(bi.key, bi.name, S.lastCode); break;
      case 'bcAddNew':
        $('sheet').hidden = true; S.add = { step: 1, shots: [], name: '', range: '', condition: '', more: {}, barcode: S.lastCode }; go('add'); break;
      case 'syncNow': syncQueue(); break;
      case 'letterOpen': showDadLetter(true); break;
      case 'letterGo': if (NAV.pushed > 0) layerBack(); else hideDadLetter(); break;
      case 'notesOpen': go('kidNotes'); break;
      case 'wantToggle': wantToggle(el.getAttribute('data-gid')); break;
      case 'wantCollapseAll': wantCollapseAll(true); break;
      case 'wantExpandAll': wantCollapseAll(false); break;
      case 'wantInfo': wantedInfoSheet(+el.getAttribute('data-i'), el.getAttribute('data-src') === 'kid' ? S.kidWanted : S.wantedList); break;
      case 'funPrev': cycleFunWorth(-1); break;
      case 'funNext': cycleFunWorth(1); break;
      case 'jokeNext': showNextJoke(); break;
      case 'noteOpen': showDadNote(el.getAttribute('data-i')); break;
      case 'noteGo': if (NOTE_UI.fromPointer && Date.now() - NOTE_UI.fromPointer < 500) break; onNoteGo(); break;
      case 'noteSkip': thanksDadNote(); break;
      case 'rwAsk': askReward(el.getAttribute('data-id')); break;
      case 'rwYes': decideRewardUI(el.getAttribute('data-id'), true); break;
      case 'rwNo': decideRewardUI(el.getAttribute('data-id'), false); break;
      case 'rwPhotoYes': decidePhotoUI(el.getAttribute('data-id'), true, !!(el.closest('.rwItem') && el.closest('.rwItem').querySelector('.qMain') && el.closest('.rwItem').querySelector('.qMain').checked)); break;
      case 'rwPhotoNo': decidePhotoUI(el.getAttribute('data-id'), false, false); break;
      case 'rwSave': saveRewardsUI(); break;
      case 'funAdd': addFunRow(); break;
      case 'rwAdd': addRewardRow(); break;
      case 'jobAdd': addJobRow(); break;
      case 'jobDone': completeJobUI(el.getAttribute('data-id')); break;
      case 'bdgAdd': addBadgeRow(); break;
      case 'bdgSave': saveBadgesUI(); break;
      case 'bdgRemove': (function () { var row = el.closest && el.closest('.bdgRow'); if (row && row.parentNode) row.parentNode.removeChild(row); var btn = $('bdgSaveBtn'); if (btn) { btn.textContent = 'Save'; btn.classList.remove('saved'); } })(); break;
      case 'addScan': keepAddName(); openScanner({ add: true }); break;
      case 'addTypeBc': keepAddName(); SCAN.opts = { add: true }; typeCode(); break;
      case 'addClearBc': var A0 = addState(); A0.barcode = ''; A0.bcLook = undefined; A0.bcRef = ''; go('add', {}, true); break;
      case 'kidEnter': enterKid(); break;
      case 'removeExamples': removeExamplesUI(); break;
      case 'kidExit': exitKid(); break;
      case 'kidItem': $('sheet').hidden = true; go('kidItem', { key: key }); break;
      case 'kidMore': S.kidShown = (S.kidShown || 40) + 40; if (S.redrawKid) S.redrawKid(); break;
      case 'kidSnap': if (S.current) openCamera({ key: S.current.key, name: S.current.name }); break;
      case 'kidGot': kidGot(+el.getAttribute('data-i')); break;
      case 'kidNew': S.add = null; go('add'); break;
      case 'mission': runMission(el.getAttribute('data-kind') || ''); break;
      case 'earnGo': runEarnJob(el.getAttribute('data-kind') || ''); break;
      case 'kidGotItem':
        confirmSheet('We got it? \uD83C\uDF89', 'Mark <b>' + esc(S.current.name) + '</b> as ours?', 'Yes!', 'Not yet').then(function (ok) {
          if (!ok) return; busy('Saving\u2026');
          return call('markGotIt', 'item', S.current.key, S.current.name, KID_ROLE).then(function (r) { done(); bumpKid('kidFound'); S.current.status = 'Owned'; S.boot = null; pointsNote(r, '\uD83C\uDF89 It\u2019s ours!'); go('kidItem', S.params, true); });
        }).catch(oops); break;
    }
  });
  $('stuckBtn').addEventListener('click', function () {
    if (!S.kid) return showHelp();
    sheet('How it works', '<ul><li>\uD83E\uDDF8 <b>Our stuff</b>: tap anything to see it big or add a photo.</li><li>\u2B50 <b>Hunt</b>: things we\u2019re looking for. Found one? Tap \u201CFound it!\u201D</li><li>\uD83D\uDCF7 <b>Scan</b>: point at a box\u2019s barcode to see if we\u2019ve got it.</li>' + (hasLetter() ? '<li>\u2709\uFE0F <b>Letter from ' + OWN + '</b>: it pops up every now and then, and you can open it again any time.</li>' : '') + '<li>\uD83D\uDCDD <b>Notes for you</b>: a little note every few visits, and all of them under Notes for you.</li><li>\uD83D\uDE04 <b>A daft joke</b>: a new one when you open this mode. Tap it for another.</li><li>\uD83C\uDF66 <b>What\u2019s our collection worth?</b>: swipe or tap to try ice creams, pizzas, cakes and things from your collection.</li><li>\u2B50 <b>My points</b>: earn points and ask ' + OWN + ' for rewards.</li><li>\uD83E\uDDF9 <b>Jobs</b>: jobs from ' + OWN + ', like tidy your room. When ' + OWN + ' taps Done you get the points.</li><li>No faces in photos - hands are fine.</li></ul>',
      [{ label: '\u21BB Refresh', value: 'refresh' }, { label: 'Got it!', value: 'ok', cls: 'main' }]).then(function (v) { if (v === 'refresh') { S.boot = null; thumbsRefresh(); go(S.screen || 'kid', S.params, true); } });
  });
  $('homeBtn').addEventListener('click', function () { if (S.kid) { S.history = []; go('kid', {}, true); return; } if (S.role) { S.history = []; go(S.screen === 'home' ? 'settings' : 'home', {}, true); } });
  $('camInput').addEventListener('change', onFiles);
  $('pickInput').addEventListener('change', onFiles);
  if ($('vidInput')) $('vidInput').addEventListener('change', onFiles);
  if ($('docInput')) $('docInput').addEventListener('change', onDocFile);
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) { /* tap outside: ignore so nothing is chosen by accident */ } });

  /* ---------------- start ---------------- */
  loadSavedThumbs();
  IDB.qAll().then(function (q) { NET.queueLen = q.length; renderNetBar(); if (q.length && navigator.onLine !== false) syncQueue(); }, noop);
  if (S.kid && !showKidFeatures()) { S.kid = false; LS.del('kidMode'); }
  if (S.kid) { S.role = KID_ROLE; S.kidGreeting = true; pickFunUnitRandom(); pickJokeOnOpen(); go('kid', {}, true); }
  else if (!LS.get('seenGuide')) go('guide', { i: 0 }, true);
  else if (!S.role || (isSolo() && S.role !== PRIV)) go('who', {}, true);
  else if (S.role === PRIV && THEME.needsPin && !dadUnlocked()) askDadPin(S.role);
  else go('home', {}, true);
})();
