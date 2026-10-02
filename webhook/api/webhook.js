// ============================================================
//  Webhook uazapi → Gemini — AUTO-RESPONDER 24/7 (Vercel/Node)
// ------------------------------------------------------------
//  Recebe os eventos da uazapi e responde AUTOMATICAMENTE com IA,
//  mesmo com o painel fechado:
//    • TEXTO   → gera resposta com o prompt do agente (Gemini) e envia
//    • ÁUDIO   → transcreve e responde com base na transcrição
//    • IMAGEM  → interpreta e responde
//    • DOC     → resume e responde
//
//  Também pode enviar fotos de modelos do Catálogo de Produtos quando
//  o cliente pede exemplos/fotos e uma subcategoria bate com o pedido.
//
//  Só responde quando a conversa está em modo IA (não pausada por
//  humano). Se o cliente/atendente enviar #humano, o bot pausa.
//
//  A IA também transfere sozinha para um atendente humano quando o
//  cliente pede, quando ela não sabe responder, ou quando um
//  agendamento é fechado — nesses casos avisa por WhatsApp o número
//  configurado na aba Ferramentas do agente (ou NOTIFY_NUMBER, se
//  nenhum número for configurado no app) com os dados do cliente,
//  o resumo da conversa e a data do agendamento (se houver).
//
//  Endpoint após deploy: https://SEU-APP.vercel.app/api/webhook?canal=<webhook_key>
//  Cada empresa/canal tem seu próprio "webhook_key" (tabela "canais" no
//  Supabase) — é isso que identifica qual empresa recebeu a mensagem e
//  quais credenciais uazapi/config usar. Configure essa URL completa (com
//  o ?canal=) no painel da uazapi como webhook da instância daquela empresa
//  (eventos de "mensagem recebida").
// ============================================================

