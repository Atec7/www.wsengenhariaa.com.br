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

  var DB_URL = null;               // usado só para listar chaves (shallow)

  function useDb(compatDb, opts) {
    enablePersistencia(compatDb);
    try { DB_URL = compatDb.app.options.databaseURL || null; } catch (e) { DB_URL = null; }
    return useAdapter({
      once: function (p) { return compatDb.ref(p).once('value'); },
      set: function (p, v) { return compatDb.ref(p).set(v); },
      update: function (p, v) { return compatDb.ref(p).update(v); },
      remove: function (p) { return compatDb.ref(p).remove(); },
      // Devolve a promessa da gravação junto com a chave: antes ela era
      // descartada e uma gravação negada aparecia na tela como salva.
      push: function (p, v) { var r = compatDb.ref(p).push(v); return { key: r.key, done: r }; },
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
  // Leitura pura do carimbo. As funções de download usavam bump() (que GRAVA o
  // _meta) só para descobrir o valor: cada leitura virava escrita, as outras
  // abas viam o _meta mudar, baixavam o nó inteiro e gravavam de novo — um
  // pingue-pongue entre aparelhos que era a maior parte do consumo diário.
  function readMeta(node) {
    if (!DB) { return Promise.resolve(null); }
    return DB.once('_meta/' + node).then(function (snap) { return snap.val(); })
      .catch(function () { return null; });
  }
  // Só as chaves do nó (sem os dados), para saber o que foi excluído em outro
  // aparelho. O pull incremental só enxerga registros novos.
  function shallowKeys(path) {
    if (!DB_URL || typeof fetch !== 'function') { return Promise.resolve(null); }
    var url = DB_URL.replace(/\/+$/, '') + '/' + path + '.json?shallow=true';
    return fetch(url).then(function (r) {
      if (!r.ok) { throw new Error('http ' + r.status); }
      return r.json();
    }).then(function (j) {
      statDown(path + ':chaves', approxBytes(j), false);
      return j || {};
    }).catch(function () { return null; });
  }
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
    var metaTs = null;
    // O carimbo é lido ANTES dos dados: uma gravação que chegue no meio fica
    // com carimbo maior e é baixada no próximo sync, em vez de se perder.
    return readMeta(path).then(function (m) {
      metaTs = m;
      return DB.once(path);
    }).then(function (snap) {
      var norm = fromSnapshot(snap);
      statDown(path, approxBytes(norm), true);
      Object.keys(map).forEach(function (k) { delete map[k]; });
      Object.keys(norm).forEach(function (k) { map[k] = norm[k]; });
      return Promise.resolve().then(function () {
        var rec = {
          data: clone(map),
          metaTs: (metaTs != null) ? metaTs : 0,
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
  function pullInc(path, entry, reconciliar) {
    var map = slotOf(entry);
    var tsKey = entry.tsKey;
    var metaLido = null;
    return readMeta(path).then(function (m) {
      metaLido = m;
      return getCache(path);
    }).then(function (cache) {
      // Cache gravado com outra tsKey, ou com ts em texto (a antiga
      // dataGeracao), não serve de ponto de partida: startAt() com string num
      // índice numérico volta vazio para sempre, e o resgate por pullFull já
      // foi desligado. Nesses casos é melhor pagar um nó inteiro uma vez e
      // reescrever o cache no formato certo.
      if (cache && cache.tsKey && cache.tsKey !== tsKey) { cache = null; }
      if (cacheInvalido(entry, cache)) { cache = null; }
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
        if (n > 0) {
          statDown(path, approxBytes(norm), false);
          STATS.nPullInc++;
          Object.keys(norm).forEach(function (k) {
            if (map[k] === undefined || map[k] === null ||
                (map[k] && norm[k] && (map[k][tsKey] === undefined || norm[k][tsKey] >= map[k][tsKey]))) {
              map[k] = norm[k];
            }
          });
        }
        // Exclusões feitas em outro aparelho: o incremental nunca as via e o
        // registro apagado continuava na tela para sempre. Só acontece quando
        // o _meta mudou, e baixa apenas as chaves.
        var rec0 = reconciliar ? shallowKeys(path) : Promise.resolve(null);
        return rec0.then(function (chaves) {
          var removidos = 0;
          if (chaves && typeof chaves === 'object') {
            Object.keys(map).forEach(function (k) {
              if (!Object.prototype.hasOwnProperty.call(chaves, k)) { delete map[k]; removidos++; }
            });
          }
          // Nada novo é o caso NORMAL, não um sinal de cache quebrado.
          if (n === 0 && removidos === 0) {
            if (cache) {
              cache.savedAt = Date.now();
              if (metaLido != null && metaLido > (cache.metaTs || 0)) { cache.metaTs = metaLido; }
              putCache(path, cache);
            }
            return { downloaded: false, vazio: true };
          }
          var rec = {
            data: clone(map),
            metaTs: (metaLido != null) ? metaLido : (cache ? cache.metaTs : 0),
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
  /* forcar = "o usuário mandou atualizar": baixa o nó mesmo que o _meta diga que
     nada mudou. Sem isso, o botão respondia "Tudo em dia" e o colaborador
     recém-cadastrado nunca aparecia — a atualização depende do carimbo _meta,
     que falha quando a gravação é negada ou feita fora do WS_DATA. */
  function cacheInvalido(entry, cache) {
    if (!entry || !entry.invalidar || !cache || !cache.data) { return false; }
    try { return !!entry.invalidar(cache.data); } catch (e) { return false; }
  }
  function syncNode(path, entry, manual, forcar) {
    var map = slotOf(entry);
    return getCache(path).then(function (cache) {
      if (cacheInvalido(entry, cache)) { delCache(path); cache = null; }
      if (cache && cache.data) {
        var cdata = cache.data;
        Object.keys(map).forEach(function (k) { delete map[k]; });
        Object.keys(cdata).forEach(function (k) { map[k] = cdata[k]; });
      }
      if (forcar) {
        return {
          shouldPull: true,
          pull: function () {
            return (entry.tsKey ? pullInc(path, entry, true) : pullFull(path, entry));
          }
        };
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
          return pullInc(path, entry, true).then(function (r) {
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
    /* Chamado depois de gravações feitas DIRETO no db (fora do WS_DATA), cujo
       conteúdo não está na memória. Antes, esta função marcava o cache local
       como "em dia" sem ter o dado novo: ao reabrir a página, o registro
       editado voltava ao valor antigo e o excluído reaparecia. Agora ela só
       carimba o servidor e deixa o cache vencido, para o próximo sync baixar. */
    advanceLocalMeta: function (node) {
      return bump(node).then(function (ts) {
        return getCache(node).then(function (c) {
          if (c) { c.savedAt = 0; putCache(node, c); }
          return ts;
        });
      }).catch(function () { return null; });
    },
    /* Depois de gravar pelo WS_DATA: a memória já tem a mudança, então ela vai
       para o cache em disco. O carimbo local só avança se o cache estava em dia
       antes desta gravação; senão o próximo sync ainda baixa o que os outros
       gravaram nesse meio-tempo. */
    _commitLocal: function (node) {
      var entry = REG[node];
      return readMeta(node).then(function (antes) {
        return getCache(node).then(function (c) {
          return bump(node).then(function (ts) {
            if (!c) { return ts; }
            if (entry && c.data) {
              var map = slotOf(entry);
              var emDia = (antes == null) || (antes <= (c.metaTs || 0));
              c.data = clone(map);
              if (emDia && ts != null) {
                c.metaTs = ts;
                if (entry.tsKey) { c.tsValue = maxTs(map, entry.tsKey); }
                c.savedAt = Date.now();
              } else {
                c.savedAt = 0;
              }
            } else {
              // nó não registrado nesta página: o cache (de outra página do
              // mesmo navegador) não tem a mudança; deixa vencido.
              c.savedAt = 0;
            }
            putCache(node, c);
            return ts;
          });
        });
      }).catch(function () { return null; });
    },

    register: function (entries) {
      REG = {};
      (entries || []).forEach(function (e) {
        REG[e.path] = {
          target: e.target, key: e.key || null, tsKey: e.tsKey || null,
          // 'sobDemanda' marca nos que nao devem entrar no sync automatico.
          // Sao nos grandes que so interessam em telas especificas: o cliente
          // baixa o que precisa na hora em que precisa, e nao a cada abertura.
          sobDemanda: !!e.sobDemanda,
          // invalidar(cache) -> true descarta o cache em disco deste nó (ex.: o
          // formato dos dados mudou no servidor e o cache antigo é pesado).
          invalidar: (typeof e.invalidar === 'function') ? e.invalidar : null
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
      // Devolve uma promessa que resolve quando o sync inicial com o servidor
      // terminou (quem precisa de dado atual, e não do cache, espera por ela).
      return Promise.all(done).then(function () {
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
    /* Situação do cache dos nós pedidos: quando foi baixado pela última vez e
       quantos registros tem. Serve para dizer se a lista está velha ou se o
       registro simplesmente não chegou. */
    cacheInfo: function (paths) {
      return (Array.isArray(paths) ? paths : []).map(function (p) {
        var c = CACHE[p];
        if (!c) { return p + ': sem cache'; }
        var n = c.data ? Object.keys(c.data).length : 0;
        var quando = c.savedAt ? new Date(c.savedAt).toLocaleTimeString() : '?';
        return p + ': ' + n + ' reg. (' + quando + ')';
      }).join(' · ');
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
      return this.refreshPaths(null, manual, !!manual);
    },
    /* Só os nós informados (ou todos, quando paths = null). As checagens de
       _meta vão em paralelo: em cadeia, 8 nós viravam 8 esperas seguidas e o
       botão de atualizar demorava mesmo quando nada tinha mudado. */
    refreshPaths: function (paths, manual, forcar) {
      if (!manual && (Date.now() - LAST_REFRESH) < 5000) { return Promise.resolve({ downloads: 0 }); }
      var lista = (Array.isArray(paths) && paths.length)
        ? paths.filter(function (p) { return !!REG[p] && !REG[p].sobDemanda; })
        : Object.keys(REG).filter(function (p) { return !REG[p].sobDemanda; });
      var self = this;
      var pulls = [];
      return Promise.all(lista.map(function (path) {
        return syncNode(path, REG[path], !!manual, !!forcar).then(function (r) {
          if (r.shouldPull) { pulls.push(r.pull()); }
        }).catch(function () {});
      })).then(function () {
        if (!pulls.length) { self.afterSync(); if (ONUPD) { ONUPD(); } return { downloads: 0 }; }
        return Promise.all(pulls).then(function () {
          self.afterSync();
          if (ONUPD) { ONUPD(); }
          return { downloads: pulls.length };
        });
      });
    },
    /* Vigia barata: consulta só o _meta dos nós indicados (poucas centenas de
       bytes) e baixa o nó inteiro apenas quando ele realmente mudou. É o que
       faz o colaborador novo aparecer sozinho, sem pagar o certificadoGerados
       a cada ciclo. A cada `forcarACada` ciclos sem mudança também baixa, como
       rede de segurança para quando o carimbo _meta não é gravado. Devolve uma
       função para parar. */
    watchPaths: function (paths, ms, onChange, forcarACada) {
      var lista = (Array.isArray(paths) ? paths : []).filter(function (p) { return !!REG[p]; });
      if (!lista.length) { return function () {}; }
      var intervalo = ms || 20000;
      // A "rede de segurança" que baixava os nós inteiros a cada N ciclos
      // (com 20 s e N=6: a cada 2 minutos, em cada aba aberta, o dia todo)
      // foi desligada por padrão. Com o _meta só sendo gravado em escritas
      // reais, ler o carimbo é suficiente.
      var forcaEm = forcarACada || 0;
      var parados = 0;
      var parar = false;
      var timer = null;
      function ciclo() {
        if (parar) { return; }
        // aba em segundo plano não consulta nada
        if (typeof document !== 'undefined' && document.hidden) {
          timer = setTimeout(ciclo, intervalo);
          return;
        }
        parados++;
        var forcar = forcaEm > 0 && parados >= forcaEm;
        Promise.all(lista.map(function (p) {
          return getCache(p).then(function (c) {
            return DB.once('_meta/' + p).then(function (snap) {
              var meta = snap.val();
              if (!forcar && meta && c && meta <= (c.metaTs || 0)) { return null; }
              if (!forcar && !meta) { return null; }
              return syncNode(p, REG[p], true, forcar).then(function (r) {
                if (r.shouldPull) { return r.pull().then(function () { return p; }); }
                return null;
              });
            });
          }).catch(function () { return null; });
        })).then(function (mudou) {
          var lista2 = mudou.filter(Boolean);
          if (lista2.length) { parados = 0; }
          if (lista2.length) {
            if (ONUPD) { ONUPD(); }
            if (typeof onChange === 'function') { try { onChange(lista2); } catch (e) {} }
          }
        }).catch(function () {}).then(function () {
          if (!parar) { timer = setTimeout(ciclo, intervalo); }
        });
      }
      timer = setTimeout(ciclo, intervalo);
      return function () { parar = true; if (timer) { clearTimeout(timer); timer = null; } };
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
        return self._commitLocal(node);
      });
    },
    remove: function (node, key) {
      var self = this;
      var entry = REG[node];
      statUp(node, approxBytes(key));
      return DB.remove(node + '/' + key).then(function () {
        if (entry) { var map = slotOf(entry); delete map[key]; }
        return self._commitLocal(node);
      });
    },
    update: function (node, key, patch) {
      var self = this;
      var entry = REG[node];
      statUp(node, approxBytes(patch));
      return DB.update(node + '/' + key, patch).then(function () {
        var completo = false;
        if (entry && patch && typeof patch === 'object') {
          var map = slotOf(entry);
          completo = !!(map[key] && typeof map[key] === 'object');
          var prev = completo ? map[key] : {};
          map[key] = Object.assign({}, prev, patch);
        }
        // Sem o registro inteiro na memória, o cache ficaria só com o patch:
        // nesse caso deixa o próximo sync baixar o registro completo.
        return completo ? self._commitLocal(node) : self.advanceLocalMeta(node);
      });
    },
    removeAll: function (node) {
      var self = this;
      var entry = REG[node];
      return DB.remove(node).then(function () {
        if (entry) { var map = slotOf(entry); Object.keys(map).forEach(function (k) { delete map[k]; }); }
        delCache(node);
        return self.bump(node);
      });
    },
    push: function (node, val) {
      var self = this;
      var entry = REG[node];
      var r = DB.push(node, val);
      var key = r && r.key ? r.key : null;
      var v = normalizeVal((val && typeof val === 'object') ? Object.assign({}, val) : val, key);
      statUp(node, approxBytes(v));
      // Espera o servidor confirmar: antes o registro entrava na tela mesmo
      // quando a gravação era negada, e sumia ao recarregar.
      var feito = (r && r.done && typeof r.done.then === 'function') ? r.done : Promise.resolve();
      return Promise.resolve(feito).then(function () {
        if (entry && key) { var map = slotOf(entry); map[key] = v; }
        return self._commitLocal(node);
      }).then(function () { return key; });
    },

    /* ── conteúdo imutável (ex.: imagem guardada pelo hash) ──
       Baixa uma vez por aparelho e guarda para sempre no IndexedDB: o mesmo
       hash nunca muda de conteúdo, então não há o que sincronizar. Não usa o
       localStorage (imagens estourariam a cota e quebrariam os outros caches). */
    _imut: {},
    imutavel: function (path) {
      var self = this;
      if (self._imut[path] !== undefined) { return Promise.resolve(self._imut[path]); }
      var chave = 'imut:' + path;
      return idbGet(chave).catch(function () { return null; }).then(function (r) {
        if (r && r.v !== undefined) { self._imut[path] = r.v; return r.v; }
        return DB.once(path).then(function (snap) {
          var v = snap.val();
          statDown('imut', approxBytes(v), false);
          if (v != null) {
            self._imut[path] = v;
            idbPut(chave, { v: v, savedAt: Date.now() }).catch(function () {});
          }
          return v;
        });
      });
    },

    /* ── medição de tráfego (nada é gravado no banco por aqui) ── */
    stats: function () { return STATS; },
    statsReset: statReset,
    dbg: dbg,
    persistence: function () { return PERSIST_STATE; },

    /* ── paginação de listas ── */
    pag: {
      n: {},   // limite das listas com "carregar mais"
      p: {},   // página atual das listas paginadas
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
      /* paginação por páginas: não renderiza a lista inteira de uma vez, o que
         travava a tela quando o histórico tinha muitos registros. */
      goto: function (key, p) { this.p[key] = p; return p; },
      cur: function (key) { return this.p[key] || 1; },
      first: function (key) { this.p[key] = 1; },
      page: function (list, key, perPage) {
        var total = (list || []).length;
        var pp = perPage || 50;
        var pages = Math.max(1, Math.ceil(total / pp));
        var p = Math.min(Math.max(this.p[key] || 1, 1), pages);
        this.p[key] = p;
        return {
          total: total, pages: pages, page: p, per: pp,
          slice: (list || []).slice((p - 1) * pp, p * pp)
        };
      },
      nav: function (info, key, renderFn) {
        if (!info || info.pages <= 1) { return ''; }
        var go = function (p) { return 'WS_DATA.pag.goto(\'' + key + '\',' + p + ');' + renderFn; };
        var items = [];
        for (var i = 1; i <= info.pages; i++) {
          if (info.pages > 7 && i > 2 && i < info.pages - 1 && Math.abs(i - info.page) > 1) {
            if (items[items.length - 1] !== '…') { items.push('<span class="pg-gap">…</span>'); }
            continue;
          }
          items.push('<button type="button" class="' + (i === info.page ? 'on' : '') + '" onclick="' + go(i) + '">' + i + '</button>');
        }
        return '<div class="pg-nav">' +
          '<button type="button" class="pg-step"' + (info.page > 1 ? ' onclick="' + go(info.page - 1) + '"' : ' disabled') + '>‹</button>' +
          items.join('') +
          '<button type="button" class="pg-step"' + (info.page < info.pages ? ' onclick="' + go(info.page + 1) + '"' : ' disabled') + '>›</button>' +
          '<span class="pg-info">' + info.total + ' registro(s) · página ' + info.page + ' de ' + info.pages + '</span>' +
          '</div>';
      },
      reset: function () { this.n = {}; this.p = {}; }
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
      // paths: nós que o botão realmente atualiza. Sem isso ele baixava o
      // certificadosGerados inteiro (megabytes) só para ver um colaborador novo.
      var only = (Array.isArray(opts.paths) && opts.paths.length) ? opts.paths.slice() : null;
      // "Atualizar" significa baixar de novo: sem forcar, o botão só perguntava
      // ao _meta e respondia "Tudo em dia" mesmo com registro novo no banco.
      var forcar = opts.forcar !== false;
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
        window.WS_DATA.refreshPaths(only, true, forcar).then(function (res) {
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