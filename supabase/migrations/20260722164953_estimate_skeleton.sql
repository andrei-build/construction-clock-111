-- 0092: PLAN-TO-ESTIMATE скелет (Бета-7, 22.07). Применено в прод через MCP 22.07 ~16:50Z.
-- Черновики смет + строки с источником/уверенностью + пины на чертеже.
-- ДНК: ИИ предлагает — человек утверждает (draft); сметы/строки — только owner/finance; пины — org кроме client.
create table if not exists estimate_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects(id),
  source_file_ids uuid[] default '{}',
  status text not null default 'draft' check (status in ('draft','review','approved','discarded')),
  title text not null default 'Черновик сметы',
  subtotal numeric(12,2) default 0,
  contingency_pct numeric(5,2) default 10,
  total numeric(12,2) default 0,
  engine_meta jsonb default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists estimate_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  draft_id uuid not null references estimate_drafts(id) on delete cascade,
  section text,
  cost_code text,
  description text not null,
  qty numeric(12,3),
  unit text,
  unit_price numeric(12,2),
  markup_pct numeric(5,2) default 0,
  line_total numeric(12,2),
  source jsonb default '{}'::jsonb,
  confidence numeric(3,2) default 0.5,
  flag text not null default 'green' check (flag in ('green','yellow','red')),
  needs_measure boolean not null default false,
  position int default 0,
  created_at timestamptz not null default now()
);
create table if not exists plan_pins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects(id),
  file_id uuid,
  page int not null default 1,
  bbox jsonb not null,
  severity text not null default 'green' check (severity in ('green','yellow','red')),
  kind text not null default 'estimate' check (kind in ('estimate','node','note')),
  title text,
  note text,
  estimate_item_id uuid references estimate_items(id) on delete set null,
  payload jsonb default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table estimate_drafts enable row level security;
alter table estimate_items enable row level security;
alter table plan_pins enable row level security;
create policy est_drafts_sel on estimate_drafts for select to authenticated
  using (org_id = app.org_id() and app.has_finance_access());
create policy est_drafts_mut on estimate_drafts for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());
create policy est_items_sel on estimate_items for select to authenticated
  using (org_id = app.org_id() and app.has_finance_access());
create policy est_items_mut on estimate_items for all to authenticated
  using (org_id = app.org_id() and app.has_finance_access())
  with check (org_id = app.org_id() and app.has_finance_access());
create policy plan_pins_sel on plan_pins for select to authenticated
  using (org_id = app.org_id() and app.user_role() <> 'client');
create policy plan_pins_mut on plan_pins for all to authenticated
  using (org_id = app.org_id() and app.user_role() in ('owner','admin'))
  with check (org_id = app.org_id() and app.user_role() in ('owner','admin'));