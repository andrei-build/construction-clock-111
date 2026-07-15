-- Construction Clock · Миграция 0001: фундамент
-- Спека: ДНК-документ §1, §3, §5. Расширения вне public, хелперы в app (не exposed через API).

create extension if not exists postgis with schema extensions;

create schema if not exists app;
grant usage on schema app to authenticated;

-- Роли: все 7 ролей карты + supervisor из боевой модели Check Time
create type public.user_role as enum ('owner','admin','manager','supervisor','worker','driver','subcontractor','client');
create type public.project_status as enum ('planned','active','paused','completed','archived');
create type public.time_event_type as enum ('check_in','check_out','break_start','break_end','adjustment');
create type public.task_status as enum ('open','in_progress','done','cancelled');
create type public.task_priority as enum ('low','medium','high','urgent');
create type public.task_type as enum ('work','material','delivery');
create type public.doc_type as enum ('estimate','invoice','payment_application','credit_memo');
create type public.doc_status as enum ('draft','sent','approved','rejected','partial','paid','void');
create type public.message_priority as enum ('urgent','info','good','task');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.organizations is 'Организация (мультитенантный корень). settings: язык, правила payroll, версии согласий.';

create table public.profiles (
  id uuid primary key default gen_random_uuid(), -- = auth.uid() для email-пользователей; генерится для PIN-работников
  org_id uuid not null references public.organizations(id),
  name text not null,
  role public.user_role not null default 'worker',
  pin_hash text,
  color text,
  language text not null default 'en',
  is_active boolean not null default true,
  require_checkout_video boolean not null default false,
  project_access_mode text not null default 'assigned' check (project_access_mode in ('assigned','all_active')),
  notif_mode text not null default 'default',
  settings jsonb not null default '{}',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.profiles is 'Люди: работники, менеджеры, водители, субподрядчики, клиенты (портал). ДНК §1: приватные колонки защищены триггером.';
create index profiles_org_idx on public.profiles(org_id) where deleted_at is null;

create table public.user_capabilities (
  user_id uuid not null references public.profiles(id) on delete cascade,
  capability text not null,
  granted boolean not null default true,
  granted_by uuid references public.profiles(id),
  granted_at timestamptz not null default now(),
  note text,
  primary key (user_id, capability)
);
comment on table public.user_capabilities is 'Гибкие права поверх ролей (finance_access и др.). ДНК §1: finance_access выдают только owner/admin.';

-- Append-only слой событий (ДНК §3, карта блок 26 «Фундамент для AI»)
create table public.events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations(id),
  event_type text not null,
  entity_type text,
  entity_id uuid,
  data jsonb not null default '{}',
  actor_id uuid,
  actor_name text,
  actor_role text,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
comment on table public.events is 'Append-only журнал всех значимых действий. Никаких UPDATE/DELETE. Единый источник правды для таймлайна (блок 21) и AI-ядра (блок 27).';
create index events_org_time_idx on public.events(org_id, created_at desc);
create index events_entity_idx on public.events(entity_type, entity_id);
revoke update, delete on public.events from authenticated, anon;

-- Хелперы в схеме app: не exposed через PostgREST => закрыто замечание линтера про anon-RPC (ДНК §5)
create or replace function app.org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from public.profiles where id = (select auth.uid()) $$;

create or replace function app.user_role() returns public.user_role
language sql stable security definer set search_path = public as
$$ select role from public.profiles where id = (select auth.uid()) $$;

create or replace function app.is_manager() returns boolean
language sql stable security definer set search_path = public as
$$ select app.user_role() in ('supervisor','manager','admin','owner') $$;

create or replace function app.is_manager_write() returns boolean
language sql stable security definer set search_path = public as
$$ select app.user_role() in ('manager','admin','owner') $$;

create or replace function app.is_owner() returns boolean
language sql stable security definer set search_path = public as
$$ select app.user_role() in ('owner','admin') $$;

create or replace function app.has_capability(cap text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists(select 1 from public.user_capabilities
   where user_id = (select auth.uid()) and capability = cap and granted) $$;

create or replace function app.has_finance_access() returns boolean
language sql stable security definer set search_path = public as
$$ select app.is_owner() or app.has_capability('finance_access') $$;

revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;

-- Служебные триггеры
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  new.version = coalesce(old.version, 0) + 1;
  return new;
end $$;

create or replace function app.protect_profile_privileged_cols() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- ДНК §1/§2 п.7: не-менеджер не может менять себе роль, PIN, орг, активность, режим доступа
  if not app.is_manager_write() then
    new.role := old.role;
    new.pin_hash := old.pin_hash;
    new.org_id := old.org_id;
    new.is_active := old.is_active;
    new.project_access_mode := old.project_access_mode;
    new.require_checkout_video := old.require_checkout_video;
  end if;
  return new;
end $$;

create trigger organizations_touch before update on public.organizations
  for each row execute function app.touch_updated_at();
create trigger profiles_touch before update on public.profiles
  for each row execute function app.touch_updated_at();
create trigger profiles_protect before update on public.profiles
  for each row execute function app.protect_profile_privileged_cols();