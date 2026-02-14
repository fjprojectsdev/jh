-- iMavy Multi-Cliente (Tenant) Setup
-- Execute no SQL Editor do Supabase.

create extension if not exists pgcrypto;

create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email text not null unique,
  senha_hash text not null,
  plano text not null check (plano in ('free', 'pro', 'enterprise')) default 'free',
  criado_em timestamptz not null default now()
);

create table if not exists public.grupos (
  id text primary key,
  nome text not null,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create index if not exists idx_grupos_cliente_id on public.grupos(cliente_id);

create table if not exists public.interacoes_cliente (
  id text primary key,
  participante text not null,
  data date not null,
  grupo_id text not null references public.grupos(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create index if not exists idx_interacoes_cliente_data on public.interacoes_cliente(data);
create index if not exists idx_interacoes_cliente_grupo on public.interacoes_cliente(grupo_id);

alter table public.clientes enable row level security;
alter table public.grupos enable row level security;
alter table public.interacoes_cliente enable row level security;

-- Back-end usa chave anon por HTTP REST.
-- Mantemos politicas permissivas aqui para compatibilidade imediata.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='clientes' and policyname='clientes_select_anon'
  ) then
    create policy clientes_select_anon on public.clientes for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='clientes' and policyname='clientes_insert_anon'
  ) then
    create policy clientes_insert_anon on public.clientes for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='grupos' and policyname='grupos_all_anon'
  ) then
    create policy grupos_all_anon on public.grupos for all to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='interacoes_cliente' and policyname='interacoes_cliente_all_anon'
  ) then
    create policy interacoes_cliente_all_anon on public.interacoes_cliente for all to anon using (true) with check (true);
  end if;
end $$;