// ----- Variáveis de ambiente (defina na Vercel) -----
//  GEMINI_API_KEY        chave do Google AI (Gemini) — único lugar onde ela mora;
//                        o app não guarda/envia mais chave nenhuma            [obrigatório]
//  UAZAPI_BASE_URL       usado só como fallback se a URL não tiver ?canal=  [opcional]
//  UAZAPI_INSTANCE_TOKEN usado só como fallback se a URL não tiver ?canal=  [opcional]
//  AGENT_PROMPT          prompt de sistema do agente                [recomendado]
//  GEMINI_MODEL          opcional (default: gemini-1.5-flash)
//  AGENT_TEMPERATURE     opcional (default: 0.5)
//  STOP_KEYWORD          opcional (default: #humano) — pausa o bot
//  AUTO_REPLY            opcional 'false' desliga o envio automático
//  NOTIFY_NUMBER          opcional — só usado se nenhum número for salvo na aba
//                         Ferramentas do agente (campo "Número para receber os avisos")

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TEMPERATURE = process.env.AGENT_TEMPERATURE ? Number(process.env.AGENT_TEMPERATURE) : 0.5;
const STOP_KEYWORD = (process.env.STOP_KEYWORD || '#humano').toLowerCase();
const AUTO_REPLY = process.env.AUTO_REPLY !== 'false';
// confirmação de leitura (check azul) desativada por padrão em toda a plataforma — só liga
// se alguém setar MARK_AS_READ=true explicitamente na Vercel
const MARK_AS_READ = process.env.MARK_AS_READ === 'true';
const DEFAULT_PROMPT = 'Você é um assistente de atendimento da empresa Versatil (gestão para salões e comércio). Responda em português do Brasil, de forma curta, cordial e útil, como uma mensagem de WhatsApp.';
const FUNIL_ESTAGIOS = ['novo', 'qualificando', 'interessado', 'fechamento', 'aguardando_reuniao', 'ganho', 'perdido'];
const NOTIFY_NUMBER_ENV = process.env.NOTIFY_NUMBER || '';
// fila de mensagens: quando o cliente manda várias mensagens seguidas rapidinho, espera
// esse tempo antes de responder — se chegar uma mensagem mais nova nesse intervalo, esta
// execução desiste (quem responde é a execução da mensagem mais recente, cujo histórico
// já inclui todas as anteriores) — assim só sai UMA resposta cobrindo tudo, não uma por
// mensagem. Configurável por agente (aba Ferramentas, campo "Tempo de fila"); isso aqui
// é só o padrão usado quando o agente ainda não tem esse campo salvo.
const DEBOUNCE_FILA_MS = process.env.DEBOUNCE_FILA_MS ? Number(process.env.DEBOUNCE_FILA_MS) : 30000;
const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
// service_role ignora RLS — o app agora exige login (RLS) nas tabelas do
// Supabase, mas o webhook precisa continuar lendo o catálogo sem login.
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_ANON_KEY;
const { readConfig, writeConfig } = require('./_configStore');
const { resolveContext, resolveSegmento } = require('./_empresa');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, token, admintoken');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'uazapi→gemini auto-responder', autoReply: AUTO_REPLY });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const msg = body.message || body.data || body;

    // ignora mensagens enviadas pela própria empresa (evita loop)
    if (msg.fromMe === true || msg.key && msg.key.fromMe === true) {
      return res.status(200).json({ ignored: true, reason: 'fromMe' });
    }

    // msg.type às vezes é só um envelope genérico ("media"/"chat"), não o tipo real da
    // mensagem — por isso checamos type + messageType + mediaType juntos (não só o
    // primeiro que existir), senão uma mensagem de áudio com type:"media" passava batido.
    const type = String(msg.type || msg.messageType || msg.mediaType || '').toLowerCase();
    const typeHints = [msg.type, msg.messageType, msg.mediaType].filter(Boolean).map((v) => String(v).toLowerCase()).join(' ');
    const from = msg.sender || msg.from || msg.chatid || msg.jid || (msg.key && msg.key.remoteJid) || '';
    const mediaUrl = msg.fileURL || msg.mediaUrl || msg.url || (msg.file && msg.file.url) || '';
    const mimetype = msg.mimetype || (msg.mediaType && msg.mediaType !== msg.type ? msg.mediaType : '') || '';
    // msg.content pode vir como objeto (mídia) em vez de string — nunca usar direto sem checar o tipo
    let textRaw = msg.text || msg.body || msg.caption || (typeof msg.content === 'string' ? msg.content : '')
      || (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) || '';
    if (textRaw && typeof textRaw === 'object') textRaw = textRaw.text || textRaw.caption || textRaw.body || '';
    const text = typeof textRaw === 'string' ? textRaw : String(textRaw == null ? '' : textRaw);

    if (!from) return res.status(200).json({ ignored: true, reason: 'sem remetente' });

    // resolve qual empresa/canal recebeu essa mensagem — vem do parâmetro
    // ?canal=<webhook_key> registrado no painel da uazapi (ver tabela "canais");
    // sem esse parâmetro, cai nas variáveis de ambiente (compatibilidade)
    let canalKey = (req.query && req.query.canal) || '';
    if (!canalKey && req.url) {
      try { canalKey = new URL(req.url, 'http://x').searchParams.get('canal') || ''; } catch (e) {}
    }
    const ctx = await resolveContext(canalKey, SUPA_SERVICE_KEY);
    const empresaId = ctx.empresaId;
    const uazBase = String(ctx.uazBaseUrl || '').replace(/\/+$/, '');
    const uazToken = ctx.uazToken || '';
    console.log('[webhook] recebido:', { type, canalKey, empresaId, temUazBase: !!uazBase, temUazToken: !!uazToken });
    // segmento da empresa (ex: "imobiliaria", "eventos") — muda o vocabulário do prompt
    // (catálogo de "imóveis"/"eventos" em vez de "produtos", roteiro de vendas adequado)
    const segmento = await resolveSegmento(empresaId, SUPA_SERVICE_KEY);
    const isImobiliaria = segmento === 'imobiliaria';
    const isEventos = segmento === 'eventos';

    // config enviada pelo app (tem prioridade sobre as variáveis de ambiente)
    const cfg = (await readConfig(empresaId)) || {};

    // métricas + pesquisa de satisfação — antes de qualquer outro filtro, pra contar também
    // conversas com humano e capturar a nota mesmo com o agente desligado. O número de
    // treinamento fica de fora (é teste, não atendimento real).
    const telefoneCliente = phoneFromJid(from);
    const ehTreino = !!(cfg.treinoAtivo && (cfg.treinoNumero || '').replace(/\D/g, '') && telefoneCliente.replace(/\D/g, '') === (cfg.treinoNumero || '').replace(/\D/g, ''));
    if (!ehTreino) {
      await registrarEvento(empresaId, telefoneCliente, 'cliente_msg');
      const pesquisa = await capturarNotaPesquisa(empresaId, telefoneCliente, text, uazBase, uazToken, from);
      if (pesquisa) {
        console.log('[pesquisa] nota registrada:', pesquisa.nota);
        return res.status(200).json({ ok: true, pesquisa: true, nota: pesquisa.nota });
      }
    }
    // GEMINI_API_KEY é a única fonte da chave agora (o app não guarda/envia mais
    // chave nenhuma); cfg.geminiKey só existe por causa de configs antigas salvas
    // antes dessa mudança — nunca deve ter prioridade sobre a variável de ambiente
    const geminiKey = process.env.GEMINI_API_KEY || cfg.geminiKey;
    const model = cfg.model || GEMINI_MODEL;
    const temperature = (cfg.temperature != null ? cfg.temperature : TEMPERATURE);
    if (cfg.enabled === false) { console.log('[webhook] ignorado: agente desativado no app'); return res.status(200).json({ ignored: true, reason: 'agente desativado no app' }); }
    if (!geminiKey) { console.log('[webhook] erro: sem GEMINI_API_KEY'); return res.status(500).json({ error: 'GEMINI_API_KEY ausente (defina na Vercel ou salve o agente no app)' }); }

    // modo treinamento — quando ativado na aba Conhecimento, o número cadastrado conversa
    // com o agente como se fosse um cliente comum, mas essas trocas nunca entram no funil/
    // avisos de handoff (é só teste) e cada mensagem do treinador é analisada em busca de
    // uma lição pra guardar e reaplicar em TODOS os atendimentos daí em diante
    const treinoNumeroDigits = (cfg.treinoNumero || '').replace(/\D/g, '');
    const isTreinamento = !!(cfg.treinoAtivo && treinoNumeroDigits && phoneFromJid(from).replace(/\D/g, '') === treinoNumeroDigits);
    if (isTreinamento) console.log('[treinamento] mensagem do número de treinamento — modo aprendizado ativo');

    // palavra-chave para pausar o bot (atendimento humano)
    if (text && text.toLowerCase().includes(STOP_KEYWORD)) {
      console.log('[webhook] ignorado: stop keyword');
      return res.status(200).json({ ignored: true, reason: 'stop keyword — atendimento humano' });
    }

    // conversa já transferida para um humano (pedido do cliente, IA sem resposta, ou
    // agendamento fechado) — não responde mais automaticamente até alguém devolver à IA no app
    // (não vale para o número de treinamento — ele sempre continua conversando com a IA)
    if (!isTreinamento && await conversaEstaComHumano(phoneFromJid(from), empresaId)) {
      console.log('[webhook] ignorado: conversa com atendente humano');
      return res.status(200).json({ ignored: true, reason: 'conversa com atendente humano' });
    }

    const isAudio = /audio|ptt|voice/.test(typeHints) || /audio\//.test(mimetype);
    const isImage = /image|photo|sticker/.test(typeHints) || /image\//.test(mimetype);
    const isDoc   = /document|file/.test(typeHints) || /(pdf|word|excel|sheet|text)/.test(mimetype);
    console.log('[webhook] tipo detectado:', { type, typeHints, mimetype, isAudio, isImage, isDoc });

    // busca o histórico recente da conversa — sem isso, cada mensagem chegava
    // "zerada" pro Gemini e ele cumprimentava/se apresentava de novo toda vez.
    const msgId = msg.id || msg.messageid || msg.messageId || (msg.key && msg.key.id) || '';
    // confirmação de leitura (check azul) desativada em toda a plataforma — o cliente não
    // vê "visto" enquanto o agente ainda está processando/decidindo a resposta
    if (MARK_AS_READ) uazapiMarkRead(uazBase, uazToken, from, msgId).catch(() => {});

    // fila: marca esta mensagem como a mais recente da conversa e espera um pouco — se
    // o cliente mandar outra mensagem nesse meio tempo, ela vai atualizar a marca e ESTA
    // execução desiste de responder (quem responde é a execução mais nova)
    const telefoneFila = phoneFromJid(from);
    await marcarFila(telefoneFila, empresaId, msgId);
    // tempo de fila configurável por agente (aba Ferramentas) — cai no padrão/env var se
    // o agente ainda não tiver esse campo salvo (configs antigas)
    const filaDelayMs = cfg.filaDelay != null ? (Math.min(60, Math.max(5, Number(cfg.filaDelay))) * 1000) : DEBOUNCE_FILA_MS;
    await new Promise((r) => setTimeout(r, filaDelayMs));
    if (!(await filaEhAtual(telefoneFila, empresaId, msgId))) {
      console.log('[fila] mensagem mais recente chegou durante a espera — não responde esta');
      return res.status(200).json({ ignored: true, reason: 'fila: aguardando mensagem mais recente' });
    }
    // reconfere se um humano assumiu a conversa DURANTE a espera da fila acima — sem isso,
    // um atendente que assumisse nesses segundos ainda recebia uma resposta automática
    if (!isTreinamento && await conversaEstaComHumano(telefoneFila, empresaId)) {
      console.log('[webhook] ignorado: conversa foi assumida por um humano durante a espera da fila');
      return res.status(200).json({ ignored: true, reason: 'conversa com atendente humano (assumida durante a espera)' });
    }

    const history = await fetchHistory(uazBase, uazToken, from, msgId);
    const historyNote = history ? ('\n\nHistórico recente da conversa (mais antigas primeiro):\n' + history) : '';

    // catálogo de produtos (categorias > subcategorias com fotos de modelos)
    const catalogo = await fetchCatalogo(empresaId);
    const catalogoText = buildCatalogoPrompt(catalogo);

    const itemSing = isImobiliaria ? 'imóvel' : isEventos ? 'evento' : 'produto';
    const itemPlural = isImobiliaria ? 'imóveis' : isEventos ? 'eventos' : 'produtos';
    const catalogoLabel = isImobiliaria
      ? 'CATÁLOGO DE IMÓVEIS DISPONÍVEIS (tipo > imóvel [id]: descrição (tags de estilo disponíveis, se houver))'
      : isEventos
      ? 'CATÁLOGO DE EVENTOS DISPONÍVEL (tipo de evento > evento [id]: descrição, data, regras e lotes de preço, se houver)'
      : 'CATÁLOGO DE PRODUTOS DISPONÍVEL (categoria > subcategoria [id]: descrição (tags de estilo disponíveis, se houver))';
    const jsonFormatNote = '\n\n== FORMATO DE RESPOSTA (OBRIGATÓRIO) ==\n'
      + 'Responda SOMENTE com um JSON válido (sem texto fora do JSON), no formato exato:\n'
      + '{"reply": "sua resposta completa em português do Brasil, curta e profissional, como mensagem de WhatsApp", "replyParts": ["opcional: a mesma resposta dividida em pedaços curtos, ou null"], "sendImages": true ou false, "subcategoriaId": "id da subcategoria escolhida, ou null", "estilo": "tag do estilo pedido pelo cliente (ex: floral, clássico), ou null", "estagioFunil": "estágio atual do cliente no funil de vendas", "precisaHumano": true ou false, "motivoHumano": "motivo curto, ou null", "agendamentoFechado": true ou false, "agendamentoData": "data/horário combinado, em texto legível, ou null", "agendamentoDataISO": "a mesma data/horário combinado, convertida para o formato ISO 8601 completo com fuso -03:00 (ex: 2026-08-05T17:30:00-03:00), ou null", "gerarImagem": true ou false, "promptImagem": "descrição em inglês da imagem a gerar, ou null"}\n'
      + '\n== DIVIDIR EM VÁRIAS MENSAGENS (QUANDO NECESSÁRIO) ==\n'
      + 'Se a resposta for longa, tiver mais de uma ideia, ou responder mais de uma pergunta do cliente, divida em pedaços curtos e naturais — como uma pessoa realmente digitaria várias mensagens seguidas no WhatsApp, em vez de mandar um texto único e comprido. Preencha "replyParts" com um array dessas partes na ordem de envio (no máximo 4 partes; cada uma precisa fazer sentido sozinha, sem cortar frase no meio). "reply" continua sendo o texto completo (todas as partes juntas), usado só como resumo interno. Se a resposta já é curta e cabe bem numa mensagem só, deixe "replyParts": null.\n'
      + (catalogoText
        ? ('Marque "sendImages": true e escolha o "subcategoriaId" SOMENTE quando o cliente pedir explicitamente para ver fotos, exemplos ou opções de ' + itemPlural + ', E uma das opções abaixo corresponder claramente ao que ele pediu na conversa. Se o cliente mencionar um estilo específico (ex: "quero algo floral", "tem modelo minimalista?") e essa tag aparecer na lista de tags, preencha "estilo" com essa tag (copie exatamente como está listado) — nesse caso até 3 fotos desse estilo são enviadas. Se o cliente pedir de forma genérica pra ver modelos/sugestões/opções (sem citar um estilo específico), deixe "estilo": null — nesse caso até 6 fotos variadas são enviadas automaticamente (sem repetir o mesmo modelo/tag), cada uma já com as tags dela como legenda explicando o que é aquele modelo, então sua "reply" não precisa descrever cada foto uma por uma. Preste atenção ao contexto: nunca envie fotos de uma categoria/subcategoria diferente da que o cliente está perguntando. Se o cliente não pediu fotos/exemplos, ou nenhuma opção bate com o pedido, use "sendImages": false e "subcategoriaId": null.\n\n== ' + catalogoLabel + ' ==\n' + catalogoText
          + (isEventos
            ? ('\n\n== DADOS DO EVENTO (OBRIGATÓRIO USAR QUANDO DISPONÍVEL) ==\nQuando um evento do catálogo acima tiver DATA, REGRAS, LOTES, LINK DE INGRESSOS, PRODUTOS VENDIDOS NESTE EVENTO, DOCUMENTOS ou LINKS ADICIONAIS listados, use essas informações como fonte de verdade: informe a data do evento quando perguntado, cite as regras quando relevante (ex: idade mínima, traje, itens proibidos), informe os produtos disponíveis (ex: bebidas, comidas) quando o cliente perguntar o que tem no local, e, ao falar de preço, informe SEMPRE o lote vigente pela data de hoje (nunca ofereça um lote marcado como ENCERRADO). Se um lote estiver perto de vencer, você pode mencionar isso pra criar senso de urgência, sem inventar prazos que não estão listados. Quando houver LINK DE INGRESSOS e o cliente confirmar que quer comprar/garantir presença, envie esse link pra ele finalizar. Quando houver DOCUMENTOS (ex: regulamento, mapa do local) ou LINKS ADICIONAIS (ex: lista de convidados, formulário de inscrição) e o cliente perguntar ou isso ajudar a decisão dele, envie o link certo exatamente como está listado — nunca invente um link que não esteja na lista.')
            : ''))
        : ('Não há catálogo de ' + itemPlural + ' cadastrado — sempre responda "sendImages": false e "subcategoriaId": null.'))
      + '\n\n== CLASSIFICAÇÃO NO FUNIL DE VENDAS (OBRIGATÓRIO) ==\n'
      + 'Preencha "estagioFunil" com o estágio atual do cliente, considerando toda a conversa (não só a última mensagem), usando exatamente um destes valores:\n'
      + '- "novo": primeiro contato, ainda não disse claramente o que precisa.\n'
      + '- "qualificando": já disse o que procura; você está entendendo a necessidade dele.\n'
      + '- "interessado": já viu produtos/fotos/exemplos e demonstrou gostar de algo específico.\n'
      + '- "fechamento": pediu orçamento/preço final, disse que quer fechar ou comprar, ou perguntou como pagar/proceder.\n'
      + '- "aguardando_reuniao": uma reunião, visita ou agendamento já foi marcado com o cliente (inclusive quando "agendamentoFechado" for true nesta mesma resposta), mas o negócio ainda não foi fechado/confirmado. Use este estágio em vez de "fechamento" a partir do momento em que a reunião for marcada.\n'
      + '- "ganho": o pedido já foi confirmado/fechado.\n'
      + '- "perdido": desistiu, disse que não quer mais, ou claramente não há mais chance de venda.'
      + '\n\n== TRANSFERÊNCIA PARA ATENDENTE HUMANO (OBRIGATÓRIO) ==\n'
      + 'Marque "precisaHumano": true e preencha "motivoHumano" com um resumo curto SOMENTE quando: (a) o cliente pedir explicitamente para falar com um atendente/humano/pessoa, OU (b) o cliente perguntar algo que você não sabe responder com confiança (informação que não está disponível para você, caso muito específico ou fora do que você pode resolver). Nesse caso, sua "reply" deve avisar educadamente que um atendente vai continuar o atendimento em breve — NUNCA invente uma resposta que você não tem certeza. Se não se aplicar, use "precisaHumano": false e "motivoHumano": null.\n'
      + 'Quando "precisaHumano" OU "agendamentoFechado" forem true, preencha também "resumoAtendimento": um resumo objetivo em 1 a 3 frases (não uma lista, não a conversa colada) do que o cliente quer e do que já foi combinado, pra um atendente humano entender o contexto rapidamente sem precisar ler a conversa inteira. Nos demais casos use "resumoAtendimento": null.\n'
      + '== AGENDAMENTO FECHADO (OBRIGATÓRIO) ==\n'
      + ('AGORA (hoje) é: ' + dataHojeBR + ', horário de Brasília. Use isso como referência pra calcular qualquer data relativa que o cliente mencionar (ex: "amanhã", "sexta-feira", "daqui 2 semanas").\n')
      + 'Marque "agendamentoFechado": true e preencha "agendamentoData" (texto legível) e "agendamentoDataISO" (data/horário resolvido no formato ISO 8601 com fuso -03:00) SOMENTE no momento em que o cliente CONFIRMAR um agendamento/data (ele concordou com uma data e horário específicos). Resolva SEMPRE a data completa (dia, mês, ano) e o horário exatos com base em "AGORA" acima — nunca deixe "agendamentoDataISO" vago ou nulo quando "agendamentoFechado" for true, a não ser que o cliente realmente não tenha dito um horário (nesse caso use um horário razoável, ex: 09:00, mas sempre preencha o dia). Nas demais mensagens use "agendamentoFechado": false, "agendamentoData": null e "agendamentoDataISO": null.'
      + (cfg.gerarImagemAtivo
        ? ('\n\n== GERAÇÃO DE IMAGEM COM IA (OBRIGATÓRIO) ==\nMarque "gerarImagem": true e preencha "promptImagem" SOMENTE quando o cliente pedir para ver algo personalizado que não existe no catálogo (ex: "mostra como fica uma caixa azul com o meu logo", "consegue gerar um exemplo com tema de dinossauro?"). "promptImagem" deve ser uma descrição detalhada EM INGLÊS do que gerar (o modelo de imagem entende melhor em inglês). Não use isso para pedidos que o catálogo já atende — nesse caso prefira "sendImages". Se não se aplicar, use "gerarImagem": false e "promptImagem": null.')
        : '\n\nA geração de imagem com IA está desativada para este agente — sempre responda "gerarImagem": false e "promptImagem": null.')
      // lições aprendidas nas conversas de treinamento (aba Conhecimento) — vão pro
      // prompt de TODOS os atendimentos, não só o do número de treinamento
      + ((Array.isArray(cfg.treinoLicoes) && cfg.treinoLicoes.length)
        ? ('\n\n== LIÇÕES APRENDIDAS EM TREINAMENTO (OBRIGATÓRIO SEGUIR) ==\nDurante conversas de treinamento com a equipe, você recebeu estas orientações — siga todas elas:\n' + cfg.treinoLicoes.map((l) => '- ' + l).join('\n'))
        : '');

    const agoraBR = new Date();
    const horaBR = agoraBR.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
    const saudacao = Number(horaBR) < 12 ? 'Bom dia' : Number(horaBR) < 18 ? 'Boa tarde' : 'Boa noite';
    const saudacaoConfigurada = (cfg.welcome || '').trim();
    // data/hora completa de hoje em São Paulo — necessário pro modelo resolver referências
    // relativas ("amanhã", "quarta-feira") em uma data/hora absoluta pro agendamentoDataISO
    const dataHojeBR = agoraBR.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const qualificacaoVendas = isImobiliaria
      ? 'Quando o cliente demonstrar intenção REAL de negociar (pediu mais informações de um imóvel específico, disse que quer visitar ou perguntou sobre condições), colete as informações na seguinte ORDEM, uma pergunta por vez: (1) primeiro, se busca COMPRAR ou ALUGAR; (2) depois, a FAIXA DE VALOR/orçamento disponível; (3) depois, o BAIRRO ou região de preferência e o tipo de imóvel (apartamento, casa, terreno). Só pergunte sobre agendar uma VISITA depois de já ter essas informações, e somente quando um imóvel específico do catálogo atender ao que ele procura.'
      : isEventos
      ? 'Cada evento do catálogo já tem sua própria DATA fixa — não pergunte "qual data" como se o cliente fosse escolher, a não ser pra ajudar a identificar QUAL evento ele quer entre vários disponíveis. Quando o cliente demonstrar intenção REAL de garantir presença/comprar (perguntou sobre um evento específico, quis saber valores, disse que quer ir ou reservar), colete as informações na seguinte ORDEM, uma pergunta por vez: (1) primeiro, confirme QUAL evento é (se ainda não estiver claro, apresente as opções do catálogo que combinam com o que ele descreveu); (2) depois, a QUANTIDADE de ingressos/convidados que ele quer garantir; (3) então informe o LOTE vigente e o valor (baseado na data de hoje) e pergunte se ele confirma a reserva/compra nessas condições. Informe a DATA do evento e as REGRAS sempre que relevante para a decisão dele. Só marque "agendamentoFechado" quando ele confirmar claramente que quer garantir a vaga/fechar a compra.'
      : 'Quando o cliente demonstrar intenção REAL de fechar negócio (pediu orçamento, disse que quer comprar/fechar, perguntou como pagar ou como proceder), colete as informações na seguinte ORDEM, uma pergunta por vez: (1) primeiro, se ele já tem as MEDIDAS definidas da caixa (dimensões); (2) depois, a QUANTIDADE de caixas desejada; (3) depois, se ele já tem a IDENTIDADE VISUAL pronta (logo, cores, arte) ou se precisa de ajuda com isso. Só pergunte a DATA do evento depois de já ter essas três informações, e somente se for realmente necessário para prazo de produção/entrega.';
    const system = (cfg.prompt || process.env.AGENT_PROMPT || DEFAULT_PROMPT)
      + '\n\n== POSTURA E CONDUÇÃO DE VENDAS ==\n'
      + 'Mantenha sempre um tom profissional e corporativo — cordial, mas sem gírias, sem excesso de emojis e sem informalidade exagerada. '
      + ('Conduza a conversa ativamente para avançar o cliente no funil de vendas: entenda a necessidade dele, desperte interesse mostrando os ' + itemPlural + ' certos do catálogo e busque encaminhar para o fechamento — nunca deixe a conversa estagnada sem próximo passo. ')
      + (isImobiliaria
        ? 'NÃO tente marcar uma visita enquanto o cliente ainda está só explorando, pedindo informações ou fotos de imóveis. Antes disso, foque em entender o que ele procura e apresentar o catálogo.'
        : isEventos
        ? 'NÃO tente fechar a reserva/venda enquanto o cliente ainda está só explorando os eventos disponíveis ou pedindo mais informações/fotos. Antes disso, foque em entender o que ele procura e apresentar o catálogo.'
        : 'NÃO peça a data do evento nem outros dados do evento enquanto o cliente ainda está só explorando, pedindo informações ou fotos. Antes disso, foque em qualificar a necessidade e apresentar o catálogo.')
      + ('\n' + qualificacaoVendas)
      + '\nFaça no máximo UMA pergunta por mensagem. Nunca bombardeie o cliente com várias perguntas de uma vez — prefira avançar aos poucos, uma coisa de cada vez.'
      + '\nNUNCA comece a mensagem com NENHUMA interjeição ou exclamação de abertura — nenhuma mesmo, seja qual for (ex: "Ótimo!", "Excelente!", "Perfeito!", "Legal!", "Que bom!", "Nossa!", "Uau!", "Ah,", "Show!", "Combinado!" ou qualquer outra variação equivalente). Não é uma lista fechada de palavras proibidas — é a estrutura "exclamação + vírgula/ponto" no início da frase que não pode existir, em hipótese nenhuma. Comece a resposta já respondendo o que o cliente perguntou ou avançando a conversa. Reaja de forma natural ao que ele disse (comente algo específico, mostre que entendeu) sem recorrer a esse tipo de abertura genérica — como uma pessoa de verdade escreveria, não como um roteiro de atendimento ou um vendedor canastrão. Evite que a conversa pareça um interrogatório.'
      + '\nSEJA DIRETO — SEM FLOREIO: no máximo 2 frases curtas por mensagem (ou por parte, se usar "replyParts"). NUNCA use linguagem de propaganda/publicidade (ex: "escolha atemporal", "sofisticado", "elegância", "exclusivo", "peça única", "refletir sua essência") — fale como uma pessoa de negócios explicando algo a um cliente, não como um anúncio. Descreva o produto só se o cliente pedir detalhes; do contrário, vá direto ao que ele perguntou ou à próxima pergunta necessária. Corte qualquer frase que não agregue informação nova.'
      + '\nResponda SEMPRE em português do Brasil, curto e objetivo, como mensagem de WhatsApp.'
      + (history
        ? '\n\nIMPORTANTE: há histórico de mensagens anteriores desta conversa abaixo. Se a Empresa já cumprimentou ou se apresentou antes, NÃO cumprimente nem se reapresente de novo — apenas continue a conversa naturalmente a partir de onde parou.'
        : ('\n\nEsta é a primeira mensagem da conversa (sem histórico). Cumprimente de forma simples e direta, sem se alongar em apresentação: ' + (saudacaoConfigurada ? ('use algo parecido com "' + saudacaoConfigurada + '"') : ('use "' + saudacao + '! Como posso ajudar você hoje?"')) + ' — não faça mais de uma pergunta nessa primeira resposta.'))
      + jsonFormatNote;

    let userContent;      // partes para o Gemini

    if (isAudio || isImage || isDoc) {
      if (!mediaUrl && !msgId) { console.log('[webhook] ignorado: mídia sem URL nem id'); return res.status(200).json({ ignored: true, reason: 'mídia sem URL nem id' }); }
      console.log('[webhook] baixando mídia:', { isAudio, isImage, isDoc, msgId, temMediaUrl: !!mediaUrl });
      const bin = await downloadMedia(uazBase, uazToken, mediaUrl, msgId);
      console.log('[webhook] mídia baixada:', { bytes: bin.buffer && bin.buffer.byteLength, contentType: bin.contentType });
      const b64 = Buffer.from(bin.buffer).toString('base64');
      // bin.contentType vem do arquivo de verdade que baixamos (via /message/download) — mais
      // confiável que msg.mimetype, que às vezes traz um rótulo simbólico (ex: "ptt") em vez
      // de um MIME type real, e isso o Gemini rejeita.
      const isRealMime = (v) => v && /\//.test(v);
      const mime = (isRealMime(bin.contentType) && bin.contentType) || (isRealMime(mimetype) && mimetype) || (isAudio ? 'audio/mpeg' : isImage ? 'image/jpeg' : 'application/pdf');
      const guia = isAudio ? 'O cliente enviou um ÁUDIO. Entenda o que ele diz e responda diretamente.'
        : isImage ? 'O cliente enviou uma IMAGEM. Interprete e responda.'
        : 'O cliente enviou um DOCUMENTO. Entenda e responda.';
      userContent = [{ text: guia + (text ? (' Legenda: "' + text + '".') : '') + historyNote }, { inline_data: { mime_type: mime, data: b64 } }];
    } else {
      if (!text) { console.log('[webhook] ignorado: sem texto (não reconhecido como áudio/imagem/doc nem tinha texto)'); return res.status(200).json({ ignored: true, reason: 'sem texto' }); }
      userContent = [{ text: 'Mensagem do cliente: "' + text + '"' + historyNote + '\n\nEscreva a resposta da empresa.' }];
    }

    // gera a resposta com o prompt do agente (JSON estruturado: texto + decisão de enviar fotos)
    const raw = await geminiGenerate(system, userContent, geminiKey, model, temperature, true);
    const parsed = parseAgentJson(raw);
    const reply = (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) ? parsed.reply.trim() : raw.trim();
    // resposta dividida em várias mensagens curtas (mais natural que um texto único
    // e longo) — só usa replyParts se o modelo mandou algo utilizável, senão manda "reply" inteiro
    const replyParts = (parsed && Array.isArray(parsed.replyParts))
      ? parsed.replyParts.map((p) => String(p || '').trim()).filter(Boolean)
      : [];
    let replyList = replyParts.length ? replyParts : (reply ? [reply] : []);
    let wantsImages = !!(parsed && parsed.sendImages && parsed.subcategoriaId);

    // treinamento: o treinador ora fala COMO um cliente (pra testar a resposta), ora fala
    // SOBRE o agente (corrigindo/ensinando um comportamento) — nesses dois casos a resposta
    // deve ser diferente. Analisa qual dos dois é essa mensagem; se for uma correção, troca a
    // resposta que seria enviada (que continuaria a venda normalmente) por um reconhecimento
    // curto da lição, e grava a lição pra aplicar em todos os atendimentos daí em diante.
    if (isTreinamento && text) {
      try {
        const analiseRaw = await geminiGenerate(
          'Você analisa mensagens dentro de uma conversa de TREINAMENTO de um agente de atendimento automático via WhatsApp.',
          [{ text: 'Mensagem do treinador: "' + text + '"' + historyNote
            + '\n\nResponda SOMENTE com um JSON válido, no formato exato:\n'
            + '{"ehCorrecao": true ou false, "licao": "se ehCorrecao for true, uma frase curta e objetiva com a regra que o agente deve seguir a partir de agora, em português; senão null", "resposta": "se ehCorrecao for true, uma frase curta e natural confirmando que entendeu e vai aplicar a correção (estilo mensagem de WhatsApp), em português; senão null"}\n\n'
            + '"ehCorrecao" é true quando a mensagem fala SOBRE como o agente deve se comportar/responder — uma instrução, correção ou ensinamento (ex: "não precisa perguntar isso", "sempre pergunte X antes", "você deveria ter dito Y", "nesse caso faça Z"). É false quando a mensagem está simulando o que um cliente comum diria (perguntando sobre produtos, preços, agendando, etc.) — nesse caso o agente deve continuar a conversa normalmente, como fez até agora.' }],
          geminiKey, model, 0.2, false,
        );
        const analise = parseAgentJson(analiseRaw);
        if (analise && analise.ehCorrecao) {
          const licao = (analise.licao || '').toString().trim();
          const ack = (analise.resposta || '').toString().trim() || 'Entendido, vou aplicar isso a partir de agora.';
          if (licao) {
            const licoesAtuais = Array.isArray(cfg.treinoLicoes) ? cfg.treinoLicoes.slice() : [];
            licoesAtuais.push(licao);
            await writeConfig(empresaId, Object.assign({}, cfg, { treinoLicoes: licoesAtuais.slice(-50) }));
            console.log('[treinamento] nova lição aprendida:', licao);
          }
          replyList = [ack];
          wantsImages = false; // não faz sentido mandar fotos do catálogo numa confirmação de treino
        }
      } catch (e) { console.error('[treinamento] falha ao analisar mensagem:', e.message || e); }
    }

    const telefone = phoneFromJid(from);
    const nomeCliente = msg.senderName || msg.pushName || msg.notifyName || msg.chatName || msg.name || telefone;

    // classificação no funil de vendas — best-effort, nunca derruba a resposta ao cliente
    // (conversas de treinamento não entram no funil nem geram agendamento/aviso — é só teste)
    const estagio = (parsed && FUNIL_ESTAGIOS.includes(parsed.estagioFunil)) ? parsed.estagioFunil : null;
    if (estagio && !isTreinamento) {
      upsertFunilCliente(telefone, nomeCliente, estagio, empresaId).catch((e) => console.error('[funil] falha ao salvar estágio:', e.message || e));
    }

    // transferência para atendente humano — cliente pediu, IA não soube responder, ou um
    // agendamento acabou de ser fechado. Marca a conversa como humana (o app para de deixar
    // a IA responder) e avisa o número de notificação com os dados do cliente e o resumo.
    const precisaHumano = !!(parsed && parsed.precisaHumano);
    const agendamentoFechado = !!(parsed && parsed.agendamentoFechado);
    const notifyNumber = cfg.notifyNumber || NOTIFY_NUMBER_ENV;
    if (AUTO_REPLY && (precisaHumano || agendamentoFechado) && !isTreinamento) {
      marcarConversaHumana(telefone, empresaId).catch((e) => console.error('[handoff] falha ao marcar conversa como humana:', e.message || e));
      if (agendamentoFechado) {
        // usa o resumo já gerado pela IA (1-3 frases objetivas) em vez de colar pedaços
        // crus do histórico — o resultado virava uma salada de "Cliente: ... Empresa: ..."
        const resumoConversa = (parsed && typeof parsed.resumoAtendimento === 'string' && parsed.resumoAtendimento.trim())
          || text || 'Sem detalhes adicionais.';
        createAgendamento(telefone, nomeCliente, (parsed && parsed.agendamentoData) || '', resumoConversa, empresaId, (parsed && parsed.agendamentoDataISO) || '')
          .catch((e) => console.error('[agendamento] falha ao salvar:', e.message || e));
      }
      if (notifyNumber) {
        const motivo = agendamentoFechado ? 'Agendamento fechado' : ((parsed && parsed.motivoHumano) || 'IA não soube responder');
        const agendamentoData = (parsed && parsed.agendamentoData) || '';
        // resumo curto gerado pela IA (1-3 frases) em vez de colar a conversa inteira —
        // o aviso vira uma mensagem só, fácil de ler rápido no celular
        const resumo = (parsed && typeof parsed.resumoAtendimento === 'string' && parsed.resumoAtendimento.trim())
          || text || 'Sem detalhes adicionais.';
        const resumoMsg = '🔔 *Atendimento precisa de atenção humana*\n'
          + 'Cliente: ' + nomeCliente + '\n'
          + 'Telefone: ' + telefone + '\n'
          + 'Motivo: ' + motivo
          + (agendamentoData ? ('\nData do agendamento: ' + agendamentoData) : '')
          + '\n\nResumo: ' + resumo;
        notifyHuman(uazBase, uazToken, notifyNumber, resumoMsg).catch((e) => console.error('[handoff] falha ao notificar:', e.message || e));
      } else {
        console.warn('[handoff] nenhum número de notificação configurado (aba Ferramentas do agente) — aviso não enviado');
      }
    }

    let replied = false;
    let imagesSent = 0;
    if (!AUTO_REPLY || !reply || !uazBase || !uazToken) console.log('[webhook] não vai enviar resposta:', { AUTO_REPLY, temReply: !!reply, temUazBase: !!uazBase, temUazToken: !!uazToken });
    if (AUTO_REPLY && reply && uazBase && uazToken) {
      // espera um pouco antes de responder, pra não parecer instantâneo/robótico —
      // mostra "digitando…" durante essa espera, pra parecer alguém realmente escrevendo
      const delaySec = Math.min(10, Math.max(2, Number(cfg.respostaDelay) || 3));
      uazapiSetPresence(uazBase, uazToken, from, 'composing').catch(() => {});
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      // reconfere de novo — se um humano assumiu a conversa durante essa última espera
      // (digitando…), não manda a resposta que já tinha sido gerada
      if (isTreinamento || !(await conversaEstaComHumano(telefoneFila, empresaId))) {
      // envia cada parte como mensagem separada (estilo WhatsApp real), com uma pausa
      // curta + "digitando…" entre elas quando há mais de uma parte
      for (let pi = 0; pi < replyList.length; pi++) {
        if (pi > 0) {
          uazapiSetPresence(uazBase, uazToken, from, 'composing').catch(() => {});
          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 900));
        }
        // marca a mensagem como sendo de treinamento (só no número de treino) — assim dá
        // pra identificar na conversa do WhatsApp quais respostas são teste, não venda real
        const texto = (isTreinamento && pi === 0) ? ('*treinamento*\n' + replyList[pi]) : replyList[pi];
        await uazapiSendText(uazBase, uazToken, from, texto);
      }
      replied = true;
      if (!isTreinamento) await registrarEvento(empresaId, telefoneFila, 'resposta_ia');
      if (wantsImages) {
        const sub = findSubcategoria(catalogo, parsed.subcategoriaId);
        // pedido com estilo específico ("quero algo floral") → até 3 fotos filtradas por
        // tag, sem legenda (o cliente já sabe o que pediu). Pedido genérico de modelos/
        // sugestões ("me mostra opções") → até 6 fotos, priorizando nunca repetir a mesma
        // tag entre si (variedade de modelos), cada uma com as tags como legenda explicando
        // o que compõe aquele modelo.
        const isGeral = !parsed.estilo;
        const maxImgs = isGeral ? 6 : 3;
        let imgs = []; // [{ url, tags }]
        if (sub) {
          const pool = Array.isArray(sub.imagens) ? sub.imagens : [];
          if (isGeral) {
            imgs = pickDiverseImages(pool, maxImgs);
          } else {
            const wanted = String(parsed.estilo).trim().toLowerCase();
            const filtered = pool.filter((im) => imgTags(im).some((tg) => tg.toLowerCase().includes(wanted)));
            const matched = filtered.length ? filtered : pool;
            imgs = matched.slice(0, maxImgs).map((im) => ({ url: imgUrl(im), tags: imgTags(im) })).filter((x) => x.url);
          }
          if (!imgs.length && sub.driveFolderId && cfg.driveApiKey) {
            const files = await fetchDriveFolderImages(sub.driveFolderId, cfg.driveApiKey);
            for (const f of files.slice(0, maxImgs)) {
              try { imgs.push({ url: await downloadDriveFile(f.id), tags: [] }); } catch (e) { console.error('[drive] falha ao baixar arquivo:', f.id, e.message || e); }
            }
          }
        }
        for (const item of imgs) {
          const caption = (isGeral && item.tags.length) ? item.tags.join(', ') : '';
          await uazapiSendImage(uazBase, uazToken, from, item.url, caption);
          imagesSent++;
          await new Promise((r) => setTimeout(r, 500)); // evita rajada/flood na uazapi
        }
      }
      // gera uma imagem sob medida com IA (fora do catálogo) — só se a ferramenta
      // estiver ligada nesse agente; nunca derruba a resposta se falhar
      if (cfg.gerarImagemAtivo && parsed && parsed.gerarImagem && parsed.promptImagem) {
        try {
          const dataUrl = await geminiGenerateImage(parsed.promptImagem, geminiKey);
          await uazapiSendImage(uazBase, uazToken, from, dataUrl);
          imagesSent++;
        } catch (e) { console.error('[imagem IA] falha ao gerar/enviar:', e.message || e); }
      }
      } else {
        console.log('[webhook] ignorado: conversa foi assumida por um humano durante a espera "digitando…"');
      }
    }
    console.log('[webhook] finalizado:', { type, replied, imagesSent, replyPreview: (reply || '').slice(0, 80), isTreinamento });
    return res.status(200).json({ ok: true, type: type || 'text', reply, replied, imagesSent });
  } catch (e) {
    console.error('[webhook] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// -------- helpers --------
function parseAgentJson(raw) {
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  return null;
}

// imagens do catálogo podem vir como string (dataURL antigo), { url, tag } (formato antigo,
// uma tag só) ou { url, tags: [] } (formato atual, mais de uma tag por imagem)
function imgUrl(im) { return (im && typeof im === 'object') ? (im.url || '') : (im || ''); }
function imgTags(im) {
  if (!im || typeof im !== 'object') return [];
  if (Array.isArray(im.tags)) return im.tags.filter(Boolean).map(String);
  return im.tag ? [String(im.tag)] : [];
}
function hasPhotos(sub) {
  return (Array.isArray(sub.imagens) && sub.imagens.length > 0) || !!sub.driveFolderId;
}

// tem info suficiente pra entrar no prompt: fotos (como antes) OU dados de evento
// preenchidos (data/regras/lotes) — sem isso, um evento cadastrado sem fotos ainda
// ficava invisível pro agente mesmo já tendo data/preço definidos
function hasCatalogoInfo(sub) {
  return hasPhotos(sub) || !!sub.dataInicio || !!sub.dataFim || !!sub.dataEvento || !!sub.regras || !!sub.linkIngressos
    || (Array.isArray(sub.lotes) && sub.lotes.length > 0)
    || (Array.isArray(sub.produtos) && sub.produtos.length > 0)
    || (Array.isArray(sub.documentos) && sub.documentos.length > 0)
    || (Array.isArray(sub.linksAdicionais) && sub.linksAdicionais.length > 0);
}

// "dataEvento" é o campo antigo (evento de um dia só) — eventos salvos antes do campo de
// início/término existir só têm esse; tratamos como início = término nesse caso.
function eventoDatas(sub) {
  const inicio = sub.dataInicio || sub.dataEvento || '';
  const fim = sub.dataFim || sub.dataEvento || inicio;
  return { inicio, fim };
}
function fmtDataBR(s) {
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('pt-BR');
}

function buildCatalogoPrompt(catalogo) {
  if (!Array.isArray(catalogo) || !catalogo.length) return '';
  const lines = [];
  const hoje = new Date();
  for (const cat of catalogo) {
    const subs = (cat.subcategorias || []).filter(hasCatalogoInfo);
    if (!subs.length) continue;
    lines.push('- ' + (cat.nome || 'Categoria'));
    for (const sub of subs) {
      const imgs = Array.isArray(sub.imagens) ? sub.imagens : [];
      const qtd = imgs.length ? (imgs.length + ' foto(s))') : 'fotos no Google Drive)';
      const tags = [...new Set(imgs.flatMap(imgTags))];
      const tagsNote = tags.length ? (' [tags: ' + tags.join(', ') + ']') : '';
      lines.push('  - ' + (sub.nome || 'Subcategoria') + ' [id: ' + sub.id + ']: ' + (sub.descricao || 'sem descrição') + ' (' + qtd + tagsNote);
      const { inicio, fim } = eventoDatas(sub);
      if (inicio || fim) {
        const label = (inicio && fim && inicio !== fim) ? ('de ' + fmtDataBR(inicio) + ' a ' + fmtDataBR(fim)) : fmtDataBR(inicio || fim);
        lines.push('    DATA DO EVENTO: ' + label);
      }
      if (sub.regras) lines.push('    REGRAS: ' + String(sub.regras).replace(/\n+/g, ' '));
      if (sub.linkIngressos) lines.push('    LINK DE INGRESSOS: ' + sub.linkIngressos);
      if (Array.isArray(sub.linksAdicionais) && sub.linksAdicionais.length) {
        const linksTxt = sub.linksAdicionais.filter((l) => l && l.url).map((l) => (l.nome || 'Link') + ': ' + l.url).join(' | ');
        if (linksTxt) lines.push('    LINKS ADICIONAIS: ' + linksTxt);
      }
      if (Array.isArray(sub.lotes) && sub.lotes.length) {
        const lotesTxt = sub.lotes.map((l) => {
          const dl = l.dataLimite ? new Date(l.dataLimite + 'T00:00:00') : null;
          const dlValida = dl && !isNaN(dl.getTime());
          const venceu = dlValida && dl < hoje;
          const valorTxt = (l.valor != null && l.valor !== '') ? (' — R$ ' + Number(l.valor).toFixed(2).replace('.', ',')) : '';
          const dataTxt = dlValida ? (' (até ' + dl.toLocaleDateString('pt-BR') + (venceu ? ', ENCERRADO' : '') + ')') : '';
          return (l.nome || 'Lote') + valorTxt + dataTxt;
        }).join('; ');
        lines.push('    LOTES: ' + lotesTxt);
      }
      if (Array.isArray(sub.produtos) && sub.produtos.length) {
        // agrupa por categoria (ex: Bebidas, Comidas) pra ficar organizado no prompt
        const porCategoria = {};
        for (const p of sub.produtos) {
          if (!p || !p.nome) continue;
          const cat = (p.categoria || 'Outros').trim() || 'Outros';
          if (!porCategoria[cat]) porCategoria[cat] = [];
          const precoTxt = (p.preco != null && p.preco !== '') ? (' — R$ ' + Number(p.preco).toFixed(2).replace('.', ',')) : '';
          porCategoria[cat].push(p.nome + precoTxt);
        }
        const categorias = Object.keys(porCategoria);
        if (categorias.length) {
          const produtosTxt = categorias.map((cat) => cat + ': ' + porCategoria[cat].join(', ')).join(' | ');
          lines.push('    PRODUTOS VENDIDOS NESTE EVENTO: ' + produtosTxt);
        }
      }
      if (Array.isArray(sub.documentos) && sub.documentos.length) {
        const docsTxt = sub.documentos.filter((d) => d && d.nome && d.url).map((d) => d.nome + ': ' + d.url).join(' | ');
        if (docsTxt) lines.push('    DOCUMENTOS: ' + docsTxt);
      }
    }
  }
  return lines.join('\n');
}

// busca as imagens de uma pasta pública do Google Drive (compartilhada como "Qualquer pessoa com o link")
async function fetchDriveFolderImages(folderId, apiKey) {
  if (!folderId || !apiKey) return [];
  try {
    const q = encodeURIComponent("'" + folderId + "' in parents and mimeType contains 'image/' and trashed = false");
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=10&key=' + encodeURIComponent(apiKey);
    const r = await fetch(url);
    if (!r.ok) { console.error('[drive] falha ao listar pasta:', r.status, await r.text()); return []; }
    const data = await r.json();
    return Array.isArray(data.files) ? data.files : [];
  } catch (e) { console.error('[drive] erro ao listar pasta:', e.message || e); return []; }
}

async function downloadDriveFile(fileId) {
  const url = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao baixar do Drive: ' + r.status);
  const buf = await r.arrayBuffer();
  const contentType = r.headers.get('content-type') || 'image/jpeg';
  return 'data:' + contentType + ';base64,' + Buffer.from(buf).toString('base64');
}

// escolhe até `max` imagens do pool priorizando variedade: nunca repete a mesma tag
// duas vezes seguidas se houver outra opção — faz um round-robin pelas tags (uma imagem
// nova de cada tag por rodada) antes de recorrer a imagens repetidas de uma tag já usada.
function pickDiverseImages(pool, max) {
  const valid = (pool || []).map((im) => ({ url: imgUrl(im), tags: imgTags(im) })).filter((x) => x.url);
  const usedIdx = new Set();
  const result = [];
  const byTag = new Map();
  const semTag = [];
  valid.forEach((im, i) => {
    if (!im.tags.length) { semTag.push(i); return; }
    im.tags.forEach((t) => { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(i); });
  });
  const tagKeys = [...byTag.keys()];
  let addedThisRound = true;
  while (result.length < max && addedThisRound) {
    addedThisRound = false;
    for (const t of tagKeys) {
      if (result.length >= max) break;
      const idx = byTag.get(t).find((i) => !usedIdx.has(i));
      if (idx != null) { usedIdx.add(idx); result.push(valid[idx]); addedThisRound = true; }
    }
  }
  for (const i of semTag) {
    if (result.length >= max) break;
    if (!usedIdx.has(i)) { usedIdx.add(i); result.push(valid[i]); }
  }
  for (let i = 0; i < valid.length && result.length < max; i++) {
    if (!usedIdx.has(i)) { usedIdx.add(i); result.push(valid[i]); }
  }
  return result;
}

function findSubcategoria(catalogo, subId) {
  const target = String(subId);
  for (const cat of (catalogo || [])) {
    const sub = (cat.subcategorias || []).find((s) => String(s.id) === target);
    if (sub) return sub;
  }
  return null;
}

function phoneFromJid(jid) {
  // JIDs de multi-dispositivo vêm como "5545999999999:26@s.whatsapp.net" — o ":26" é o
  // identificador do aparelho, não parte do telefone. Sem cortar isso ANTES de tirar os
  // caracteres não-numéricos, os dígitos do sufixo grudavam no fim do número (telefone
  // "estranho", maior que o de verdade).
  const semDominio = String(jid || '').split('@')[0].split(':')[0];
  const digits = semDominio.replace(/[^0-9]/g, '');
  return digits ? ('+' + digits) : '';
}

// grava/atualiza qual foi a última mensagem recebida dessa conversa — usado pra saber,
// depois da espera de debounce, se chegou algo mais novo enquanto essa execução esperava
async function marcarFila(telefone, empresaId, msgId) {
  if (!telefone || !empresaId) return;
  try {
    await fetch(SUPA_URL + '/rest/v1/fila_mensagens?on_conflict=empresa_id,telefone', {
      method: 'POST',
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ empresa_id: empresaId, telefone, msg_id: msgId || '', updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.warn('[fila] falha ao marcar:', e.message || e); }
}

// best-effort: se a consulta falhar, deixa responder (nunca trava o atendimento por causa disso)
async function filaEhAtual(telefone, empresaId, msgId) {
  if (!telefone || !empresaId) return true;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/fila_mensagens?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=msg_id', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
    });
    if (!r.ok) return true;
    const rows = await r.json();
    return !rows[0] || rows[0].msg_id === msgId;
  } catch (e) { return true; }
}

async function conversaEstaComHumano(telefone, empresaId) {
  if (!telefone || !empresaId) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=dados', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
    });
    if (!r.ok) return false;
    const rows = await r.json();
    const dados = rows && rows[0] && rows[0].dados;
    return !!(dados && dados.humano === true && !dados.resolvida);
  } catch (e) { return false; }
}

