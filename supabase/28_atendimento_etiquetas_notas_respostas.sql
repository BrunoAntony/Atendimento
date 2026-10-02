-- Atendimento: etiquetas, notas internas e respostas rápidas.
-- Ficam em tabelas próprias (e não dentro de conversas.dados) porque cada aparelho
-- regrava a conversa inteira ao sincronizar — uma nota ou etiqueta guardada ali podia
-- ser sobrescrita por outro aparelho com uma cópia mais antiga da conversa.

-- etiquetas disponíveis na empresa (ex: Orçamento, Pós-venda, VIP)
create table if not exists etiquetas (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  nome text not null,
  cor text not null default '#14b8a6',
  created_at timestamptz default now()
);

-- quais etiquetas cada conversa tem (uma linha por telefone, lista de ids de etiqueta)
create table if not exists conversa_etiquetas (
  empresa_id uuid not null references empresas(id),
  telefone text not null,
  etiquetas jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now(),
  primary key (empresa_id, telefone)
);

-- notas internas da conversa (só a equipe vê; nunca vão pro cliente)
create table if not exists conversa_notas (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  telefone text not null,
  texto text not null,
  autor text,
  created_at timestamptz default now()
);
create index if not exists conversa_notas_tel on conversa_notas (empresa_id, telefone);

-- respostas rápidas: digitar /atalho no campo de mensagem insere o texto
create table if not exists respostas_rapidas (
  id bigint primary key,
  empresa_id uuid not null references empresas(id),
  atalho text not null,
  texto text not null,
  created_at timestamptz default now()
);
create unique index if not exists respostas_rapidas_atalho on respostas_rapidas (empresa_id, atalho);

-- empresa_id automático e as mesmas políticas de RLS da tabela "conversas" (e não de
-- "compras"): quem atende — inclusive o papel de funcionário — já tem acesso às conversas,
-- então tem que ter acesso às etiquetas, notas e respostas rápidas também
do $$
declare
  t text;
  pol record;
  novo_nome text;
begin
  foreach t in array array['etiquetas', 'conversa_etiquetas', 'conversa_notas', 'respostas_rapidas'] loop
    execute format('drop trigger if exists trg_set_empresa_id on %I', t);
    execute format('create trigger trg_set_empresa_id before insert on %I for each row execute function set_empresa_id()', t);
    execute format('alter table %I enable row level security', t);
    for pol in
      select policyname, permissive, roles, cmd, qual, with_check
      from pg_policies
      where schemaname = 'public' and tablename = 'conversas'
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

-- confirma que as tabelas novas ficaram com o mesmo número de políticas de "conversas"
select tablename, count(*) as politicas
from pg_policies
where schemaname = 'public' and tablename in ('conversas', 'etiquetas', 'conversa_etiquetas', 'conversa_notas', 'respostas_rapidas')
group by tablename;
