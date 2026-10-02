// ============================================================
//  /api/lembretes — rotinas automáticas, chamadas a cada 10 min pelo GitHub
//  Actions (.github/workflows/lembretes.yml; o plano Hobby da Vercel só permite
//  cron diário). Fica tudo neste endpoint porque o plano Hobby também limita o
//  número de funções — não dá pra criar uma por rotina.
// ------------------------------------------------------------
//  1) LEMBRETES DE AGENDAMENTO — agendamentos com "data_iso" que ainda não tiveram
//     lembrete: manda WhatsApp quando entra na janela configurada pela empresa (aba
//     Ferramentas do agente, "Alerta de agendamento" → alertaAgendamentoMin).
//  2) RETOMADA DE CONVERSAS PARADAS — a empresa falou por último e o cliente sumiu
//     há X horas: manda uma mensagem curta retomando o assunto (escrita pela IA ou
//     texto fixo). Uma vez só por "silêncio" do cliente.
//  3) COBRANÇA AUTOMÁTICA — contas a receber do Financeiro (tabela lancamentos):
//     lembrete antes do vencimento, no dia e depois de vencida (a cada N dias, até
//     M vezes), juntando numa mensagem só as contas do mesmo cliente.
//  As regras de 2 e 3 ficam em app_config (id = 'automacoes', uma linha por empresa,
//  tela Automações do app) e cada envio fica em automacao_envios (script 29).
// ============================================================
const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_ANON_KEY;
const { readConfig } = require('./_configStore');

// não avisa mais de X minutos depois do horário marcado (evita disparar um
// lembrete "atrasado" pra um agendamento que já passou há muito tempo, caso
// o cron fique parado ou atrasado por algum motivo)
const GRACE_MIN = 60;
// teto de mensagens automáticas (retomada + cobrança) por empresa a cada execução —
// o que sobrar sai na próxima (10 min depois), em vez de uma rajada que o WhatsApp
// poderia entender como spam
const MAX_ENVIOS_POR_RODADA = 15;
const PAUSA_ENTRE_ENVIOS_MS = 1200;
const FUSO = 'America/Sao_Paulo';

function sbHeaders(extra) {
  return Object.assign({ apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json' }, extra || {});
}
async function sbGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase ' + r.status + ' em ' + path.split('?')[0] + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCanalDaEmpresa(empresaId) {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/canais?empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=uazapi_base_url,uazapi_instance_token&limit=1', {
      headers: sbHeaders(),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0]) || null;
  } catch (e) { return null; }
}