// service_role não carrega um empresa_id no token (é assim que o Supabase
// identifica multi-tenant), então todo INSERT feito por aqui precisa mandar
// empresa_id explicitamente — sem isso, o gatilho do banco não consegue
// preenchê-lo sozinho e a gravação falha. empresaId vem de resolveContext(),
// já resolvido a partir do canal que recebeu a mensagem.
async function upsertFunilCliente(telefone, nome, estagio, empresaId) {
  if (!telefone || !empresaId) return;
  // a chave passou a ser (empresa_id, telefone) — mesmo número pode existir em
  // empresas diferentes, então precisa dizer explicitamente qual é o conflito
  await fetch(SUPA_URL + '/rest/v1/funil_clientes?on_conflict=empresa_id,telefone', {
    method: 'POST',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ telefone, nome: nome || telefone, estagio, empresa_id: empresaId, updated_at: new Date().toISOString() }),
  });
}

// cria o registro do agendamento assim que a IA detecta que o cliente
// fechou uma data — antes disso só existia o aviso por WhatsApp, o
// agendamento nunca ficava salvo em lugar nenhum se ninguém estivesse
// com o app aberto naquela conversa
async function createAgendamento(telefone, nome, quando, resumo, empresaId, dataISO) {
  if (!telefone || !empresaId) return;
  // só grava data_iso quando o Gemini realmente devolveu uma data válida — evita salvar lixo
  // que quebraria o lembrete automático (que depende desse campo pra saber quando avisar)
  const dataIsoValida = dataISO && !isNaN(new Date(dataISO).getTime()) ? new Date(dataISO).toISOString() : null;
  await fetch(SUPA_URL + '/rest/v1/agendamentos', {
    method: 'POST',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ telefone, nome: nome || telefone, quando: quando || '', resumo: resumo || '', origem: 'IA', status: 'ativo', empresa_id: empresaId, data_iso: dataIsoValida, lembrete_enviado: false }),
  });
}

