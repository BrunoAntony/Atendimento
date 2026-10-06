// ============================================================
//  Google Calendar sync  (função serverless — Vercel/Node)
// ------------------------------------------------------------
//  Recebe um agendamento do CRM ATENDIMENTO e cria o evento
//  automaticamente na Google Agenda da empresa — SEM o usuário
//  precisar clicar. Usa um refresh token OAuth (configurado 1x).
//
//  Endpoint: https://SEU-BACKEND.vercel.app/api/gcal
//  Método:   POST  { nome, telefone, resumo, data(YYYY-MM-DD), hora(HH:MM) }
//
//  Variáveis de ambiente necessárias (Vercel → Settings → Env):
//    GOOGLE_CLIENT_ID
//    GOOGLE_CLIENT_SECRET
//    GOOGLE_REFRESH_TOKEN
//    GOOGLE_CALENDAR_ID   (opcional; default: 'primary')
//    SYNC_SECRET          (opcional; se definido, o app deve enviar o header x-sync-secret igual)
// ============================================================

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'google-calendar-sync' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    // proteção opcional por segredo compartilhado
    if (process.env.SYNC_SECRET && req.headers['x-sync-secret'] !== process.env.SYNC_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { nome, telefone, resumo, data, hora } = body;
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
      return res.status(500).json({ error: 'credenciais Google ausentes (defina as variáveis de ambiente)' });
    }

    // 1) troca o refresh token por um access token
    const accessToken = await getAccessToken();

    // 2) monta o evento (1h de duração). Sem data → cria para amanhã 09:00.
    const { start, end } = buildTimes(data, hora);
    const calId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
    const event = {
      summary: 'Atendimento — ' + (nome || 'Cliente'),
      description: 'Cliente: ' + (nome || '') + '\nTelefone: ' + (telefone || '') + '\n\nSolicitações:\n' + (resumo || ''),
      start: { dateTime: start, timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end, timeZone: 'America/Sao_Paulo' },
    };

    // 3) cria o evento
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/' + calId + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      body: JSON.stringify(event),
    });
    const dataResp = await r.json();
    if (!r.ok) return res.status(500).json({ error: (dataResp.error && dataResp.error.message) || ('Google ' + r.status) });

    return res.status(200).json({ ok: true, eventId: dataResp.id, htmlLink: dataResp.htmlLink });
  } catch (e) {
    console.error('[gcal] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('OAuth: ' + (data.error_description || data.error || r.status));
  return data.access_token;
}

function buildTimes(data, hora) {
  let dt;
  if (data) {
    const [y, m, d] = data.split('-').map(Number);
    const [hh, mm] = (hora || '09:00').split(':').map(Number);
    dt = new Date(y, (m || 1) - 1, d || 1, hh || 9, mm || 0);
  } else {
    dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    dt.setHours(9, 0, 0, 0);
  }
  const iso = (x) => {
    const pad = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) + 'T' + pad(x.getHours()) + ':' + pad(x.getMinutes()) + ':00';
  };
  const end = new Date(dt.getTime() + 60 * 60 * 1000);
  return { start: iso(dt), end: iso(end) };
}
