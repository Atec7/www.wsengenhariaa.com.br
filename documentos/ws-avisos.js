/* ws-avisos.js — avisos de vencimento, lembretes/tarefas e voz.
 *
 * Usado pelo index.html (painel). Depende de globais do painel: DATA, db,
 * USUARIO_ATUAL, toArr, esc, isBlindagem, histVisivel, funcVisivel,
 * empresaPermitida, getCertCursoName, cls.
 *
 * - Balões no canto da tela, um por empresa (certificados, documentos e ASO)
 *   e um por lembrete. Somem ao clicar no X ou sozinhos depois de 18 s
 *   (pausa com o mouse em cima).
 * - Faixas: vencido, até 7 dias, até 15 dias, até 30 dias.
 * - Cada balão aparece uma vez por sessão; volta se a situação mudar (ex.: de
 *   "15 dias" para "7 dias") ou depois de 4 horas com o sistema aberto.
 * - Voz: síntese do próprio navegador, escolhendo a voz pt-BR mais natural
 *   disponível (no Edge, as vozes "Natural" da Microsoft).
 * - Lembretes ficam em 'lembretesUsuario/{usuario}/{id}' (só do dono) e em
 *   'lembretesComuns/{id}' (marcados "para todos"). Cada usuário baixa só
 *   esses dois nós, e por diferença (child_*), não a lista inteira a cada
 *   mudança. Os avisos de vencimento não consultam o banco: usam os dados
 *   que o painel já carregou.
 */
