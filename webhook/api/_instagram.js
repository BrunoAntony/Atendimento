// ============================================================
//  Instagram (Direct + comentários) — API oficial da Meta, "login do Instagram"
// ------------------------------------------------------------
//  Um app da Meta só (o da DeOli); cada empresa conecta a PRÓPRIA conta profissional
//  pelo botão "Conectar Instagram" do app. Tudo passa pelo /api/webhook (o plano Hobby
//  da Vercel limita o número de funções), com endereços amigáveis no vercel.json:
//    /instagram/webhook   → eventos da Meta (mensagens e comentários) + verificação
//    /instagram/callback  → volta do login do Instagram (troca o código pelo token)
//    /instagram/exclusao  → pedido de exclusão de dados (exigência da Meta)
//    /instagram/desautorizar → usuário removeu o app no Instagram
//  e, para o app (com o token de login do Versatil):
//    ?ig=status | ?ig=conectar | ?ig=desconectar | ?ig=enviar
//
//  Variáveis na Vercel: IG_APP_ID, IG_APP_SECRET, IG_VERIFY_TOKEN
//  (IG_SKIP_SIGNATURE=1 desliga a conferência de assinatura — só pra diagnóstico)
// ============================================================
const crypto = require('crypto');
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
const GRAPH = 'https://graph.instagram.com/v25.0';
const ESCOPOS = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
const BASE_PUBLICA = process.env.PUBLIC_BASE_URL || 'https://webhook-blond-pi.vercel.app';
const REDIRECT_URI = BASE_PUBLICA + '/instagram/callback';
// pra onde o login pode devolver o usuário (evita redirecionamento aberto)
const VOLTAS_PERMITIDAS = [/^https:\/\/[a-z0-9-]+\.vercel\.app(\/|$)/i, /^https:\/\/([a-z0-9-]+\.)?deoliautomacoes\.com(\/|$)/i, /^http:\/\/localhost(:\d+)?(\/|$)/i];

const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_ANON_KEY;
const meta = () => ({ appId: process.env.IG_APP_ID || '', secret: process.env.IG_APP_SECRET || '', verify: process.env.IG_VERIFY_TOKEN || '' });

// ---------- Supabase (chave de serviço) ----------
function sbHeaders(extra) {
  return Object.assign({ apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey(), 'Content-Type': 'application/json' }, extra || {});
}
async function sbGet(path) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
async function sbPost(path, body, prefer) {
  return fetch(SUPA_URL + '/rest/v1/' + path, { method: 'POST', headers: sbHeaders({ Prefer: prefer || 'return=minimal' }), body: JSON.stringify(body) });
}
async function sbPatch(path, body) {
  return fetch(SUPA_URL + '/rest/v1/' + path, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(body) });
}
async function sbDelete(path) {
  return fetch(SUPA_URL + '/rest/v1/' + path, { method: 'DELETE', headers: sbHeaders({ Prefer: 'return=minimal' }) });
}

async function contaPorIgId(igUserId) {
  const rows = await sbGet('instagram_contas?ig_user_id=eq.' + encodeURIComponent(igUserId) + '&select=*&limit=1');
  return rows[0] || null;
}
async function contaDaEmpresa(empresaId) {
  const rows = await sbGet('instagram_contas?empresa_id=eq.' + encodeURIComponent(empresaId) + '&ativo=eq.true&select=*&order=conectado_em.desc&limit=1');
  return rows[0] || null;
}
// WhatsApp da empresa — só para os avisos à equipe (handoff, robô) que vão por WhatsApp
async function whatsappDaEmpresa(empresaId) {
  try {
    const rows = await sbGet('canais?empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=uazapi_base_url,uazapi_instance_token&limit=1');
    return rows[0] || {};
  } catch (e) { return {}; }
}

