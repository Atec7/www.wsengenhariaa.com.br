/* ws-notas.js — anotações internas nos cadastros.
 *
 * Texto entre parênteses no NOME de um cadastro (colaborador, empresa, cargo,
 * curso, obra, cidade, filial, contrato, material, pessoa, título de texto,
 * usuário) aparece nas telas e nas buscas, mas não sai nos documentos.
 *   Ex.: "JOÃO SILVA (turma B)" -> no PDF: "JOÃO SILVA"
 *
 * Como funciona: monta a lista dos nomes cadastrados que têm parênteses e,
 * no momento em que o texto vai para o documento, troca cada nome pela versão
 * sem a anotação. Só os NOMES dos cadastros são trocados: o conteúdo dos
 * textos de OS/NR (que pode ter parênteses de verdade) não muda.
 *  - jsPDF (painel, geração em massa, documento coringa): cada documento
 *    criado tem o seu doc.text interceptado.
 *  - Certificados (HTML -> PDF): o HTML das páginas do certificado e da lista
 *    de presença passa pelo mesmo filtro.
 */
(function () {
  'use strict';
  var RX = /\s*\([^()]*\)/g;
  var CAMPOS = ['nome', 'titulo', 'razaoSocial', 'nomeFantasia'];

  function semNota(s) {
    var t = String(s == null ? '' : s), ant;
    do { ant = t; t = t.replace(RX, ''); } while (t !== ant);
    return t.replace(/\s{2,}/g, ' ').trim();
  }

  function valores(col) {
    if (!col) return [];
    if (Array.isArray(col)) return col;
    if (typeof col === 'object') return Object.keys(col).map(function (k) { return col[k]; });
    return [];
  }
  // Coleções de cadastro de cada tela (as que existirem nela)
  function fontes() {
    var out = [];
    try {
      if (typeof DATA !== 'undefined' && DATA) {
        ['funcionarios', 'empresas', 'cargos', 'obras', 'cidades', 'filiais', 'contratos', 'materiais', 'pessoas', 'textos', 'usuarios', 'coringaTextos', 'cursos']
          .forEach(function (k) { out.push(DATA[k]); });
      }
    } catch (e) { }
    try { if (typeof empresasData !== 'undefined') out.push(empresasData); } catch (e) { }
    try { if (typeof cursosData !== 'undefined') out.push(cursosData); } catch (e) { }
    try { if (typeof alunosData !== 'undefined') out.push(alunosData); } catch (e) { }
    try { if (typeof certAlunos === 'function') out.push(certAlunos()); } catch (e) { }
    try {
      // retrato gravado nos certificados emitidos (nome do aluno/curso na época)
      if (typeof certificadosGeradosData !== 'undefined') {
        valores(certificadosGeradosData).forEach(function (c) { if (c) { out.push([c.aluno, c.curso, c.empresa]); } });
      }
    } catch (e) { }
    return out;
  }

  var cache = null, cacheEm = 0;
  function pares() {
    if (cache && Date.now() - cacheEm < 3000) return cache;
    var mapa = {};
    fontes().forEach(function (col) {
      valores(col).forEach(function (r) {
        if (!r || typeof r !== 'object') return;
        CAMPOS.forEach(function (k) {
          var v = r[k];
          if (typeof v !== 'string' || v.indexOf('(') < 0) return;
          var orig = v.trim(), limpo = semNota(orig);
          if (!limpo || limpo === orig) return;
          mapa[orig] = limpo;
          mapa[orig.toUpperCase()] = limpo.toUpperCase();
        });
      });
    });
    cache = Object.keys(mapa).sort(function (a, b) { return b.length - a.length; }).map(function (k) { return [k, mapa[k]]; });
    cacheEm = Date.now();
    return cache;
  }

  function limpar(x) {
    if (typeof x === 'string') {
      if (x.indexOf('(') < 0) return x;
      var t = x;
      pares().forEach(function (p) { if (t.indexOf(p[0]) >= 0) t = t.split(p[0]).join(p[1]); });
      return t;
    }
    if (Array.isArray(x)) return x.map(limpar);
    return x;
  }

  // jsPDF: o método text é próprio de cada documento, então é trocado quando
  // o documento é criado (evento 'initialized' dos plugins do jsPDF).
  function instalarJsPDF() {
    var J = window.jspdf && window.jspdf.jsPDF;
    if (!J || !J.API || J.API.__wsNotas) return;
    J.API.__wsNotas = true;
    if (!J.API.events) J.API.events = [];
    J.API.events.push(['initialized', function () {
      var doc = this, orig = doc.text;
      if (typeof orig !== 'function' || orig.__wsNotas) return;
      var novo = function () {
        var a = Array.prototype.slice.call(arguments);
        try { a[0] = limpar(a[0]); } catch (e) { }
        return orig.apply(doc, a);
      };
      novo.__wsNotas = true;
      doc.text = novo;
    }]);
  }

  // Certificados: o HTML das páginas passa pelo filtro.
  function envolverHtml(nome) {
    var f = window[nome];
    if (typeof f !== 'function' || f.__wsNotas) return;
    var novo = function () { return limpar(f.apply(this, arguments)); };
    novo.__wsNotas = true;
    window[nome] = novo;
  }
  function instalarHtml() {
    ['buildPage1', 'buildPage2', 'buildListaPresenca'].forEach(envolverHtml);
  }

  instalarJsPDF();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { instalarJsPDF(); instalarHtml(); });
  else { instalarJsPDF(); instalarHtml(); }
  window.addEventListener('load', function () { instalarJsPDF(); instalarHtml(); });

  window.WS_NOTAS = { semNota: semNota, limpar: limpar, invalidar: function () { cache = null; } };
})();
