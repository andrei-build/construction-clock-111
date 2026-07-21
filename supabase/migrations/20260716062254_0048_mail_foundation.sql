-- MAIL-1: корпоративная почта в приложении (ДНК §13, закон 16.07)
-- Реквизиты ящиков (host/port/user/pass) живут ТОЛЬКО в Supabase edge secrets:
--   MAIL_<KEY>_HOST / MAIL_<KEY>_PORT / MAIL_<KEY>_USER / MAIL_<KEY>_PASS  (KEY = upper(mail_accounts.key))
-- Здесь — только несекретные метаданные и сами письма.

create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  key text not null unique check (key ~ '^[a-z0-9_]+$'),
  brand text not null check (brand in ('nw_build_pro','nw_custom_homes')),
  email text not null,
  display_name text not null default '',
  active boolean not null default true,
  last_sync_at timestamptz,
  last_uid bigint,
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.mail_accounts enable row level security;
create policy mail_accounts_owner on public.mail_accounts
  for all
  using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());

create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  account_id uuid not null references public.mail_accounts(id) on delete cascade,
  uid bigint not null,
  message_id text,
  from_name text,
  from_addr text,
  to_addr text,
  subject text,
  snippet text,
  body_text text,
  sent_at timestamptz,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, uid)
);

create index mail_messages_account_sent_idx on public.mail_messages (account_id, sent_at desc);

alter table public.mail_messages enable row level security;
-- Чтение — только owner (закон: «чтобы у меня был доступ к ним»)
create policy mail_messages_owner_select on public.mail_messages
  for select using (org_id = app.org_id() and app.is_owner());
-- Правка — только пометка прочитанности owner'ом; вставка/удаление только service-role (edge mail-sync)
create policy mail_messages_owner_update on public.mail_messages
  for update
  using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());

-- Токен для cron-вызова edge mail-sync (тот же паттерн, что digest_token у evening-digest)
update public.app_settings
set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{mail_sync_token}', to_jsonb(encode(gen_random_bytes(24), 'hex')))
where settings is null or settings->>'mail_sync_token' is null;

-- Сид двух корпоративных ящиков (email Build Pro уточнит Андрей — заглушка, роли не играет до ввода secrets)
insert into public.mail_accounts (org_id, key, brand, email, display_name, active)
select o.id, v.key, v.brand, v.email, v.display_name, false
from public.organizations o,
     (values
       ('buildpro',    'nw_build_pro',    'office@nwbuildpro.com',      'NW Build Pro'),
       ('customhomes', 'nw_custom_homes', 'office@nwhomesremodel.com',  'NW Custom Homes Remodel')
     ) as v(key, brand, email, display_name)
limit 2;
