-- Novo segmento de empresa: "clinicas" (Clínicas — pacientes, serviços por especialidade
-- e agendamento de consultas). A coluna empresas.segmento só aceita os valores da regra
-- abaixo; sem isto, escolher "Clínicas" no app dá erro de check constraint.

-- remove QUALQUER check constraint existente na coluna "segmento" (seja qual for o nome)
do $$
declare
  con record;
begin
  for con in
    select c.conname
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_attribute att on att.attrelid = rel.oid
    where rel.relname = 'empresas'
      and c.contype = 'c'
      and att.attname = 'segmento'
      and att.attnum = any(c.conkey)
  loop
    execute format('alter table empresas drop constraint %I', con.conname);
  end loop;
end $$;

alter table empresas add constraint empresas_segmento_check
  check (segmento in ('geral', 'imobiliaria', 'eventos', 'clinicas', 'todos'));
