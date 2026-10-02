-- Limpeza única: apaga da tabela "conversas" os chats do WhatsApp que nunca tiveram
-- mensagem (contatos da agenda do celular, números inválidos como "+0"), que apareciam
-- no Atendimento como "Nova conversa". O app já não mostra nem grava mais esses chats
-- (commit 10a523a) — isto só tira os que ficaram salvos antes da correção.
--
-- Mesma regra do app (convWppVazia): conversa do WhatsApp SEM data de última mensagem,
-- sem mensagens, sem prévia e sem não lidas — OU com telefone de menos de 8 dígitos.
-- Conversas criadas à mão no app (não-WhatsApp) nunca entram.
--
-- Rode em duas etapas: primeiro só o PASSO 1 (confere a lista), depois o PASSO 2.

-- PASSO 1 — conferir o que vai ser apagado (não altera nada)
select empresa_id, telefone, nome, dados->>'ts' as ts, dados->>'previewText' as previa
from conversas
where dados->>'source' = 'wpp'
  and (
    (
      coalesce(nullif(regexp_replace(coalesce(dados->>'ts', ''), '[^0-9]', '', 'g'), ''), '0')::numeric = 0
      and (jsonb_typeof(dados->'msgs') is distinct from 'array' or jsonb_array_length(dados->'msgs') = 0)
      and coalesce(dados->>'previewText', '') = ''
      and coalesce(nullif(regexp_replace(coalesce(dados->>'unread', ''), '[^0-9]', '', 'g'), ''), '0')::numeric = 0
    )
    or length(regexp_replace(coalesce(telefone, ''), '[^0-9]', '', 'g')) < 8
  )
order by empresa_id, nome;

-- PASSO 2 — apagar (mesmo filtro do passo 1). Devolve quantas linhas saíram por empresa.
with apagadas as (
  delete from conversas
  where dados->>'source' = 'wpp'
    and (
      (
        coalesce(nullif(regexp_replace(coalesce(dados->>'ts', ''), '[^0-9]', '', 'g'), ''), '0')::numeric = 0
        and (jsonb_typeof(dados->'msgs') is distinct from 'array' or jsonb_array_length(dados->'msgs') = 0)
        and coalesce(dados->>'previewText', '') = ''
        and coalesce(nullif(regexp_replace(coalesce(dados->>'unread', ''), '[^0-9]', '', 'g'), ''), '0')::numeric = 0
      )
      or length(regexp_replace(coalesce(telefone, ''), '[^0-9]', '', 'g')) < 8
    )
  returning empresa_id
)
select empresa_id, count(*) as conversas_apagadas from apagadas group by empresa_id;
