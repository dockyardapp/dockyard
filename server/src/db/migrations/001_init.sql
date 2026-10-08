-- Dockyard 001_init — baseline schema (owner: agent 1).
-- Exact DDL as frozen in CONTRACT.md §3. Never edit an applied migration.

create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin','operator','viewer')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text, ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists audit_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  action text not null, target_type text not null, target_id text,
  detail jsonb, ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on audit_log(created_at desc);

create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  category text not null default 'other',
  icon text not null default 'package',
  description text not null default '',
  spec jsonb not null,
  source text not null default 'user' check (source in ('builtin','user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists stacks (
  id uuid primary key default gen_random_uuid(),
  name text not null, slug text not null,
  source text not null default 'template' check (source in ('template','user')),
  template_slug text,
  spec jsonb not null default '{}'::jsonb,
  values jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running','stopped','partial','error')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stacks_slug_idx on stacks(slug);

create table if not exists tunnels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mode text not null check (mode in ('quick','named')),
  target_url text not null,
  container_id text, port integer,
  hostname text, zone_id text, tunnel_id text,
  credentials_path text, config_path text,
  status text not null default 'stopped' check (status in ('stopped','starting','running','error')),
  url text, pid integer, last_error text,
  auto_start boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  secret boolean not null default false,
  updated_at timestamptz not null default now()
);
