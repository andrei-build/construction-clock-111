-- 1) Управление входом по PIN (заглушка в WorkerDetail просила backend-колонку)
alter table public.profiles add column if not exists pin_enabled boolean not null default true;
comment on column public.profiles.pin_enabled is 'Разрешён ли вход по PIN (тумблер в карточке работника, управляет manager+)';

-- 2) Напоминания по клиентам (закон Андрея 17.07: «связаться через месяц, клиент хочет то-то»)
create table if not exists public.client_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  client_account_id uuid not null references public.accounts(id) on delete cascade,
  remind_on date not null,
  note text not null,
  done_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
comment on table public.client_reminders is 'Напоминания владельца по клиентам (видны manager+, всплывают в срок в Оповещениях/КЦ)';
create index if not exists client_reminders_due_idx on public.client_reminders (org_id, remind_on) where done_at is null;

alter table public.client_reminders enable row level security;
drop policy if exists client_reminders_manager on public.client_reminders;
create policy client_reminders_manager on public.client_reminders
  for all using ((org_id = app.org_id()) and app.is_manager())
  with check ((org_id = app.org_id()) and app.is_manager());
