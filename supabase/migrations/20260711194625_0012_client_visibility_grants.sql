-- В10 «Поехали → клиент знает»: точечные гранты владельца — какой клиент что видит/получает.
-- v1: таблица грантов + RLS. v2 будет читать их при travel.started/check_in/check_out.

create table public.client_visibility_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  account_id uuid not null references public.accounts(id),
  project_id uuid references public.projects(id), -- null = все проекты этого клиента
  can_see_presence boolean not null default false, -- клиент видит: кто на объекте, пришёл/ушёл, когда
  notify_travel boolean not null default false,    -- сообщать «работник выехал, будет ~к N»
  notify_checkin boolean not null default false,   -- сообщать о приходе на объект
  notify_checkout boolean not null default false,  -- сообщать об уходе с объекта
  channel text not null default 'portal' check (channel in ('portal','email','sms')),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index client_visibility_grants_account_idx on public.client_visibility_grants(account_id) where revoked_at is null;
create index client_visibility_grants_project_idx on public.client_visibility_grants(project_id) where revoked_at is null;

alter table public.client_visibility_grants enable row level security;

-- менеджеры организации управляют грантами
create policy cvg_select on public.client_visibility_grants
  for select using (
    org_id = app.org_id() and (
      app.is_manager()
      or exists (select 1 from public.client_users cu
                 where cu.profile_id = (select auth.uid())
                   and cu.account_id = client_visibility_grants.account_id)
    )
  );

create policy cvg_insert on public.client_visibility_grants
  for insert with check (org_id = app.org_id() and app.is_manager_write());

create policy cvg_update on public.client_visibility_grants
  for update using (org_id = app.org_id() and app.is_manager_write());
