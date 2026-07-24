-- 0093: ВНУТРЕННИЕ АГЕНТЫ MARVEL (Бета-7, 23.07). Marvel командует под-агентами по данным владельца.
-- ДНК: Marvel ПРЕДЛАГАЕТ задание (proposal run_job) → человек утверждает → задание бежит асинхронно →
-- результат с флагами; критичные действия внутри задания — только после «да». Финансы гейтит RLS.
-- Задания РАБОТАЮТ С ДАННЫМИ (фото/часы/почта/сметы), НЕ переписывают код приложения (это внешний флот).

create table if not exists ai_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  created_by uuid,
  job_type text not null,                    -- photo_audit | hours_review | estimate_from_plan | ...
  status text not null default 'queued'
    check (status in ('queued','running','needs_approval','done','error','cancelled')),
  title text not null,
  project_id uuid references projects(id),
  params jsonb default '{}'::jsonb,           -- вход задания
  progress jsonb default '{}'::jsonb,         -- {done, total, note} для живого прогресса
  result jsonb default '{}'::jsonb,           -- итог: находки/флаги/сводка
  flags_summary jsonb default '{}'::jsonb,    -- {green,yellow,red} счётчики для карточки
  error text,
  is_finance boolean not null default false,  -- задание касается финансов → строже RLS
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_jobs_org_status_idx on ai_jobs(org_id, status, created_at desc);

alter table ai_jobs enable row level security;

-- Владелец/админ видят все задания org; финансовые — только при finance-доступе.
create policy ai_jobs_sel on ai_jobs for select to authenticated
  using (
    org_id = app.org_id()
    and app.user_role() in ('owner','admin')
    and (is_finance = false or app.has_finance_access())
  );
create policy ai_jobs_mut on ai_jobs for all to authenticated
  using (org_id = app.org_id() and app.user_role() in ('owner','admin'))
  with check (org_id = app.org_id() and app.user_role() in ('owner','admin'));