async function uazapiSendText(base, token, to, text) {
  try {
    const r = await fetch(base.replace(/\/+$/, '') + '/send/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ number: to, text: text }),
    });
    if (!r.ok) { console.error('[lembretes] falha ao enviar:', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('[lembretes] erro ao enviar:', e.message || e); return false; }
}

async function uazapiPost(canal, path, body) {
  const r = await fetch(String(canal.uazapi_base_url).replace(/\/+$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: canal.uazapi_instance_token },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('uazapi ' + path + ' ' + r.status);
  return r.json();
}

// ---------- 1) lembretes de agendamento ----------
async function marcarLembreteEnviado(id) {
  await fetch(SUPA_URL + '/rest/v1/agendamentos?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ lembrete_enviado: true }),
  });
}

function montarMensagem(nome, quando) {
  const primeiroNome = (nome || '').trim().split(/\s+/)[0] || '';
  const saudacaoNome = primeiroNome ? (primeiroNome + ', ') : '';
  return 'Olá! ' + saudacaoNome + 'passando pra lembrar do seu agendamento' + (quando ? (' em ' + quando) : '') + '. Até lá! 🙂';
}

async function rodarLembretes(agora, ctx) {
  const janelaMaxima = new Date(agora + 24 * 60 * 60 * 1000).toISOString(); // olha até 24h à frente
  const agendamentos = await sbGet('agendamentos?status=eq.ativo&lembrete_enviado=eq.false&data_iso=not.is.null&data_iso=lte.' + encodeURIComponent(janelaMaxima)
    + '&select=id,telefone,nome,quando,empresa_id,data_iso&order=data_iso.asc&limit=500');
  let enviados = 0, pulados = 0;
  for (const ag of agendamentos) {
    const dataIsoMs = new Date(ag.data_iso).getTime();
    if (isNaN(dataIsoMs)) continue;
    if (dataIsoMs < agora - GRACE_MIN * 60000) continue; // já passou demais — não avisa mais

    const cfg = (await ctx.agente(ag.empresa_id)) || {};
    const alertaMin = Number(cfg.alertaAgendamentoMin) || 0;
    if (alertaMin <= 0) { pulados++; continue; } // lembrete desativado para este agente/empresa

    const janelaInicioMs = dataIsoMs - alertaMin * 60000;
    if (agora < janelaInicioMs) { pulados++; continue; } // ainda não chegou a hora de avisar

    const canal = await ctx.canal(ag.empresa_id);
    if (!canal || !canal.uazapi_base_url || !canal.uazapi_instance_token) { pulados++; continue; }

    const texto = montarMensagem(ag.nome, ag.quando);
    const ok = await uazapiSendText(canal.uazapi_base_url, canal.uazapi_instance_token, ag.telefone, texto);
    if (ok) { await marcarLembreteEnviado(ag.id); enviados++; }
  }
  return { verificados: agendamentos.length, enviados, pulados };
}

// ---------- utilidades de data/hora (sempre no fuso de Brasília) ----------
function partesSP(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { ymd: p.year + '-' + p.month + '-' + p.day, hora: Number(p.hour) % 24, diaSemana: p.weekday }; // weekday: Sun..Sat
}
function diasEntre(deYmd, ateYmd) {
  const a = deYmd.split('-').map(Number), b = ateYmd.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}
function addDias(ymd, n) {
  const p = ymd.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function fmtData(ymd) { const p = String(ymd || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
function fmtMoney(v) { return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// timestamp da uazapi vem em segundos ou em milissegundos, dependendo do campo
function toMs(v) { const n = Number(v || 0); return n > 0 && n < 1e12 ? n * 1000 : n; }
const num = (v, def, min, max) => { const n = Number(v); return Math.min(max, Math.max(min, isNaN(n) || v === '' || v == null ? def : n)); };

// regras padrão — a tela Automações grava por cima disso
function normalizarRegras(data) {
  const d = data || {}, h = d.horario || {}, r = d.retomada || {}, c = d.cobranca || {};
  return {
    horario: { inicio: num(h.inicio, 9, 0, 23), fim: num(h.fim, 19, 1, 24), sabado: h.sabado !== false, domingo: !!h.domingo },
    retomada: { ativo: !!r.ativo, horas: num(r.horas, 24, 1, 168), maxDias: num(r.maxDias, 3, 1, 14), modo: r.modo === 'texto' ? 'texto' : 'ia',
      texto: r.texto || 'Oi {nome}, tudo bem? Conseguiu ver minha última mensagem? Qualquer dúvida, estou à disposição! 🙂' },
    cobranca: { ativo: !!c.ativo, diasAntes: num(c.diasAntes, 1, 0, 15), noDia: c.noDia !== false, depoisCadaDias: num(c.depoisCadaDias, 3, 1, 30), depoisMax: num(c.depoisMax, 3, 0, 10),
      pix: c.pix || '',
      textoAntes: c.textoAntes || 'Olá {nome}, tudo bem? Passando para lembrar que {descricao} no valor de {valor} vence em {vencimento}.{pix}',
      textoDia: c.textoDia || 'Olá {nome}, tudo bem? Hoje é o vencimento de {descricao}, no valor de {valor}. Se já pagou, é só desconsiderar.{pix}',
      textoDepois: c.textoDepois || 'Olá {nome}, tudo bem? Consta em aberto {descricao}, no valor de {valor}, que venceu em {vencimento}. Se já pagou, me envie o comprovante, por favor. Qualquer dúvida estou à disposição!{pix}' },
  };
}
// fora do horário comercial configurado, nenhuma mensagem automática sai (só os
// lembretes de agendamento, que têm hora marcada pelo próprio cliente)
function dentroDoHorario(regras, agora) {
  const p = partesSP(agora);
  if (p.diaSemana === 'Sun' && !regras.horario.domingo) return false;
  if (p.diaSemana === 'Sat' && !regras.horario.sabado) return false;
  return p.hora >= regras.horario.inicio && p.hora < regras.horario.fim;
}
function preencher(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)).replace(/[ \t]+\n/g, '\n').trim(); }

async function registrarEnvio(empresaId, tipo, telefone, nome, referencia, mensagem) {
  try {
    await fetch(SUPA_URL + '/rest/v1/automacao_envios', {
      method: 'POST',
      headers: sbHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ empresa_id: empresaId, tipo, telefone, nome: nome || null, referencia: referencia == null ? null : String(referencia), mensagem }),
    });
  } catch (e) { console.error('[automacoes] não registrou envio:', e.message || e); }
}

// ---------- 2) retomada de conversas paradas ----------
async function gerarRetomadaIA(historico, nome, agente, empresaNome) {
  const key = process.env.GEMINI_API_KEY || (agente && agente.geminiKey);
  if (!key || !historico) return '';
  const model = (agente && agente.model) || process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const system = 'Você é atendente' + (empresaNome ? ' da empresa ' + empresaNome : '') + ' no WhatsApp. A conversa abaixo parou: a empresa mandou a última mensagem e o cliente não respondeu. '
    + 'Escreva UMA mensagem curta (no máximo 2 frases) para retomar o assunto de forma natural, gentil e sem pressionar, em português do Brasil. '
    + 'Retome o último assunto concreto da conversa. Não invente preços, prazos nem informações que não estejam na conversa. Não se apresente de novo. '
    + 'Responda só com o texto da mensagem, sem aspas.';
  const prompt = 'Nome do cliente: ' + (nome || 'cliente') + '\n\nConversa (mais antigas primeiro):\n' + historico;
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.6 } }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error((data.error && data.error.message) || r.status);
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || '').join('').trim().replace(/^["“]|["”]$/g, '');
  } catch (e) { console.error('[retomada] IA falhou, usando texto fixo:', e.message || e); return ''; }
}

