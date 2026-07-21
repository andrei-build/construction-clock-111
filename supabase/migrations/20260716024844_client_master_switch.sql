-- 0045: закон Андрея 16.07 — «возможность вообще никак не взаимодействовать с клиентом».
-- Мастер-выключатель на клиенте: выключен → клиентский портал слепнет (RLS через client_account_ids),
-- уведомления (travel-notify и будущие рассылки) обязаны проверять этот флаг.
alter table public.accounts add column if not exists client_access_enabled boolean not null default true;

create or replace function app.client_account_ids()
returns setof uuid
language sql
stable security definer
set search_path to 'public'
as $$
  select cu.account_id
  from public.client_users cu
  join public.accounts a on a.id = cu.account_id
  where cu.profile_id = (select auth.uid())
    and a.client_access_enabled
    and a.deleted_at is null
$$;
