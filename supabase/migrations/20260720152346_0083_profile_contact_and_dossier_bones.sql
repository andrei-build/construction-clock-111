-- Ф1, топ-остаток: приватные данные анкеты видны коллегам на чтение. Строим отдельные кости.
-- АДДИТИВНО: колонки profiles НЕ трогаем (фронт продолжает работать). Фаза-2 (drop) — после
-- перецепки фронта флотом. Данные всё равно будут перемигрированы из Check Time на готовый скелет.

-- ── КОСТЬ 1: контакты (видит сам сотрудник ИЛИ менеджер) ──
create table if not exists public.profile_contact (
  profile_id        uuid primary key references public.profiles(id) on delete cascade,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  phone             text,
  email             text,
  home_address      text,
  emergency_contact text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_profile_contact_org on public.profile_contact(org_id);
alter table public.profile_contact enable row level security;

create policy pc_select on public.profile_contact for select
  using (org_id = app.org_id() and (profile_id = (select auth.uid()) or app.is_manager()));
create policy pc_write on public.profile_contact for all
  using (org_id = app.org_id() and (profile_id = (select auth.uid()) or app.is_manager_write()))
  with check (org_id = app.org_id() and (profile_id = (select auth.uid()) or app.is_manager_write()));

-- ── КОСТЬ 2: досье + дата найма (ТОЛЬКО менеджер; сам сотрудник НЕ видит заметки о себе) ──
create table if not exists public.profile_dossier (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  org_id         uuid not null references public.organizations(id) on delete cascade,
  hire_date      date,
  dossier_notes  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_profile_dossier_org on public.profile_dossier(org_id);
alter table public.profile_dossier enable row level security;

create policy pd_select on public.profile_dossier for select
  using (org_id = app.org_id() and app.is_manager());
create policy pd_write on public.profile_dossier for all
  using (org_id = app.org_id() and app.is_manager_write())
  with check (org_id = app.org_id() and app.is_manager_write());

-- updated_at триггеры (как у остальных)
create trigger profile_contact_touch before update on public.profile_contact
  for each row execute function app.touch_updated_at();
create trigger profile_dossier_touch before update on public.profile_dossier
  for each row execute function app.touch_updated_at();

-- гранты (RLS гейтит строки; anon не нужен — только вошедшие)
grant select, insert, update, delete on public.profile_contact to authenticated;
grant select, insert, update, delete on public.profile_dossier to authenticated;

-- ── бэкфилл текущих значений (разово, чтобы тест-данные не выглядели пустыми) ──
insert into public.profile_contact (profile_id, org_id, phone, email, home_address, emergency_contact)
select id, org_id, phone, email, home_address, emergency_contact from public.profiles
on conflict (profile_id) do nothing;

insert into public.profile_dossier (profile_id, org_id, hire_date, dossier_notes)
select id, org_id, hire_date, dossier_notes from public.profiles
on conflict (profile_id) do nothing;
