-- Construction Clock · 0009: продажи, календарь/инспекции, расходы+профит, подписи
-- (разделы К, Л, М, Н документа замысла)

-- === Л. ВОРОНКА ПРОДАЖ ===
create type public.deal_stage as enum ('lead','contacted','measured','quoted','negotiation','signed','handed_off','lost');

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  account_id uuid references public.accounts(id),
  contact_id uuid references public.contacts(id),
  title text not null,
  stage public.deal_stage not null default 'lead',
  expected_amount numeric(12,2),
  source text, -- откуда лид: реклама/рекомендация/сосед...
  owner_profile_id uuid references public.profiles(id), -- продавец
  project_id uuid references public.projects(id), -- заполняется при передаче в производство
  next_action text,
  next_action_at timestamptz,
  notes text,
  metadata jsonb not null default '{}',
  created_by uuid references public.profiles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.deals is 'Сделки: лид → замер → смета → подписано → передача в производство (Л1-Л2). При handed_off создаётся проект и документы переезжают.';
create index deals_org_stage_idx on public.deals(org_id, stage) where deleted_at is null;
create trigger deals_touch before update on public.deals for each row execute function app.touch_updated_at();

-- === М. КАЛЕНДАРЬ: ВСТРЕЧИ / ИНСПЕКЦИИ / ЗАМЕРЫ / ПОСТАВКИ ===
create type public.calendar_event_type as enum ('meeting','inspection','measure','delivery','other');
create type public.inspection_status as enum ('requested','scheduled','passed','failed','cancelled');

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  event_type public.calendar_event_type not null default 'meeting',
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  project_id uuid references public.projects(id),
  account_id uuid references public.accounts(id),
  deal_id uuid references public.deals(id),
  assigned_to uuid references public.profiles(id),
  permit_number text,               -- для инспекций
  inspection_status public.inspection_status, -- только для инспекций
  remind_offsets_minutes integer[] not null default '{4320,1440,60}', -- за 3 дня, за день, за час
  notes text,
  metadata jsonb not null default '{}',
  created_by uuid references public.profiles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.calendar_events is 'Календарь компании: встречи, ИНСПЕКЦИИ (с permit и статусом), замеры, поставки. Провал инспекции → задача на исправление (М2).';
create index calendar_org_time_idx on public.calendar_events(org_id, starts_at) where deleted_at is null;
create trigger calendar_touch before update on public.calendar_events for each row execute function app.touch_updated_at();

-- === К5/Д. РАСХОДЫ ПРОЕКТА И БЮДЖЕТ (для светофора профита) ===
alter table public.projects add column if not exists budget_amount numeric(12,2);
comment on column public.projects.budget_amount is 'Бюджет из сметы — база для светофора перспективности (К5).';

create table public.project_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  project_id uuid not null references public.projects(id),
  kind text not null default 'material' check (kind in ('material','sub','equipment','permit','other')),
  description text,
  amount numeric(12,2) not null,
  vendor text,
  source text not null default 'manual' check (source in ('manual','receipt_ocr','invoice')),
  media_id uuid references public.media(id), -- фото чека
  incurred_at date not null default current_date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.project_expenses is 'Расходы проекта: материалы/субы/техника. Источник — вручную или чек через OCR (Д2).';
create index expenses_project_idx on public.project_expenses(project_id) where deleted_at is null;

-- === Н. ПОДПИСИ (универсальные, как DocuSign внутри) ===
create table public.signatures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  entity_type text not null, -- document / file / deal / safety / consent / change_order
  entity_id uuid not null,
  signer_profile_id uuid references public.profiles(id),
  signer_name text not null,
  signer_email text,
  signature_path text not null, -- изображение подписи в storage
  doc_hash text,                -- хэш подписанного содержимого
  signed_at timestamptz not null default now(),
  ip inet,
  user_agent text
);
comment on table public.signatures is 'Журнал подписей: кто, когда, что, с какого устройства (Н1-Н2). Юридическая прослеживаемость.';
create index signatures_entity_idx on public.signatures(entity_type, entity_id);