// ---------- métricas do atendimento + pesquisa de satisfação (script 30) ----------
// tudo best-effort: se as tabelas ainda não existirem, só não registra — nunca
// atrapalha a resposta ao cliente
function sbServiceHeaders(extra) {
  return Object.assign({ apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json' }, extra || {});
}
// linha do tempo da conversa (cliente_msg / resposta_ia) — telefone só com dígitos
async function registrarEvento(empresaId, telefone, tipo) {
  const tel = String(telefone || '').replace(/\D/g, '');
  if (!empresaId || !tel) return;
  try {
    await fetch(SUPA_URL + '/rest/v1/atendimento_eventos', {
      method: 'POST', headers: sbServiceHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ empresa_id: empresaId, telefone: tel, tipo }),
    });
  } catch (e) { /* métricas nunca derrubam o atendimento */ }
}
// nota da pesquisa: "5", "nota 4", "4 estrelas", "⭐⭐⭐⭐"… — null se não for uma nota
function extrairNota(texto) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const estrelas = (t.match(/⭐|★/g) || []).length;
  if (estrelas >= 1 && estrelas <= 5 && !t.replace(/⭐|★|\s|️/g, '')) return estrelas;
  const m = /^(?:nota\s*)?([1-5])(?:\s*(?:estrelas?|\/\s*5|de\s*5))?\s*[.!,)]?(?:\s|$)/i.exec(t);
  return m ? Number(m[1]) : null;
}
// se o cliente tem pesquisa pendente (até 24h), a mensagem é tratada como resposta dela:
// com nota → grava, agradece e NÃO passa pra IA; sem nota → encerra a pesquisa e a
// conversa segue normal (a mensagem vai pra IA como qualquer outra)
async function capturarNotaPesquisa(empresaId, telefone, texto, base, token, to) {
  const tel = String(telefone || '').replace(/\D/g, '');
  if (!empresaId || !tel) return null;
  try {
    const desde = new Date(Date.now() - 24 * 3600000).toISOString();
    const r = await fetch(SUPA_URL + '/rest/v1/pesquisas_satisfacao?empresa_id=eq.' + encodeURIComponent(empresaId) + '&telefone=eq.' + tel
      + '&status=eq.pendente&enviada_em=gt.' + encodeURIComponent(desde) + '&order=enviada_em.desc&limit=1&select=id,agradecimento', { headers: sbServiceHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    const p = rows && rows[0];
    if (!p) return null;
    const nota = extrairNota(texto);
    const body = nota
      ? { status: 'respondida', nota, comentario: String(texto || '').slice(0, 500), respondida_em: new Date().toISOString() }
      : { status: 'sem_nota', comentario: String(texto || '').slice(0, 500), respondida_em: new Date().toISOString() };
    await fetch(SUPA_URL + '/rest/v1/pesquisas_satisfacao?id=eq.' + p.id, { method: 'PATCH', headers: sbServiceHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(body) });
    if (!nota) return null;
    if (base && token) await uazapiSendText(base, token, to, p.agradecimento || 'Obrigado pela avaliação! 🙏');
    return { nota };
  } catch (e) { return null; }
}

// marca a conversa como "com humano" na tabela conversas (mesma linha que o app lê/escreve) —
// só atualiza uma linha que já existe (lê e reescreve o mesmo "dados" com o campo alterado),
// nunca cria uma linha nova, para não gravar um snapshot de conversa incompleto/sem mensagens
async function marcarConversaHumana(telefone, empresaId) {
  if (!telefone || !empresaId) return;
  const r = await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=dados', {
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
  });
  if (!r.ok) return;
  const rows = await r.json();
  const dados = rows && rows[0] && rows[0].dados;
  if (!dados) return; // conversa ainda não sincronizada pelo app — nada a atualizar ainda
  const novoDados = Object.assign({}, dados, { humano: true, iaAtiva: false, resolvida: false, _localCtrl: true });
  await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId), {
    method: 'PATCH',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ dados: novoDados, updated_at: new Date().toISOString() }),
  });
}