function textoDaMsg(m) {
  let t = m.text || m.content || m.caption || (m.message && (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || '';
  if (t && typeof t === 'object') t = t.text || t.caption || t.body || '';
  return typeof t === 'string' && t ? t : '[mídia]';
}

async function rodarRetomadas(empresaId, regras, canal, agora, ctx, cota) {
  const r = regras.retomada, out = { enviados: 0, verificados: 0 };
  if (!r.ativo || cota.restante <= 0) return out;
  const silencioMinMs = r.horas * 3600000, silencioMaxMs = silencioMinMs + r.maxDias * 86400000;
  const resp = await uazapiPost(canal, '/chat/find', { operator: 'AND', sort: '-wa_lastMsgTimestamp', limit: 100, offset: 0, wa_isGroup: false });
  const chats = (resp.chats || resp.data || (Array.isArray(resp) ? resp : []) || []).filter((ch) => {
    const ts = toMs(ch.wa_lastMsgTimestamp);
    return ts && agora - ts >= silencioMinMs && agora - ts <= silencioMaxMs;
  });
  if (!chats.length) return out;
  const agente = (await ctx.agente(empresaId)) || {};
  const treino = String(agente.treinoNumero || '').replace(/\D/g, '');
  // conversas resolvidas no app não são retomadas
  const resolvidas = new Set();
  try { (await sbGet('conversas?empresa_id=eq.' + empresaId + '&select=telefone,dados->>resolvida')).forEach((c) => { if (String(c.resolvida) === 'true') resolvidas.add(String(c.telefone).replace(/\D/g, '')); }); } catch (e) {}

  for (const ch of chats) {
    if (cota.restante <= 0) break;
    const chatid = ch.wa_chatid || ch.chatid || ch.id || '';
    const telefone = String(ch.phone || chatid).split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!telefone || resolvidas.has(telefone) || (treino && telefone === treino)) continue;
    out.verificados++;
    let msgs;
    try { const d = await uazapiPost(canal, '/message/find', { chatid, limit: 20, offset: 0 }); msgs = d.messages || d.data || (Array.isArray(d) ? d : []) || []; }
    catch (e) { continue; }
    msgs = msgs.slice().sort((a, b) => toMs(b.messageTimestamp) - toMs(a.messageTimestamp));
    // só retoma quando a EMPRESA falou por último (se foi o cliente, quem deve resposta é a empresa)
    if (!msgs.length || !msgs[0].fromMe) continue;
    // e o cliente precisa ter falado em algum momento — senão é alguém que só recebeu
    // um disparo/cobrança e nunca respondeu, e "retomar" viraria spam
    const ultimaDoCliente = msgs.find((m) => !m.fromMe);
    if (!ultimaDoCliente) continue;
    const desdeCliente = new Date(toMs(ultimaDoCliente.messageTimestamp)).toISOString();
    // qualquer mensagem automática (retomada ou cobrança) depois da última fala do cliente
    // já conta — uma retomada por silêncio, e nunca "retomar" uma cobrança
    const jaEnviou = await sbGet('automacao_envios?empresa_id=eq.' + empresaId + '&telefone=eq.' + telefone + '&enviado_em=gt.' + encodeURIComponent(desdeCliente) + '&select=id&limit=1');
    if (jaEnviou.length) continue;
    // pesquisa de satisfação enviada depois disso também é "a empresa falou por último" —
    // não faz sentido retomar uma pesquisa não respondida (tabela do script 30; sem ela, ignora)
    try {
      const pesq = await sbGet('pesquisas_satisfacao?empresa_id=eq.' + empresaId + '&telefone=eq.' + telefone + '&enviada_em=gt.' + encodeURIComponent(desdeCliente) + '&select=id&limit=1');
      if (pesq.length) continue;
    } catch (e) {}

    const nome = ch.name || ch.wa_contactName || ch.wa_name || '';
    const primeiro = (nome || '').trim().split(/\s+/)[0] || '';
    let texto = '';
    if (r.modo === 'ia') {
      const historico = msgs.slice(0, 12).reverse().map((m) => (m.fromMe ? 'Empresa' : 'Cliente') + ': ' + textoDaMsg(m)).join('\n');
      texto = await gerarRetomadaIA(historico, primeiro, agente, await ctx.empresaNome(empresaId));
    }
    if (!texto) texto = preencher(r.texto, { nome: primeiro, empresa: await ctx.empresaNome(empresaId) }).replace(/\s+,/g, ',').replace(/^Oi ,/, 'Oi,');
    const ok = await uazapiSendText(canal.uazapi_base_url, canal.uazapi_instance_token, telefone, texto);
    if (ok) {
      await registrarEnvio(empresaId, 'retomada', telefone, nome, toMs(ultimaDoCliente.messageTimestamp), texto);
      out.enviados++; cota.restante--;
      await dormir(PAUSA_ENTRE_ENVIOS_MS);
    }
  }
  return out;
}

// ---------- 3) cobrança automática ----------
// mesma comparação de telefone do app: DDD + 8 últimos dígitos (o 9 da frente às vezes falta)
function telKey(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.indexOf('55') === 0 ? d.slice(2, 4) + d.slice(-8) : d;
}
function foneWhats(t) { const d = String(t || '').replace(/\D/g, '').replace(/^0+/, ''); return d.length === 10 || d.length === 11 ? '55' + d : d; }

// qual etapa cabe a cada conta hoje (ou null) — "depois" respeita o intervalo e o máximo
function etapaDaConta(l, hoje, c, enviosDaConta) {
  const d = diasEntre(hoje, l.vencimento); // >0: falta; 0: hoje; <0: venceu
  const ja = (tipo) => enviosDaConta.filter((e) => e.tipo === tipo);
  if (d > 0) return c.diasAntes > 0 && d <= c.diasAntes && !ja('cobranca_antes').length ? 'cobranca_antes' : null;
  if (d === 0) return c.noDia && !ja('cobranca_dia').length ? 'cobranca_dia' : null;
  if (c.depoisMax <= 0) return null;
  const depois = ja('cobranca_depois');
  if (depois.length >= c.depoisMax) return null;
  if (!depois.length) return 'cobranca_depois';
  const ultimo = depois.map((e) => partesSP(new Date(e.enviado_em).getTime()).ymd).sort().pop();
  return diasEntre(ultimo, hoje) >= c.depoisCadaDias ? 'cobranca_depois' : null;
}

function mensagemCobranca(c, etapa, contas, nome, empresaNome) {
  const pix = c.pix ? '\n\nPix para pagamento: ' + c.pix : '';
  const tpl = etapa === 'cobranca_antes' ? c.textoAntes : etapa === 'cobranca_dia' ? c.textoDia : c.textoDepois;
  if (contas.length === 1) {
    const l = contas[0];
    return preencher(tpl, { nome, descricao: l.descricao || 'sua conta', valor: fmtMoney(l.valor), vencimento: fmtData(l.vencimento), pix, empresa: empresaNome || '' });
  }
  // várias contas do mesmo cliente: uma mensagem só, com a lista
  const total = contas.reduce((a, l) => a + Number(l.valor || 0), 0);
  const titulo = etapa === 'cobranca_antes' ? 'Passando para lembrar das contas que vencem em breve:' : etapa === 'cobranca_dia' ? 'Passando para lembrar das contas em aberto:' : 'Constam em aberto as contas abaixo:';
  return 'Olá' + (nome ? ' ' + nome : '') + ', tudo bem? ' + titulo + '\n'
    + contas.map((l) => '• ' + (l.descricao || 'Conta') + ' — ' + fmtMoney(l.valor) + ' (vencimento ' + fmtData(l.vencimento) + ')').join('\n')
    + '\n\nTotal: ' + fmtMoney(total) + pix + '\n\nSe já pagou, é só desconsiderar. Qualquer dúvida, estou à disposição!';
}

async function rodarCobrancas(empresaId, regras, canal, agora, ctx, cota) {
  const c = regras.cobranca, out = { enviados: 0, contas: 0, semTelefone: 0 };
  if (!c.ativo || cota.restante <= 0) return out;
  const hoje = partesSP(agora).ymd, limite = addDias(hoje, c.diasAntes);
  const contas = await sbGet('lancamentos?empresa_id=eq.' + empresaId + '&tipo=eq.receita&status=eq.aberto&transferencia_id=is.null&vencimento=lte.' + limite
    + '&select=id,descricao,valor,vencimento,pessoa&order=vencimento.asc&limit=500');
  if (!contas.length) return out;
  const clientes = await sbGet('clientes?empresa_id=eq.' + empresaId + '&select=nome,telefone');
  const telPorNome = {};
  clientes.forEach((cl) => { const k = (cl.nome || '').trim().toLowerCase(); if (k && cl.telefone && !telPorNome[k]) telPorNome[k] = cl.telefone; });
  const desde = new Date(agora - 180 * 86400000).toISOString();
  const envios = await sbGet('automacao_envios?empresa_id=eq.' + empresaId + '&tipo=like.cobranca*&enviado_em=gt.' + encodeURIComponent(desde) + '&select=tipo,referencia,enviado_em');
  const enviosPorConta = {};
  envios.forEach((e) => { (enviosPorConta[e.referencia] = enviosPorConta[e.referencia] || []).push(e); });

  // agrupa por cliente: cada cliente recebe no máximo uma mensagem por rodada
  const grupos = {};
  const ordemEtapa = { cobranca_antes: 1, cobranca_dia: 2, cobranca_depois: 3 };
  for (const l of contas) {
    if (!l.vencimento) continue;
    const etapa = etapaDaConta(l, hoje, c, enviosPorConta[String(l.id)] || []);
    if (!etapa) continue;
    out.contas++;
    const tel = telPorNome[(l.pessoa || '').trim().toLowerCase()];
    if (!tel) { out.semTelefone++; continue; }
    const k = telKey(tel);
    const g = grupos[k] = grupos[k] || { telefone: foneWhats(tel), nome: (l.pessoa || '').trim().split(/\s+/)[0] || '', contas: [], etapa: etapa };
    g.contas.push(Object.assign({ etapa }, l));
    if (ordemEtapa[etapa] > ordemEtapa[g.etapa]) g.etapa = etapa; // vale o tom da conta mais atrasada
  }
  const empresaNome = await ctx.empresaNome(empresaId);
  for (const g of Object.values(grupos)) {
    if (cota.restante <= 0) break;
    const texto = mensagemCobranca(c, g.etapa, g.contas, g.nome, empresaNome);
    const ok = await uazapiSendText(canal.uazapi_base_url, canal.uazapi_instance_token, g.telefone, texto);
    if (!ok) continue;
    for (const l of g.contas) await registrarEnvio(empresaId, l.etapa, g.telefone, l.pessoa, l.id, texto);
    // marca no Financeiro ("Cobrado em dd/mm" na lista de lançamentos)
    const ids = g.contas.map((l) => l.id).join(',');
    try { await fetch(SUPA_URL + '/rest/v1/lancamentos?id=in.(' + ids + ')', { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ ultima_cobranca: new Date(agora).toISOString() }) }); } catch (e) {}
    out.enviados++; cota.restante--;
    await dormir(PAUSA_ENTRE_ENVIOS_MS);
  }
  return out;
}

