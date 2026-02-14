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

-- Seguranca:
-- 1) remove politicas antigas permissivas para anon
-- 2) bloqueia acesso anon direto nas tabelas multi-tenant
-- 3) backend deve usar service_role key nas rotas multi-cliente

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='clientes' and policyname='clientes_select_anon'
  ) then
    drop policy clientes_select_anon on public.clientes;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='clientes' and policyname='clientes_insert_anon'
  ) then
    drop policy clientes_insert_anon on public.clientes;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='grupos' and policyname='grupos_all_anon'
  ) then
    drop policy grupos_all_anon on public.grupos;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='interacoes_cliente' and policyname='interacoes_cliente_all_anon'
  ) then
    drop policy interacoes_cliente_all_anon on public.interacoes_cliente;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='clientes' and policyname='clientes_deny_anon'
  ) then
    create policy clientes_deny_anon on public.clientes for all to anon using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='grupos' and policyname='grupos_deny_anon'
  ) then
    create policy grupos_deny_anon on public.grupos for all to anon using (false) with check (false);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='interacoes_cliente' and policyname='interacoes_cliente_deny_anon'
  ) then
    create policy interacoes_cliente_deny_anon on public.interacoes_cliente for all to anon using (false) with check (false);
  end if;
end $$;
