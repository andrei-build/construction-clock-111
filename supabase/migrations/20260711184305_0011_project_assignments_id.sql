-- v0.2 frontend expects a surrogate id on project_assignments (select/delete by id)
alter table public.project_assignments
  add column if not exists id uuid not null default gen_random_uuid();

create unique index if not exists project_assignments_id_key
  on public.project_assignments(id);