-- tabela única do financeiro: cada linha é uma conta a receber (receita) ou a pagar
-- (despesa). Vendas, OS, compras e despesas geram seus lançamentos automaticamente
-- pelo app (origem + origem_id apontam pro registro de origem); lançamentos avulsos
-- ficam com origem = 'manual'.
create table if not exists lancamentos (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  tipo text not null check (tipo in ('receita', 'despesa')),
  descricao text,
  valor numeric not null default 0,
  valor_pago numeric,
  vencimento date,
  data_pagamento date,
  status text not null default 'aberto' check (status in ('aberto', 'pago', 'cancelado')),
  categoria text,
  forma_pagamento text,
  pessoa text,
  origem text not null default 'manual',
  origem_id bigint,
  parcela int,
  total_parcelas int,
  grupo_id bigint,
  recorrente boolean not null default false,
  parcela_de bigint,
  observacao text,
  created_at timestamptz default now()
);

create index if not exists lancamentos_empresa_venc on lancamentos (empresa_id, vencimento);

-- impede que o mesmo registro de origem gere o lançamento principal duas vezes
-- (ex: dois dispositivos sincronizando ao mesmo tempo). O restante de um pagamento
-- parcial tem parcela_de preenchido e por isso fica fora dessa regra.
create unique index if not exists lancamentos_origem_unica
  on lancamentos (empresa_id, origem, origem_id)
  where origem <> 'manual' and parcela_de is null;

-- preenche empresa_id automaticamente, igual às outras tabelas
drop trigger if exists trg_set_empresa_id on lancamentos;
create trigger trg_set_empresa_id
before insert on lancamentos
for each row execute function set_empresa_id();

-- copia as políticas de RLS da tabela "compras" (sem isso toda leitura/escrita fica
-- bloqueada assim que o RLS é habilitado)
alter table lancamentos enable row level security;
do $$
declare
  pol record;
  novo_nome text;
begin
  for pol in
    select policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public' and tablename = 'compras'
  loop
    novo_nome := pol.policyname || ' (lancamentos)';
    execute format('drop policy if exists %I on lancamentos', novo_nome);
    execute format(
      'create policy %I on lancamentos as %s for %s to %s%s%s',
      novo_nome,
      case when pol.permissive = 'PERMISSIVE' then 'permissive' else 'restrictive' end,
      pol.cmd,
      array_to_string(pol.roles, ', '),
      case when pol.qual is not null then format(' using (%s)', pol.qual) else '' end,
      case when pol.with_check is not null then format(' with check (%s)', pol.with_check) else '' end
    );
  end loop;
end $$;

-- confirma que as duas tabelas ficaram com o mesmo número de políticas
select tablename, count(*) as politicas
from pg_policies
where schemaname = 'public' and tablename in ('compras', 'lancamentos')
group by tablename;