(function () {
  'use strict';

  const AUTO_FECHAR_MS = 18000;
  const MAX_BALOES = 4;
  const REAVISAR_MS = 4 * 60 * 60 * 1000;
  const FAIXAS = [
    { k: 'vencido', rot: 'vencido(s)', cor: '#dc2626', bg: '#fef2f2' },
    { k: 'd7', rot: 'vencem em até 7 dias', cor: '#ea580c', bg: '#fff7ed' },
    { k: 'd15', rot: 'vencem em até 15 dias', cor: '#d97706', bg: '#fffbeb' },
    { k: 'd30', rot: 'vencem em até 30 dias', cor: '#ca8a04', bg: '#fefce8' }
  ];
  const DIA = 864e5;

  // ---------------------------------------------------------------- util
  const $ = (id) => document.getElementById(id);
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])));
  const arr = (o) => (typeof toArr === 'function' ? toArr(o) : Object.keys(o || {}).map((k) => Object.assign({ id: k }, o[k])));
  const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  function hoje0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function parseData(s) {
    const t = String(s || '').slice(0, 10);
    const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function diasAte(s) { const d = parseData(s); return d ? Math.round((d - hoje0()) / DIA) : null; }
  function faixaDe(dias) {
    if (dias == null) return null;
    if (dias < 0) return 'vencido';
    if (dias <= 7) return 'd7';
    if (dias <= 15) return 'd15';
    if (dias <= 30) return 'd30';
    return null;
  }
  function fmtData(s) { const d = parseData(s); return d ? d.toLocaleDateString('pt-BR') : '—'; }
  function textoDias(dias) {
    if (dias < -1) return 'venceu há ' + (-dias) + ' dias';
    if (dias === -1) return 'venceu ontem';
    if (dias === 0) return 'vence hoje';
    if (dias === 1) return 'vence amanhã';
    return 'vence em ' + dias + ' dias';
  }
  function usuarioId() {
    const u = window.USUARIO_ATUAL || (typeof USUARIO_ATUAL !== 'undefined' ? USUARIO_ATUAL : null);
    if (u) return String(u.id || u.nome || '');
    return sessionStorage.getItem('ws_user_id') || sessionStorage.getItem('ws_user_nome') || '';
  }
  function usuarioNome() {
    const u = (typeof USUARIO_ATUAL !== 'undefined' ? USUARIO_ATUAL : null);
    return (u && u.nome) || sessionStorage.getItem('ws_user_nome') || '';
  }
  function primeiroNome() { return usuarioNome().split(/\s+/)[0] || ''; }
  function nomeEmpresa(id) {
    const emp = (typeof DATA !== 'undefined' && DATA.empresas) ? (DATA.empresas[id] || arr(DATA.empresas).find((x) => String(x.id) === String(id))) : null;
    return (emp && emp.nome) || 'Empresa não identificada';
  }
  function podeVerEmpresa(id) { return !id || typeof empresaPermitida !== 'function' || empresaPermitida(id); }

  // ---------------------------------------------------------------- config
  const CFG_KEY = 'ws_avisos_cfg';
  function cfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (_) { }
    return Object.assign({ voz: true, baloes: true, vozNome: '', velocidade: 1 }, c);
  }
  function salvarCfg(p) { try { localStorage.setItem(CFG_KEY, JSON.stringify(Object.assign(cfg(), p))); } catch (_) { } }

  // ---------------------------------------------------------------- CSS
  function css() {
    if ($('wsav-css')) return;
    const st = document.createElement('style');
    st.id = 'wsav-css';
    st.textContent = `
#wsav-pilha{position:fixed;right:18px;bottom:18px;z-index:9000;display:flex;flex-direction:column-reverse;gap:10px;width:360px;max-width:calc(100vw - 36px);pointer-events:none}
.wsav-b{pointer-events:auto;position:relative;background:#fff;border:1px solid #e4e4e7;border-left:4px solid var(--c);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.12),0 2px 6px rgba(0,0,0,.06);padding:13px 38px 14px 14px;font-family:'DM Sans',sans-serif;color:#18181b;overflow:hidden;opacity:0;transform:translateY(14px) scale(.98);transition:opacity .45s ease,transform .45s cubic-bezier(.2,.8,.2,1)}
.wsav-b.on{opacity:1;transform:none}
.wsav-b.sai{opacity:0;transform:translateX(30px);transition:opacity .35s ease,transform .35s ease}
.wsav-b .wsav-ic{position:absolute;left:14px;top:14px;width:30px;height:30px;border-radius:50%;background:var(--bg);color:var(--c);display:flex;align-items:center;justify-content:center;font-size:14px}
.wsav-b .wsav-cp{margin-left:42px}
.wsav-b .wsav-tt{font-size:13px;font-weight:700;line-height:1.25;margin-bottom:3px}
.wsav-b .wsav-sub{font-size:10px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--c);margin-bottom:4px}
.wsav-b .wsav-li{font-size:12px;color:#3f3f46;line-height:1.45}
.wsav-b .wsav-li b{color:var(--c)}
.wsav-b .wsav-ac{margin-top:8px;display:flex;gap:6px}
.wsav-b .wsav-ac button{border:1px solid #e4e4e7;background:#fafafa;border-radius:7px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;color:#3f3f46}
.wsav-b .wsav-ac button:hover{background:#f4f4f5}
.wsav-b .wsav-x{position:absolute;top:8px;right:8px;width:24px;height:24px;border:none;border-radius:50%;background:transparent;color:#71717a;font-size:16px;line-height:1;cursor:pointer}
.wsav-b .wsav-x:hover{background:#f4f4f5;color:#18181b}
.wsav-b .wsav-pg{position:absolute;left:0;bottom:0;height:3px;background:var(--c);opacity:.35;width:100%;transform-origin:left;animation:wsavpg linear forwards}
.wsav-b:hover .wsav-pg{animation-play-state:paused}
@keyframes wsavpg{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.wsav-badge{margin-left:auto;background:#dc2626;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;min-width:18px;text-align:center}
.wsav-badge:empty{display:none}
.wsav-tab{width:100%;border-collapse:collapse;font-size:12px}
.wsav-tab th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#71717a;padding:6px 8px;border-bottom:1px solid #e4e4e7;position:sticky;top:0;background:#fff}
.wsav-tab td{padding:6px 8px;border-bottom:1px solid #f4f4f5;vertical-align:top}
.wsav-st{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;white-space:nowrap}
.wsav-lst{border:1px solid #e4e4e7;border-radius:8px;max-height:46vh;overflow:auto}
.wsav-lr{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid #f4f4f5}
.wsav-lr:last-child{border-bottom:none}
.wsav-lr.feito .wsav-lt{text-decoration:line-through;color:#a1a1aa}
.wsav-lt{font-size:13px;font-weight:600}
.wsav-ld{font-size:11px;color:#71717a;margin-top:2px}
.wsav-lr .wsav-la{margin-left:auto;display:flex;gap:4px;flex-shrink:0}
.wsav-lr .wsav-la button{border:1px solid #e4e4e7;background:#fff;border-radius:6px;padding:4px 7px;font-size:11px;cursor:pointer;color:#3f3f46}
.wsav-lr .wsav-la button:hover{background:#f4f4f5}
.wsav-chk{width:18px;height:18px;margin-top:2px;flex-shrink:0;cursor:pointer;accent-color:#16a34a}
.wsav-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.wsav-row>.fg{flex:1;min-width:150px}
.wsav-tg{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer}
.wsav-tg input{width:auto}
`;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- voz
  const Voz = {
    pend: [],
    liberado: false,
    vozes() {
      if (!window.speechSynthesis) return [];
      return speechSynthesis.getVoices().filter((v) => /^pt/i.test(v.lang));
    },
    // Ordem de preferência: vozes neurais (Edge "Online (Natural)"),
    // depois Google pt-BR, depois qualquer pt-BR, depois pt-PT.
    melhor() {
      const vs = this.vozes();
      if (!vs.length) return null;
      const escolhida = cfg().vozNome;
      if (escolhida) { const v = vs.find((x) => x.name === escolhida); if (v) return v; }
      const nota = (v) => {
        let n = 0;
        if (/pt[-_]BR/i.test(v.lang)) n += 100;
        if (/natural/i.test(v.name)) n += 60;
        if (/online/i.test(v.name)) n += 20;
        if (/francisca|thalita|brenda|leila|yara|giovanna|manuela/i.test(v.name)) n += 15;
        if (/google/i.test(v.name)) n += 30;
        if (/antonio|donato|fabio|humberto|julio|nicolau|valerio/i.test(v.name)) n += 10;
        if (/daniel|maria|helia/i.test(v.name) && !/natural/i.test(v.name)) n -= 5;
        return n;
      };
      return vs.slice().sort((a, b) => nota(b) - nota(a))[0];
    },
    falar(texto, forcar) {
      if (!window.speechSynthesis || !texto) return;
      if (!forcar && !cfg().voz) return;
      if (!this.liberado && !forcar) { this.pend.push(texto); return; }
      // frases curtas soam mais naturais e evitam o corte de ~15 s do Chrome
      const frases = String(texto).replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+/).filter(Boolean);
      // Falha na voz (navegador sem suporte, voz removida) nunca pode
      // impedir os balões de aparecerem.
      try {
        const v = this.melhor();
        frases.forEach((f) => {
          const u = new SpeechSynthesisUtterance(f);
          u.lang = (v && v.lang) || 'pt-BR';
          if (v) u.voice = v;
          u.rate = Number(cfg().velocidade) || 1;
          u.pitch = 1;
          speechSynthesis.speak(u);
        });
      } catch (err) { console.warn('voz:', err); }
    },
    // O navegador só deixa falar depois de um clique/tecla na página.
    liberar() {
      if (this.liberado) return;
      this.liberado = true;
      const p = this.pend.splice(0);
      if (p.length) this.falar(p.join(' '));
    },
    parar() { this.pend = []; try { speechSynthesis.cancel(); } catch (_) { } },
    // "Ignorar": cala na hora, descarta o que estava na fila e desliga a voz
    // (fica salvo neste navegador até ligar de novo em "Voz e balões").
    silenciar() {
      salvarCfg({ voz: false });
      this.parar();
      document.querySelectorAll('.wsav-ign').forEach((b) => b.remove());
      const ck = $('wsav-c-voz'); if (ck) ck.checked = false;
    }
  };
  if (window.speechSynthesis) {
    try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => { }; } catch (_) { }
    // Já houve interação (ex.: clique no Entrar do login)?
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) Voz.liberado = true;
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, () => Voz.liberar(), { capture: true }));
  }

  // ---------------------------------------------------------------- balões
  const Baloes = {
    fila: [],
    vivos: 0,
    pilha() {
      let p = $('wsav-pilha');
      if (!p) { p = document.createElement('div'); p.id = 'wsav-pilha'; p.setAttribute('aria-live', 'polite'); document.body.appendChild(p); }
      return p;
    },
    mostrar(b) { this.fila.push(b); this.proximo(); },
    proximo() {
      while (this.vivos < MAX_BALOES && this.fila.length) this.abrir(this.fila.shift());
    },
    abrir(b) {
      css();
      this.vivos++;
      const el = document.createElement('div');
      el.className = 'wsav-b';
      el.setAttribute('role', 'status');
      el.style.setProperty('--c', b.cor);
      el.style.setProperty('--bg', b.bg);
      el.innerHTML =
        '<div class="wsav-ic"><i class="fa-solid ' + (b.icone || 'fa-bell') + '"></i></div>' +
        '<div class="wsav-cp">' +
        (b.sub ? '<div class="wsav-sub">' + e(b.sub) + '</div>' : '') +
        '<div class="wsav-tt">' + e(b.titulo) + '</div>' +
        (b.linhas || []).map((l) => '<div class="wsav-li">' + l + '</div>').join('') +
        '<div class="wsav-ac">' + (b.acao ? '<button type="button" class="wsav-ver">' + e(b.acao.rot) + '</button>' : '') +
        (cfg().voz ? '<button type="button" class="wsav-ign" title="Silencia a voz. Para ligar de novo: Avisos de Vencimento > Voz e balões"><i class="fa-solid fa-volume-xmark"></i> Ignorar</button>' : '') + '</div>' +
        '</div>' +
        '<button type="button" class="wsav-x" title="Fechar" aria-label="Fechar">&times;</button>' +
        '<div class="wsav-pg" style="animation-duration:' + AUTO_FECHAR_MS + 'ms"></div>';
      this.pilha().appendChild(el);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));

      let fechado = false;
      const fechar = () => {
        if (fechado) return; fechado = true;
        el.classList.add('sai');
        setTimeout(() => { el.remove(); this.vivos--; this.proximo(); }, 380);
      };
      el.querySelector('.wsav-x').onclick = fechar;
      if (b.acao) el.querySelector('.wsav-ver').onclick = () => { b.acao.fn(); fechar(); };
      const ign = el.querySelector('.wsav-ign');
      if (ign) ign.onclick = () => Voz.silenciar();
      // Fecha sozinho quando a barra termina (pausa com o mouse em cima)
      el.querySelector('.wsav-pg').addEventListener('animationend', fechar);
      if (b.voz) Voz.falar(b.voz);
    }
  };

  // ---------------------------------------------------------------- vencimentos
  // Mesma base do relatório: 'historico' (campo expiracao) + ASO dos
  // colaboradores. Um documento renovado só conta pela emissão mais recente.
  function coletarVencimentos() {
    if (typeof DATA === 'undefined') return [];
    const ultimo = {};
    const funcs = DATA.funcionarios || {};
    const tsDe = (h) => Number(h.ts) || 0;
    arr(DATA.historico).forEach((h) => {
      if (!h || !h.expiracao) return;
      if (typeof isBlindagem === 'function' && isBlindagem(h)) return;
      if (typeof histVisivel === 'function' && !histVisivel(h)) return;
      const ehCert = h.tipo === 'certificado' || /^certificado/i.test(String(h.nome || ''));
      let doc = ehCert && typeof getCertCursoName === 'function' ? getCertCursoName(h) : String(h.nome || 'Documento');
      doc = doc.replace(/(\s*\([^()]*\))+\s*$/, '').trim() || (ehCert ? 'Certificado' : 'Documento');
      const ids = Array.isArray(h.funcionarioIds) && h.funcionarioIds.length ? h.funcionarioIds : [null];
      ids.forEach((fid) => {
        const f = fid ? funcs[fid] : null;
        if (f && f.ativo === false) return; // desligado
        if (f && typeof funcVisivel === 'function' && !funcVisivel(f)) return;
        const empId = (f && f.empresaId) || h.empresaId || '';
        if (!podeVerEmpresa(empId)) return;
        const chave = (fid ? 'f' + fid : 'h' + h.id) + '|' + (ehCert ? 'c' : 'd') + '|' + semAcento(doc);
        const atual = ultimo[chave];
        if (atual && atual.ts >= tsDe(h)) return;
        ultimo[chave] = {
          ts: tsDe(h), tipo: ehCert ? 'cert' : 'doc', doc,
          colaborador: (f && f.nome) || '—', empresaId: empId, exp: String(h.expiracao).slice(0, 10)
        };
      });
    });
    arr(funcs).forEach((f) => {
      if (!f || !f.asoDate || f.ativo === false) return;
      if (typeof funcVisivel === 'function' && !funcVisivel(f)) return;
      if (!podeVerEmpresa(f.empresaId)) return;
      ultimo['aso|' + f.id] = { ts: 0, tipo: 'aso', doc: 'ASO', colaborador: f.nome || '—', empresaId: f.empresaId || '', exp: String(f.asoDate).slice(0, 10) };
    });
    const out = [];
    Object.keys(ultimo).forEach((k) => {
      const it = ultimo[k];
      it.dias = diasAte(it.exp);
      it.faixa = faixaDe(it.dias);
      if (it.faixa) out.push(it);
    });
    return out.sort((a, b) => a.dias - b.dias);
  }
  function agruparPorEmpresa(itens) {
    const g = {};
    itens.forEach((it) => {
      const k = it.empresaId || '_';
      if (!g[k]) g[k] = { empresaId: it.empresaId, nome: nomeEmpresa(it.empresaId), itens: [], cont: {} };
      g[k].itens.push(it);
      const c = g[k].cont;
      c[it.tipo] = c[it.tipo] || { vencido: 0, d7: 0, d15: 0, d30: 0 };
      c[it.tipo][it.faixa]++;
    });
    return Object.values(g).sort((a, b) => {
      const peso = (x) => x.itens.filter((i) => i.faixa === 'vencido').length * 1000 + x.itens.filter((i) => i.faixa === 'd7').length;
      return peso(b) - peso(a) || a.nome.localeCompare(b.nome, 'pt-BR');
    });
  }
  const ROT_TIPO = { cert: ['certificado', 'certificados'], doc: ['documento', 'documentos'], aso: ['ASO', 'ASOs'] };
  function frase(n, tipo, faixa) {
    const nome = ROT_TIPO[tipo][n === 1 ? 0 : 1];
    if (faixa === 'vencido') return n + ' ' + nome + (n === 1 ? ' vencido' : ' vencidos');
    const prazo = { d7: '7', d15: '15', d30: '30' }[faixa];
    return n + ' ' + nome + (n === 1 ? ' vence' : ' vencem') + ' em até ' + prazo + ' dias';
  }
  function baloesEmpresa(grupo) {
    const linhas = [], falas = [];
    ['cert', 'doc', 'aso'].forEach((tipo) => {
      const c = grupo.cont[tipo]; if (!c) return;
      const partes = [];
      FAIXAS.forEach((f) => { if (c[f.k]) partes.push('<b>' + c[f.k] + '</b> ' + (f.k === 'vencido' ? 'vencido' + (c[f.k] > 1 ? 's' : '') : 'em até ' + f.k.slice(1) + ' dias')); });
      const tit = { cert: 'Certificados', doc: 'Documentos', aso: 'ASO' }[tipo];
      linhas.push(tit + ': ' + partes.join(' · '));
      FAIXAS.forEach((f) => { if (c[f.k]) falas.push(frase(c[f.k], tipo, f.k)); });
    });
    const temVenc = grupo.itens.some((i) => i.faixa === 'vencido');
    const tem7 = grupo.itens.some((i) => i.faixa === 'd7');
    const f = temVenc ? FAIXAS[0] : tem7 ? FAIXAS[1] : grupo.itens.some((i) => i.faixa === 'd15') ? FAIXAS[2] : FAIXAS[3];
    const juntar = (l) => l.length > 1 ? l.slice(0, -1).join(', ') + ' e ' + l[l.length - 1] : l[0];
    return {
      cor: f.cor, bg: f.bg, icone: temVenc ? 'fa-triangle-exclamation' : 'fa-clock',
      sub: temVenc ? 'Vencimentos atrasados' : 'Vencimentos próximos',
      titulo: grupo.nome, linhas,
      voz: 'Na empresa ' + grupo.nome + ', ' + juntar(falas) + '.',
      acao: { rot: 'Ver detalhes', fn: () => abrirPainel(grupo.empresaId || '_') }
    };
  }

  // ---------------------------------------------------------------- lembretes
  // Consumo do banco: cada usuário baixa SÓ os próprios lembretes
  // ('lembretesUsuario/{usuario}') e os compartilhados ('lembretesComuns').
  // A escuta é por filho (child_added/changed/removed): depois da carga
  // inicial, cada alteração traz só o lembrete alterado, não a lista toda.
  // Os avisos de vencimento leem os dados que o painel já tem em memória e
  // não fazem nenhuma consulta extra ao banco.
  let LEMBRETES = {};
  let lembretesOuvindo = false;
  function chaveUsuario() { return (usuarioId() || 'anon').replace(/[.#$\[\]\/]/g, '_'); }
  function caminhoDe(l) { return l.compartilhado ? 'lembretesComuns/' + l.id : 'lembretesUsuario/' + chaveUsuario() + '/' + l.id; }
  let _avisoTimer = null;
  function lembretesMudaram() {
    clearTimeout(_avisoTimer);
    _avisoTimer = setTimeout(() => {
      if ($('wsav-mdl-lem') && $('wsav-mdl-lem').style.display === 'flex') renderLembretes();
      atualizarBadge();
      agendarVerificacao(1500);
    }, 150);
  }
  // Cada origem (meus / comuns) tem seu mapa: um lembrete que passa de uma
  // para a outra gera "removido" numa e "adicionado" na outra, e a ordem dos
  // dois eventos não pode apagá-lo da tela.
  const ORIGENS = { u: {}, c: {} };
  function remontar() { LEMBRETES = Object.assign({}, ORIGENS.u, ORIGENS.c); lembretesMudaram(); }
  function escutar(ref, src) {
    const put = (sn) => { ORIGENS[src][sn.key] = Object.assign({}, sn.val(), { id: sn.key }); remontar(); };
    ref.on('child_added', put, (err) => console.warn('lembretes:', err));
    ref.on('child_changed', put);
    ref.on('child_removed', (sn) => { delete ORIGENS[src][sn.key]; remontar(); });
  }
  function ouvirLembretes() {
    if (lembretesOuvindo || typeof db === 'undefined' || !usuarioId()) return;
    lembretesOuvindo = true;
    escutar(db.ref('lembretesUsuario/' + chaveUsuario()), 'u');
    escutar(db.ref('lembretesComuns'), 'c');
    migrarLembretesAntigos();
  }
  // A primeira versão gravava tudo em 'lembretes/{id}'. Move os itens para a
  // estrutura nova uma única vez (depois o nó fica vazio e a leitura custa
  // praticamente nada).
  function migrarLembretesAntigos() {
    try { if (localStorage.getItem('ws_lem_migrado') === '1') return; } catch (_) { }
    db.ref('lembretes').once('value').then((snap) => {
      const v = snap.val() || {};
      const up = {};
      Object.keys(v).forEach((id) => {
        const l = v[id]; if (!l || typeof l !== 'object') return;
        const dono = String(l.usuarioId || 'anon').replace(/[.#$\[\]\/]/g, '_');
        up[(l.compartilhado ? 'lembretesComuns/' : 'lembretesUsuario/' + dono + '/') + id] = Object.assign({}, l, { id });
        up['lembretes/' + id] = null;
      });
      return Object.keys(up).length ? db.ref().update(up) : null;
    }).then(() => { try { localStorage.setItem('ws_lem_migrado', '1'); } catch (_) { } })
      .catch((err) => console.warn('migração de lembretes:', err));
  }
  function meusLembretes() {
    const uid = usuarioId();
    return arr(LEMBRETES).filter((l) => l && (String(l.usuarioId || '') === uid || l.compartilhado));
  }
  function lembretesEmAlerta() {
    return meusLembretes().filter((l) => !l.concluido).map((l) => {
      const dias = diasAte(l.data);
      return Object.assign({}, l, { dias, faixa: faixaDe(dias) });
    }).filter((l) => l.faixa).sort((a, b) => a.dias - b.dias);
  }
  function balaoLembrete(l) {
    const f = FAIXAS.find((x) => x.k === l.faixa) || FAIXAS[3];
    const tipo = l.tipo === 'tarefa' ? 'Tarefa' : 'Lembrete';
    const quando = textoDias(l.dias) + (l.hora ? ' às ' + l.hora : '');
    return {
      cor: f.cor, bg: f.bg, icone: l.tipo === 'tarefa' ? 'fa-list-check' : 'fa-bell',
      sub: tipo + (l.dias < 0 ? ' atrasada' : ''),
      titulo: l.titulo || '(sem título)',
      linhas: [e(quando.charAt(0).toUpperCase() + quando.slice(1)) + ' · ' + e(fmtData(l.data)) + (l.empresaId ? ' · ' + e(nomeEmpresa(l.empresaId)) : '')],
      voz: tipo + ': ' + (l.titulo || '') + ', ' + quando + '.',
      acao: { rot: 'Abrir', fn: () => abrirLembretes() }
    };
  }

  // ---------------------------------------------------------------- verificação
  const VISTOS_KEY = 'ws_avisos_vistos';
  function vistos() { try { return JSON.parse(sessionStorage.getItem(VISTOS_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function marcarVisto(k) { const v = vistos(); v[k] = Date.now(); try { sessionStorage.setItem(VISTOS_KEY, JSON.stringify(v)); } catch (_) { } }
  function deveMostrar(k) { const t = vistos()[k]; return !t || Date.now() - t > REAVISAR_MS; }

  function pronto() {
    return sessionStorage.getItem('ws_logado') === '1' &&
      typeof DATA !== 'undefined' && DATA.empresas && Object.keys(DATA.empresas).length > 0 &&
      typeof USUARIO_ATUAL !== 'undefined' && !!USUARIO_ATUAL;
  }
  let timer = null, saudou = false;
  function agendarVerificacao(ms) { clearTimeout(timer); timer = setTimeout(verificar, ms || 0); }
  function verificar() {
    if (!pronto()) { agendarVerificacao(3000); return; }
    ouvirLembretes();
    atualizarBadge();
    if (!cfg().baloes) return;
    const novos = [];
    agruparPorEmpresa(coletarVencimentos()).forEach((g) => {
      const assinatura = 'emp|' + g.empresaId + '|' + ['cert', 'doc', 'aso'].map((t) => g.cont[t] ? FAIXAS.map((f) => g.cont[t][f.k]).join('.') : '').join('/');
      if (deveMostrar(assinatura)) { marcarVisto(assinatura); novos.push(baloesEmpresa(g)); }
    });
    lembretesEmAlerta().forEach((l) => {
      const k = 'lem|' + l.id + '|' + l.faixa + '|' + l.data + '|' + (l.dias <= 1 ? l.dias : '');
      if (deveMostrar(k)) { marcarVisto(k); novos.push(balaoLembrete(l)); }
    });
    if (!novos.length) return;
    if (!saudou) {
      saudou = true;
      const nome = primeiroNome();
      const h = new Date().getHours();
      const cumprimento = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
      Voz.falar(cumprimento + (nome ? ', ' + nome : '') + '. Você tem ' + (novos.length === 1 ? 'um aviso' : novos.length + ' avisos') + ' de vencimento.');
    }
    novos.forEach((b) => Baloes.mostrar(b));
  }

  function atualizarBadge() {
    const b = $('wsav-badge-av');
    if (b) {
      let n = 0;
      try { n = pronto() ? coletarVencimentos().filter((i) => i.faixa === 'vencido' || i.faixa === 'd7').length : 0; } catch (_) { }
      b.textContent = n ? (n > 99 ? '99+' : String(n)) : '';
    }
    const bl = $('wsav-badge-lem');
    if (bl) { let n = 0; try { n = lembretesEmAlerta().filter((l) => l.dias <= 7).length; } catch (_) { } bl.textContent = n ? String(n) : ''; }
  }

  // ---------------------------------------------------------------- modais
  function modal(id, largura, html) {
    let m = $(id);
    if (!m) {
      m = document.createElement('div');
      m.className = 'modal'; m.id = id;
      m.addEventListener('click', (ev) => { if (ev.target === m) m.style.display = 'none'; });
      document.body.appendChild(m);
    }
    m.innerHTML = '<div class="mb" style="width:' + largura + 'px">' + html + '</div>';
    m.style.display = 'flex';
    return m;
  }
  function stBadge(faixa, dias) {
    const f = FAIXAS.find((x) => x.k === faixa);
    const txt = faixa === 'vencido' ? 'Vencido há ' + (-dias) + 'd' : dias === 0 ? 'Vence hoje' : 'Em ' + dias + 'd';
    return '<span class="wsav-st" style="background:' + f.bg + ';color:' + f.cor + '">' + e(txt) + '</span>';
  }

  // Painel de vencimentos + configurações de voz/balões
  function abrirPainel(empFiltro) {
    css();
    const itens = coletarVencimentos();
    const grupos = agruparPorEmpresa(itens);
    const c = cfg();
    const vozes = Voz.vozes();
    const atual = Voz.melhor();
    const m = modal('wsav-mdl-painel', 860,
      '<div class="mt2"><i class="fa-solid fa-bell" style="color:#dc2626;margin-right:6px"></i> Avisos de vencimento</div>' +
      '<div class="wsav-row" style="margin:6px 0 10px">' +
      '<div class="fg"><label class="fl">Empresa</label><select id="wsav-f-emp"><option value="">Todas (' + grupos.length + ')</option>' +
      grupos.map((g) => '<option value="' + e(g.empresaId || '_') + '">' + e(g.nome) + ' (' + g.itens.length + ')</option>').join('') + '</select></div>' +
      '<div class="fg"><label class="fl">Situação</label><select id="wsav-f-fx"><option value="">Todas</option>' +
      FAIXAS.map((f) => '<option value="' + f.k + '">' + (f.k === 'vencido' ? 'Vencidos' : 'Vencem em até ' + f.k.slice(1) + ' dias') + '</option>').join('') + '</select></div>' +
      '<div class="fg"><label class="fl">Tipo</label><select id="wsav-f-tp"><option value="">Todos</option><option value="cert">Certificados</option><option value="doc">Documentos</option><option value="aso">ASO</option></select></div>' +
      '</div>' +
      '<div class="wsav-lst" id="wsav-tab"></div>' +
      '<details style="margin-top:14px"><summary style="cursor:pointer;font-size:12px;font-weight:600">Voz e balões</summary>' +
      '<div style="padding:10px 2px 0">' +
      '<label class="wsav-tg"><input type="checkbox" id="wsav-c-baloes"' + (c.baloes ? ' checked' : '') + '> Mostrar balões de aviso ao entrar no sistema</label>' +
      '<label class="wsav-tg" style="margin-top:6px"><input type="checkbox" id="wsav-c-voz"' + (c.voz ? ' checked' : '') + '> Ler os avisos em voz alta</label>' +
      '<div class="wsav-row" style="margin-top:10px">' +
      '<div class="fg"><label class="fl">Voz</label><select id="wsav-c-vn">' +
      (vozes.length ? '<option value="">Automática (mais natural disponível)</option>' + vozes.map((v) => '<option value="' + e(v.name) + '"' + (c.vozNome === v.name ? ' selected' : '') + '>' + e(v.name) + '</option>').join('') : '<option value="">Nenhuma voz em português neste navegador</option>') +
      '</select></div>' +
      '<div class="fg" style="max-width:170px"><label class="fl">Velocidade</label><select id="wsav-c-vel">' +
      [['0.9', 'Mais devagar'], ['1', 'Normal'], ['1.1', 'Mais rápida']].map(([v, r]) => '<option value="' + v + '"' + (String(c.velocidade) === v ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></div>' +
      '<div class="fg" style="flex:0"><button class="btn bg2" type="button" id="wsav-c-teste"><i class="fa-solid fa-volume-high"></i> Testar</button></div>' +
      '</div>' +
      '<div class="pd" style="font-size:11px;margin-top:2px">Voz em uso: ' + e(atual ? atual.name : 'nenhuma') + '. As vozes mais humanas são as "Natural" do Microsoft Edge (Francisca, Thalita, Antônio).</div>' +
      '</div></details>' +
      '<div class="ma"><button class="btn bg2" type="button" onclick="this.closest(\'.modal\').style.display=\'none\'">Fechar</button></div>');

    const desenhar = () => {
      const fe = $('wsav-f-emp').value, fx = $('wsav-f-fx').value, tp = $('wsav-f-tp').value;
      const lst = itens.filter((i) => (!fe || (i.empresaId || '_') === fe) && (!fx || i.faixa === fx) && (!tp || i.tipo === tp));
      $('wsav-tab').innerHTML = lst.length
        ? '<table class="wsav-tab"><thead><tr><th>Empresa</th><th>Colaborador</th><th>Documento</th><th>Vencimento</th><th>Situação</th></tr></thead><tbody>' +
          lst.slice(0, 800).map((i) => '<tr><td>' + e(nomeEmpresa(i.empresaId)) + '</td><td>' + e(i.colaborador) + '</td><td>' + e((i.tipo === 'cert' ? 'Certificado ' : '') + i.doc) + '</td><td>' + e(fmtData(i.exp)) + '</td><td>' + stBadge(i.faixa, i.dias) + '</td></tr>').join('') +
          '</tbody></table>' + (lst.length > 800 ? '<div class="es" style="padding:8px">mostrando 800 de ' + lst.length + '</div>' : '')
        : '<div class="es" style="padding:16px">Nenhum vencimento nos próximos 30 dias.</div>';
    };
    ['wsav-f-emp', 'wsav-f-fx', 'wsav-f-tp'].forEach((id) => { $(id).onchange = desenhar; });
    if (empFiltro) $('wsav-f-emp').value = empFiltro;
    desenhar();
    $('wsav-c-baloes').onchange = (ev) => salvarCfg({ baloes: ev.target.checked });
    $('wsav-c-voz').onchange = (ev) => { salvarCfg({ voz: ev.target.checked }); if (!ev.target.checked) Voz.parar(); };
    $('wsav-c-vn').onchange = (ev) => salvarCfg({ vozNome: ev.target.value });
    $('wsav-c-vel').onchange = (ev) => salvarCfg({ velocidade: Number(ev.target.value) });
    $('wsav-c-teste').onclick = () => {
      Voz.parar();
      const nome = primeiroNome();
      Voz.falar('Olá' + (nome ? ', ' + nome : '') + '. Esta é a voz que vai ler os seus avisos de vencimento.', true);
    };
    return m;
  }

  // Lembretes e tarefas
  let lemEditando = null, lemMostrarFeitos = false;
  function abrirLembretes() {
    css();
    ouvirLembretes();
    const emps = (typeof DATA !== 'undefined' ? arr(DATA.empresas) : []).filter((x) => x && x.nome && podeVerEmpresa(x.id)).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    modal('wsav-mdl-lem', 640,
      '<div class="mt2"><i class="fa-solid fa-list-check" style="color:#16a34a;margin-right:6px"></i> Lembretes e tarefas</div>' +
      '<div class="card" style="padding:14px;margin:8px 0 12px" id="wsav-lem-form">' +
      '<div class="fg"><label class="fl">Título *</label><input id="wsav-l-tit" maxlength="140" placeholder="Ex.: Renovar PGR da obra Centro"></div>' +
      '<div class="wsav-row">' +
      '<div class="fg"><label class="fl">Tipo</label><select id="wsav-l-tipo"><option value="tarefa">Tarefa</option><option value="lembrete">Lembrete</option></select></div>' +
      '<div class="fg"><label class="fl">Vence em *</label><input type="date" id="wsav-l-data"></div>' +
      '<div class="fg" style="max-width:120px"><label class="fl">Hora</label><input type="time" id="wsav-l-hora"></div>' +
      '</div>' +
      '<div class="fg"><label class="fl">Empresa (opcional)</label><select id="wsav-l-emp"><option value="">—</option>' + emps.map((x) => '<option value="' + e(x.id) + '">' + e(x.nome) + '</option>').join('') + '</select></div>' +
      '<div class="fg"><label class="fl">Detalhes</label><textarea id="wsav-l-desc" rows="2" maxlength="1000"></textarea></div>' +
      '<label class="wsav-tg"><input type="checkbox" id="wsav-l-comp"> Visível para todos os usuários</label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">' +
      '<button class="btn bg2" type="button" id="wsav-l-cancel" style="display:none">Cancelar edição</button>' +
      '<button class="btn bp" type="button" id="wsav-l-salvar"><i class="fa-solid fa-plus"></i> Adicionar</button></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><div style="font-size:12px;font-weight:700">Pendentes</div>' +
      '<label class="wsav-tg"><input type="checkbox" id="wsav-l-feitos"' + (lemMostrarFeitos ? ' checked' : '') + '> Mostrar concluídos</label></div>' +
      '<div class="wsav-lst" id="wsav-lem-lista"></div>' +
      '<div class="ma"><button class="btn bg2" type="button" onclick="this.closest(\'.modal\').style.display=\'none\'">Fechar</button></div>');
    $('wsav-l-salvar').onclick = salvarLembrete;
    $('wsav-l-cancel').onclick = () => { lemEditando = null; limparForm(); };
    $('wsav-l-feitos').onchange = (ev) => { lemMostrarFeitos = ev.target.checked; renderLembretes(); };
    limparForm();
    renderLembretes();
  }
  function limparForm() {
    ['wsav-l-tit', 'wsav-l-hora', 'wsav-l-desc'].forEach((id) => { $(id).value = ''; });
    const d = new Date(); d.setDate(d.getDate() + 7);
    $('wsav-l-data').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    $('wsav-l-tipo').value = 'tarefa'; $('wsav-l-emp').value = ''; $('wsav-l-comp').checked = false;
    $('wsav-l-salvar').innerHTML = '<i class="fa-solid fa-plus"></i> Adicionar';
    $('wsav-l-cancel').style.display = 'none';
  }
  function renderLembretes() {
    const box = $('wsav-lem-lista'); if (!box) return;
    const uid = usuarioId();
    const lst = meusLembretes().filter((l) => lemMostrarFeitos || !l.concluido)
      .sort((a, b) => (a.concluido ? 1 : 0) - (b.concluido ? 1 : 0) || String(a.data || '').localeCompare(String(b.data || '')) || String(a.hora || '').localeCompare(String(b.hora || '')));
    box.innerHTML = lst.length ? lst.map((l) => {
      const dias = diasAte(l.data);
      const fx = faixaDe(dias);
      const meu = String(l.usuarioId || '') === uid;
      const st = l.concluido ? '<span class="wsav-st" style="background:#dcfce7;color:#15803d">Concluído</span>'
        : fx ? stBadge(fx, dias) : '<span class="wsav-st" style="background:#f4f4f5;color:#52525b">' + e(textoDias(dias)) + '</span>';
      return '<div class="wsav-lr' + (l.concluido ? ' feito' : '') + '">' +
        '<input type="checkbox" class="wsav-chk" title="Concluir" data-ok="' + e(l.id) + '"' + (l.concluido ? ' checked' : '') + '>' +
        '<div style="min-width:0"><div class="wsav-lt">' + (l.tipo === 'lembrete' ? '<i class="fa-solid fa-bell" style="font-size:11px;color:#a1a1aa;margin-right:5px"></i>' : '') + e(l.titulo) + '</div>' +
        '<div class="wsav-ld">' + st + ' &nbsp;' + e(fmtData(l.data)) + (l.hora ? ' às ' + e(l.hora) : '') +
        (l.empresaId ? ' · ' + e(nomeEmpresa(l.empresaId)) : '') +
        (l.compartilhado ? ' · <i class="fa-solid fa-users" title="Visível para todos"></i>' + (meu ? '' : ' por ' + e(l.usuarioNome || '?')) : '') + '</div>' +
        (l.descricao ? '<div class="wsav-ld" style="white-space:pre-wrap">' + e(l.descricao) + '</div>' : '') + '</div>' +
        (meu ? '<div class="wsav-la"><button type="button" title="Editar" data-ed="' + e(l.id) + '"><i class="fa-solid fa-pen"></i></button><button type="button" title="Excluir" data-del="' + e(l.id) + '"><i class="fa-solid fa-trash"></i></button></div>' : '') +
        '</div>';
    }).join('') : '<div class="es" style="padding:16px">Nenhum lembrete' + (lemMostrarFeitos ? '' : ' pendente') + '.</div>';
    box.querySelectorAll('[data-ok]').forEach((el) => { el.onchange = () => concluir(el.getAttribute('data-ok'), el.checked); });
    box.querySelectorAll('[data-ed]').forEach((el) => { el.onclick = () => editar(el.getAttribute('data-ed')); });
    box.querySelectorAll('[data-del]').forEach((el) => { el.onclick = () => excluir(el.getAttribute('data-del')); });
  }
  function editar(id) {
    const l = LEMBRETES[id]; if (!l) return;
    lemEditando = id;
    $('wsav-l-tit').value = l.titulo || ''; $('wsav-l-tipo').value = l.tipo || 'tarefa';
    $('wsav-l-data').value = l.data || ''; $('wsav-l-hora').value = l.hora || '';
    $('wsav-l-emp').value = l.empresaId || ''; $('wsav-l-desc').value = l.descricao || '';
    $('wsav-l-comp').checked = !!l.compartilhado;
    $('wsav-l-salvar').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar';
    $('wsav-l-cancel').style.display = '';
    $('wsav-l-tit').focus();
  }
  async function salvarLembrete() {
    const titulo = $('wsav-l-tit').value.trim();
    const data = $('wsav-l-data').value;
    if (!titulo) { alert('Informe o título.'); $('wsav-l-tit').focus(); return; }
    if (!data) { alert('Informe a data de vencimento.'); return; }
    const rec = {
      titulo, data, hora: $('wsav-l-hora').value || '', tipo: $('wsav-l-tipo').value,
      empresaId: $('wsav-l-emp').value || '', descricao: $('wsav-l-desc').value.trim(),
      compartilhado: $('wsav-l-comp').checked, atualizadoEm: Date.now()
    };
    const btn = $('wsav-l-salvar'); btn.disabled = true;
    try {
      if (lemEditando && LEMBRETES[lemEditando]) {
        const antigo = LEMBRETES[lemEditando];
        const novo = Object.assign({}, antigo, rec);
        delete novo._;
        const de = caminhoDe(antigo), para = caminhoDe(novo);
        if (de === para) await db.ref(para).update(rec);
        else { const up = {}; up[para] = novo; up[de] = null; await db.ref().update(up); } // passou a ser (ou deixou de ser) para todos
      } else {
        const id = db.ref().push().key;
        const novo = Object.assign(rec, { id, usuarioId: usuarioId(), usuarioNome: usuarioNome(), concluido: false, criadoEm: Date.now() });
        await db.ref(caminhoDe(novo)).set(novo);
      }
      lemEditando = null; limparForm();
    } catch (err) { alert('Não foi possível salvar: ' + (err && err.message ? err.message : err)); }
    finally { btn.disabled = false; }
  }
  function concluir(id, ok) {
    const l = LEMBRETES[id]; if (!l) return;
    db.ref(caminhoDe(l)).update({ concluido: !!ok, concluidoEm: ok ? Date.now() : null, concluidoPor: ok ? usuarioNome() : null })
      .catch((err) => alert('Não foi possível atualizar: ' + err.message));
  }
  function excluir(id) {
    const l = LEMBRETES[id]; if (!l) return;
    if (!confirm('Excluir "' + (l.titulo || '') + '"?')) return;
    db.ref(caminhoDe(l)).remove().catch((err) => alert('Não foi possível excluir: ' + err.message));
  }

  // ---------------------------------------------------------------- menu
  function instalarMenu() {
    const dash = document.querySelector('aside .mi[onclick^="nav(\'dash\'"]');
    if (!dash || $('wsav-mi-av')) return;
    css();
    const mk = (id, ic, txt, badgeId, fn) => {
      const d = document.createElement('div');
      d.className = 'mi'; d.id = id;
      d.innerHTML = '<i class="fa-solid ' + ic + '"></i> ' + txt + '<span class="wsav-badge" id="' + badgeId + '"></span>';
      d.addEventListener('click', fn);
      return d;
    };
    const lem = mk('wsav-mi-lem', 'fa-list-check', 'Lembretes e Tarefas', 'wsav-badge-lem', () => abrirLembretes());
    const av = mk('wsav-mi-av', 'fa-bell', 'Avisos de Vencimento', 'wsav-badge-av', () => abrirPainel());
    dash.after(lem); dash.after(av);
  }

  // ---------------------------------------------------------------- início
  function iniciar() {
    instalarMenu();
    agendarVerificacao(2500);
    // revisa a cada 10 min (vira o dia, dados novos chegam, etc.)
    setInterval(() => { if (pronto()) verificar(); }, 10 * 60 * 1000);
    // depois do login o painel chama renderAll; um pouco depois revisamos
    const orig = window.renderAll;
    if (typeof orig === 'function' && !orig.__wsav) {
      const emb = function () { const r = orig.apply(this, arguments); agendarVerificacao(2000); return r; };
      emb.__wsav = true;
      window.renderAll = emb;
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  window.WS_AVISOS = { verificar, abrirPainel, abrirLembretes, voz: Voz, coletarVencimentos };
})();