// ---------- Graph API ----------
async function graph(method, path, token, body) {
  const r = await fetch(GRAPH + path, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const err = new Error((data.error && data.error.message) || ('Instagram ' + r.status));
    err.code = data.error && data.error.code; err.subcode = data.error && data.error.error_subcode;
    throw err;
  }
  return data;
}
// mensagem amigável pros erros mais comuns da Meta
function erroAmigavel(e) {
  const m = (e && e.message) || String(e);
  if (/outside of allowed window|24.?hour|window/i.test(m) || (e && e.code === 10)) return 'Fora da janela de 24 horas: o Instagram só permite responder até 24h depois da última mensagem do cliente.';
  if (/expired|invalid.*token|session has been invalidated/i.test(m) || (e && e.code === 190)) return 'A conexão com o Instagram expirou — conecte a conta de novo em Agentes IA › Canais.';
  return m;
}

// ---------- texto ----------
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// palavra-chave vazia = qualquer comentário; senão, alguma das palavras (separadas por vírgula)
function palavrasCasam(palavras, texto) {
  const lista = String(palavras || '').split(/[,;\n]/).map((p) => normalizar(p).trim()).filter(Boolean);
  if (!lista.length) return true;
  const t = ' ' + normalizar(texto).replace(/[^a-z0-9@#]+/g, ' ') + ' ';
  return lista.some((p) => t.indexOf(' ' + p.replace(/[^a-z0-9@# ]+/g, ' ').trim() + ' ') >= 0);
}
function preencher(tpl, vars) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)).trim(); }

// ---------- assinatura dos webhooks (X-Hub-Signature-256) ----------
// a Vercel já entrega o corpo convertido em objeto; a Meta assina o JSON com "/" e
// caracteres não-ASCII escapados, então refazemos esse formato para conferir
function jsonNoFormatoMeta(obj) {
  return JSON.stringify(obj).replace(/\//g, '\\/').replace(/[\u007f-￿]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}
function assinaturaValida(req, corpo, secret) {
  if (process.env.IG_SKIP_SIGNATURE === '1') return true;
  const header = String((req.headers && (req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'])) || '');
  if (!header.startsWith('sha256=') || !secret) return false;
  const esperado = header.slice(7);
  const candidatos = typeof req.body === 'string' ? [req.body] : [jsonNoFormatoMeta(corpo), JSON.stringify(corpo)];
  return candidatos.some((raw) => {
    const calc = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    return calc.length === esperado.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(esperado));
  });
}
function lerSignedRequest(sr, secret) {
  const [sig, payload] = String(sr || '').split('.');
  if (!sig || !payload) return null;
  const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const calc = crypto.createHmac('sha256', secret).update(payload).digest();
  const dado = b64(sig);
  if (calc.length !== dado.length || !crypto.timingSafeEqual(calc, dado)) return null;
  try { return JSON.parse(b64(payload).toString('utf8')); } catch (e) { return null; }
}

// ---------- conversa no Atendimento ----------
// a conversa do Instagram fica na mesma tabela "conversas" (chave telefone = "ig:<igsid>"):
// o servidor cria/atualiza nome, prévia e não lidas; o app manda nos controles (humano,
// resolvida...), por isso aqui sempre lemos e preservamos o que já existe
async function atualizarConversa(conta, igsid, patch) {
  const chave = 'ig:' + igsid;
  let dados = null;
  try {
    const rows = await sbGet('conversas?empresa_id=eq.' + conta.empresa_id + '&telefone=eq.' + encodeURIComponent(chave) + '&select=dados&limit=1');
    dados = rows[0] && rows[0].dados;
  } catch (e) {}
  const base = dados || { id: 'ig_' + igsid, source: 'ig', canal: 'Instagram', telefone: chave, igsid, igConta: conta.ig_user_id, nome: patch.nome || 'Instagram', msgs: [], unread: 0, humano: false, resolvida: false, iaAtiva: true };
  const novo = Object.assign({}, base, patch, { unread: (base.unread || 0) + (patch.somarNaoLida ? 1 : 0) });
  delete novo.somarNaoLida;
  if (!patch.nome) novo.nome = base.nome;
  await sbPost('conversas?on_conflict=empresa_id,telefone', { empresa_id: conta.empresa_id, telefone: chave, nome: novo.nome || '', canal: 'Instagram', dados: novo, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  return novo;
}
async function gravarMensagem(conta, igsid, fromMe, texto, midiaUrl, mid, em) {
  const r = await sbPost('ig_mensagens', { empresa_id: conta.empresa_id, ig_user_id: conta.ig_user_id, igsid, from_me: fromMe, texto: texto || null, midia_url: midiaUrl || null, mid: mid || null, em: em || new Date().toISOString() });
  if (r.status === 409) return false; // mid repetido: a Meta reenviou o mesmo evento
  if (!r.ok) console.warn('[instagram] mensagem não gravada:', r.status, (await r.text()).slice(0, 200));
  return true;
}
// manda DM e registra no histórico/conversa
async function enviarDM(conta, igsid, mensagem, textoLog) {
  const resp = await graph('POST', '/me/messages', conta.access_token, { recipient: { id: igsid }, message: mensagem });
  await gravarMensagem(conta, igsid, true, textoLog || mensagem.text || '[imagem]', mensagem.attachment && mensagem.attachment.payload && mensagem.attachment.payload.url, resp.message_id);
  await atualizarConversa(conta, igsid, { ts: Date.now(), previewText: textoLog || mensagem.text || '[imagem]' });
  return resp;
}

// ---------- mensagens do Direct → mesmo fluxo de IA do WhatsApp ----------
async function nomeDoContato(conta, igsid) {
  try {
    const p = await graph('GET', '/' + igsid + '?fields=name,username', conta.access_token);
    return p.name || (p.username ? '@' + p.username : '');
  } catch (e) { return ''; }
}
async function historicoTexto(conta, igsid, excluirMid) {
  const rows = await sbGet('ig_mensagens?empresa_id=eq.' + conta.empresa_id + '&igsid=eq.' + encodeURIComponent(igsid) + '&select=from_me,texto,mid,em&order=em.desc&limit=21');
  return rows.reverse().filter((m) => !excluirMid || m.mid !== excluirMid).slice(-20)
    .map((m) => (m.from_me ? 'Empresa' : 'Cliente') + ': ' + (m.texto || '[mídia]')).join('\n');
}
async function mensagensBrutas(conta, igsid) {
  const rows = await sbGet('ig_mensagens?empresa_id=eq.' + conta.empresa_id + '&igsid=eq.' + encodeURIComponent(igsid) + '&select=from_me,texto,em&order=em.desc&limit=30');
  return rows.map((m) => ({ fromMe: m.from_me, messageTimestamp: Date.parse(m.em), text: m.texto || '' }));
}
function tipoDoAnexo(att) {
  const t = String((att && att.type) || '').toLowerCase();
  if (t === 'image' || t === 'story_mention' || t === 'ig_reel' || t === 'share') return { type: 'image', mimetype: 'image/jpeg' };
  if (t === 'audio') return { type: 'audio', mimetype: 'audio/mp4' };
  if (t === 'file') return { type: 'document', mimetype: 'application/pdf' };
  return { type: t || 'text', mimetype: '' };
}

async function tratarMensagem(conta, ev, deps) {
  const m = ev.message;
  if (!m || ev.read || ev.reaction) return; // leitura, reação, etc.
  const remetente = ev.sender && ev.sender.id, destinatario = ev.recipient && ev.recipient.id;
  // eco: mensagem enviada pela própria empresa (pelo app, pela IA ou pelo celular)
  if (m.is_echo || remetente === conta.ig_user_id) {
    if (destinatario) {
      const novo = await gravarMensagem(conta, destinatario, true, m.text || '', null, m.mid, ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : null);
      if (novo) await atualizarConversa(conta, destinatario, { ts: Number(ev.timestamp) || Date.now(), previewText: m.text || '[mídia]' });
    }
    return;
  }
  const igsid = remetente;
  const anexo = Array.isArray(m.attachments) && m.attachments[0];
  const midiaUrl = anexo && anexo.payload && anexo.payload.url;
  const texto = m.text || '';
  const em = ev.timestamp ? new Date(Number(ev.timestamp)).toISOString() : new Date().toISOString();
  // grava primeiro: se a Meta reenviar o mesmo evento (mid repetido), para aqui
  const novo = await gravarMensagem(conta, igsid, false, texto || (anexo ? '[' + (anexo.type || 'mídia') + ']' : ''), midiaUrl, m.mid, em);
  if (!novo) return;
  let conversa = null;
  try {
    const rows = await sbGet('conversas?empresa_id=eq.' + conta.empresa_id + '&telefone=eq.' + encodeURIComponent('ig:' + igsid) + '&select=dados&limit=1');
    conversa = rows[0] && rows[0].dados;
  } catch (e) {}
  const nome = (conversa && conversa.nome && conversa.nome !== 'Instagram') ? conversa.nome : (await nomeDoContato(conta, igsid)) || 'Instagram';
  await atualizarConversa(conta, igsid, { nome, ts: Date.now(), previewText: texto || '[mídia]', somarNaoLida: true });

  if (!deps || !deps.processar) return;
  const wpp = await whatsappDaEmpresa(conta.empresa_id);
  const tipo = anexo ? tipoDoAnexo(anexo) : { type: 'text', mimetype: '' };
  const transporte = {
    canal: 'instagram',
    ctx: { empresaId: conta.empresa_id, uazBaseUrl: wpp.uazapi_base_url || '', uazToken: wpp.uazapi_instance_token || '' },
    enviarTexto: (t) => enviarDM(conta, igsid, { text: t }),
    enviarImagem: async (url, legenda) => {
      if (!/^https?:\/\//i.test(String(url || ''))) return; // imagem gerada (data:) não dá pra mandar por URL
      await enviarDM(conta, igsid, { attachment: { type: 'image', payload: { url } } }, '[imagem]' + (legenda ? ' ' + legenda : ''));
      if (legenda) await enviarDM(conta, igsid, { text: legenda });
    },
    historico: (excluirMid) => historicoTexto(conta, igsid, excluirMid),
    mensagensBrutas: () => mensagensBrutas(conta, igsid),
  };
  const fakeReq = { method: 'POST', query: {}, headers: {}, url: '/api/webhook', _ig: transporte,
    body: { message: { id: m.mid, type: tipo.type, messageType: tipo.type, mimetype: tipo.mimetype, text: texto, fileURL: midiaUrl || '', sender: 'ig:' + igsid, senderName: nome, fromMe: false } } };
  const fakeRes = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await deps.processar(fakeReq, fakeRes);
  if (fakeRes.statusCode >= 400) console.error('[instagram] fluxo da IA falhou:', fakeRes.statusCode, JSON.stringify(fakeRes.body).slice(0, 300));
}

// ---------- comentários com palavra-chave → mensagem privada ----------
async function regrasDoInstagram(empresaId) {
  try {
    const rows = await sbGet('app_config?id=eq.automacoes&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=data&limit=1');
    const ig = (rows[0] && rows[0].data && rows[0].data.instagram) || {};
    return { ativo: !!ig.ativo, regras: Array.isArray(ig.regras) ? ig.regras : [] };
  } catch (e) { return { ativo: false, regras: [] }; }
}
async function tratarComentario(conta, v) {
  if (!v || !v.id || !v.from || !v.from.id || v.from.id === conta.ig_user_id) return null; // ignora os da própria conta
  const cfg = await regrasDoInstagram(conta.empresa_id);
  if (!cfg.ativo) return null;
  const regra = cfg.regras.find((r) => r && r.ativo !== false && (r.mensagem || r.respostaPublica) && palavrasCasam(r.palavras, v.text));
  if (!regra) return null;
  // um comentário só gera uma resposta (a Meta também só deixa uma mensagem privada por comentário)
  try {
    const ja = await sbGet('automacao_envios?empresa_id=eq.' + conta.empresa_id + '&tipo=eq.ig_comentario&referencia=eq.' + encodeURIComponent(v.id) + '&select=id&limit=1');
    if (ja.length) return null;
  } catch (e) { /* sem a tabela do script 29: segue (a própria Meta barra a 2ª mensagem privada) */ }
  const username = v.from.username || '';
  const vars = { nome: username ? '@' + username : '', usuario: username };
  let igsid = '';
  const textoDM = preencher(regra.mensagem, vars);
  if (textoDM) {
    try {
      const resp = await graph('POST', '/me/messages', conta.access_token, { recipient: { comment_id: v.id }, message: { text: textoDM } });
      igsid = resp.recipient_id || '';
      if (igsid) {
        await gravarMensagem(conta, igsid, true, textoDM, null, resp.message_id);
        await atualizarConversa(conta, igsid, { nome: username ? '@' + username : 'Instagram', ts: Date.now(), previewText: textoDM });
      }
    } catch (e) { console.error('[instagram] resposta privada falhou:', erroAmigavel(e)); }
  }
  const textoPublico = preencher(regra.respostaPublica, vars);
  if (textoPublico) {
    try { await graph('POST', '/' + v.id + '/replies', conta.access_token, { message: textoPublico }); }
    catch (e) { console.error('[instagram] resposta pública falhou:', erroAmigavel(e)); }
  }
  try {
    await sbPost('automacao_envios', { empresa_id: conta.empresa_id, tipo: 'ig_comentario', telefone: 'ig:' + (igsid || v.from.id), nome: username ? '@' + username : null, referencia: v.id, mensagem: textoDM || textoPublico });
  } catch (e) {}
  return { regra: regra.id || null, igsid };
}

// ---------- eventos da Meta ----------
async function processarEventos(payload, deps) {
  if (!payload || (payload.object && payload.object !== 'instagram')) return { ignorado: true };
  const resumo = { mensagens: 0, comentarios: 0 };
  for (const entry of payload.entry || []) {
    const conta = await contaPorIgId(String(entry.id));
    if (!conta || !conta.ativo) { console.log('[instagram] evento de conta não conectada:', entry.id); continue; }
    for (const ev of entry.messaging || []) { await tratarMensagem(conta, ev, deps); resumo.mensagens++; }
    for (const ch of entry.changes || []) {
      if (ch.field === 'comments' || ch.field === 'live_comments') { await tratarComentario(conta, ch.value); resumo.comentarios++; }
      else if (ch.field === 'messages' && ch.value) { await tratarMensagem(conta, ch.value, deps); resumo.mensagens++; }
    }
  }
  return resumo;
}

// ---------- login do Instagram (OAuth) ----------
async function trocarCodigo(code) {
  const { appId, secret } = meta();
  const form = new URLSearchParams({ client_id: appId, client_secret: secret, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code: String(code).replace(/#_$/, '') });
  const r = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const curto = await r.json().catch(() => ({}));
  if (!r.ok || !curto.access_token) throw new Error((curto.error_message || curto.error && curto.error.message) || 'Falha ao trocar o código do Instagram');
  const r2 = await fetch('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=' + encodeURIComponent(secret) + '&access_token=' + encodeURIComponent(curto.access_token));
  const longo = await r2.json().catch(() => ({}));
  if (!r2.ok || !longo.access_token) throw new Error((longo.error && longo.error.message) || 'Falha ao gerar o token de longa duração');
  return { token: longo.access_token, expiraEm: new Date(Date.now() + (Number(longo.expires_in) || 5184000) * 1000).toISOString(), appUserId: String(curto.user_id || '') };
}
async function conectarConta(empresaId, code) {
  const t = await trocarCodigo(code);
  const me = await graph('GET', '/me?fields=user_id,username,name', t.token);
  const igUserId = String(me.user_id || me.id);
  const existente = await contaPorIgId(igUserId);
  if (existente && existente.empresa_id !== empresaId && existente.ativo) throw new Error('Esta conta do Instagram já está conectada a outra empresa no Versatil.');
  // passa a receber mensagens e comentários dessa conta
  await graph('POST', '/me/subscribed_apps?subscribed_fields=messages,comments', t.token);
  // uma conta por empresa: troca a anterior, se houver
  await sbDelete('instagram_contas?empresa_id=eq.' + encodeURIComponent(empresaId) + '&ig_user_id=neq.' + encodeURIComponent(igUserId));
  const r = await sbPost('instagram_contas?on_conflict=ig_user_id', {
    empresa_id: empresaId, ig_user_id: igUserId, app_user_id: t.appUserId || null, username: me.username || null, nome: me.name || null,
    access_token: t.token, token_expira_em: t.expiraEm, atualizado_em: new Date().toISOString(), ativo: true,
  }, 'resolution=merge-duplicates,return=minimal');
  if (!r.ok) throw new Error('Não foi possível salvar a conta: ' + (await r.text()).slice(0, 200));
  return { username: me.username, igUserId };
}

// ---------- autenticação das rotas usadas pelo app ----------
function sessaoDoApp(req) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  const p = secret ? jwt.verify(token, secret) : null;
  return p && p.sub && p.empresa_id ? p : null;
}
function voltaSegura(url) {
  const u = String(url || '');
  return VOLTAS_PERMITIDAS.some((re) => re.test(u)) ? u : '';
}
function comParametro(url, chave, valor) {
  const u = new URL(url);
  u.searchParams.set(chave, valor);
  return u.toString();
}

// ---------- roteador ----------
async function handle(req, res, deps) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const q = req.query || {};
  const modo = String(q.ig || '');
  const m = meta();
  try {
    // ----- eventos da Meta -----
    if (modo === 'webhook') {
      if (req.method === 'GET') {
        if (q['hub.mode'] === 'subscribe' && m.verify && q['hub.verify_token'] === m.verify) return res.status(200).send ? res.status(200).send(String(q['hub.challenge'])) : res.status(200).end(String(q['hub.challenge']));
        return res.status(403).json({ error: 'token de verificação inválido' });
      }
      const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!assinaturaValida(req, corpo, m.secret)) { console.warn('[instagram] assinatura inválida — evento descartado'); return res.status(401).json({ error: 'assinatura inválida' }); }
      const resumo = await processarEventos(corpo, deps);
      return res.status(200).json({ ok: true, resumo });
    }
    // ----- volta do login do Instagram -----
    if (modo === 'callback') {
      const estado = jwt.verify(String(q.state || ''), process.env.SUPABASE_JWT_SECRET || '');
      const volta = voltaSegura(estado && estado.voltar) || 'https://app-versatil-25fad2d7.vercel.app/';
      const redirecionar = (chave, valor) => { res.setHeader('Location', comParametro(volta, chave, valor)); return res.status(302).end(); };
      if (!estado || !estado.empresa_id) return redirecionar('ig_erro', 'O link de conexão expirou — tente de novo.');
      if (q.error || !q.code) return redirecionar('ig_erro', q.error_description || q.error_reason || 'Conexão cancelada.');
      try { const c = await conectarConta(estado.empresa_id, q.code); return redirecionar('ig', 'conectado:' + (c.username || '')); }
      catch (e) { console.error('[instagram] falha ao conectar:', e.message); return redirecionar('ig_erro', e.message); }
    }
    // ----- exigências da Meta: exclusão de dados e desautorização -----
    if (modo === 'exclusao' || modo === 'desautorizar') {
      if (req.method === 'GET' && q.codigo) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).end('<!doctype html><meta charset="utf-8"><title>Exclusão de dados</title><body style="font-family:system-ui;padding:40px;max-width:560px">'
          + '<h2>Solicitação de exclusão de dados</h2><p>Código: <b>' + String(q.codigo).replace(/[^a-z0-9-]/gi, '') + '</b></p><p>Os dados da conta do Instagram vinculados ao Versatil (token de acesso e mensagens do Direct) foram excluídos.</p></body>');
      }
      const corpo = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : (req.body || {});
      const dados = lerSignedRequest(corpo.signed_request, m.secret);
      if (!dados || !dados.user_id) return res.status(400).json({ error: 'signed_request inválido' });
      const uid = encodeURIComponent(String(dados.user_id));
      const contas = await sbGet('instagram_contas?or=(ig_user_id.eq.' + uid + ',app_user_id.eq.' + uid + ')&select=ig_user_id');
      for (const c of contas) {
        if (modo === 'exclusao') await sbDelete('ig_mensagens?ig_user_id=eq.' + encodeURIComponent(c.ig_user_id));
        await sbDelete('instagram_contas?ig_user_id=eq.' + encodeURIComponent(c.ig_user_id));
      }
      if (modo === 'desautorizar') return res.status(200).json({ ok: true });
      const codigo = crypto.randomBytes(6).toString('hex');
      return res.status(200).json({ url: BASE_PUBLICA + '/instagram/exclusao?codigo=' + codigo, confirmation_code: codigo });
    }
    // ----- rotas do app (exigem login no Versatil) -----
    const sessao = sessaoDoApp(req);
    if (!sessao) return res.status(401).json({ error: 'Sessão inválida — entre no app de novo.' });
    if (modo === 'status') {
      const conta = await contaDaEmpresa(sessao.empresa_id).catch(() => null);
      return res.status(200).json({
        configurado: !!(m.appId && m.secret && m.verify),
        conta: conta ? { username: conta.username, nome: conta.nome, igUserId: conta.ig_user_id, conectadoEm: conta.conectado_em, tokenExpiraEm: conta.token_expira_em } : null,
        webhookUrl: BASE_PUBLICA + '/instagram/webhook', redirectUri: REDIRECT_URI,
      });
    }
    if (modo === 'conectar') {
      if (!m.appId || !m.secret) return res.status(400).json({ error: 'O app da Meta ainda não foi configurado no servidor (IG_APP_ID / IG_APP_SECRET).' });
      const volta = voltaSegura(q.voltar);
      const state = jwt.sign({ empresa_id: sessao.empresa_id, voltar: volta, exp: Math.floor(Date.now() / 1000) + 15 * 60 }, process.env.SUPABASE_JWT_SECRET);
      const url = 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({ client_id: m.appId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: ESCOPOS, state, enable_fb_login: 'false', force_reauth: 'true' }).toString();
      return res.status(200).json({ url });
    }
    if (modo === 'desconectar') {
      await sbDelete('instagram_contas?empresa_id=eq.' + encodeURIComponent(sessao.empresa_id));
      return res.status(200).json({ ok: true });
    }
    if (modo === 'enviar') {
      const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const texto = String(corpo.texto || '').trim(), igsid = String(corpo.igsid || '').trim();
      if (!texto || !igsid) return res.status(400).json({ error: 'Informe o contato e o texto' });
      const conta = await contaDaEmpresa(sessao.empresa_id);
      if (!conta) return res.status(400).json({ error: 'Nenhuma conta do Instagram conectada' });
      try { const r = await enviarDM(conta, igsid, { text: texto }); return res.status(200).json({ ok: true, mid: r.message_id }); }
      catch (e) { return res.status(400).json({ error: erroAmigavel(e) }); }
    }
    return res.status(404).json({ error: 'rota do Instagram desconhecida' });
  } catch (e) {
    console.error('[instagram] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

// renovação dos tokens (chamada pela rotina /api/lembretes): renova os que vencem em até
// 10 dias e têm mais de 1 dia (a Meta só renova token com pelo menos 24h)
async function renovarTokens() {
  const limite = new Date(Date.now() + 10 * 86400000).toISOString(), umDia = new Date(Date.now() - 86400000).toISOString();
  let contas = [];
  try { contas = await sbGet('instagram_contas?ativo=eq.true&token_expira_em=lt.' + encodeURIComponent(limite) + '&atualizado_em=lt.' + encodeURIComponent(umDia) + '&select=id,access_token&limit=50'); }
  catch (e) { return { erro: e.message }; }
  let renovados = 0;
  for (const c of contas) {
    try {
      const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(c.access_token));
      const d = await r.json();
      if (!r.ok || !d.access_token) throw new Error((d.error && d.error.message) || r.status);
      await sbPatch('instagram_contas?id=eq.' + c.id, { access_token: d.access_token, token_expira_em: new Date(Date.now() + (Number(d.expires_in) || 5184000) * 1000).toISOString(), atualizado_em: new Date().toISOString() });
      renovados++;
    } catch (e) { console.error('[instagram] não renovou token da conta', c.id, e.message); }
  }
  return { verificadas: contas.length, renovados };
}

module.exports = { handle, renovarTokens, _t: { palavrasCasam, preencher, jsonNoFormatoMeta, assinaturaValida, lerSignedRequest, processarEventos, tratarComentario, tratarMensagem, tipoDoAnexo, voltaSegura, erroAmigavel } };
