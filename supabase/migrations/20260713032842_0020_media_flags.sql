-- 0020: флаги на медиа («проверить фото») — по запросу супервизора для Галереи. Spec: DNA §2.8
create table public.media_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  media_id uuid not null references public.media(id),
  flagged_by uuid not null references public.profiles(id),
  reason text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.media_flags is 'Флаг «на проверку» на фото/видео, ревью менеджером. Spec: DNA §2.8';

alter table public.media_flags enable row level security;
create policy mf_insert on public.media_flags
  for insert to authenticated
  with check (org_id = app.org_id() and flagged_by = (select auth.uid()));
create policy mf_select on public.media_flags
  for select to authenticated
  using (org_id = app.org_id() and (flagged_by = (select auth.uid()) or app.is_manager()));
create policy mf_update on public.media_flags
  for update to authenticated
  using (org_id = app.org_id() and app.is_manager_write());