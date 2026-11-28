/**
 * WS Documentos — Avisos de RH por e-mail (Google Apps Script)
 *
 * Envia um e-mail quando um colaborador é ADMITIDO (cadastrado ativo) ou
 * DESLIGADO no sistema WS Documentos, para os e-mails de RH cadastrados na
 * empresa dele (campo "E-mails para avisos de RH") e para a cópia definida em
 * Configurações.
 *
 * Grátis: usa a cota de e-mails da conta Google onde o script roda
 * (Gmail comum ~100 destinatários/dia; Google Workspace ~1.500/dia).
 *
 * COMO INSTALAR (uma vez só, na conta Google que vai enviar os e-mails):
 *  1. Acesse https://script.google.com e clique em "Novo projeto".
 *  2. Apague o conteúdo do arquivo Code.gs, cole TODO este arquivo e salve.
 *  3. No menu de funções (barra de cima), escolha "instalarVerificacaoDiaria"
 *     e clique em Executar. Autorize o acesso quando o Google pedir
 *     (enviar e-mail e acessar serviço externo). Isso cria a conferência
 *     diária das 7h, que pega admissões/desligamentos que não foram avisados
 *     na hora (ex.: importação em massa).
 *  4. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
 *     - Executar como: Eu
 *     - Quem pode acessar: Qualquer pessoa
 *     Clique em Implantar e copie o "URL do app da Web" (termina em /exec).
 *  5. No WS Documentos: Configurações > Avisos de RH por e-mail > cole o URL,
 *     salve e clique em "Enviar e-mail de teste".
 *
 * Segurança: o sistema só informa QUAL colaborador e QUAL evento. O script
 * confere no banco que o evento é real e só envia para os e-mails cadastrados
 * na empresa (e para a cópia). Cada aviso fica registrado em avisosRH e não é
 * enviado duas vezes.
 */

var DB = 'https://cadastr-produtos-clevir-default-rtdb.firebaseio.com';
var NOME_REMETENTE = 'WS Engenharia - Avisos de RH';