async function notifyHuman(base, token, number, text) {
  if (!number || !base || !token) return;
  await uazapiSendText(base, token, number, text);
}

async function fetchCatalogo(empresaId) {
  if (!empresaId) return [];
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/app_config?id=eq.produtos_catalogo&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=data', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
    });
    if (!r.ok) return [];
    const rows = await r.json();
    const data = rows && rows[0] && rows[0].data;
    return (data && Array.isArray(data.catalogo)) ? data.catalogo : [];
  } catch (e) { return []; }
}

async function fetchHistory(base, token, chatid, excludeId) {
  if (!base || !token || !chatid) return '';
  try {
    const r = await fetch(base + '/message/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ chatid: chatid, limit: 20, offset: 0 }),
    });
    if (!r.ok) return '';
    const data = await r.json();
    const arr = data.messages || data.data || (Array.isArray(data) ? data : []) || [];
    const ordered = arr.slice().sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
    const lines = [];
    for (const m of ordered) {
      const id = m.id || m.messageid || m.messageId || (m.key && m.key.id) || '';
      if (excludeId && id === excludeId) continue;
      let txt = m.text || m.content || m.caption || (m.message && (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || '';
      if (txt && typeof txt === 'object') txt = txt.text || txt.caption || txt.body || '';
      if (typeof txt !== 'string') txt = String(txt == null ? '' : txt);
      if (!txt) txt = '[mídia]';
      lines.push((m.fromMe ? 'Empresa' : 'Cliente') + ': ' + txt);
    }
    return lines.slice(-20).join('\n');
  } catch (e) { return ''; }
}

// baixa a mídia da mensagem — prioriza o endpoint da uazapi que descriptografa o arquivo
// da CDN do WhatsApp (o link cru do evento às vezes não é baixável diretamente, sobretudo
// áudio); cai para a URL crua do evento só se isso falhar ou não tivermos o id da mensagem.
async function downloadMedia(uazBase, uazToken, url, msgId) {
  if (uazBase && uazToken && msgId) {
    try {
      const r = await fetch(uazBase.replace(/\/+$/, '') + '/message/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: uazToken },
        body: JSON.stringify({ id: msgId, return_base64: true, return_link: false, generate_mp3: true }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data && data.base64Data) {
          return { buffer: Buffer.from(data.base64Data, 'base64'), contentType: data.mimetype || '' };
        }
      } else {
        console.warn('[uazapi download] não confirmado:', r.status, await r.text());
      }
    } catch (e) { console.warn('[uazapi download] falhou, tentando URL direta:', e.message || e); }
  }
  if (!url) throw new Error('sem URL nem id de mensagem para baixar mídia');
  const headers = {};
  if (uazToken) headers.token = uazToken;
  let r = await fetch(url, { headers });
  if (!r.ok) r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao baixar mídia: ' + r.status);
  return { buffer: await r.arrayBuffer(), contentType: r.headers.get('content-type') || '' };
}

async function geminiGenerate(system, parts, key, model, temperature, jsonMode) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(key || process.env.GEMINI_API_KEY);
  const generationConfig = { temperature: (temperature != null ? temperature : TEMPERATURE) };
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = {
      type: 'OBJECT',
      properties: {
        reply: { type: 'STRING' },
        replyParts: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
        sendImages: { type: 'BOOLEAN' },
        subcategoriaId: { type: 'STRING', nullable: true },
        estilo: { type: 'STRING', nullable: true },
        estagioFunil: { type: 'STRING', enum: FUNIL_ESTAGIOS },
        precisaHumano: { type: 'BOOLEAN' },
        motivoHumano: { type: 'STRING', nullable: true },
        resumoAtendimento: { type: 'STRING', nullable: true },
        agendamentoFechado: { type: 'BOOLEAN' },
        agendamentoData: { type: 'STRING', nullable: true },
        agendamentoDataISO: { type: 'STRING', nullable: true },
        gerarImagem: { type: 'BOOLEAN' },
        promptImagem: { type: 'STRING', nullable: true },
      },
      required: ['reply', 'sendImages', 'estagioFunil', 'precisaHumano', 'agendamentoFechado'],
    };
  }
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: generationConfig,
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error('Gemini: ' + (data.error && data.error.message || r.status));
  const out = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
  return out.map(p => p.text || '').join('').trim();
}

