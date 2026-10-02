-- Financeiro, fase 2: contas (caixa, banco, carteira digital...), orçamento por
-- categoria e marcações extras nos lançamentos. Rode DEPOIS do 26_lancamentos.sql.

-- contas onde o dinheiro entra/sai; o saldo de cada uma é o saldo inicial mais os
-- lançamentos pagos ligados a ela
create table if not exists contas_financeiras (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  nome text not null,
  tipo text not null default 'banco',
  saldo_inicial numeric not null default 0,
  cor text,
  padrao boolean not null default false,
  ativo boolean not null default true,
  created_at timestamptz default now()
);

-- limite mensal de gasto por categoria de despesa
create table if not exists orcamentos (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  categoria text not null,
  limite numeric not null default 0,
  created_at timestamptz default now()
);
create unique index if not exists orcamentos_empresa_categoria on orcamentos (empresa_id, categoria);

-- conta_id: em qual conta o dinheiro entrou/saiu
-- transferencia_id: as duas pernas de uma transferência entre contas compartilham esse id
--   (ficam fora de entradas/saídas/resultado, só mexem no saldo das contas)
-- ultima_cobranca: última vez que o cliente foi cobrado pelo WhatsApp
alter table lancamentos add column if not exists conta_id bigint;
alter table lancamentos add column if not exists transferencia_id bigint;
alter table lancamentos add column if not exists ultima_cobranca timestamptz;

-- empresa_id automático e as mesmas políticas de RLS da tabela "compras"
do $$
declare
  t text;
  pol record;
  novo_nome text;
begin
  foreach t in array array['contas_financeiras', 'orcamentos'] loop
    execute format('drop trigger if exists trg_set_empresa_id on %I', t);
    execute format('create trigger trg_set_empresa_id before insert on %I for each row execute function set_empresa_id()', t);
    execute format('alter table %I enable row level security', t);
    for pol in
      select policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
      where schemaname = 'public' and tablename = 'compras'
    loop
      novo_nome := pol.policyname || ' (' || t || ')';
      execute format('drop policy if exists %I on %I', novo_nome, t);
      execute format(
        'create policy %I on %I as %s for %s to %s%s%s',
        novo_nome, t,
        case when pol.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
        pol.cmd,
        array_to_string(pol.roles, ', '),
        case when pol.qual is not null then format(' using (%s)', pol.qual) else '' end,
        case when pol.with_check is not null then format(' with check (%s)', pol.with_check) else '' end
      );
    end loop;
  end loop;
end $$;

-- confirma que as três tabelas ficaram com o mesmo número de políticas
select tablename, count(*) as politicas
from pg_policies
where schemaname = 'public' and tablename in ('compras', 'contas_financeiras', 'orcamentos')
group by tablename;
