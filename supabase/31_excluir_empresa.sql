-- Exclusão completa de uma empresa (botão "Excluir" em Configurações › Empresas, só
-- para desenvolvedor). Apaga, numa transação só, todas as linhas da empresa em TODAS as
-- tabelas do schema public que têm a coluna empresa_id (vendas, conversas, lançamentos,
-- usuários, config…) e por fim a própria empresa. Se qualquer coisa falhar, nada é apagado.
--
-- É genérica de propósito: tabela nova criada depois com empresa_id entra sozinha.
-- Só pode ser chamada com a chave de serviço (pelo endpoint /api/empresas, que confere
-- se quem pediu é desenvolvedor) — anon/authenticated não têm permissão de executar.

create or replace function excluir_empresa(p_empresa uuid)
returns jsonb
language plpgsql
as $$
declare
  t text;
  pendentes text[];
  restantes text[];
  apagadas jsonb := '{}'::jsonb;
  n bigint;
  passo int := 0;
begin
  if not exists (select 1 from empresas where id = p_empresa) then
    raise exception 'Empresa não encontrada';
  end if;
  -- não apaga a conta de um desenvolvedor junto com a empresa onde ela está cadastrada
  if exists (select 1 from app_users where empresa_id = p_empresa and is_admin) then
    raise exception 'Há desenvolvedores cadastrados nesta empresa — mova-os para outra empresa antes de excluir';
  end if;

  select array_agg(distinct c.table_name::text) into pendentes
  from information_schema.columns c
  join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'empresa_id' and c.table_name <> 'empresas';

  -- tabelas que dependem umas das outras: o que falhar por chave estrangeira tenta de
  -- novo na próxima passada, depois que as tabelas "filhas" já tiverem sido limpas
  while coalesce(array_length(pendentes, 1), 0) > 0 and passo < 10 loop
    passo := passo + 1;
    restantes := '{}';
    foreach t in array pendentes loop
      begin
        execute format('delete from %I where empresa_id = $1', t) using p_empresa;
        get diagnostics n = row_count;
        if n > 0 then apagadas := apagadas || jsonb_build_object(t, n); end if;
      exception when foreign_key_violation then
        restantes := restantes || t;
      end;
    end loop;
    if coalesce(array_length(restantes, 1), 0) = coalesce(array_length(pendentes, 1), 0) then
      raise exception 'Não foi possível apagar por dependência entre tabelas: %', array_to_string(restantes, ', ');
    end if;
    pendentes := restantes;
  end loop;

  delete from empresas where id = p_empresa;
  return apagadas;
end $$;

revoke all on function excluir_empresa(uuid) from public, anon, authenticated;
grant execute on function excluir_empresa(uuid) to service_role;
