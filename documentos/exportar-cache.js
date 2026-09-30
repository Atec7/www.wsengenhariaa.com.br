/* ==========================================================================
   EXPORTA O CACHE LOCAL DO SISTEMA (somente LEITURA - nada e gravado)
   ----------------------------------------------------------------------------
   Como usar:
   1. Abra no Chrome o endereco  https://www.wsengenhariaa.com.br/
      (pode ser a pagina inicial do site; o cache e por dominio, nao por pagina)
   2. Aperte F12 e va na aba "Console" / "Console"
   3. Cole este codigo inteiro e aperte Enter
   4. Vai baixar um arquivo .json na pasta de Downloads
   ========================================================================== */

(async function exportarCache() {
  const IDB_NAME = 'ws_cache', IDB_STORE = 'nodes';
  const LS_PREFIX = 'ws_cache_v1_';

  console.log('%c=== EXPORTANDO CACHE LOCAL (somente leitura) ===', 'color:#0a0;font-weight:bold');
  console.log('origem:', location.origin);

  function abrir() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }

  function lerTudo(db) {
    return new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const st = tx.objectStore(IDB_STORE);
      const out = {};
      st.openCursor().onsuccess = ev => {
        const c = ev.target.result;
        if (c) { out[c.key] = c.value; c.continue(); }
        else res(out);
      };
      tx.onerror = () => rej(tx.error);
    });
  }

  let idb = {};
  try {
    const db = await abrir();
    idb = await lerTudo(db);
    db.close();
    console.log('%cIndexedDB lido: ' + Object.keys(idb).length + ' chave(s)', 'color:#0a0');
  } catch (e) {
    console.warn('IndexedDB indisponivel:', e.message);
  }

  // monta o dump: IndexedDB tem prioridade; localStorage completa o que faltar
  const dump = { origem: location.origin, extraidoEm: new Date().toISOString(), nos: {} };

  for (const chave of Object.keys(idb)) {
    const rec = idb[chave];
    const n = rec && rec.data ? Object.keys(rec.data).length : 0;
    console.log('  IndexedDB  ' + chave.padEnd(20) + ' ' + n + ' registro(s)  salvo em ' +
      (rec && rec.savedAt ? new Date(rec.savedAt).toLocaleString() : '?'));
    dump.nos[chave] = { origemCache: 'IndexedDB', salvoEm: rec && rec.savedAt, dados: rec && rec.data };
  }

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith(LS_PREFIX)) continue;
      const nome = k.slice(LS_PREFIX.length);
      const p = JSON.parse(localStorage.getItem(k));
      const n = p && p.data ? Object.keys(p.data).length : 0;
      console.log('  localStorage ' + nome.padEnd(20) + ' ' + n + ' registro(s)  salvo em ' +
        (p && p.savedAt ? new Date(p.savedAt).toLocaleString() : '?'));
      // so entra no dump se ainda nao temos esse no, ou se o do localStorage tem mais
      if (!dump.nos[nome] || (Object.keys(dump.nos[nome].dados || {}).length < n)) {
        dump.nos[nome] = { origemCache: 'localStorage', salvoEm: p && p.savedAt, dados: p && p.data };
      }
    }
  } catch (e) { console.warn('localStorage:', e.message); }

  // resumo final
  console.log('%c--- RESUMO ---', 'color:#0a0;font-weight:bold');
  let maior = 0, qual = '';
  for (const nome of Object.keys(dump.nos)) {
    const n = Object.keys(dump.nos[nome].dados || {}).length;
    console.log('  ' + nome + ': ' + n + ' registro(s)');
    if (n > maior) { maior = n; qual = nome; }
  }

  if (!Object.keys(dump.nos).length) {
    console.warn('%cNenhum cache encontrado neste navegador/perfil.', 'color:#b91c1c');
    return;
  }

  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cache-original-' + qual + '-' + Date.now() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  console.log('%cBAIXADO: ' + a.download, 'color:#0a0;font-weight:bold');
  console.log('Maior no encontrado: ' + qual + ' com ' + maior + ' registro(s).');
})();
