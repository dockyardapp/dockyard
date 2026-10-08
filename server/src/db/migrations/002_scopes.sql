-- Dockyard 002_scopes — resource allocation.
--
-- Until now every authenticated user saw the whole Docker host: the role ladder
-- decided what you could *do*, never what you could *see*. This migration adds
-- the missing axis.
--
--   users.scope_mode = 'all'      -> sees everything (the default; unchanged)
--   users.scope_mode = 'granted'  -> sees exactly what user_grants lists
--
-- A grant is one of two forms, never both:
--
--   * resource_id          an explicit resource (a container id, a template slug)
--   * label_key/value      a label selector
--
-- The label form is the durable one. An explicit container id stops matching the
-- moment that container is recreated, whereas a label survives recreation because
-- the panel re-applies it on create and deploy. Prefer labels.
--
-- users.can_exec gates POST /containers/:id/exec separately from the operator
-- role. The panel mounts the Docker socket, so exec into any container is
-- effectively root on the host, and it should not be conferred silently by a
-- role that otherwise only means "can start and stop things". Admins bypass it.

alter table users add column if not exists scope_mode text not null default 'all'
  check (scope_mode in ('all', 'granted'));

alter table users add column if not exists can_exec boolean not null default false;

create table if not exists user_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  resource_kind text not null check (resource_kind in
    ('container', 'stack', 'volume', 'network', 'image', 'template', 'tunnel')),
  resource_id text,
  label_key text,
  label_value text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Exactly one selector form.
  constraint user_grants_selector check (
    (resource_id is not null and label_key is null and label_value is null)
    or (resource_id is null and label_key is not null and label_value is not null)
  ),
  -- An empty label key would match nothing useful and reads as a mistake.
  constraint user_grants_label_nonempty check (
    label_key is null or length(trim(label_key)) > 0
  )
);

create index if not exists user_grants_user_id_idx on user_grants(user_id);

-- The same allocation twice is a no-op, so make it impossible.
create unique index if not exists user_grants_unique_idx on user_grants (
  user_id,
  resource_kind,
  coalesce(resource_id, ''),
  coalesce(label_key, ''),
  coalesce(label_value, '')
);
