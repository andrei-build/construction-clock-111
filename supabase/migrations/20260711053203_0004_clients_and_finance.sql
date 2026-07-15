-- Construction Clock · Миграция 0004: клиенты, сметы/инвойсы, субподрядчики, зарплата (карта блоки 9, 13, 14, 15, 16; архитектура BuildAdmin)

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  name text not null,
  account_type text not null default 'client' check (account_type in ('client','gc','vendor','subcontractor_company')),
  email text,
  phone text,
  address text,
  notes text,
  is_taxable boolean not null default true,
  insurance_status text,
  metadata jsonb not null default '{}',
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  archived_at timestamptz
);
comment on table public.accounts is 'Клиенты/GC/поставщики — единая сущность (архитектура BuildAdmin, карта блок 16).';

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  title text,
  email text,
  phone text,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.contacts is 'Контактные лица клиента (карта блок 16).';

-- Привязка портального пользователя к клиенту (блок 14)
create table public.client_users (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  primary key (profile_id, account_id)
);
comment on table public.client_users is 'Клиентский портал: какой профиль (role=client) принадлежит какому клиенту.';

alter table public.projects
  add constraint projects_client_fk foreign key (client_account_id) references public.accounts(id);
alter table public.files
  add constraint files_account_fk foreign key (account_id) references public.accounts(id);

create table public.subcontractor_details (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  org_id uuid not null references public.organizations(id),
  company_account_id uuid references public.accounts(id),
  trade text,
  license_number text,
  insurance_expires date,
  payment_terms text,
  notes text,
  metadata jsonb not null default '{}'
);
comment on table public.subcontractor_details is 'Профиль субподрядчика: специализация, лицензия, страховка (карта блок 13). Документы — в files (scope=subcontractor).';

create table public.cost_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  code text not null,
  name text not null,
  cost_type text, -- labor / material / equipment / sub / other
  is_active boolean not null default true,
  unique (org_id, code)
);
comment on table public.cost_codes is 'Коды затрат для смет и учёта (архитектура BuildAdmin, блок 15).';

create table public.units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id),
  name text not null,
  abbreviation text
);
comment on table public.units is 'Единицы измерения (шт, час, кв.фут...).';

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  account_id uuid references public.accounts(id),
  project_id uuid references public.projects(id),
  doc_type public.doc_type not null,
  status public.doc_status not null default 'draft',
  number text not null,
  title text,
  source_document_id uuid references public.documents(id), -- смета → инвойс (карта блок 15)
  from_party jsonb not null default '{}', -- реквизиты отправителя
  to_party jsonb not null default '{}',   -- реквизиты получателя
  issue_date date,
  due_date date,
  subtotal numeric(12,2) not null default 0,
  tax_rate numeric(6,4) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  amount_paid numeric(12,2) not null default 0,
  balance numeric(12,2) generated always as (total - amount_paid) stored,
  retainage_pct numeric(6,4),
  margin_pct numeric(6,4),
  client_visible boolean not null default false,
  approved_at timestamptz,
  approved_by_contact uuid references public.contacts(id),
  signature_path text,
  signed_at timestamptz,
  sent_at timestamptz,
  notes text,
  metadata jsonb not null default '{}',
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, doc_type, number)
);
comment on table public.documents is 'Сметы/инвойсы/платёжки: шапка. Смета→инвойс через source_document_id. Подпись, согласование клиентом в портале (блоки 14, 15).';
create index documents_org_type_idx on public.documents(org_id, doc_type, status) where deleted_at is null;

create table public.document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id),
  description text not null,
  qty numeric(12,3) not null default 1,
  unit_id uuid references public.units(id),
  unit_price numeric(12,2) not null default 0,
  markup_pct numeric(6,4) not null default 0,
  is_client_material boolean not null default false, -- материалы клиента vs GC (блок 15)
  total numeric(12,2) not null default 0,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'
);
comment on table public.document_items is 'Строки смет/инвойсов: позиции, количество, цена, наценка.';

-- Зарплата (ДНК §2 п.5-7, карта блок 9)
create table public.profile_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  rate_type text not null default 'hourly' check (rate_type in ('hourly','fixed')),
  hourly_rate numeric(10,2),
  fixed_amount numeric(12,2),
  overtime_multiplier numeric(4,2) not null default 1.5,
  effective_from date not null default current_date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
comment on table public.profile_rates is 'Ставки: только финансовый доступ (ДНК §2 п.7). История через effective_from.';

create table public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  label text not null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','approved','paid')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.pay_periods is 'Зарплатный период (две недели). Статусы draft→approved→paid (блок 9).';

create table public.pay_period_items (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  regular_hours numeric(8,2) not null default 0,
  overtime_hours numeric(8,2) not null default 0,
  overtime_multiplier numeric(4,2) not null default 1.5,
  hourly_rate numeric(10,2),
  bonus numeric(12,2) not null default 0,
  reimbursement numeric(12,2) not null default 0,
  deduction numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  time_event_ids uuid[] not null default '{}', -- прослеживаемость: из каких отметок собраны часы (ДНК-правило №1)
  adjustments jsonb not null default '[]',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_period_id, profile_id)
);
comment on table public.pay_period_items is 'Строка зарплаты работника. time_event_ids связывает деньги с отметками — каждое действие прослеживаемо (ДНК-правило №4).';

create table public.payroll_closures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  profile_id uuid not null references public.profiles(id),
  closed_from timestamptz not null,
  closed_through timestamptz not null,
  pay_period_id uuid references public.pay_periods(id),
  closed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (closed_through > closed_from)
);
comment on table public.payroll_closures is 'Закрытие/сброс выплаченных часов по работнику (ДНК §2 п.5): периоды не пересекаются (триггер).';

create or replace function app.prevent_payroll_closure_overlap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.payroll_closures pc
    where pc.profile_id = new.profile_id
      and pc.id is distinct from new.id
      and tstzrange(pc.closed_from, pc.closed_through) && tstzrange(new.closed_from, new.closed_through)
  ) then
    raise exception 'Payroll closure overlaps an existing closure for this worker';
  end if;
  return new;
end $$;

create trigger payroll_closures_no_overlap before insert or update on public.payroll_closures
  for each row execute function app.prevent_payroll_closure_overlap();

create trigger accounts_touch before update on public.accounts
  for each row execute function app.touch_updated_at();
create trigger contacts_touch before update on public.contacts
  for each row execute function app.touch_updated_at();
create trigger documents_touch before update on public.documents
  for each row execute function app.touch_updated_at();
create trigger pay_periods_touch before update on public.pay_periods
  for each row execute function app.touch_updated_at();
create trigger pay_period_items_touch before update on public.pay_period_items
  for each row execute function app.touch_updated_at();