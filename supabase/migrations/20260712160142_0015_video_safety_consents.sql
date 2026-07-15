-- 0015: галочка видео-ухода, согласия GPS, выравнивание политик ТБ, storage-префиксы.
-- time_events.video_path/video_status и safety_acknowledgements существуют с 0002. Spec: DNA §2.1, §2.10

alter table public.projects
  add column if not exists require_checkout_video boolean not null default false;

create table public.worker_location_consents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  worker_id uuid not null references public.profiles(id),
  consent_version text not null default 'v1',
  signature_path text not null,
  signed_at timestamptz not null default now(),
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.worker_location_consents is 'Согласие на GPS, штат Вашингтон. Spec: DNA §2.10';

alter table public.worker_location_consents enable row level security;
alter table public.safety_acknowledgements enable row level security;

drop policy if exists sa_insert_own on public.safety_acknowledgements;
create policy sa_insert_own on public.safety_acknowledgements
  for insert to authenticated
  with check (worker_id = (select auth.uid()) and org_id = app.org_id());
drop policy if exists sa_select on public.safety_acknowledgements;
create policy sa_select on public.safety_acknowledgements
  for select to authenticated
  using (org_id = app.org_id() and (worker_id = (select auth.uid()) or app.is_manager()));

create policy wlc_insert_own on public.worker_location_consents
  for insert to authenticated
  with check (worker_id = (select auth.uid()) and org_id = app.org_id());
create policy wlc_select on public.worker_location_consents
  for select to authenticated
  using (org_id = app.org_id() and (worker_id = (select auth.uid()) or app.is_manager()));

drop policy if exists storage_media_insert on storage.objects;
create policy storage_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (
      name like 'tasks/%' or name like 'projects/%'
      or name like 'videos/%' or name like 'signatures/%'
      or (name like 'receipts/%' and app.has_finance_access())
    )
  );