// ---------- handler ----------
async function rodarAutomacoes(agora, ctx) {
  let linhas;
  try { linhas = await sbGet('app_config?id=eq.automacoes&select=empresa_id,data'); }
  catch (e) { return { erro: 'sem regras de automação (' + e.message + ')' }; }
  const resultado = [];
  for (const linha of linhas) {
    const empresaId = linha.empresa_id, regras = normalizarRegras(linha.data);
    if (!empresaId || (!regras.retomada.ativo && !regras.cobranca.ativo)) continue;
    const item = { empresaId };
    if (!dentroDoHorario(regras, agora)) { item.pulado = 'fora do horário'; resultado.push(item); continue; }
    const canal = await ctx.canal(empresaId);
    if (!canal || !canal.uazapi_base_url || !canal.uazapi_instance_token) { item.pulado = 'sem WhatsApp conectado'; resultado.push(item); continue; }
    const cota = { restante: MAX_ENVIOS_POR_RODADA };
    // cobrança primeiro: tem data certa; a retomada pode esperar a próxima rodada
    try { item.cobranca = await rodarCobrancas(empresaId, regras, canal, agora, ctx, cota); } catch (e) { item.cobranca = { erro: e.message || String(e) }; }
    try { item.retomada = await rodarRetomadas(empresaId, regras, canal, agora, ctx, cota); } catch (e) { item.retomada = { erro: e.message || String(e) }; }
    resultado.push(item);
  }
  return resultado;
}

