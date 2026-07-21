-- MEDIA-EYES v1: результаты AI-анализа фото
create table public.media_analysis (
  media_id uuid primary key references public.media(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  analysis jsonb not null,
  flags text[] not null default '{}',
  severity text not null default 'green' check (severity in ('green','yellow','red')),
  client_visible_rec boolean,
  model text,
  tokens_in int default 0,
  tokens_out int default 0,
  analyzed_at timestamptz not null default now()
);

create index media_analysis_org_idx on public.media_analysis (org_id);
create index media_analysis_severity_idx on public.media_analysis (severity);

alter table public.media_analysis enable row level security;

-- Чтение: члены организации, кроме роли client. Запись: только service_role (политик insert/update для authenticated нет).
create policy media_analysis_select on public.media_analysis
  for select to authenticated
  using (org_id = app.org_id() and app.user_role() <> 'client');

grant select on public.media_analysis to authenticated;