// ───────────────────────── entrada (chamada pelo sistema)
function doGet(e) {
  var p = (e && e.parameter) || {};
  var r;
  try {
    if (p.teste) r = enviarTeste(p.para);
    else if (p.f && p.t) r = enviarEvento(String(p.f), String(p.t));
    else r = { ok: false, erro: 'parametros' };
  } catch (err) {
    r = { ok: false, erro: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(r)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── banco (Firebase Realtime Database, REST)
function fb(path, query) {
  var url = DB + '/' + path + '.json' + (query ? '?' + query : '');
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Banco: HTTP ' + res.getResponseCode());
  return JSON.parse(res.getContentText());
}
function fbPut(path, val) {
  UrlFetchApp.fetch(DB + '/' + path + '.json', {
    method: 'put', contentType: 'application/json', payload: JSON.stringify(val), muteHttpExceptions: true
  });
}
function chaveSegura(s) { return String(s || '').replace(/[.#$\[\]\/]/g, '_'); }
function semNota(s) { var t = String(s || ''), a; do { a = t; t = t.replace(/\s*\([^()]*\)/g, ''); } while (t !== a); return t.replace(/\s{2,}/g, ' ').trim(); }
function nomeDe(col, id) {
  if (!id) return '';
  try { var r = fb(col + '/' + encodeURIComponent(id)); if (r && r.nome) return semNota(r.nome); } catch (e) { }
  return semNota(id); // registros antigos guardam o nome no lugar do id
}
function dataBR(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : '—'; }
function emails(txt) {
  return String(txt || '').split(/[,;\s]+/).map(function (x) { return x.trim(); })
    .filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
}

// ───────────────────────── envio de um evento
function enviarEvento(fid, tipo) {
  if (tipo !== 'admissao' && tipo !== 'desligamento') return { ok: false, erro: 'tipo' };
  var f = fb('funcionarios/' + encodeURIComponent(fid));
  if (!f) return { ok: false, erro: 'colaborador nao encontrado' };
  // o evento precisa ser verdade no banco
  if (tipo === 'desligamento' && f.ativo !== false) return { ok: false, erro: 'colaborador nao esta desligado' };
  if (tipo === 'admissao' && f.ativo === false) return { ok: false, erro: 'colaborador esta desligado' };

  var dataEv = tipo === 'desligamento' ? (f.dataDemissao || '') : (f.dataAdm || '');
  var chave = chaveSegura(fid + '_' + tipo + '_' + (dataEv || 'sem-data'));
  if (fb('avisosRH/' + chave)) return { ok: true, repetido: true };

  var emp = f.empresaId ? (fb('empresas/' + encodeURIComponent(f.empresaId)) || {}) : {};
  var cfg = fb('config') || {};
  var para = emails(emp.emailsRH);
  var copia = emails(cfg.emailsRHCopia).filter(function (x) { return para.indexOf(x) < 0; });
  var registro = {
    tipo: tipo, funcionarioId: fid, colaborador: semNota(f.nome), empresa: semNota(emp.nome || ''),
    data: dataEv, ts: Date.now()
  };
  if (!para.length && !copia.length) {
    registro.status = 'sem e-mail cadastrado';
    fbPut('avisosRH/' + chave, registro);
    return { ok: false, erro: 'sem destinatario' };
  }

  var cargo = f.funcao ? nomeDe('cargos', f.funcao) : '';
  var linhas = [
    ['Colaborador', semNota(f.nome)],
    ['Matrícula', f.matricula || '—'],
    ['Empresa', semNota(emp.nome || '—')],
    ['Cargo / Função', cargo || '—'],
    ['Obra', nomeDe('obras', f.obraId) || '—'],
    ['Cidade', nomeDe('cidades', f.cidadeId) || '—'],
    ['Data de admissão', dataBR(f.dataAdm)]
  ];
  if (tipo === 'desligamento') linhas.push(['Data de desligamento', dataBR(f.dataDemissao)]);
  var lembretes = tipo === 'desligamento'
    ? ['ASO demissional', 'Recolher EPIs e crachá', 'Baixa nos treinamentos e na obra']
    : ['ASO admissional', 'Ficha Admissional e Ordem de Serviço', 'Entrega de EPIs e treinamentos obrigatórios'];

  var titulo = tipo === 'desligamento' ? 'Desligamento de colaborador' : 'Admissão de colaborador';
  var assunto = titulo + ' - ' + semNota(f.nome) + (emp.nome ? ' - ' + semNota(emp.nome) : '');
  var html = montarHtml(titulo, linhas, lembretes, tipo);

  MailApp.sendEmail({
    to: (para.length ? para : copia).join(','),
    cc: para.length ? copia.join(',') : '',
    subject: assunto,
    htmlBody: html,
    name: NOME_REMETENTE
  });
  registro.status = 'enviado';
  registro.para = para.concat(copia).join(', ');
  fbPut('avisosRH/' + chave, registro);
  return { ok: true };
}

function montarHtml(titulo, linhas, lembretes, tipo) {
  var cor = tipo === 'desligamento' ? '#b91c1c' : '#15803d';
  var tr = linhas.map(function (l) {
    return '<tr><td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;color:#71717a;font-size:13px;width:42%">' + l[0] +
      '</td><td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;color:#18181b;font-size:13px;font-weight:600">' + esc(l[1]) + '</td></tr>';
  }).join('');
  var li = lembretes.map(function (x) { return '<li style="margin:3px 0">' + x + '</li>'; }).join('');
  return '<div style="background:#f4f4f5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e4e4e7">' +
    '<div style="background:#3c3e44;padding:18px 22px;color:#f4f5f8">' +
    '<div style="font-size:12px;letter-spacing:.5px;color:#b6b8c4">WS ENGENHARIA · AVISO DE RH</div>' +
    '<div style="font-size:20px;font-weight:700;margin-top:4px">' + titulo + '</div></div>' +
    '<div style="height:4px;background:' + cor + '"></div>' +
    '<div style="padding:18px 22px">' +
    '<table style="width:100%;border-collapse:collapse">' + tr + '</table>' +
    '<div style="margin-top:18px;padding:12px 14px;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;font-size:13px;color:#3f3f46">' +
    '<b>Providências comuns:</b><ul style="margin:6px 0 0 18px;padding:0">' + li + '</ul></div>' +
    '</div>' +
    '<div style="padding:12px 22px;border-top:1px solid #e4e4e7;font-size:11px;color:#a1a1aa">' +
    'Aviso automático do sistema WS Documentos. Não responda este e-mail.</div>' +
    '</div></div>';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// ───────────────────────── teste
function enviarTeste(para) {
  var lista = emails(para);
  if (!lista.length) return { ok: false, erro: 'email invalido' };
  var html = montarHtml('Teste de envio', [
    ['Situação', 'Avisos de RH configurados'], ['Enviado em', Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm')]
  ], ['Nada a fazer: este é só um teste.'], 'admissao');
  MailApp.sendEmail({ to: lista[0], subject: 'Teste - Avisos de RH do WS Documentos', htmlBody: html, name: NOME_REMETENTE });
  fbPut('avisosRH/teste_' + Date.now(), { tipo: 'teste', para: lista[0], status: 'enviado', ts: Date.now() });
  return { ok: true };
}

// ───────────────────────── conferência diária
// Lê SÓ o registro de alterações dos colaboradores desde a última conferência
// (não baixa a lista inteira) e avisa o que ficou para trás.
function verificacaoDiaria() {
  var props = PropertiesService.getScriptProperties();
  var desde = props.getProperty('ultimaMudanca') || '';
  var q = 'orderBy=%22%24key%22' + (desde ? '&startAt=' + encodeURIComponent(JSON.stringify(desde)) : '&limitToLast=200');
  var muds = fb('_mudancas/funcionarios', q) || {};
  var chaves = Object.keys(muds).sort();
  var ids = {};
  chaves.forEach(function (k) { var m = muds[k]; (m && m.k || []).forEach(function (id) { ids[id] = 1; }); });
  var limite = new Date(); limite.setDate(limite.getDate() - 3);
  var limiteIso = Utilities.formatDate(limite, 'America/Sao_Paulo', 'yyyy-MM-dd');
  Object.keys(ids).forEach(function (id) {
    try {
      var f = fb('funcionarios/' + encodeURIComponent(id));
      if (!f) return;
      if (f.ativo === false && f.dataDemissao && f.dataDemissao >= limiteIso) enviarEvento(id, 'desligamento');
      else if (f.ativo !== false && f.dataAdm && f.dataAdm >= limiteIso) enviarEvento(id, 'admissao');
    } catch (e) { console.warn(e); }
  });
  if (chaves.length) props.setProperty('ultimaMudanca', chaves[chaves.length - 1]);
}
function instalarVerificacaoDiaria() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'verificacaoDiaria') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('verificacaoDiaria').timeBased().everyDays(1).atHour(7).inTimezone('America/Sao_Paulo').create();
  verificacaoDiaria();
}
