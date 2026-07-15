-- 0029: спецификация материалов проекта (план-BOM как в Check Time: раздел/этап, позиция, кол-во, ед., поставщик, ссылка, заметка)
-- Без цен (работники видят список целиком). Ведёт manager+; статус позиции синхронизируется с материальной задачей (task_id).

create table if not exists public.project_materials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  section text,
  name text not null,
  qty numeric,
  unit text,
  supplier text,
  url text,
  note text,
  sort_order integer not null default 0,
  status text not null default 'plan' check (status in ('plan','requested','picked_up','delivered')),
  task_id uuid references public.tasks(id),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.project_materials is 'Спецификация материалов проекта (план, БЕЗ цен). Работники видят список; ведёт manager+. status синхронизируется с материальной задачей task_id (заявка драйверам).';

create index if not exists project_materials_project_idx
  on public.project_materials (project_id, sort_order);

alter table public.project_materials enable row level security;

create policy pm_select on public.project_materials
  for select to authenticated
  using (org_id = app.org_id() and app.can_access_project(project_id));

create policy pm_insert on public.project_materials
  for insert to authenticated
  with check (org_id = app.org_id() and app.is_manager_write());

create policy pm_update on public.project_materials
  for update to authenticated
  using (org_id = app.org_id() and app.is_manager_write());

create trigger project_materials_touch
  before update on public.project_materials
  for each row execute function app.touch_updated_at();