// gera uma imagem sob medida (ferramenta "Gerar imagens com IA" do agente) quando o
// cliente pede algo fora do catálogo — usa a mesma GEMINI_API_KEY, modelo próprio de imagem
async function geminiGenerateImage(prompt, key) {
  const model = 'gemini-2.5-flash-image';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error('Gemini imagem: ' + (data.error && data.error.message || r.status));
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const imgPart = parts.find((p) => p.inlineData || p.inline_data);
  const inline = imgPart && (imgPart.inlineData || imgPart.inline_data);
  if (!inline || !inline.data) throw new Error('Gemini não retornou imagem');
  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return 'data:' + mime + ';base64,' + inline.data;
}

// marca a(s) mensagem(ns) recebida(s) como lida (check azul) — best-effort,
// nunca derruba a resposta se a uazapi não reconhecer o endpoint/formato
async function uazapiMarkRead(base, token, chatid, messageId) {
  if (!messageId || !base || !token) return;
  try {
    const r = await fetch(base + '/message/markread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ id: [messageId], number: chatid }),
    });
    if (!r.ok) console.warn('[uazapi markread] não confirmado:', r.status, await r.text());
  } catch (e) { console.warn('[uazapi markread] falhou:', e.message || e); }
}

// mostra "digitando…" pro cliente enquanto a IA "pensa" a resposta — best-effort
async function uazapiSetPresence(base, token, to, presence) {
  if (!to || !base || !token) return;
  try {
    const r = await fetch(base + '/chat/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ number: to, presence: presence }),
    });
    if (!r.ok) console.warn('[uazapi presence] não confirmado:', r.status, await r.text());
  } catch (e) { console.warn('[uazapi presence] falhou:', e.message || e); }
}

async function uazapiSendText(base, token, to, text) {
  const r = await fetch(base + '/send/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: token },
    body: JSON.stringify({ number: to, text: text }),
  });
  if (!r.ok) console.error('[uazapi send] falhou:', r.status, await r.text());
}

async function uazapiSendImage(base, token, to, dataUrl, caption) {
  const body = { number: to, type: 'image', file: dataUrl };
  if (caption) body.text = caption;
  const r = await fetch(base + '/send/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: token },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error('[uazapi send image] falhou:', r.status, await r.text());
}
