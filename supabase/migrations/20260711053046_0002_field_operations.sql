-- Construction Clock · Миграция 0002: полевые операции (карта блоки 2, 4, 5, 8, 22; ДНК §2)

-- Фикс: touch-триггер бампит version только там, где колонка есть
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  if to_jsonb(new) ? 'version' then
    new.version = coalesce((to_jsonb(old)->>'version')::int, 0) + 1;
  end if;
  return new;
end $$;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  name text not null,
  address text,
  notes text,
  status public.project_status not null default 'active',
  site_point extensions.geography(point,4326),
  gps_radius_m integer not null default 150,
  start_date date,
  end_date date,
  client_account_id uuid, -- FK добавится в 0004 (clients)
  settings jsonb not null default '{}',
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz
);
comment on table public.projects is 'Проекты/объекты: адрес, геозона (точка+радиус), статусы, архив. Карта блок 2.';
create index projects_org_status_idx on public.projects(org_id, status) where deleted_at is null;

create table public.project_assignments (
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now(),
  note text,
  primary key (project_id, profile_id)
);
comment on table public.project_assignments is 'Явные назначения людей на проекты (диспетчер, карта блок 10).';

create table public.project_exclusions (
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (project_id, profile_id)
);
comment on table public.project_exclusions is 'Исключения при project_access_mode=all_active (ДНК §2 п.9).';

create table public.time_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  profile_id uuid not null references public.profiles(id),
  project_id uuid references public.projects(id),
  event_type public.time_event_type not null,
  event_time timestamptz not null,
  server_time timestamptz not null default now(),
  gps_point extensions.geography(point,4326),
  gps_accuracy_m numeric,
  gps_source text,
  gps_status text, -- good/bad/off — GPS не взялся, отметка всё равно проходит (ДНК §2 п.1, карта блок 4)
  distance_to_site_m numeric,
  video_status text,
  video_path text,
  adjusts_event_id uuid references public.time_events(id),
  adjust_reason text,
  adjusted_by uuid references public.profiles(id),
  notes text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
comment on table public.time_events is 'События времени: приход/уход/перерыв. История неизменна: корректировки — новые события с adjusts_event_id+причиной (ДНК §2 п.1). Нет отметки — нет оплаченных часов (ДНК-правило №1).';
create index time_events_org_profile_time_idx on public.time_events(org_id, profile_id, event_time desc);
create index time_events_project_idx on public.time_events(project_id, event_time desc);

create table public.safety_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  project_id uuid references public.projects(id),
  time_event_id uuid references public.time_events(id),
  doc_version text not null,
  signature_path text,
  signed_at timestamptz not null default now(),
  ip inet,
  user_agent text
);
comment on table public.safety_acknowledgements is 'Подпись ТБ при заходе на объект, привязана к check-in (ДНК §2 п.10).';

create table public.location_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  consent_version text not null,
  granted boolean not null,
  signature_path text,
  signed_at timestamptz not null default now(),
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
comment on table public.location_consents is 'Согласие на GPS-трекинг (юридика штата Вашингтон, карта блок 5).';

create table public.live_locations (
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  gps_point extensions.geography(point,4326) not null,
  accuracy_m numeric,
  recorded_at timestamptz not null default now(),
  primary key (worker_id, recorded_at)
);
comment on table public.live_locations is 'Живая карта: кто сейчас где (карта блок 1). Хранится скользящее окно, чистится джобом.';

create table public.shift_geo_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  project_id uuid references public.projects(id),
  status text not null, -- signal_lost / far_from_site / gps_off / back_on_site
  minutes_since_signal numeric,
  distance_m numeric,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);
comment on table public.shift_geo_events is 'Контрольная логика GPS: пропал сигнал, далеко от объекта, GPS выключен — событие в лог, работа не блокируется (карта блоки 5, 22).';

create table public.supply_stores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  name text not null,
  address text,
  point extensions.geography(point,4326),
  radius_m integer not null default 120,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.supply_stores is 'Магазины поставок для автодетекта заездов (ДНК §2 п.11).';

create table public.store_visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  store_id uuid references public.supply_stores(id),
  project_id uuid references public.projects(id),
  entered_at timestamptz not null,
  exited_at timestamptz,
  is_paid boolean not null default true,
  note text,
  metadata jsonb not null default '{}'
);
comment on table public.store_visits is 'Заезды в магазины во время смены (детект edge-функцией).';

create trigger projects_touch before update on public.projects
  for each row execute function app.touch_updated_at();