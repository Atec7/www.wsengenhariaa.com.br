/* WS Data — cache por navegador + sync seletivo (só o que mudou) + refresh com botão */
(function () {
  if (window.WS_DATA) { return; }
  var DB = null;                  // adapter fb
  var TS = null;                  // ServerValue.TIMESTAMP
  var REG = {};                   // path -> {target, key, tsKey}
  var ONUPD = null;               // callback de re-render
  var CACHE = {};                 // espelho em memória do cache
  var MEMDB = null;               // instancia idb
  var IDB_NAME = 'ws_cache';
  var IDB_STORE = 'nodes';
  var LS_PREFIX = 'ws_cache_v1_';
  var FRESH_MS = 60000;           // janela onde não checa rede ao reabrir
  var LAST_REFRESH = 0;

  /* ── medição de tráfego (para saber quanto cada nó custa) ── */
  var STATS = { down: {}, up: {}, nDown: 0, nUp: 0, nPullFull: 0, nPullInc: 0 };
  function approxBytes(v) {
    if (v == null) { return 0; }
    if (typeof v === 'string') { return v.length; }
    try { return JSON.stringify(v).length; } catch (e) { return 0; }
  }
  function statDown(path, bytes, full) {
    bytes = bytes || 0;
    if (!STATS.down[path]) { STATS.down[path] = { bytes: 0, pulls: 0 }; }
    STATS.down[path].bytes += bytes;
    STATS.down[path].pulls++;
    STATS.nDown++;
    if (full) { STATS.nPullFull++; }
    return bytes;
  }
  function statUp(path, bytes) {
    bytes = bytes || 0;
    if (!STATS.up[path]) { STATS.up[path] = { bytes: 0, writes: 0 }; }
    STATS.up[path].bytes += bytes;
    STATS.up[path].writes++;
    STATS.nUp++;
  }
  function statReset() { STATS = { down: {}, up: {}, nDown: 0, nUp: 0, nPullFull: 0, nPullInc: 0 }; }

  // inspeção do cache em disco: serve para o painel e para depurar por que uma
  // página não está enxergando um registro novo.
  function dbg(path) {
    if (!path) { return Promise.resolve({}); }
    return getCache(path);
  }

  /* ── IndexedDB ── */
  function idbOpen() {
    if (MEMDB) { return Promise.resolve(MEMDB); }
    if (typeof indexedDB === 'undefined') { return Promise.reject(new Error('no-idb')); }
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) { d.createObjectStore(IDB_STORE); }
      };
      rq.onsuccess = function (e) { MEMDB = e.target.result; res(MEMDB); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbGet(path) {
    return idbOpen().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(IDB_STORE, 'readonly');
        var rq = tx.objectStore(IDB_STORE).get(path);
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbPut(path, rec) {
    return idbOpen().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(rec, path);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbDel(path) {
    return idbOpen().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(path);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function getCache(path) {
    if (CACHE[path]) { return Promise.resolve(CACHE[path]); }
    var fallback = function () {
      try {
        var s = localStorage.getItem(LS_PREFIX + path);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    };
    return idbGet(path).then(function (r) {
      CACHE[path] = r || fallback();
      return CACHE[path];
    }).catch(function () {
      CACHE[path] = fallback();
      return CACHE[path];
    });
  }
  function putCache(path, rec) {
    CACHE[path] = rec;
    idbPut(path, rec).catch(function () {});
    try { localStorage.setItem(LS_PREFIX + path, JSON.stringify(rec)); } catch (e) {}
  }
  function delCache(path) {
    if (CACHE[path]) { delete CACHE[path]; }
    idbDel(path).catch(function () {});
    try { localStorage.removeItem(LS_PREFIX + path); } catch (e) {}
  }

  /* ── interface com o Firebase ── */
  var PERSIST_P = null;            // promessa da persistencia (uma vez so)
  var PERSIST_STATE = 'nao-chamado';

  // Sem isto, toda partida a frio (aparelho novo, storage limpo, aba anonima)
  // baixa os nos inteiros. Com o cache em disco, o SDK passa a responder pela
  // diferenca e baixa so o que mudou.
  function enablePersistencia(dbCompat) {
    if (PERSIST_P) { return PERSIST_P; }
    if (!dbCompat || typeof dbCompat.enablePersistence !== 'function') {
      PERSIST_STATE = 'indisponivel';
      PERSIST_P = Promise.resolve(PERSIST_STATE);
      return PERSIST_P;
    }
    PERSIST_STATE = 'ligando';
    PERSIST_P = Promise.resolve()
      .then(function () {
        return dbCompat.enablePersistence(['indexedDB', 'localstorage']);
      })
      .then(function () { PERSIST_STATE = 'ativo'; return PERSIST_STATE; })
      .catch(function (e) {
        // 'failed-precondition' = outra aba ja esta com o cache maior. Nao e
        // erro fatal: a tela funciona, so que com cache reduzido.
        var code = e && e.code ? e.code : String(e);
        PERSIST_STATE = (code.indexOf('failed-precondition') === 0) ? 'reduzido' : 'falhou:' + code;
        return PERSIST_STATE;
      });
    return PERSIST_P;
  }

  function useDb(compatDb, opts) {
    enablePersistencia(compatDb);
    return useAdapter({
      once: function (p) { return compatDb.ref(p).once('value'); },
      set: function (p, v) { return compatDb.ref(p).set(v); },
      update: function (p, v) { return compatDb.ref(p).update(v); },
      remove: function (p) { return compatDb.ref(p).remove(); },
      push: function (p, v) { var r = compatDb.ref(p).push(v); return { key: r.key }; },
      orderBy: function (p, child, start, limit) {
        var q = compatDb.ref(p).orderByChild(child).startAt(start);
        if (limit) { q = q.limitToLast(limit); }
        return q.once('value');
      }
    }, opts);
  }
  function useAdapter(adapter, opts) {
    DB = adapter;
    TS = (opts && opts.timestamp) || firebase.database.ServerValue.TIMESTAMP;
  }
  function refOf(p) { return p; }

  /* ── meta ── */
  function bump(node) {
    if (!DB) { return Promise.resolve(null); }
    return DB.set('_meta/' + node, TS).then(function () {
      return DB.once('_meta/' + node).then(function (snap) { return snap.val(); });
    }).catch(function () { return null; });
  }

  /* ── normalização (igual aos apps) ── */
  function normalizeVal(v, k) {
    if (v && typeof v === 'object' && v.id === undefined) { return Object.assign({}, v, { id: k }); }
    return v;
  }
  function fromSnapshot(snap) {
    var raw = snap.val() || {};
    var norm = {};
    Object.keys(raw).forEach(function (k) { norm[k] = normalizeVal(raw[k], k); });
    return norm;
  }
  function maxTs(map, tsKey) {
    if (!tsKey) { return null; }
    var m = null;
    Object.keys(map).forEach(function (k) {
      var v = map[k];
      if (v && v[tsKey] != null) {
        var t = v[tsKey];
        if (m === null || t > m) { m = t; }
      }
    });
    return m;
  }
  function clone(obj) {
    if (!obj) { return {}; }
    return JSON.parse(JSON.stringify(obj));
  }
  function slotOf(entry) {
    if (!entry) { return null; }
    var t = entry.target;
    if (entry.key) { t[entry.key] = t[entry.key] || {}; return t[entry.key]; }
    return t || {};
  }

  /* ── pull único (nó inteiro) ── */
  function pullFull(path, entry) {
    var map = slotOf(entry);
    return DB.once(path).then(function (snap) {
      var norm = fromSnapshot(snap);
      statDown(path, approxBytes(norm), true);
      Object.keys(map).forEach(function (k) { delete map[k]; });
      Object.keys(norm).forEach(function (k) { map[k] = norm[k]; });
      return bump(path).then(function (metaTs) {
        var rec = {
          data: clone(map),
          metaTs: (metaTs != null) ? metaTs : Date.now(),
          savedAt: Date.now(),
          tsKey: entry.tsKey || null,
          tsValue: maxTs(map, (entry.tsKey || null))
        };
        putCache(path, rec);
        return { downloaded: true, full: true };
      });
    });
  }

  /* ── pull incremental (só registros novos) ── */
  function pullInc(path, entry) {
    var map = slotOf(entry);
    var tsKey = entry.tsKey;
    return getCache(path).then(function (cache) {
      // Cache gravado com outra tsKey, ou com ts em texto (a antiga
      // dataGeracao), não serve de ponto de partida: startAt() com string num
      // índice numérico volta vazio para sempre, e o resgate por pullFull já
      // foi desligado. Nesses casos é melhor pagar um nó inteiro uma vez e
      // reescrever o cache no formato certo.
      if (cache && cache.tsKey && cache.tsKey !== tsKey) { cache = null; }
      if (cache && cache.tsValue != null &&
          !(typeof cache.tsValue === 'number' && isFinite(cache.tsValue))) { cache = null; }
      if (!cache || !cache.data) { return pullFull(path, entry); }

      var since = (cache.tsValue != null) ? cache.tsValue : 0;
      // +1 porque startAt() é inclusivo: sem isso a leva do limite volta
      // inteira a cada sync (com dataGeracao, o dia inteiro, a cada sync).
      var from = (typeof since === 'number' && isFinite(since)) ? since + 1 : since;
      return DB.orderBy(path, tsKey, from, 2000).then(function (snap) {
        var norm = fromSnapshot(snap);
        var n = Object.keys(norm).length;
        // Nada novo é o caso NORMAL, não um sinal de cache quebrado.
        // Cair em pullFull aqui transformava qualquer registro sem o campo
        // tsKey em download do nó inteiro, repetidamente.
        if (n === 0) {
          if (cache) { cache.savedAt = Date.now(); putCache(path, cache); }
          return { downloaded: false, vazio: true };
        }
        statDown(path, approxBytes(norm), false);
        STATS.nPullInc++;
        Object.keys(norm).forEach(function (k) {
          if (map[k] === undefined || map[k] === null ||
              (map[k] && norm[k] && (map[k][tsKey] === undefined || norm[k][tsKey] >= map[k][tsKey]))) {
            map[k] = norm[k];
          }
        });
        return bump(path).then(function (metaTs) {
          var rec = {
            data: clone(map),
            metaTs: (metaTs != null) ? metaTs : (cache ? cache.metaTs : Date.now()),
            savedAt: Date.now(),
            tsKey: tsKey || null,
            tsValue: maxTs(map, tsKey)
          };
          putCache(path, rec);
          return { downloaded: true, incremental: true, novos: n };
        });
      });
    });
  }
  function needsCacheRefresh(cache, manual) {
    if (!cache || !cache.data) { return true; }
    if (!manual && (Date.now() - cache.savedAt) < FRESH_MS) { return false; }
    return null;
  }

  /* ── sync de um nó (fase 1: cache imediato; fase 2: rede se mudou) ── */
  function syncNode(path, entry, manual) {
    var map = slotOf(entry);
    return getCache(path).then(function (cache) {
      if (cache && cache.data) {
        var cdata = cache.data;
        Object.keys(map).forEach(function (k) { delete map[k]; });
        Object.keys(cdata).forEach(function (k) { map[k] = cdata[k]; });
      }
      var fresh = needsCacheRefresh(cache, manual);
      if (fresh === false) {
        return { shouldPull: false, ok: true };
      }
      if (fresh === true || !cache || !cache.data) {
        return { shouldPull: true, pull: function () { return pullFull(path, entry); } };
      }
      return DB.once('_meta/' + path).then(function (snap) {
        var meta = snap.val();
        if (!meta || meta <= (cache.metaTs || 0)) {
          cache.savedAt = Date.now();
          putCache(path, cache);
          return { shouldPull: false, ok: true };
        }
        if (!entry.tsKey) {
          return { shouldPull: true, pull: function () { return pullFull(path, entry); } };
        }
        // Se a consulta incremental não trouxer nada novo, o _meta observado já
        // está lido e pode ser adiantado no cache local. Sem isso, todo refresh
        // seguinte repetiria a consulta porque _meta continuaria "acima" do cache.
        var pull = function () {
          return pullInc(path, entry).then(function (r) {
            if (r && r.vazio && meta != null) {
              return getCache(path).then(function (c) {
                if (c && meta > (c.metaTs || 0)) {
                  c.metaTs = meta; c.savedAt = Date.now(); putCache(path, c);
                }
                return r;
              });
            }
            return r;
          });
        };
        return { shouldPull: true, pull: pull };
      }).catch(function () {
        return { shouldPull: true, pull: function () { return pullFull(path, entry); } };
      });
    });
  }

  /* ── API pública ── */
  window.WS_DATA = {
    useDb: useDb,
    useAdapter: useAdapter,
    bump: bump,
    advanceLocalMeta: function (node) {
      return getCache(node).then(function (c) {
        return bump(node).then(function (ts) {
          if (c && ts != null) { c.metaTs = ts; c.savedAt = Date.now(); putCache(node, c); }
          return ts;
        }).catch(function () { return null; });
      });
    },

    register: function (entries) {
      REG = {};
      (entries || []).forEach(function (e) {
        REG[e.path] = {
          target: e.target, key: e.key || null, tsKey: e.tsKey || null,
          // 'sobDemanda' marca nos que nao devem entrar no sync automatico.
          // Sao nos grandes que so interessam em telas especificas: o cliente
          // baixa o que precisa na hora em que precisa, e nao a cada abertura.
          sobDemanda: !!e.sobDemanda
        };
      });
    },
    init: function (o) {
      this.register(o.entries || []);
      ONUPD = o.onUpdated || null;
      var paths = Object.keys(REG).filter(function (p) { return !REG[p].sobDemanda; });
      var self = this;
      var pulls = [];
      var done = paths.map(function (path) {
        return syncNode(path, REG[path], false).then(function (r) {
          if (r.shouldPull) { pulls.push(r.pull()); }
        }).catch(function () {});
      });
      setTimeout(function () { self.afterSync(); if (ONUPD) { ONUPD(); } }, 80);
      Promise.all(done).then(function () {
        if (!pulls.length) { self.afterSync(); if (ONUPD) { ONUPD(); } return; }
        return Promise.all(pulls).then(function () {
          self.afterSync();
          if (ONUPD) { ONUPD(); }
        }).catch(function () {
          self.afterSync();
          if (ONUPD) { ONUPD(); }
        });
      }).catch(function () {
        self.afterSync();
        if (ONUPD) { ONUPD(); }
      });
    },
    afterSync: function () {
      LAST_REFRESH = Date.now();
    },
    refreshNode: function (path) {
      var entry = REG[path];
      if (!entry) { return Promise.resolve({ downloaded: false }); }
      var self = this;
      return syncNode(path, entry, false).then(function (r) {
        if (r.shouldPull) { return r.pull(); }
        return { downloaded: false };
      });
    },
    refreshAll: function (manual) {
      if (!manual && (Date.now() - LAST_REFRESH) < 5000) { return Promise.resolve({ downloads: 0 }); }
      var paths = Object.keys(REG).filter(function (p) { return !REG[p].sobDemanda; });
      var self = this;
      var pulls = [];
      var chain = Promise.resolve();
      paths.forEach(function (path) {
        chain = chain.then(function () {
          return syncNode(path, REG[path], !!manual).then(function (r) {
            if (r.shouldPull) { pulls.push(r.pull()); }
          });
        });
      });
      return chain.then(function () {
        if (!pulls.length) { self.afterSync(); if (ONUPD) { ONUPD(); } return { downloads: 0 }; }
        return Promise.all(pulls).then(function () {
          self.afterSync();
          if (ONUPD) { ONUPD(); }
          return { downloads: pulls.length };
        });
      });
    },

    /* ── helpers de escrita (mantêm cache/memória quentes + bump meta) ── */
    write: function (node, key, val) {
      var self = this;
      var v = normalizeVal((val && typeof val === 'object') ? Object.assign({}, val) : val, key);
      var p = node + '/' + key;
      var entry = REG[node];
      statUp(node, approxBytes(v));
      return DB.set(p, v).then(function () {
        if (entry) { var map = slotOf(entry); map[key] = v; }
        return self.advanceLocalMeta(node);
      });
    },
    remove: function (node, key) {
      var self = this;
      var entry = REG[node];
      statUp(node, approxBytes(key));
      return DB.remove(node + '/' + key).then(function () {
        if (entry) { var map = slotOf(entry); delete map[key]; }
        return self.advanceLocalMeta(node);
      });
    },
    update: function (node, key, patch) {
      var self = this;
      var entry = REG[node];
      statUp(node, approxBytes(patch));
      return DB.update(node + '/' + key, patch).then(function () {
        if (entry && patch && typeof patch === 'object') {
          var map = slotOf(entry);
          var prev = map[key] && typeof map[key] === 'object' ? map[key] : {};
          map[key] = Object.assign({}, prev, patch);
        }
        return self.advanceLocalMeta(node);
      });
    },
    removeAll: function (node) {
      var self = this;
      var entry = REG[node];
      return DB.remove(node).then(function () {
        if (entry) { var map = slotOf(entry); Object.keys(map).forEach(function (k) { delete map[k]; }); }
        delCache(node);
        return self.advanceLocalMeta(node);
      });
    },
    push: function (node, val) {
      var self = this;
      var entry = REG[node];
      var r = DB.push(node, val);
      var key = r && r.key ? r.key : null;
      var v = normalizeVal((val && typeof val === 'object') ? Object.assign({}, val) : val, key);
      statUp(node, approxBytes(v));
      if (entry && key) { var map = slotOf(entry); map[key] = v; }
      return self.advanceLocalMeta(node).then(function () { return key; });
    },

    /* ── medição de tráfego (nada é gravado no banco por aqui) ── */
    stats: function () { return STATS; },
    statsReset: statReset,
    dbg: dbg,
    persistence: function () { return PERSIST_STATE; },

    /* ── paginação de listas ── */
    pag: {
      n: {},
      slice: function (list, key, base) {
        if (!list || !list.length) { return list; }
        if (list.length <= base) { return list; }
        var m = this.n[key] || base;
        return list.slice(0, m);
      },
      more: function (key, base) { this.n[key] = (this.n[key] || base) + base; },
      // volta uma lista especifica para o tamanho inicial, sem mexer nas outras
      set: function (key, base) { this.n[key] = base || 0; return this.n[key]; },
      count: function (list, key, base) { return Math.min(this.n[key] || base, list.length); },
      reset: function () { this.n = {}; }
    },
    pagBtn: function (listLen, shown, key, base, renderFn) {
      if (listLen <= shown) { return ''; }
      return '<div style="text-align:center;padding:12px 0"><button type="button" onclick="' +
        'WS_DATA.pag.more(\'' + key + '\',' + base + ');' + renderFn + '" ' +
        'style="padding:7px 16px;border-radius:6px;border:1px solid #e4e4e7;background:#fff;color:#52525b;font-family:DM Sans,arial,sans-serif;font-size:12px;font-weight:600;cursor:pointer">' +
        'Carregar mais (' + listLen + ' · mostrando ' + shown + ')</button></div>';
    },

    /* ── botão flutuante de atualizar ── */
    injectRefreshButton: function (opts) {
      opts = opts || {};
      var label = opts.label || 'Atualizar dados';
      var ifApp = opts.onlyWhen || null;
      var already = document.getElementById('ws-refresh-fab');
      if (already && already.parentNode) { already.parentNode.removeChild(already); }
      var b = document.createElement('button');
      b.id = 'ws-refresh-fab';
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;width:52px;height:52px;' +
        'border-radius:50%;border:none;cursor:pointer;background:#2c2c2e;color:#e4e4e7;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.28);font-size:20px;font-family:DM Sans,arial,sans-serif;' +
        'display:flex;align-items:center;justify-content:center;transition:transform .15s,background .15s;';
      b.innerHTML = '<span style="line-height:1">&#x27F3;</span>';
      b.onmouseenter = function () { b.style.background = '#3f3f46'; };
      b.onmouseleave = function () { b.style.background = '#2c2c2e'; };
      // clique segurado abre o painel de trafego; clique normal atualiza
      var pressT = null, longPress = false;
      b.addEventListener('mousedown', function () {
        longPress = false;
        pressT = setTimeout(function () { pressT = null; longPress = true; window.WS_DATA.toggleTrafficPanel(); }, 550);
      });
      b.addEventListener('mouseup', function () { if (pressT) { clearTimeout(pressT); pressT = null; } });
      b.addEventListener('mouseleave', function () { if (pressT) { clearTimeout(pressT); pressT = null; } });
      b.title = label + ' (segure para ver o trafego)';
      var tip = document.createElement('span');
      tip.id = 'ws-refresh-fab-tip';
      tip.style.cssText = 'position:fixed;right:80px;bottom:34px;z-index:2147483000;background:#18181b;color:#fafafa;' +
        'padding:6px 10px;border-radius:6px;font-size:12px;font-family:DM Sans,arial,sans-serif;' +
        'opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,.3);';
      tip.textContent = label;
      var spin = false;
      b.onclick = function () {
        if (spin) { return; }
        if (longPress) { longPress = false; return; }   // o clique Longo ja abriu o painel
        spin = true;
        b.style.pointerEvents = 'none';
        b.innerHTML = '<span style="line-height:1;display:inline-block;animation:wsSpin .8s linear infinite">&#x27F3;</span>';
        if (!document.getElementById('ws-spin-key')) {
          var st = document.createElement('style');
          st.id = 'ws-spin-key';
          st.textContent = '@keyframes wsSpin{to{transform:rotate(360deg)}}';
          document.head.appendChild(st);
        }
        window.WS_DATA.refreshAll(true).then(function (res) {
          spin = false;
          b.style.pointerEvents = '';
          b.innerHTML = '<span style="line-height:1">&#x2713;</span>';
          var txt = res && res.downloads ? 'Atualizado: ' + res.downloads + ' nó(s)' : 'Tudo em dia — 0 downloads';
          tip.textContent = txt;
          tip.style.opacity = '1';
          setTimeout(function () {
            b.innerHTML = '<span style="line-height:1">&#x27F3;</span>';
            setTimeout(function () { tip.style.opacity = '0'; }, 2600);
          }, 1800);
        });
      };
      document.body.appendChild(b);
      document.body.appendChild(tip);
    },

    /* ── painel de tráfego: onde o custo aparece, por nó ── */
    injectTrafficPanel: function () {
      if (document.getElementById('ws-traffic-panel')) { return; }
      var panel = document.createElement('div');
      panel.id = 'ws-traffic-panel';
      panel.style.cssText = 'position:fixed;left:18px;bottom:88px;z-index:2147483000;display:none;' +
        'background:#18181b;color:#fafafa;padding:12px 14px;border-radius:8px;font-size:12px;' +
        'min-width:260px;max-width:340px;box-shadow:0 6px 20px rgba(0,0,0,.32);font-family:DM Sans,arial,sans-serif;';
      document.body.appendChild(panel);
      return panel;
    },
    toggleTrafficPanel: function () {
      var panel = this.injectTrafficPanel();
      if (!panel) { return; }
      if (panel.style.display === 'none') { panel.style.display = 'block'; this.renderTrafficPanel(panel); }
      else { panel.style.display = 'none'; }
    },
    renderTrafficPanel: function (panel) {
      panel = panel || document.getElementById('ws-traffic-panel');
      if (!panel) { return; }
      var s = STATS;
      function human(b) {
        if (b < 1024) { return b + ' B'; }
        if (b < 1048576) { return (b / 1024).toFixed(1) + ' KB'; }
        if (b < 1073741824) { return (b / 1048576).toFixed(1) + ' MB'; }
        return (b / 1073741824).toFixed(2) + ' GB';
      }
      var downTotal = 0, upTotal = 0;
      Object.keys(s.down).forEach(function (k) { downTotal += s.down[k].bytes; });
      Object.keys(s.up).forEach(function (k) { upTotal += s.up[k].bytes; });
      var rows = Object.keys(s.down)
        .map(function (k) { return { k: k, b: s.down[k].bytes, p: s.down[k].pulls }; })
        .sort(function (a, b) { return b.b - a.b; })
        .slice(0, 8)
        .map(function (r) {
          return '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0">' +
            '<span style="color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            r.k.replace('certificadosGerados:curso:', 'cert/') + '</span>' +
            '<span style="font-weight:600">' + human(r.b) + '</span></div>';
        }).join('');
      var upRows = Object.keys(s.up)
        .map(function (k) { return { k: k, b: s.up[k].bytes, w: s.up[k].writes }; })
        .sort(function (a, b) { return b.b - a.b; })
        .slice(0, 5)
        .map(function (r) {
          return '<div style="display:flex;justify-content:space-between;gap:12px;padding:2px 0">' +
            '<span style="color:#a1a1aa">' + r.k + ' (' + r.w + 'x)</span>' +
            '<span style="font-weight:600">' + human(r.b) + '</span></div>';
        }).join('');
      var persist = PERSIST_STATE;
      panel.innerHTML =
        '<div style="font-weight:700;margin-bottom:6px">Tráfego desta sessão</div>' +
        '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #3f3f46">' +
          '<span>baixado</span><b style="color:#fbbf24">' + human(downTotal) + '</b></div>' +
        '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #3f3f46">' +
          '<span>escrito</span><b style="color:#4ade80">' + human(upTotal) + '</b></div>' +
        '<div style="color:#a1a1aa;padding:3px 0;border-bottom:1px solid #3f3f46">' +
          'pulls: ' + s.nPullFull + ' inteiro(s) · ' + s.nPullInc + ' incremental · ' +
          'cache em disco: ' + persist + '</div>' +
        (rows ? '<div style="margin-top:8px;font-weight:600;color:#a1a1aa">Leitura por nó</div>' + rows : '<div style="margin-top:8px;color:#a1a1aa">nenhuma leitura</div>') +
        (upRows ? '<div style="margin-top:8px;font-weight:600;color:#a1a1aa">Escrita por nó</div>' + upRows : '') +
        '<div style="margin-top:10px"><button type="button" style="width:100%;padding:5px;border:1px solid #3f3f46;' +
        'background:#27272a;color:#e4e4e7;border-radius:5px;cursor:pointer;font-size:11px" ' +
        'onclick="WS_DATA.statsReset();WS_DATA.renderTrafficPanel()">Zerar medição</button></div>';
    }
  };
})();