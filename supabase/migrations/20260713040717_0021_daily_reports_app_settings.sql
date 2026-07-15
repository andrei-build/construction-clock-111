-- 0021: дневные рапорты + настройки приложения (разблокировка задач очереди паритета)
create table public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  author_id uuid not null references public.profiles(id),
  report_date date not null default current_date,
  body text not null,
  media_ids uuid[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (project_id, author_id, report_date)
);
comment on table public.daily_reports is 'Дневной рапорт бригадира по проекту. Spec: паритет Check Time';
alter table public.daily_reports enable row level security;
create policy dr_insert on public.daily_reports for insert to authenticated
  with check (org_id = app.org_id() and author_id = (select auth.uid()));
create policy dr_select on public.daily_reports for select to authenticated
  using (org_id = app.org_id() and (author_id = (select auth.uid()) or app.is_manager()));
create policy dr_update on public.daily_reports for update to authenticated
  using (org_id = app.org_id() and (author_id = (select auth.uid()) or app.is_manager_write()));

create table public.app_settings (
  org_id uuid primary key references public.organizations(id),
  default_language text not null default 'ru',
  timezone text not null default 'America/Los_Angeles',
  overlong_shift_hours numeric not null default 11,
  default_gps_radius_m integer not null default 150,
  settings jsonb not null default '{}',
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
comment on table public.app_settings is 'Настройки организации. Spec: паритет Check Time';
alter table public.app_settings enable row level security;
create policy as_select on public.app_settings for select to authenticated
  using (org_id = app.org_id());
create policy as_write on public.app_settings for all to authenticated
  using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());