function novoContexto() {
  // cache por empresa nesta execução — evita repetir a mesma consulta quando
  // várias linhas/rotinas são da mesma empresa
  const agentes = new Map(), canais = new Map(), nomes = new Map();
  return {
    agente: async (id) => { if (!agentes.has(id)) agentes.set(id, await readConfig(id)); return agentes.get(id); },
    canal: async (id) => { if (!canais.has(id)) canais.set(id, await fetchCanalDaEmpresa(id)); return canais.get(id); },
    empresaNome: async (id) => {
      if (!nomes.has(id)) {
        let nome = '';
        try { const rows = await sbGet('app_config?id=eq.shared&empresa_id=eq.' + id + '&select=data'); nome = (rows[0] && rows[0].data && rows[0].data.brand && rows[0].data.brand.nome) || ''; } catch (e) {}
        nomes.set(id, nome);
      }
      return nomes.get(id);
    },
  };
}

module.exports = async (req, res) => {
  // protege o endpoint quando CRON_SECRET estiver configurado na Vercel — sem isso,
  // qualquer um poderia chamar essa URL publicamente e disparar lembretes fora de hora
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['authorization'] !== ('Bearer ' + cronSecret)) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  const agora = Date.now(), ctx = novoContexto(), out = { ok: true };
  // cada rotina isolada: uma falha (ex: tabela do script 29 ainda não criada) não
  // derruba as outras — os lembretes de agendamento continuam saindo
  try { out.lembretes = await rodarLembretes(agora, ctx); } catch (e) { out.lembretes = { erro: String((e && e.message) || e) }; }
  try { out.automacoes = await rodarAutomacoes(agora, ctx); } catch (e) { out.automacoes = { erro: String((e && e.message) || e) }; }
  return res.status(200).json(out);
};
// exposto só para os testes
module.exports._internals = { normalizarRegras, dentroDoHorario, etapaDaConta, mensagemCobranca, partesSP, diasEntre, addDias, telKey, rodarRetomadas, rodarCobrancas, rodarAutomacoes, preencher };
