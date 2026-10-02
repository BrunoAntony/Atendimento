// ============================================================
//  /api/empresas — lista as empresas que o usuário pode ver
// ------------------------------------------------------------
//  Usuário comum: só devolve a própria empresa (o seletor no app
//  fica escondido quando só tem uma). Usuário admin
//  (app_users.is_admin): devolve todas as empresas cadastradas,
//  pra alimentar o seletor "trocar de empresa" na sidebar.
//
//  Header: Authorization: Bearer <access_token da sessão>
//
//  DELETE ?id=<empresa> — só desenvolvedor (is_admin): apaga a empresa e
//  TUDO dela (função excluir_empresa, script supabase/31). Exige no corpo
//  { confirmarNome } igual ao nome da empresa, e não deixa apagar a empresa
//  que está ativa na própria sessão.
// ============================================================
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'DELETE') return res.status(405).json({ error: 'method not allowed' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!serviceKey || !jwtSecret) {
    return res.status(500).json({ error: 'Não configurado no servidor (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET ausentes).' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const payload = jwt.verify(token, jwtSecret);
    if (!payload || !payload.sub) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

    const ru = await fetch(SUPA_URL + '/rest/v1/app_users?id=eq.' + encodeURIComponent(payload.sub) + '&select=is_admin,empresa_id', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!ru.ok) throw new Error('Falha ao consultar usuário: ' + ru.status);
    const users = await ru.json();
    const user = users && users[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    if (req.method === 'DELETE') return excluirEmpresa(req, res, user, payload, serviceKey);

    if (!user.is_admin) {
      const re = await fetch(SUPA_URL + '/rest/v1/empresas?id=eq.' + encodeURIComponent(user.empresa_id) + '&select=id,nome,segmento', {
        headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
      });
      const empresas = re.ok ? await re.json() : [];
      return res.status(200).json({ isAdmin: false, empresas: empresas || [] });
    }

    const re = await fetch(SUPA_URL + '/rest/v1/empresas?select=id,nome,segmento&order=nome.asc', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!re.ok) throw new Error('Falha ao listar empresas: ' + re.status);
    const empresas = await re.json();
    return res.status(200).json({ isAdmin: true, empresas: empresas || [] });
  } catch (e) {
    console.error('[empresas] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

async function excluirEmpresa(req, res, user, payload, serviceKey) {
  if (!user.is_admin) return res.status(403).json({ error: 'Só desenvolvedores podem excluir empresas' });
  let id = (req.query && req.query.id) || '';
  if (!id && req.url) { try { id = new URL(req.url, 'http://x').searchParams.get('id') || ''; } catch (e) {} }
  if (!id) return res.status(400).json({ error: 'Informe a empresa (id)' });
  // apagar a empresa em que a própria sessão está deixaria o app sem empresa
  if (id === payload.empresa_id) return res.status(400).json({ error: 'Esta é a empresa ativa na sua sessão — troque para outra empresa antes de excluir' });

  const headers = { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json' };
  const re = await fetch(SUPA_URL + '/rest/v1/empresas?id=eq.' + encodeURIComponent(id) + '&select=id,nome', { headers });
  const emp = re.ok ? (await re.json())[0] : null;
  if (!emp) return res.status(404).json({ error: 'Empresa não encontrada' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  // segunda trava, além da confirmação na tela: o nome digitado tem que bater
  if (String(body.confirmarNome || '').trim().toLowerCase() !== String(emp.nome || '').trim().toLowerCase()) {
    return res.status(400).json({ error: 'O nome digitado não confere com o da empresa' });
  }

  const r = await fetch(SUPA_URL + '/rest/v1/rpc/excluir_empresa', { method: 'POST', headers, body: JSON.stringify({ p_empresa: id }) });
  const txt = await r.text();
  if (!r.ok) {
    let msg = txt;
    try { msg = JSON.parse(txt).message || txt; } catch (e) {}
    if (/excluir_empresa/.test(msg) && /not find|does not exist|PGRST202/i.test(msg)) msg = 'Execute o script supabase/31_excluir_empresa.sql no Supabase primeiro';
    return res.status(400).json({ error: msg });
  }
  let apagadas = {};
  try { apagadas = JSON.parse(txt) || {}; } catch (e) {}
  console.log('[empresas] empresa excluída por', user.is_admin ? 'dev' : '?', { id, nome: emp.nome, apagadas });
  return res.status(200).json({ ok: true, nome: emp.nome, apagadas });
}
