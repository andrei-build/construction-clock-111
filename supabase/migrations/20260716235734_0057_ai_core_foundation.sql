-- AI-1: фундамент AI-ядра (ДНК §5: три уровня действий, каждое действие прослеживаемо; образец — Custom Metals)
create table public.ai_action_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  action_type text not null,                    -- 'create_task' | 'send_message' | 'send_mail' | ...
  policy text not null default 'suggest' check (policy in ('auto','confirm','suggest')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (org_id, action_type)
);
alter table public.ai_action_policies enable row level security;
create policy ai_policies_owner on public.ai_action_policies
  for all using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());

create table public.ai_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  user_id uuid,                                  -- кто разговаривал с ИИ
  action_type text not null,
  title text not null,
  payload jsonb not null default '{}'::jsonb,    -- параметры действия (для create_task: title/description/assignee...)
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed')),
  resolved_by uuid,
  resolved_at timestamptz,
  result jsonb,                                  -- что получилось после исполнения (id созданной задачи и т.п.)
  created_at timestamptz not null default now()
);
alter table public.ai_proposals enable row level security;
create policy ai_proposals_owner on public.ai_proposals
  for all using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  user_id uuid not null,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index ai_messages_user_time_idx on public.ai_messages (user_id, created_at desc);
alter table public.ai_messages enable row level security;
create policy ai_messages_own on public.ai_messages
  for select using (org_id = app.org_id() and user_id = auth.uid() and app.is_owner());
-- insert только service-role (edge), правок/удаления с клиента нет — журнал.

-- Дефолтные политики: v1 всё в режиме «предлагать» (сам ИИ ничего не делает)
insert into public.ai_action_policies (org_id, action_type, policy)
select o.id, v.t, 'suggest' from public.organizations o,
  (values ('create_task'), ('send_message'), ('send_mail'), ('create_event')) as v(t)
on conflict do nothing;