-- === К5. СВЕТОФОР ПРОФИТА: view (security_invoker — уважает RLS) ===
create or replace view public.v_project_profit
with (security_invoker = true) as
with intervals as (
  select te.org_id, te.project_id,  te.profile_id, te.event_time,
         lead(te.event_time) over w as next_time,
         lead(te.event_type) over w as next_type,
         te.event_type
  from public.time_events te
  window w as (partition by te.profile_id order by te.event_time)
),
labor as (
  select i.org_id, i.project_id,
         sum(extract(epoch from (i.next_time - i.event_time)) / 3600.0
             * coalesce(r.hourly_rate, 0)) as labor_cost,
         sum(extract(epoch from (i.next_time - i.event_time)) / 3600.0) as labor_hours
  from intervals i
  left join lateral (
    select pr.hourly_rate from public.profile_rates pr
    where pr.profile_id = i.profile_id order by pr.effective_from desc limit 1
  ) r on true
  where i.event_type in ('check_in','break_end')
    and i.next_type in ('break_start','check_out')
    and i.project_id is not null
  group by i.org_id, i.project_id
),
exp as (
  select project_id, sum(amount) as expenses_cost
  from public.project_expenses where deleted_at is null group by project_id
)
select p.id as project_id, p.org_id, p.name, p.status, p.budget_amount,
       round(coalesce(l.labor_hours,0)::numeric, 1) as labor_hours,
       round(coalesce(l.labor_cost,0)::numeric, 2) as labor_cost,
       round(coalesce(e.expenses_cost,0)::numeric, 2) as expenses_cost,
       round((coalesce(l.labor_cost,0) + coalesce(e.expenses_cost,0))::numeric, 2) as total_cost,
       case when p.budget_amount is null or p.budget_amount = 0 then null
            else round(((p.budget_amount - coalesce(l.labor_cost,0) - coalesce(e.expenses_cost,0))
                 / p.budget_amount * 100)::numeric, 1) end as margin_pct,
       case when p.budget_amount is null or p.budget_amount = 0 then 'grey'
            when (coalesce(l.labor_cost,0) + coalesce(e.expenses_cost,0)) > p.budget_amount then 'red'
            when (coalesce(l.labor_cost,0) + coalesce(e.expenses_cost,0)) > p.budget_amount * 0.75 then 'amber'
            else 'green' end as profit_status
from public.projects p
left join labor l on l.project_id = p.id
left join exp e on e.project_id = p.id
where p.deleted_at is null;
comment on view public.v_project_profit is 'Светофор перспективности проекта (К5): бюджет vs труд+расходы. green/amber/red/grey.';

-- === RLS ===
alter table public.deals enable row level security;
alter table public.calendar_events enable row level security;
alter table public.project_expenses enable row level security;
alter table public.signatures enable row level security;

-- Продажи видят сделки/клиентов; менеджеры тоже; клиенты и полевые — нет
create policy deals_select on public.deals for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
         and (app.is_manager() or app.user_role() = 'sales' or owner_profile_id = (select auth.uid())));
create policy deals_write on public.deals for all to authenticated
  using (org_id = app.org_id() and (app.is_manager_write() or app.user_role() = 'sales'))
  with check (org_id = app.org_id() and (app.is_manager_write() or app.user_role() = 'sales'));

create policy cal_select on public.calendar_events for select to authenticated
  using (org_id = app.org_id() and deleted_at is null
         and (app.is_manager() or app.user_role() = 'sales' or assigned_to = (select auth.uid())));
create policy cal_write on public.calendar_events for all to authenticated
  using (org_id = app.org_id() and (app.is_manager_write() or app.user_role() = 'sales'))
  with check (org_id = app.org_id() and (app.is_manager_write() or app.user_role() = 'sales'));

-- Расходы: финансовый доступ пишет и видит; менеджер видит
create policy exp_select on public.project_expenses for select to authenticated
  using (org_id = app.org_id() and deleted_at is null and (app.has_finance_access() or app.is_manager()));
create policy exp_write on public.project_expenses for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());

-- Подписи: участник видит свои, менеджер — все; вставка — сам подписант или менеджер
create policy sig_select on public.signatures for select to authenticated
  using (org_id = app.org_id() and (app.is_manager() or signer_profile_id = (select auth.uid())));
create policy sig_insert on public.signatures for insert to authenticated
  with check (org_id = app.org_id() and (signer_profile_id = (select auth.uid()) or app.is_manager_write()));