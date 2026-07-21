-- MAIL-3: «рабочий фильтр» почты (закон Андрея 16.07: в приложение — только письма по работе;
-- заказы/рассылки/прочее остаются в Gmail и в приложение не тянутся).
alter table public.mail_accounts
  add column work_only boolean not null default false;

comment on column public.mail_accounts.work_only is 'true — в mail_messages сохраняются только письма от адресов из белого списка (mail_allowlist + email клиентов из accounts/contacts + свои корпоративные ящики)';

create table public.mail_allowlist (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  entry text not null,           -- полный адрес (accountant@x.com) или домен (@cpafirm.com)
  note text,                     -- «бухгалтер», «инспектор города» — чтобы помнить, кто это
  created_at timestamptz not null default now(),
  unique (org_id, entry)
);

alter table public.mail_allowlist enable row level security;
create policy mail_allowlist_owner on public.mail_allowlist
  for all
  using (org_id = app.org_id() and app.is_owner())
  with check (org_id = app.org_id() and app.is_owner());

-- Включаем рабочий фильтр на Build Pro (личный Gmail, там много нерабочего). office@ — чистый корпоративный, фильтр не нужен.
update public.mail_accounts set work_only = true where key = 'buildpro';

-- Сид белого списка: свои корпоративные адреса (переписка между ящиками — всегда рабочая)
insert into public.mail_allowlist (org_id, entry, note)
select o.id, v.entry, v.note from public.organizations o,
  (values ('office@nwhomesremodel.com', 'корп. ящик Custom Homes'),
          ('crew@nwhomesremodel.com',   'исходящий адрес приложения (Resend)'),
          ('nwbuildpro@gmail.com',      'корп. ящик Build Pro')) as v(entry, note)
on conflict do nothing;
