-- 0022: фундамент «проект-хаба»: рейтинг клиента + заметки проекта
alter table public.accounts add column if not exists client_rating text;
alter table public.accounts add column if not exists rating_note text;
alter table public.accounts drop constraint if exists accounts_client_rating_check;
alter table public.accounts add constraint accounts_client_rating_check
  check (client_rating is null or client_rating in ('green','amber','red'));
comment on column public.accounts.client_rating is 'Светофор клиента (задаёт владелец/менеджер): green=кайфовый, amber=нормальный/внимание, red=проблемный';

create table if not exists public.project_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  author_id uuid not null references public.profiles(id),
  body text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.project_notes is 'Заметки проекта: коды, описания, договорённости. Часть проект-хаба (требование Андрея 13.07).';

alter table public.project_notes enable row level security;

drop policy if exists pn_select on public.project_notes;
create policy pn_select on public.project_notes for select
  using (org_id = app.org_id() and deleted_at is null and (app.is_manager() or app.can_access_project(project_id)));

drop policy if exists pn_insert on public.project_notes;
create policy pn_insert on public.project_notes for insert
  with check (org_id = app.org_id() and author_id = (select auth.uid()) and (app.is_manager_write() or app.can_access_project(project_id)));

drop policy if exists pn_update on public.project_notes;
create policy pn_update on public.project_notes for update
  using (org_id = app.org_id() and (author_id = (select auth.uid()) or app.is_manager_write()));

drop trigger if exists project_notes_touch on public.project_notes;
create trigger project_notes_touch before update on public.project_notes
  for each row execute function app.touch_updated_at();