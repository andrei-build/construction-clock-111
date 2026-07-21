-- Ф2 Шаг 3 (аддитивно, потребители НЕ трогаются): канон производных фактов, считаем в БД один раз.
-- security_invoker=on → уважают RLS вызывающего (дашборд под JWT авто-скоупится по org/видимости).
-- org_id в выдаче → сервисный вызов ассистента фильтрует .eq('org_id',...), дашборд — через RLS.

-- (1) КТО СЕЙЧАС НА СМЕНЕ: по последнему shift-событию (check_in/check_out) на человека; на смене = последний check_in.
create or replace view public.v_on_shift_now
with (security_invoker = on) as
select te.org_id,
       te.profile_id,
       p.name,
       p.role,
       te.project_id,
       te.event_time as since
from (
  select distinct on (profile_id)
         profile_id, org_id, project_id, event_type, event_time
  from public.time_events
  where event_type in ('check_in','check_out')
  order by profile_id, event_time desc
) te
join public.profiles p on p.id = te.profile_id and p.deleted_at is null
where te.event_type = 'check_in';

-- (2) ТЕКУЩИЕ НАЗНАЧЕНИЯ ПО ПРОЕКТАМ (строка = проект×работник). «Кто свободен» посчитаем в org_snapshot() (нужен весь состав).
create or replace view public.v_assignments_current
with (security_invoker = on) as
select a.org_id,
       a.project_id,
       pr.name as project_name,
       a.profile_id,
       p.name  as worker_name,
       p.role,
       a.note,
       a.assigned_at
from public.project_assignments a
join public.projects pr on pr.id = a.project_id and pr.deleted_at is null and pr.status <> 'archived'
join public.profiles p  on p.id  = a.profile_id and p.deleted_at is null;

grant select on public.v_on_shift_now to authenticated;
grant select on public.v_assignments_current to authenticated;
